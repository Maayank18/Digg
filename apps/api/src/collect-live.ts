import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PipelineError, domainOf, intentDefinition, slug, normalizeDate } from "@dig/core";
import type { CollectedRecord, ProvenanceSource } from "@dig/core";
import type { CollectionBlueprint } from "@dig/schemas";
import { collectIntent } from "./collect-intents.js";
import { env } from "./env.js";

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string | null;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

export interface SearchPlan {
  query: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  depth?: "basic" | "advanced";
  maxResults?: number;
  rawContent?: boolean;
  /** Return up to 3 relevant chunks per page as `content` (advanced depth only). */
  chunks?: boolean;
}

const HACKATHON_PATTERN = /\bhackathon(s)?\b|\bhack[\s-]?(the|for|day|fest)\b|\bdevpost\b|\bunstop\b|\bdevfolio\b|\bhackerearth\b/i;

/** Turns a Tavily HTTP error into a message a person can act on. */
export function searchError(status: number): PipelineError {
  if (status === 432 || status === 433) {
    return new PipelineError(
      "SEARCH_QUOTA",
      "The web-search quota for this Tavily API key is used up. Add credits on tavily.com or put a fresh TAVILY_API_KEY in .env, then run the search again.",
    );
  }
  if (status === 429) return new PipelineError("SEARCH_RATE_LIMITED", "The web search is rate limited right now. Wait a minute, then run the search again.", true);
  if (status === 401 || status === 403) {
    return new PipelineError("SEARCH_AUTH", "The Tavily API key in .env was rejected. Check TAVILY_API_KEY, then run the search again.");
  }
  return new PipelineError("SOURCE_UNAVAILABLE", `The web search service returned an error (${status}). Try again in a minute.`, status >= 500);
}

export async function tavilySearch(plan: SearchPlan, signal?: AbortSignal): Promise<TavilyResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: signal ?? AbortSignal.timeout(30_000),
    body: JSON.stringify({
      api_key: env.tavilyKey,
      query: plan.query,
      search_depth: plan.depth ?? "advanced",
      max_results: plan.maxResults ?? 10,
      include_answer: false,
      include_raw_content: plan.rawContent ? "text" : false,
      ...(plan.includeDomains ? { include_domains: plan.includeDomains } : {}),
      ...(plan.excludeDomains ? { exclude_domains: plan.excludeDomains } : {}),
      ...(plan.chunks ? { chunks_per_source: 3 } : {}),
    }),
  });
  if (!response.ok) {
    throw searchError(response.status);
  }
  const body = (await response.json()) as TavilyResponse;
  return body.results ?? [];
}

/** One batched /extract call. Never throws: a URL that cannot be fetched is simply absent from the map. */
export async function tavilyExtract(urls: string[]): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  if (urls.length === 0) return pages;
  try {
    const response = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: env.tavilyKey, urls, extract_depth: "basic", format: "text" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return pages;
    const body = (await response.json()) as { results?: Array<{ url: string; raw_content?: string | null }> };
    for (const result of body.results ?? []) {
      if (result.raw_content) pages.set(result.url, result.raw_content);
    }
  } catch (error) {
    log("extract failed, continuing without it:", errorMessage(error));
  }
  return pages;
}

// ---------------------------------------------------------------------------
// LLM lanes: Groq limits tokens-per-minute per model, so each model is a lane
// with its own token bucket, calibrated from the x-ratelimit-* response headers.
// ---------------------------------------------------------------------------

const CHAT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};

export interface Lane {
  model: string;
  capacity: number;
  remaining: number;
  checkedAt: number;
  blockedUntil: number;
}

const laneState = new Map<string, Lane>();
const keyCooldown = new Map<number, number>();
let keyCursor = 0;

/** The first Groq key that is not cooling off. Null when every key is waiting out a limit. */
function liveKey(): { index: number; key: string } | null {
  const keys = env.llmKeys;
  const now = Date.now();
  for (let step = 0; step < keys.length; step += 1) {
    const index = (keyCursor + step) % keys.length;
    if ((keyCooldown.get(index) ?? 0) <= now) {
      keyCursor = index;
      const key = keys[index];
      if (key) return { index, key };
    }
  }
  return null;
}

function coolKey(index: number, ms: number) {
  keyCooldown.set(index, Date.now() + ms);
  const count = env.llmKeys.length;
  if (count > 0) keyCursor = (index + 1) % count;
}

/** A new key has its own token bucket, so the lane's previous balance no longer applies. */
function releaseLane(lane: Lane) {
  lane.remaining = lane.capacity;
  lane.checkedAt = Date.now();
  lane.blockedUntil = 0;
}

export function llmLanes(): Lane[] {
  const endpoint = CHAT_ENDPOINTS[env.llmProvider];
  if (!endpoint || env.llmKeys.length === 0) {
    throw new PipelineError(
      "LLM_UNAVAILABLE",
      "Live collection needs LLM_PROVIDER set to openai or groq, with LLM_API_KEY set in .env, to extract structured records from search results.",
    );
  }
  const models = [...new Set([env.llmModel, ...env.llmExtraModels])];
  return models.map((model) => {
    let lane = laneState.get(model);
    if (!lane) {
      lane = { model, capacity: 8000, remaining: 8000, checkedAt: Date.now(), blockedUntil: 0 };
      laneState.set(model, lane);
    }
    return lane;
  });
}

function laneAvailable(lane: Lane): number {
  const refill = ((Date.now() - lane.checkedAt) / 60_000) * lane.capacity;
  return Math.min(lane.capacity, lane.remaining + refill);
}

function laneSpend(lane: Lane, tokens: number, headers: Headers) {
  const capacity = Number(headers.get("x-ratelimit-limit-tokens"));
  const remaining = Number(headers.get("x-ratelimit-remaining-tokens"));
  const estimated = laneAvailable(lane) - tokens;
  if (capacity > 0) lane.capacity = capacity;
  lane.remaining = Number.isFinite(remaining) && headers.has("x-ratelimit-remaining-tokens") ? Math.min(remaining, estimated) : estimated;
  lane.checkedAt = Date.now();
}

async function waitForTokens(lane: Lane, needed: number, deadline: number): Promise<boolean> {
  const target = Math.min(needed, lane.capacity);
  const shortfall = target - laneAvailable(lane);
  const blocked = Math.max(0, lane.blockedUntil - Date.now());
  if (shortfall <= 0 && blocked === 0) return true;
  const waitMs = Math.max(blocked, Math.ceil((Math.max(0, shortfall) / lane.capacity) * 60_000));
  if (Date.now() + waitMs > deadline) return false;
  await sleep(waitMs);
  return true;
}

function retryAfterMs(headers: Headers): number {
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 6000;
}

/** Calls one lane, pacing against its token bucket and retrying 429s. Returns parsed JSON, or null on failure. */
export async function chatJson<T>(
  lane: Lane,
  input: { system: string; user: string; maxTokens: number; deadline: number; label: string; handBack?: boolean },
): Promise<T | null> {
  const endpoint = CHAT_ENDPOINTS[env.llmProvider] as string;
  const estimate = Math.ceil((input.system.length + input.user.length) / 3.5) + Math.min(2500, input.maxTokens);
  const reasoning = /gpt-oss/.test(lane.model) ? { reasoning_effort: "low" } : {};
  const attempts = Math.min(8, Math.max(4, env.llmKeys.length));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const chosen = liveKey();
    if (!chosen) {
      log(`${input.label}: every Groq key is cooling off`);
      return null;
    }
    if (!(await waitForTokens(lane, estimate, input.deadline))) {
      coolKey(chosen.index, Math.max(1000, lane.blockedUntil - Date.now()));
      if (liveKey()) {
        releaseLane(lane);
        continue;
      }
      log(`${input.label}: skipped, not enough rate budget before the deadline`);
      return null;
    }
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${chosen.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: lane.model,
          temperature: 0,
          max_completion_tokens: input.maxTokens,
          response_format: { type: "json_object" },
          ...reasoning,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      log(`${input.label}: request error on ${lane.model}:`, errorMessage(error));
      return null;
    }

    if (response.status === 429) {
      const wait = retryAfterMs(response.headers);
      const remaining = Number(response.headers.get("x-ratelimit-remaining-tokens"));
      lane.remaining = Number.isFinite(remaining) ? remaining : 0;
      lane.checkedAt = Date.now();
      lane.blockedUntil = Date.now() + wait;
      coolKey(chosen.index, wait);
      if (liveKey()) {
        releaseLane(lane);
        log(`${input.label}: rate limited on ${lane.model}, switching Groq key`);
        continue;
      }
      // When other lanes exist, the wait is better spent there: give the work back to the caller.
      if (input.handBack || wait > 12_000 || Date.now() + wait > input.deadline) {
        log(`${input.label}: rate limited on ${lane.model} for ${Math.round(wait / 1000)}s, handing back:`, (await response.text()).slice(0, 160));
        return null;
      }
      log(`${input.label}: rate limited on ${lane.model}, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      coolKey(chosen.index, 86_400_000);
      if (liveKey()) {
        releaseLane(lane);
        log(`${input.label}: Groq key rejected, switching`);
        continue;
      }
      log(`${input.label}: ${lane.model} returned ${response.status}`);
      return null;
    }
    if (!response.ok) {
      log(`${input.label}: ${lane.model} returned ${response.status}`);
      if (response.status >= 500 && attempt === 0) continue;
      return null;
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    laneSpend(lane, body.usage?.total_tokens ?? estimate, response.headers);
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    try {
      return JSON.parse(content) as T;
    } catch {
      log(`${input.label}: ${lane.model} returned invalid JSON`);
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Grounding: a field survives only if its value is a literal (case-insensitive)
// substring of the text it claims to come from.
// ---------------------------------------------------------------------------

const EXEMPT_FROM_GROUNDING = new Set(["website", "last_verified", "source_url", "pdf_url"]);
const IDENTITY_PRIORITY = ["company_name", "event_name", "paper_title", "person_name", "role_title", "program_name", "product_name", "segment"];

const OFFICIAL_PAPER_DOMAINS = new Set([
  "arxiv.org",
  "openreview.net",
  "semanticscholar.org",
  "aclanthology.org",
  "paperswithcode.com",
  "ieee.org",
  "acm.org",
  "nature.com",
  "science.org",
  "sciencedirect.com",
  "springer.com",
  "cell.com",
  "biorxiv.org",
  "medrxiv.org",
  "pnas.org",
  "nih.gov",
  "ncbi.nlm.nih.gov",
  "researchgate.net",
  "orcid.org",
]);

const OFFICIAL_EVENT_DOMAINS = new Set([
  "devfolio.co",
  "unstop.com",
  "devpost.com",
  "hackerearth.com",
  "mlh.io",
  "lu.ma",
  "eventbrite.com",
  "meetup.com",
  "hackclub.com",
]);

function groundedFields(fields: Record<string, string>, content: string): { fields: Record<string, string>; fieldNames: string[] } {
  const haystack = content.toLowerCase();
  const kept: Record<string, string> = {};
  const fieldNames: string[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    if (EXEMPT_FROM_GROUNDING.has(key)) {
      kept[key] = value;
      fieldNames.push(key);
      continue;
    }
    const at = haystack.indexOf(value.toLowerCase());
    if (at < 0) continue;
    // Keep the source's own spelling, not the model's re-cased copy ("legend sponsor" → "Legend Sponsor"),
    // so the same page yields the same value on every run.
    const literal = content.slice(at, at + value.length);
    kept[key] = literal.toLowerCase() === value.toLowerCase() ? literal : value;
    fieldNames.push(key);
  }
  return { fields: kept, fieldNames };
}

function authorityFor(url: string, fields: Record<string, string>): ProvenanceSource["authority"] {
  const domain = domainOf(url).toLowerCase();
  if ([...OFFICIAL_PAPER_DOMAINS].some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return "official";
  }
  if ([...OFFICIAL_EVENT_DOMAINS].some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return "official";
  }
  const entityCandidate =
    fields.company_name ||
    fields.organizer ||
    fields.event_name ||
    fields.paper_title ||
    fields.person_name ||
    fields.vendor ||
    fields.organization ||
    "";
  const nameSlug = slug(entityCandidate);
  if (nameSlug && nameSlug.length >= 3) {
    const compactSlug = nameSlug.replace(/-/g, "");
    const compactDomain = domain.replace(/\./g, "");
    if (compactDomain.includes(compactSlug) || compactSlug.includes(compactDomain.split(".")[0] ?? "")) {
      return "official";
    }
  }
  if (/\.(gov|edu|ac\.in|ac\.uk|edu\.in|org\.in)$/i.test(domain)) {
    return "official";
  }
  if (/news|times|tribune|herald|express|economictimes|business-standard|techcrunch|venturebeat|wired|reuters|bloomberg|forbes/.test(domain)) {
    return "press";
  }
  return "secondary";
}

function entityLabel(fields: Record<string, string>): string | null {
  for (const key of IDENTITY_PRIORITY) {
    if (fields[key]?.trim()) return fields[key].trim();
  }
  return null;
}

/** Literal windows of `text` around each value, so the excerpt itself evidences every grounded field. */
export function excerptAround(text: string, values: string[], radius = 120): string {
  const lower = text.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const value of values) {
    const at = lower.indexOf(value.toLowerCase());
    if (at < 0) continue;
    spans.push([Math.max(0, at - radius), Math.min(text.length, at + value.length + radius)]);
  }
  if (spans.length === 0) return text.slice(0, 500);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged.map(([start, end]) => text.slice(start, end).replace(/\s+/g, " ").trim()).join(" … ");
}

export function provenance(input: {
  url: string;
  title: string;
  text: string;
  publishedAt: string;
  sourceType: string;
  extractionMethod: string;
  claims: Record<string, string>;
  /** The entity this source is about, so its own domain counts as official even when it grounds no name. */
  entity?: string;
}): { fields: Record<string, string>; source: ProvenanceSource } | null {
  const haystack = `${input.title}\n${input.text}`;
  const { fields, fieldNames } = groundedFields(input.claims, haystack);
  if (fieldNames.length === 0) return null;
  const literal = fieldNames.filter((name) => !EXEMPT_FROM_GROUNDING.has(name)).map((name) => fields[name] as string);
  return {
    fields,
    source: {
      url: input.url,
      title: input.title,
      domain: domainOf(input.url),
      publishedAt: input.publishedAt,
      sourceType: input.sourceType,
      authority: authorityFor(input.url, input.entity ? { company_name: input.entity, ...fields } : fields),
      excerpt: excerptAround(haystack, literal),
      fieldNames,
      extractionMethod: input.extractionMethod,
      demo: false,
    },
  };
}

// ---------------------------------------------------------------------------
// SPONSOR_LOOKUP
//
// 1. Breadth: several parallel Tavily searches (listing sites + open web) that
//    return full page text in the same call.
// 2. Pages that came back empty (JS-rendered Unstop/Devfolio) are re-fetched in
//    ONE batched /extract, using their server-rendered variants (/amp, /overview).
// 3. Each page is cut down to the text around its sponsor cues, then all pages
//    are packed into a few large batched LLM calls, spread over the model lanes.
// 4. As sponsors arrive, each company's contact details are found with one cheap
//    search and pulled out deterministically (regex, own-domain only) — no LLM.
// ---------------------------------------------------------------------------

const SPONSOR_DEADLINE_MS = 100_000;
const MAX_ENRICH = env.sponsorEnrichLimit;
const ENRICH_CONCURRENCY = 8;
const BATCH_CHARS = 16_000;
const MAX_CORPUS_CHARS = 80_000;
const PAGE_WINDOW_CHARS = 5_500;
const CONTACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const QUERY_NOISE =
  /\b(find|search|get|list|of|me|show|potential|possible|top|best|who|are|is|the|for|and|companies|company|brands?|sponsors?|sponsorships?|sponsoring|sponsored|partners?|hackathons?|events?|in|at|with|to|a|an)\b/gi;

function topicOf(query: string): string {
  return query.replace(QUERY_NOISE, " ").replace(/[^\w\s.+#-]/g, " ").replace(/\s+/g, " ").trim();
}

function eventKindOf(query: string): string {
  if (HACKATHON_PATTERN.test(query)) return "hackathon";
  const match = /\b(conference|summit|festival|fest|meetup|expo|event)s?\b/i.exec(query);
  return match ? (match[1] as string).toLowerCase() : "hackathon";
}

function sponsorSearchPlans(blueprint: CollectionBlueprint): SearchPlan[] {
  const topic = (blueprint.entities.subject || topicOf(blueprint.query)).trim();
  const place = (blueprint.entities.location || "").trim();
  const kind = eventKindOf(blueprint.query);
  const t = topic ? `${topic} ` : "";
  const loc = place ? ` ${place}` : "";
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const common = {
    depth: "advanced" as const,
    maxResults: 20,
    rawContent: true,
    excludeDomains: ["pinterest.com", "quora.com", "facebook.com", "instagram.com", "tiktok.com"],
  };
  const plans: SearchPlan[] = [
    { ...common, query: `${t}${kind}${loc} ${currentYear} sponsors partners` },
    { ...common, query: `${t}${kind}${loc} ${prevYear} our sponsors title sponsor gold sponsor` },
    { ...common, query: `${t}${kind}${loc} powered by sponsored by partners` },
  ];
  if (kind === "hackathon") {
    plans.push(
      { ...common, query: `${t}hackathon${loc} ${currentYear} hackathon sponsors`, includeDomains: ["devpost.com", "devfolio.co", "unstop.com"] },
      { ...common, query: `${t}hackathon sponsors track prizes partners`, includeDomains: ["hackerearth.com", "dorahacks.io", "mlh.io"] },
    );
  }
  return plans;
}

interface SourceDoc {
  id: number;
  url: string;
  title: string;
  text: string;
  publishedAt: string;
  fed: string;
  score: number;
}

const UNFETCHABLE = /(^|\.)(instagram|facebook|linkedin|x|twitter|youtube|reddit|tiktok|threads)\.(com|net)$/;

function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const trimmed = parsed.pathname.replace(/\/+$/, "").replace(/\/(amp|overview)$/, "");
    return `${host}${trimmed}`;
  } catch {
    return url;
  }
}

/** Server-rendered variant of a JS-heavy listing page, which Tavily can actually read. */
function fetchableVariant(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const trimmed = parsed.pathname.replace(/\/+$/, "");
    if (host === "unstop.com" && !trimmed.endsWith("/amp") && trimmed.split("/").length >= 3) {
      return `https://unstop.com${trimmed}/amp`;
    }
    if (host.endsWith(".devfolio.co") && (trimmed === "" || trimmed === "/")) {
      return `https://${host}/overview`;
    }
  } catch {
    // fall through
  }
  return url;
}

const SPONSOR_CUE =
  /sponsor|partner|powered by|presented by|backed by|supported by|in association with|in collaboration with|brought to you by|best use of|prizes? (?:by|from)|bounties? (?:by|from)|grants? (?:by|from)|credits (?:by|from)|api partner/gi;
const STRONG_CUE =
  /(?:title|gold|silver|platinum|diamond|bronze|associate|official|premium|tech(?:nology)?|cloud|venue|prize|track|co|hackathon|our|event|knowledge|community|tooling|education|career|domain|basic|ecosystem)[- ]?(?:sponsors?|partners?)\b|powered by|sponsored by|presented by|best use of|cloud credits|bounty sponsor/gi;

/** The page text around its sponsor cues, with repeated lines collapsed. Empty when the page has no cues. */
function sponsorWindows(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  }
  const clean = lines.join("\n");
  const spans: Array<[number, number]> = [];
  for (const match of clean.matchAll(SPONSOR_CUE)) {
    const index = match.index ?? 0;
    const start = Math.max(0, index - 200);
    const end = Math.min(clean.length, index + 700);
    const last = spans[spans.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  const emitted = new Set<string>();
  const pieces: string[] = [];
  let total = 0;
  for (const [start, end] of spans) {
    const kept = clean
      .slice(start, end)
      .split("\n")
      .filter((line) => {
        if (line.length <= 25) return true;
        const key = line.toLowerCase();
        if (emitted.has(key)) return false;
        emitted.add(key);
        return true;
      })
      .join("\n")
      .trim();
    if (!kept) continue;
    pieces.push(kept);
    total += kept.length;
    if (total >= PAGE_WINDOW_CHARS) break;
  }
  return pieces.join("\n…\n").slice(0, PAGE_WINDOW_CHARS);
}

const HACKATHON_PAGE = /hackathon|\bhacks?\b|buildathon|ideathon|codefest|devpost|devfolio/i;

async function gatherSponsorPages(blueprint: CollectionBlueprint): Promise<SourceDoc[]> {
  const kind = eventKindOf(blueprint.query);
  const plans = sponsorSearchPlans(blueprint);
  const settled = await Promise.allSettled(plans.map((plan) => tavilySearch(plan)));
  const failure = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failure && settled.every((outcome) => outcome.status === "rejected")) throw failure.reason;

  const byKey = new Map<string, TavilyResult>();
  settled.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      log(`search "${plans[index]?.query}" failed:`, errorMessage(outcome.reason));
      return;
    }
    log(`search "${plans[index]?.query}" → ${outcome.value.length} results`);
    for (const result of outcome.value) {
      const key = urlKey(result.url);
      const existing = byKey.get(key);
      if (!existing || (result.raw_content?.length ?? 0) > (existing.raw_content?.length ?? 0)) byKey.set(key, result);
    }
  });
  if (byKey.size === 0 && settled.every((outcome) => outcome.status === "rejected")) {
    throw new PipelineError("SOURCE_UNAVAILABLE", "Every sponsor search failed.", true);
  }

  const missing = [...byKey.values()]
    .filter((result) => (result.raw_content?.length ?? 0) < 400 && !UNFETCHABLE.test(domainOf(result.url)))
    .slice(0, 20);
  const variants = new Map(missing.map((result) => [fetchableVariant(result.url), result]));
  const extracted = await tavilyExtract([...variants.keys()]);
  for (const [variant, text] of extracted) {
    const result = variants.get(variant);
    if (result) result.raw_content = text;
  }
  log(`recovered ${extracted.size}/${missing.length} empty pages via extract`);

  const docs: SourceDoc[] = [];
  for (const result of byKey.values()) {
    const text = result.raw_content && result.raw_content.length >= 400 ? result.raw_content : result.content;
    // For a hackathon request, a page that never mentions a hackathon (a trade expo's sponsor list) is off-topic.
    if (kind === "hackathon" && !HACKATHON_PAGE.test(`${result.title}\n${text ?? ""}`)) continue;
    const fed = sponsorWindows(text ?? "");
    if (!fed) continue;
    docs.push({
      id: 0,
      url: result.url,
      title: result.title,
      text,
      publishedAt: result.published_date ? normalizeDate(result.published_date) : "",
      fed,
      score: (fed.match(STRONG_CUE) ?? []).length,
    });
  }
  docs.sort((a, b) => b.score - a.score);
  const kept: SourceDoc[] = [];
  let total = 0;
  for (const doc of docs) {
    if (doc.score === 0 || total + doc.fed.length > MAX_CORPUS_CHARS) continue;
    doc.id = kept.length + 1;
    kept.push(doc);
    total += doc.fed.length;
  }
  log(`${kept.length} pages with sponsor sections (${total} chars) out of ${byKey.size} unique results`);
  return kept;
}

function packBatches(docs: SourceDoc[]): SourceDoc[][] {
  const batches: SourceDoc[][] = [];
  let current: SourceDoc[] = [];
  let size = 0;
  for (const doc of docs) {
    const cost = doc.fed.length + doc.title.length + doc.url.length + 20;
    if (current.length > 0 && size + cost > BATCH_CHARS) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(doc);
    size += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const SPONSOR_SYSTEM_PROMPT =
  "You read excerpts of hackathon and tech-event web pages and list the organizations that sponsor or " +
  "partner with each event. Every value you output must be copied character-for-character from the " +
  "source text (title or body) — same spelling, never paraphrased, translated, expanded, or guessed. " +
  "Include companies, startups, investors, foundations and government programmes named as a sponsor, " +
  "partner (of any tier), prize/track/bounty provider, or the org an event is 'powered by'/'presented " +
  "by'. When a line lists several names (e.g. 'Tooling Partners: JetBrains, Balsamiq'), output each " +
  "name separately with that line's tier. Logo strips are sometimes run together with no separator " +
  "(e.g. 'MaticTezosPortis' or 'ETHIndiaOrkes'): split them into the separate organizations (Matic, " +
  "Tezos, Portis), each still copied exactly. EXCLUDE:the organization organizing or hosting the event " +
  "itself (e.g. a company running its own hiring hackathon, or the college hosting it); universities, " +
  "colleges and schools; student clubs and communities; individual people as sponsors; the listing " +
  "platform (Devpost, Unstop, Devfolio, HackerEarth) unless the page explicitly names it as a sponsor or " +
  "partner; employers of judges or speakers unless the page calls them a sponsor or partner; generic " +
  "phrases like 'our partners'. Skip sources that only discuss sponsorship in general (advice, how-to, " +
  "platform marketing) without naming a specific event's sponsors. " +
  'Return JSON: {"events":[{"i":<source number>,"event":"<event name, verbatim>","sponsors":[{"c":"<organization name, verbatim>","t":"<tier or role, verbatim, e.g. Gold Sponsor, Cloud Partner, Powered by>","p":"<full name of a person from THIS sponsor named on the page, e.g. its partnerships or devrel contact>","m":"<email address for THIS sponsor written on the page>"}]}]}. ' +
  "Omit a key when the page does not state it. Omit sources with no sponsors.";

interface SponsorBatchResponse {
  events?: Array<{
    i?: number;
    event?: string;
    sponsors?: Array<{ c?: string; t?: string; p?: string; m?: string }>;
  }>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERSON = /^[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]*){1,3}$/;
const NOT_A_SPONSOR =
  /^(sponsors?|partners?|our (sponsors|partners)|tba|tbd|coming soon|and more|more|others?|your (company|logo|brand)( here)?|(sponsor|company|partner) name|name sponsor|logo|company|.)$/i;
const SITE_NAMES =
  "devpost|devfolio|unstop|hackerearth|hackerrank|dorahacks|luma|lu\\.ma|instagram|facebook|linkedin|twitter|youtube|reddit|threads|tiktok|medium|eventbrite|meetup|mlh";
const TITLE_SUFFIX = new RegExp(`\\s*[|·–—-]\\s*(${SITE_NAMES})(\\.(com|co|io))?\\s*$`, "i");
// A page's title is often just the site ("Instagram") or a section ("Hackathons"), which is no event name.
// Titles of the sponsor list itself ("Thank you, Hackathon Sponsors!", "Our Sponsors") name no event.
const SPONSOR_LIST_TITLE = /thank you|\b(our|the) (sponsors|partners)\b|^(hackathon |event )?(sponsors|partners)\b/i;
const NOT_AN_EVENT = new RegExp(`^(${SITE_NAMES}|home|events?|hackathons?|sponsors?|partners?|overview|register|login)$`, "i");

/**
 * The event name for a mention, as a literal prefix of the source text with any "| Devfolio"-style site
 * suffix removed — or null when neither the model's answer nor the page title names a real event.
 */
function eventNameFor(candidate: string | undefined, doc: SourceDoc, haystack: string): string | null {
  const siteLabel = registrableLabel(domainOf(doc.url));
  for (const raw of [candidate ?? "", doc.title]) {
    const grounded = groundedFields({ event_name: raw }, haystack).fields.event_name;
    if (!grounded) continue;
    let name = grounded;
    for (let before = ""; before !== name; ) {
      before = name;
      name = name.replace(TITLE_SUFFIX, "").replace(/\s*(\.{3}|…)$/, "").trim();
    }
    // "Hack the North 2024: Canada's Biggest Hackathon" → "Hack the North 2024": drop a long tagline, keep short editions.
    const colon = name.indexOf(": ");
    if (colon >= 4 && name.length - colon - 2 >= 25) name = name.slice(0, colon).trim();
    if (name.length < 4 || NOT_AN_EVENT.test(name) || SPONSOR_LIST_TITLE.test(name) || companyKey(name) === siteLabel) continue;
    return name;
  }
  return null;
}

const KEY_NOISE = ["incorporated", "inc", "llc", "ltd", "pvt", "private", "limited", "corporation", "corp", "company", "co", "ai", "labs", "technologies", "technology", "tech", "software", "com", "io", "india", "global"];

/** Dedupe key: "ElevenLabs" = "Eleven Labs", "Rentr" = "Rentr Company (England-Based)", "Featherless AI" = "Featherless.ai". */
function companyKey(name: string): string {
  let key = slug(name.replace(/\([^)]*\)/g, " ")).replace(/-/g, "");
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of KEY_NOISE) {
      if (key.endsWith(suffix) && key.length - suffix.length >= 4) {
        key = key.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return key;
}

function registrableLabel(host: string): string {
  const parts = host.replace(/^www\./, "").toLowerCase().split(".");
  const n = parts.length;
  if (n >= 3 && /^(co|com|org|net|ac|gov|edu)$/.test(parts[n - 2] as string) && (parts[n - 1] as string).length === 2) {
    return parts[n - 3] as string;
  }
  return (n >= 2 ? parts[n - 2] : parts[0]) as string;
}

/** Whether a hostname plausibly belongs to the named company (replit.com ↔ "Replit", cloud.google.com ↔ "Google Cloud"). */
function isOwnDomain(host: string, name: string): boolean {
  const bare = host.replace(/^www\./, "").toLowerCase();
  const spelled = name.trim().toLowerCase();
  // A name that is itself a domain ("Navan.ai", "name.com") only matches that exact domain, never navan.com.
  if (/^[a-z0-9-]+\.[a-z]{2,}$/.test(spelled)) return bare === spelled || bare.endsWith(`.${spelled}`);
  const label = registrableLabel(bare).replace(/-/g, "");
  const tokens = slug(name.replace(/\([^)]*\)/g, " ")).split("-").filter(Boolean);
  if (label.length < 3 || tokens.length === 0) return false;
  // Acronyms are ambiguous across TLDs (AWS ≠ aws.org, the welding society): only trust company-style TLDs.
  if (label.length <= 3 && !/\.(com|io|ai|co|dev|in|co\.in)$/.test(bare)) return false;
  // The label must spell whole leading tokens of the name: "google" ↔ "Google Cloud", "redbull" ↔ "Red Bull", never "rent" ↔ "Rentr".
  let prefix = "";
  for (const token of tokens) {
    prefix += token;
    if (label === prefix) return true;
    if (prefix.length >= label.length) break;
  }
  return label === companyKey(name);
}

function registrableDomain(host: string): string {
  const parts = host.replace(/^www\./, "").toLowerCase().split(".");
  return parts.slice(parts.lastIndexOf(registrableLabel(host))).join(".");
}

const NOT_A_COMPANY =
  /\b(institute|institution|university|college|school|academy|iit|iiit|iim|iisc|nit|bits|gdsc|gdg|ieee|acm|club|chapter|students?|community|council|department|faculty)\b|^(iiit|iit)|^(centre|center|office) (for|of)\b/i;
const NON_SPONSOR_TIER = /community|student|campus|chapter|organi[sz]/i;

/** A company whose name opens the event's own name is its host ("Garuda Aerospace" ↔ "GARUDA INDIA HACKATHON"), unless co-branded "A x B". */
function isOrganizer(name: string, event: string): boolean {
  if (/\s(x|×)\s/i.test(event)) return false;
  const eventJoined = slug(event).replace(/-/g, "");
  const key = companyKey(name);
  const first = slug(name).split("-")[0] ?? "";
  return (key.length >= 4 && eventJoined.startsWith(key)) || (first.length >= 4 && eventJoined.startsWith(first));
}

interface Mention {
  doc: SourceDoc;
  fields: Record<string, string>;
}

interface SponsorCandidate {
  name: string;
  mentions: Mention[];
  contact?: Promise<ContactFinding[]>;
}

function acceptSponsors(batch: SourceDoc[], parsed: SponsorBatchResponse | null, companies: Map<string, SponsorCandidate>, onNew: (key: string) => void) {
  const inBatch = new Map(batch.map((doc) => [doc.id, doc]));
  let accepted = 0;
  let dropped = 0;
  for (const entry of parsed?.events ?? []) {
    const doc = typeof entry.i === "number" ? inBatch.get(entry.i) : undefined;
    if (!doc || !Array.isArray(entry.sponsors)) continue;
    const haystack = `${doc.title}\n${doc.fed}`;
    const event = eventNameFor(entry.event, doc, haystack);
    if (!event) {
      dropped += entry.sponsors.length;
      continue;
    }
    const hostLabel = registrableLabel(domainOf(doc.url));

    for (const sponsor of entry.sponsors) {
      const claims: Record<string, string> = { company_name: (sponsor.c ?? "").trim(), event_name: event };
      if (sponsor.t) claims.sponsorship_type = sponsor.t;
      if (sponsor.p && PERSON.test(sponsor.p.trim())) claims.contact = sponsor.p;
      if (sponsor.m && EMAIL.test(sponsor.m.trim())) claims.email = sponsor.m;
      const { fields } = groundedFields(claims, haystack);
      const name = fields.company_name;
      if (!name || !fields.event_name) {
        dropped += 1;
        continue;
      }
      const key = companyKey(name);
      if (!key || name.length > 80 || NOT_A_SPONSOR.test(name) || NOT_A_COMPANY.test(name) || key === hostLabel) continue;
      if (isOrganizer(name, fields.event_name) || (fields.sponsorship_type && NON_SPONSOR_TIER.test(fields.sponsorship_type))) continue;
      if (fields.contact && companyKey(fields.contact) === key) delete fields.contact;

      let candidate = companies.get(key);
      if (!candidate) {
        candidate = { name, mentions: [] };
        companies.set(key, candidate);
        onNew(key);
      }
      if (!candidate.mentions.some((mention) => mention.doc.id === doc.id)) {
        candidate.mentions.push({ doc, fields });
        accepted += 1;
      }
    }
  }
  return { accepted, dropped };
}

// --- contact enrichment (deterministic) ------------------------------------

export interface ContactFinding {
  url: string;
  title: string;
  publishedAt: string;
  text: string;
  fields: Record<string, string>;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const EMAIL_JUNK =
  /^(no-?reply|do-?not-?reply|privacy|legal|abuse|security|disclosure|vulnerab\w*|bugs?|bugbounty|dpo|gdpr|unsubscribe|postmaster|webmaster|hostmaster|email|your\w*|someone|you|me|careers?|jobs?|recruit\w*|hr|talent|billing|accounts?|invoices?|payroll|refunds?|dmca|copyright|compliance|usersafety|safety|trust|ir|investors?|investor-?relations|analystrelations|taxforms?|[\w-]+-ir)$/i;
// Documentation placeholders: first.last@, jdoe@, john@, lfirst@, jane.d@ …
const PLACEHOLDER_EMAIL =
  /(^|[._-])(first|last|middle|firstname|lastname|firstlast|lastfirst|fname|lname|fl|jd|john|jane|doe|jdoe|johndoe|janedoe|jsmith|flast|lfirst|firstl|djohn|name|surname|yourname|username|user|example|test)([._-]|$)|^[a-z](first|last|doe|john|jane)$|^(first|last|john|jane|doe)[a-z]?$|^[a-z]{0,7}last$/i;
const JUNK_EMAIL_FRAGMENT = /legal|arbitrat|arbdemand|subpoena|tax|informe|rendimento|redimento|fraud|phish|abuse|dmca|privacy|gdpr/i;
const NOT_A_CONTACT_PAGE = /privacy|terms|legal|policy|cookie|gdpr|ccpa|disclosure/i;
const EMAIL_RANK: RegExp[] = [
  /partner|sponsor|allianc|bd|business|biz|devrel|developer|community|event|marketing|outreach|collab|brand/i,
  /hello|contact|info|enquir|inquir|connect|team|hi$|hey$/i,
  /sales|media|press|pr$|news/i,
  /^[a-z]+[._][a-z]+$/i,
];
const PHONE_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}/g;
const PHONE_LABEL = /(phone|tel|call|mobile|contact|whatsapp|toll[\s-]?free|helpline|reach us|☎|📞)[^\n]{0,40}$/i;

function emailRank(email: string): number {
  const local = email.split("@")[0] ?? "";
  const index = EMAIL_RANK.findIndex((pattern) => pattern.test(local));
  return index < 0 ? EMAIL_RANK.length : index;
}

function findEmails(text: string, name: string, officialHost: string | null): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const email = match[0].replace(/\.+$/, "");
    const [local, domain] = email.split("@") as [string, string];
    // Also placeholders: any "…doe…" (jmichaeldoe@), bare initials (lf@), scraped fragments (_nolan@).
    const placeholder = PLACEHOLDER_EMAIL.test(local) || /doe/i.test(local) || (local.length <= 2 && local !== "hi") || /^[^a-z0-9]/i.test(local);
    if (EMAIL_JUNK.test(local) || placeholder || JUNK_EMAIL_FRAGMENT.test(local) || /accommodation/i.test(local) || /\.(png|jpe?g|gif|svg|webp)$/i.test(domain) || /example|sentry|wixpress|domain\.com/i.test(domain)) continue;
    const ownsDomain = isOwnDomain(domain, name) || (officialHost !== null && registrableDomain(domain) === registrableDomain(officialHost));
    if (ownsDomain) found.add(email);
  }
  return [...found].sort((a, b) => emailRank(a) - emailRank(b));
}

/** "benjamin.gorelick@…" → "Benjamin Gorelick", but only when the page itself writes that name out. */
function personForEmail(email: string, text: string): string | null {
  const parts = (email.split("@")[0] ?? "").split(/[._-]/);
  if (parts.length !== 2 || parts.some((part) => !/^[a-z]{2,}$/i.test(part))) return null;
  const match = new RegExp(`\\b${parts[0]}\\s+${parts[1]}\\b`, "i").exec(text);
  return match ? match[0] : null;
}

function findPhone(text: string): string | null {
  for (const match of text.matchAll(PHONE_PATTERN)) {
    const phone = match[0].trim();
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13 || /^(\d)\1+$/.test(digits)) continue;
    // Placeholder numbers: 123-4567 sequences, US 555-01xx, UK drama range 020 7946 0xxx.
    if (/1234567|55501\d\d|79460\d{3}$/.test(digits)) continue;
    if (phone.split(/[\s.-]+/).every((group) => /^(19|20)\d{2}$/.test(group))) continue;
    const before = text.slice(Math.max(0, (match.index ?? 0) - 45), match.index ?? 0);
    const wider = text.slice(Math.max(0, (match.index ?? 0) - 160), match.index ?? 0);
    if (/consumer|attorney|department of|california|complaint|regulator/i.test(wider)) continue;
    if (PHONE_LABEL.test(before)) return phone;
  }
  return null;
}

// Cached per company: the raw search results, trimmed to the text around email/phone patterns. Caching the
// evidence rather than the conclusions means improving the matching never needs fresh Tavily credits.
type CachedLookup = { at: number; results: TavilyResult[] };
let contactCache: Map<string, CachedLookup> | null = null;
const contactCacheFile = path.join(env.cacheDir, "sponsor-contact-pages.json");

function loadContactCache() {
  if (contactCache) return contactCache;
  contactCache = new Map();
  try {
    if (existsSync(contactCacheFile)) {
      const raw = JSON.parse(readFileSync(contactCacheFile, "utf8")) as Record<string, CachedLookup>;
      for (const [key, value] of Object.entries(raw)) {
        if (Date.now() - value.at < CONTACT_CACHE_TTL_MS) contactCache.set(key, value);
      }
    }
  } catch {
    // a corrupt cache is just an empty cache
  }
  return contactCache;
}

function saveContactCache() {
  if (!contactCache) return;
  try {
    mkdirSync(path.dirname(contactCacheFile), { recursive: true });
    writeFileSync(contactCacheFile, JSON.stringify(Object.fromEntries(contactCache)));
  } catch (error) {
    log("could not write contact cache:", errorMessage(error));
  }
}

/** Keeps only the literal text around email- and phone-shaped strings — all that contact matching ever reads. */
function contactText(text: string): string {
  const spans: Array<[number, number]> = [];
  for (const pattern of [EMAIL_PATTERN, PHONE_PATTERN]) {
    let count = 0;
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      spans.push([Math.max(0, at - 240), Math.min(text.length, at + match[0].length + 240)]);
      if ((count += 1) >= 40) break;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged.map(([start, end]) => text.slice(start, end)).join("\n…\n");
}

async function contactPages(name: string, signal?: AbortSignal): Promise<TavilyResult[]> {
  const cache = loadContactCache();
  const key = companyKey(name);
  const cached = cache.get(key);
  if (cached) return cached.results;
  const results = await tavilySearch({
    query: `${name} partnerships sponsorship events contact email`,
    depth: "basic",
    maxResults: 6,
    rawContent: true,
  }, signal);
  const trimmed = results.map((result) => ({
    title: result.title,
    url: result.url,
    content: result.content,
    raw_content: contactText(result.raw_content || result.content || ""),
    published_date: result.published_date,
  }));
  cache.set(key, { at: Date.now(), results: trimmed });
  return trimmed;
}

export async function findContact(name: string, signal?: AbortSignal): Promise<ContactFinding[]> {
  const results = await contactPages(name, signal);
  const official = results.find((result) => isOwnDomain(domainOf(result.url), name));
  const officialHost = official ? domainOf(official.url) : null;
  const findings: ContactFinding[] = [];
  const claimed = new Set<string>();

  const pages = [...results].sort((a, b) => Number(isOwnDomain(domainOf(b.url), name)) - Number(isOwnDomain(domainOf(a.url), name)));
  for (const page of pages) {
    const text = page.raw_content || page.content || "";
    const own = isOwnDomain(domainOf(page.url), name);
    const fields: Record<string, string> = {};
    if (!claimed.has("email")) {
      const email = findEmails(text, name, officialHost)[0];
      if (email) {
        fields.email = email;
        const person = personForEmail(email, text);
        if (person) fields.contact = person;
      }
    }
    if (own && !claimed.has("phone") && !NOT_A_CONTACT_PAGE.test(page.url)) {
      const phone = findPhone(text);
      if (phone) fields.phone = phone;
    }
    if (own && !claimed.has("website")) {
      fields.website = `https://${registrableDomain(domainOf(page.url))}`;
    }
    if (Object.keys(fields).length === 0) continue;
    for (const field of Object.keys(fields)) claimed.add(field);
    const values = [fields.email, fields.phone, fields.contact].filter(Boolean) as string[];
    findings.push({
      url: page.url,
      title: page.title,
      publishedAt: page.published_date ? normalizeDate(page.published_date) : "",
      text: values.length > 0 ? excerptAround(text, values, 200) : page.content.slice(0, 400),
      fields,
    });
    if (claimed.has("email") && claimed.has("phone") && claimed.has("website")) break;
  }
  return findings;
}

/**
 * For companies whose own site is known but whose search pages had no email, reads their /contact pages
 * in a few batched /extract calls (~0.2 credits per URL) and pattern-matches those instead.
 */
async function contactPageFallback(candidates: SponsorCandidate[], contacts: ContactFinding[][], deadline: number) {
  const targets: Array<{ index: number; site: string; urls: string[] }> = [];
  candidates.forEach((candidate, index) => {
    const found = contacts[index] ?? [];
    const site = found.find((finding) => finding.fields.website)?.fields.website;
    if (!site || found.some((finding) => finding.fields.email) || !candidate.name) return;
    targets.push({ index, site, urls: [`${site}/contact`, `${site}/contact-us`] });
  });
  if (targets.length === 0 || Date.now() > deadline - 8_000) return 0;

  const urls = targets.flatMap((target) => target.urls);
  const chunks: string[][] = [];
  for (let at = 0; at < urls.length; at += 20) chunks.push(urls.slice(at, at + 20));
  const pages = new Map<string, string>();
  for (const extracted of await Promise.all(chunks.map((chunk) => tavilyExtract(chunk)))) {
    for (const [url, text] of extracted) pages.set(urlKey(url), text);
  }

  let filled = 0;
  for (const target of targets) {
    const name = (candidates[target.index] as SponsorCandidate).name;
    const found = contacts[target.index] as ContactFinding[];
    const hasPhone = found.some((finding) => finding.fields.phone);
    for (const url of target.urls) {
      const text = pages.get(urlKey(url));
      if (!text) continue;
      const fields: Record<string, string> = {};
      const email = findEmails(text, name, domainOf(target.site))[0];
      if (email) {
        fields.email = email;
        const person = personForEmail(email, text);
        if (person) fields.contact = person;
      }
      const phone = hasPhone ? null : findPhone(text);
      if (phone) fields.phone = phone;
      if (Object.keys(fields).length === 0) continue;
      found.push({
        url,
        title: `${name} — contact`,
        publishedAt: "",
        text: excerptAround(text, Object.values(fields), 200),
        fields,
      });
      if (email) filled += 1;
      break;
    }
  }
  return filled;
}

// --- assembly ----------------------------------------------------------------

function buildSponsorRecord(candidate: SponsorCandidate, contacts: ContactFinding[], collectedAt: string): CollectedRecord | null {
  const richness = (mention: Mention) => Object.keys(mention.fields).length;
  const mentions = [...candidate.mentions].sort((a, b) => richness(b) - richness(a));
  const primary = mentions[0];
  if (!primary) return null;

  const fields: Record<string, string> = {};
  const sources: ProvenanceSource[] = [];
  const add = (grounded: { fields: Record<string, string>; source: ProvenanceSource } | null) => {
    if (!grounded) return;
    for (const [key, value] of Object.entries(grounded.fields)) if (!fields[key]) fields[key] = value;
    sources.push(grounded.source);
  };

  const pageSource = (mention: Mention, claims: Record<string, string>) =>
    provenance({
      url: mention.doc.url,
      title: mention.doc.title,
      text: mention.doc.fed,
      publishedAt: mention.doc.publishedAt,
      sourceType: "event_page",
      extractionMethod: "tavily+llm-batch",
      entity: candidate.name,
      claims,
    });

  add(
    pageSource(primary, {
      ...primary.fields,
      company_name: candidate.name,
      source_url: primary.doc.url,
      last_verified: primary.doc.publishedAt || collectedAt.slice(0, 10),
    }),
  );
  for (const mention of mentions.slice(1, 4)) {
    const claims: Record<string, string> = { company_name: candidate.name };
    if (!fields.contact && mention.fields.contact) claims.contact = mention.fields.contact;
    if (!fields.email && mention.fields.email) claims.email = mention.fields.email;
    add(pageSource(mention, claims));
  }
  for (const contact of contacts) {
    const claims: Record<string, string> = {};
    for (const [key, value] of Object.entries(contact.fields)) if (!fields[key]) claims[key] = value;
    if (Object.keys(claims).length === 0) continue;
    add(
      provenance({
        url: contact.url,
        title: contact.title,
        text: contact.text,
        publishedAt: contact.publishedAt,
        sourceType: "company_page",
        extractionMethod: "tavily+pattern",
        entity: candidate.name,
        claims,
      }),
    );
  }

  if (!fields.company_name || !fields.event_name) return null;
  return { canonicalEntityId: slug(fields.company_name), fields, sources };
}

async function collectSponsors(blueprint: CollectionBlueprint, collectedAt: string): Promise<CollectedRecord[]> {
  const started = Date.now();
  const deadline = started + SPONSOR_DEADLINE_MS;
  const lanes = llmLanes();

  const docs = await gatherSponsorPages(blueprint);
  if (docs.length === 0) {
    throw new PipelineError("NO_RESULTS", "Dig couldn't find any event pages that list sponsors for this question. Try a broader or differently worded question.");
  }
  const queue = packBatches(docs);
  log(`${queue.length} extraction batches over ${lanes.length} lanes (${lanes.map((lane) => lane.model).join(", ")}) after ${elapsed(started)}`);

  const companies = new Map<string, SponsorCandidate>();
  const enrichLimit = limiter(ENRICH_CONCURRENCY);
  let enrichStarted = 0;
  const onNew = (key: string) => {
    const candidate = companies.get(key);
    if (!candidate) return;
    // A company looked up in the last week is free (cached), so it never counts against the credit limit.
    const cached = loadContactCache().has(key);
    if (!cached && enrichStarted >= MAX_ENRICH) return;
    if (!cached) enrichStarted += 1;
    candidate.contact = enrichLimit(async () => {
      if (Date.now() > deadline - 5_000) return [];
      try {
        return await findContact(candidate.name);
      } catch (error) {
        log(`contact lookup failed for "${candidate.name}", skipping:`, errorMessage(error));
        return [];
      }
    });
  };

  // Each lane pulls the next batch; a batch that fails on one lane (rate limit, bad JSON) goes back on the
  // queue once for whichever lane frees up first. A worker idles while others are in flight, since those
  // may still hand work back.
  const pending = queue.map((batch, index) => ({ batch, label: `batch ${index + 1}`, tries: 0 }));
  let inFlight = 0;
  await Promise.all(
    lanes.map(async (lane) => {
      while (pending.length > 0 || inFlight > 0) {
        if (Date.now() > deadline - 10_000) break;
        const job = lane.blockedUntil - Date.now() > 3_000 ? undefined : pending.shift();
        if (!job) {
          await sleep(250);
          continue;
        }
        inFlight += 1;
        job.tries += 1;
        const catalog = job.batch.map((doc) => `[${doc.id}] ${doc.title}\nURL: ${doc.url}\n${doc.fed}`).join("\n\n");
        const parsed = await chatJson<SponsorBatchResponse>(lane, {
          system: SPONSOR_SYSTEM_PROMPT,
          user: `Request: "${blueprint.query}"\n\nSources:\n\n${catalog}`,
          maxTokens: 6000,
          deadline: deadline - 10_000,
          label: job.label,
          handBack: lanes.length > 1,
        });
        inFlight -= 1;
        if (!parsed && job.tries < 2) {
          pending.push(job);
          continue;
        }
        const { accepted, dropped } = acceptSponsors(job.batch, parsed, companies, onNew);
        log(`${job.label} (${lane.model}, ${job.batch.length} pages): +${accepted} sponsor mentions, ${dropped} ungrounded dropped, ${companies.size} companies so far, ${elapsed(started)}`);
      }
    }),
  );

  const candidates = [...companies.values()];
  const contacts = await Promise.all(candidates.map((candidate) => candidate.contact ?? Promise.resolve([])));
  saveContactCache();
  const filled = await contactPageFallback(candidates, contacts, deadline);
  log(`contact pages added ${filled} more emails, ${elapsed(started)}`);

  const records: CollectedRecord[] = [];
  const seen = new Set<string>();
  candidates.forEach((candidate, index) => {
    const record = buildSponsorRecord(candidate, contacts[index] ?? [], collectedAt);
    if (!record || seen.has(record.canonicalEntityId)) return;
    seen.add(record.canonicalEntityId);
    records.push(record);
  });
  records.sort((a, b) => b.sources.length - a.sources.length);

  const count = (field: string) => records.filter((record) => record.fields[field]).length;
  log(
    `done in ${elapsed(started)}: ${records.length} sponsors — email ${count("email")}, phone ${count("phone")}, ` +
      `contact ${count("contact")}, website ${count("website")}, tier ${count("sponsorship_type")}`,
  );
  if (records.length === 0) {
    throw new PipelineError("NO_RESULTS", "Dig found sponsor pages but couldn't quote any sponsor from them. Try a broader or differently worded question.");
  }
  return records;
}

// ---------------------------------------------------------------------------

export function limiter(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(started: number) {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function log(...parts: unknown[]) {
  console.log("[collect-live]", ...parts);
}

export async function collectLive(blueprint: CollectionBlueprint, collectedAt: string): Promise<CollectedRecord[]> {
  if (!env.tavilyKey) {
    throw new PipelineError("SOURCE_UNAVAILABLE", "Live collection needs TAVILY_API_KEY set in .env.");
  }
  if (blueprint.intent === "SPONSOR_LOOKUP") {
    return collectSponsors(blueprint, collectedAt);
  }
  return collectIntent(blueprint, collectedAt);
}
