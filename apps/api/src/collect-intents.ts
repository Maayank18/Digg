import { PipelineError, domainOf, intentDefinition, normalizeDate, slug } from "@dig/core";
import type { CollectedRecord } from "@dig/core";
import type { CollectionBlueprint, IntentId } from "@dig/schemas";
import {
  chatJson,
  errorMessage,
  findContact,
  limiter,
  llmLanes,
  log,
  provenance,
  tavilySearch,
  type SearchPlan,
  type TavilyResult,
} from "./collect-live.js";
import { env } from "./env.js";

/*
  JOB_LOOKUP, LEAD_LOOKUP, COMPETITOR_LOOKUP and JUDGE_LOOKUP.

  1. Breadth: a handful of parallel Tavily searches per intent — the open web plus the public sources that
     matter for that intent (job boards, review sites, YouTube/Instagram, Google Scholar).
  2. The relevant chunks of every page are packed into a few batched LLM extraction calls, spread over the
     model lanes so no single rate limit stalls the run.
  3. Grounding: a field is kept only if its value appears word for word (ignoring case) on the page it cites.
     A record whose identity (company, role, person) isn't on the page is dropped.
  4. Leads only: each company's public email/phone is found on its own site, the same way sponsors are.
*/
const DEADLINE_MS = 110_000;
const BATCH_CHARS = 18_000;
const DOC_CHARS = 6_000;
const MAX_BATCHES = 8;

interface IntentSpec {
  searches: (topic: string, place: string, blueprint: CollectionBlueprint) => SearchPlan[];
  guidance: (topic: string) => string;
  /** Identity fields that must survive grounding for a record to count. */
  identity: string[];
  reject?: (fields: Record<string, string>, topic: string, url: string) => boolean;
}

const JOB_BOARDS = /^(wellfound|angel|angellist|instahyre|cutshort|naukri|indeed|glassdoor|linkedin|foundit|monster|iimjobs|hirist|internshala|y combinator|yc|work at a startup|shine|apna|unstop|jobs?)$/i;
const GENERIC_NAME = /^(the )?(company|startup|team|us|we|our client|confidential|stealth|various)$/i;

const LOW_SIGNAL_EXCLUDES = [
  "pinterest.com",
  "quora.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "scribd.com",
  "coursehero.com",
];

function cleanEventTopic(topic: string): string {
  return topic
    .replace(/\b(find|search|upcoming|active|live|top|best|hackathons?|events?|conferences?|competitions?|gatherings?|meetups?|in|at|for|the|of|on)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPaperTopic(topic: string): string {
  return topic
    .replace(/\b(find|search|recent|latest|top|best|research|papers?|studies?|preprints?|articles?|scientific|in|at|for|the|of|on|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanJudgeTopic(topic: string): string {
  return topic
    .replace(/\b(find|search|who|could|be|judges?|mentors?|speakers?|keynotes?|experts?|professionals?|for|our|hackathons?|conference|in|at)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SPECS: Partial<Record<IntentId, IntentSpec>> = {
  JOB_LOOKUP: {
    searches: (topic, place) => [
      { query: `${topic} jobs ${place}`.trim(), includeDomains: ["wellfound.com"], excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 8, depth: "advanced", chunks: true },
      { query: `${topic} ${place}`.trim(), includeDomains: ["ycombinator.com", "workatastartup.com"], excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 8, depth: "advanced", chunks: true },
      { query: `${topic} ${place} careers hiring apply`.trim(), includeDomains: ["boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com"], excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 8, depth: "advanced", chunks: true },
      { query: `${topic} jobs ${place}`.trim(), includeDomains: ["instahyre.com", "cutshort.io", "hirist.tech", "internshala.com"], excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 8, depth: "advanced", chunks: true },
      { query: `${topic} job openings ${place} apply now`.trim(), excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 8, depth: "advanced", chunks: true },
    ],
    guidance: (topic) =>
      `Each record is ONE open role at ONE hiring company, relevant to "${topic}". role_title: the job title exactly as written. ` +
      `company_name: the company that is hiring — never the job board or site (not Wellfound, Instahyre, Naukri, LinkedIn, Y Combinator). ` +
      `location: city/country as written. workplace: "Remote", "Hybrid" or "On-site" only if the text says so. ` +
      `Skip listings that don't name both the role and the hiring company.`,
    identity: ["company_name", "role_title"],
    reject: (fields) => JOB_BOARDS.test(fields.company_name ?? "") || GENERIC_NAME.test(fields.company_name ?? ""),
  },
  LEAD_LOOKUP: {
    searches: (topic, place) => [
      { query: `${topic} ${place} companies directory overview`.trim(), excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 10, depth: "advanced", chunks: true },
      { query: `top ${topic} ${place} startups companies`.trim(), excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 10, depth: "advanced", chunks: true },
      { query: `${topic} ${place}`.trim(), includeDomains: ["yourstory.com", "inc42.com", "tracxn.com", "entrackr.com", "startupindia.gov.in", "crunchbase.com", "producthunt.com"], excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 10, depth: "advanced", chunks: true },
    ],
    guidance: (topic) =>
      `Each record is ONE company, startup or organization that fits "${topic}". company_name: the company's name as written. ` +
      `category: a few words from the text saying what the company does or provides. website: only if its domain is written in the text. ` +
      `contact / email / phone: only if written in the text next to that company. Never include the publisher of the article or list itself.`,
    identity: ["company_name"],
    reject: (fields, _topic, url) => GENERIC_NAME.test(fields.company_name ?? "") || sameAsPublisher(fields.company_name, url),
  },
  COMPETITOR_LOOKUP: {
    searches: (topic) => [
      { query: `${topic} competitors alternatives`.trim(), excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 10, depth: "advanced", chunks: true },
      { query: `${topic} alternatives`.trim(), includeDomains: ["g2.com", "capterra.com", "alternativeto.net", "getapp.com", "softwareadvice.com", "trustradius.com", "producthunt.com"], excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 10, depth: "advanced", chunks: true },
      { query: `${topic} vs`.trim(), includeDomains: ["youtube.com"], maxResults: 8, depth: "advanced", chunks: true },
      { query: `${topic} alternative software tools`.trim(), excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 8, depth: "advanced", chunks: true },
    ],
    guidance: (topic) =>
      `Each record is ONE product or company that competes with, or is presented as an alternative to, "${topic}". ` +
      `company_name: the competitor's name as written (never "${topic}" itself). category: a few words from the text saying WHAT the product is (e.g. "note-taking app", "project management tool") — not a ranking label like "Best for teams" or "Alternative". ` +
      `pricing_signal: a literal pricing phrase if the text gives one for that competitor (e.g. "Free plan", "$10 per user/month"). ` +
      `website: only if its domain is written in the text.`,
    identity: ["company_name"],
    reject: (fields, topic) => sameName(fields.company_name, topic) || GENERIC_NAME.test(fields.company_name ?? ""),
  },
  JUDGE_LOOKUP: {
    searches: (topic, place) => {
      const clean = cleanJudgeTopic(topic) || topic;
      const loc = place ? ` ${place}` : "";
      return [
        { query: `${clean} hackathon judges mentors jury${loc}`.trim(), includeDomains: ["devpost.com", "devfolio.co", "unstop.com"], excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 10, depth: "advanced", chunks: true },
        { query: `${clean} keynote speakers conference tech summit${loc}`.trim(), includeDomains: ["sessionize.com", "papercall.io"], excludeDomains: LOW_SIGNAL_EXCLUDES, maxResults: 10, depth: "advanced", chunks: true },
        { query: `${clean} researcher professor${loc}`.trim(), includeDomains: ["scholar.google.com"], maxResults: 10, depth: "advanced", chunks: true },
        { query: `${clean} principal research scientist professor tech lead${loc}`.trim(), includeDomains: ["linkedin.com"], maxResults: 8, depth: "advanced", chunks: true },
      ];
    },
    guidance: (topic) =>
      `Each record is ONE real, named person who has judged, mentored or spoken at an event, or is a recognised expert/researcher in "${topic}". ` +
      `person_name: the full name exactly as written. affiliation: their company, university, lab or title as written. ` +
      `expertise: their field or research topic as written. event_name: the event they judged, mentored or spoke at, if named. ` +
      `email: only if written. Skip organisations, teams and anyone without a full name.`,
    identity: ["person_name"],
    reject: (fields) => !/\s/.test((fields.person_name ?? "").trim()) || /\b(team|committee|panel|judges|mentors|speakers)\b/i.test(fields.person_name ?? ""),
  },
  EVENT_LOOKUP: {
    searches: (topic, place) => {
      const clean = cleanEventTopic(topic);
      const theme = clean ? `${clean} ` : "";
      const loc = place ? ` ${place}` : "";
      const currentYear = new Date().getFullYear();
      const nextYear = currentYear + 1;
      return [
        {
          query: `${theme}hackathon${loc} ${currentYear} ${nextYear} registration devfolio unstop devpost`.trim(),
          includeDomains: ["devfolio.co", "unstop.com", "hackerearth.com", "devpost.com", "mlh.io", "dorahacks.io", "ethglobal.com"],
          excludeDomains: LOW_SIGNAL_EXCLUDES,
          maxResults: 10,
          depth: "advanced",
          chunks: true,
        },
        {
          query: `upcoming ${theme}hackathons${loc} prize pool cash awards registration "register"`.trim(),
          excludeDomains: LOW_SIGNAL_EXCLUDES,
          maxResults: 10,
          depth: "advanced",
          chunks: true,
        },
        {
          query: `${theme}hackathon tech events${loc} ${currentYear}`.trim(),
          includeDomains: ["lu.ma", "eventbrite.com", "meetup.com", "kaggle.com"],
          excludeDomains: LOW_SIGNAL_EXCLUDES,
          maxResults: 8,
          depth: "advanced",
          chunks: true,
        },
        {
          query: `top ${theme}hackathons${loc} ${currentYear} timeline dates mode online in-person`.trim(),
          excludeDomains: LOW_SIGNAL_EXCLUDES,
          maxResults: 8,
          depth: "advanced",
          chunks: true,
        },
      ];
    },
    guidance: (topic) =>
      `Each record is ONE real hackathon, tech conference or summit, relevant to "${topic}". ` +
      `event_name: the official title/name of the hackathon or event as written. ` +
      `organizer: the university, company, community, or host organizing it. ` +
      `dates: dates, duration or timing as written (e.g. "Oct 15 - 17, 2026", "36 Hours", "Nov 2026"). ` +
      `location: city/venue or "Online" / "Hybrid" / "In-person" as written. ` +
      `prize_pool: total prize money, cash awards, bounties, or grants if stated (e.g. "₹5,00,000", "$25,000", "Swag & Cash Prizes"). ` +
      `website: official registration link, application URL, or website if given. ` +
      `description: brief theme, tracks, or eligibility criteria. ` +
      `Skip generic platforms or aggregators like Devfolio or Unstop themselves; extract the actual hackathons hosted on them.`,
    identity: ["event_name"],
    reject: (fields) =>
      !fields.event_name ||
      /^(hackathon|hackathons|event|events|conference|meetup|devpost|devfolio|unstop|hackerearth|dorahacks)$/i.test(fields.event_name.trim()) ||
      GENERIC_NAME.test(fields.event_name.trim()),
  },
  PAPER_LOOKUP: {
    searches: (topic) => {
      const clean = cleanPaperTopic(topic) || topic;
      return [
        {
          query: `${clean} research paper arXiv abs pdf`.trim(),
          includeDomains: ["arxiv.org", "semanticscholar.org"],
          excludeDomains: LOW_SIGNAL_EXCLUDES,
          maxResults: 10,
          depth: "advanced",
          chunks: true,
        },
        {
          query: `${clean} conference proceedings NeurIPS ICML CVPR ICLR ACL ACM`.trim(),
          includeDomains: ["openreview.net", "aclanthology.org", "paperswithcode.com", "ieee.org", "dl.acm.org"],
          excludeDomains: LOW_SIGNAL_EXCLUDES,
          maxResults: 10,
          depth: "advanced",
          chunks: true,
        },
        {
          query: `${clean} research papers download pdf abstract authors`.trim(),
          excludeDomains: LOW_SIGNAL_EXCLUDES,
          maxResults: 10,
          depth: "advanced",
          chunks: true,
        },
        {
          query: `${clean} scientific publications methodology findings benchmark`.trim(),
          includeDomains: ["scholar.google.com", "nature.com", "sciencedirect.com", "springer.com", "pubmed.ncbi.nlm.nih.gov"],
          excludeDomains: LOW_SIGNAL_EXCLUDES,
          maxResults: 8,
          depth: "advanced",
          chunks: true,
        },
      ];
    },
    guidance: (topic) =>
      `Each record is ONE published academic or research paper, relevant to "${topic}". ` +
      `paper_title: the exact title of the paper as written. ` +
      `authors: primary authors or researchers as written (separated by commas). ` +
      `venue: conference, journal, or preprint repository (e.g. "arXiv", "NeurIPS", "CVPR", "ICLR", "IEEE", "Nature", "ACM"). ` +
      `year: year or date of publication (e.g. "2025", "2026"). ` +
      `topic: a brief 1-sentence summary of the paper's core topic, methodology or key findings. ` +
      `pdf_url: direct URL to the downloadable PDF or paper preprint page (e.g. https://arxiv.org/pdf/..., https://arxiv.org/abs/...). ` +
      `citations: citation count or signal if stated. ` +
      `website: official paper page, publisher URL, or DOI. ` +
      `Skip blog posts or general opinion articles that are not real academic/research papers.`,
    identity: ["paper_title"],
    reject: (fields) =>
      !fields.paper_title ||
      /^(research paper|papers|arxiv|abstract|introduction|pdf|download|index)$/i.test(fields.paper_title.trim()) ||
      fields.paper_title.length < 5,
  },
};

function sameName(a: string | undefined, b: string) {
  const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Boolean(a) && norm(a!) === norm(b);
}

function sameAsPublisher(name: string | undefined, url: string) {
  if (!name) return false;
  const host = domainOf(url).replace(/^www\./, "").split(".")[0] ?? "";
  return host.length > 2 && name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(host);
}

const LABEL_NOT_CATEGORY = /^(an? )?(alternative|alternatives|competitor|option|pick|choice|winner|top\b|best\b|#?\d)|\bbest for\b|\bour pick\b/i;

function ownWebsite(website: string, name: string, text: string): boolean {
  const host = website.replace(/^https?:\/\/(www\.)?/i, "").replace(/[/?#].*$/, "").toLowerCase();
  if (!host || !text.toLowerCase().includes(host)) return false;
  const label = host.split(".").slice(0, -1).join("").replace(/[^a-z0-9]/g, "");
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key.length >= 3 && (label.includes(key.slice(0, Math.max(3, Math.min(key.length, 8)))) || key.includes(label));
}

interface Doc {
  url: string;
  title: string;
  text: string;
  publishedAt: string;
}

function toDoc(result: TavilyResult): Doc {
  const text = (result.content || result.raw_content || "").replace(/\s+/g, " ").trim().slice(0, DOC_CHARS);
  return { url: result.url, title: result.title ?? "", text, publishedAt: result.published_date ? normalizeDate(result.published_date) : "" };
}

async function gather(plans: SearchPlan[]): Promise<Doc[]> {
  const settled = await Promise.allSettled(plans.map((plan) => tavilySearch(plan)));
  const docs: Doc[] = [];
  const seen = new Set<string>();
  let failures = 0;
  let firstError: unknown = null;
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      failures += 1;
      firstError ??= outcome.reason;
      log("search failed:", errorMessage(outcome.reason));
      continue;
    }
    for (const result of outcome.value) {
      const key = result.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (seen.has(key) || !(result.content || result.raw_content)) continue;
      seen.add(key);
      docs.push(toDoc(result));
    }
  }
  if (docs.length === 0 && failures === plans.length && firstError instanceof PipelineError) throw firstError;
  if (docs.length === 0) {
    throw new PipelineError(
      "SOURCE_UNAVAILABLE",
      failures === plans.length ? "Web search is unavailable right now (all searches failed). Try again in a minute." : "The web search found no pages for this question. Try wording it differently.",
      true,
    );
  }
  return docs;
}

function batches(docs: Doc[]): Array<Array<{ index: number; doc: Doc }>> {
  const out: Array<Array<{ index: number; doc: Doc }>> = [];
  let current: Array<{ index: number; doc: Doc }> = [];
  let size = 0;
  docs.forEach((doc, index) => {
    const cost = doc.text.length + doc.title.length + 80;
    if (current.length > 0 && size + cost > BATCH_CHARS) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push({ index, doc });
    size += cost;
  });
  if (current.length) out.push(current);
  return out.slice(0, MAX_BATCHES);
}

interface Extracted {
  source?: number;
  fields?: Record<string, unknown>;
}

const SYSTEM =
  "You extract structured records from web pages for a research tool whose rule is: nothing is shown unless it can be " +
  "pointed to on the page. Copy every value verbatim from the page text or title — never paraphrase, translate, " +
  "abbreviate, infer or complete a value. If a field is not written on the page, leave it out. If a page names no " +
  "suitable entity, extract nothing from it. Be exhaustive: list and comparison pages often name ten or more " +
  "qualifying entities — return a record for EVERY one of them on every page, not just the first few.";

export async function collectIntent(blueprint: CollectionBlueprint, collectedAt: string): Promise<CollectedRecord[]> {
  const spec = SPECS[blueprint.intent];
  if (!spec) throw new PipelineError("UNSUPPORTED", `${blueprint.intent} has no live collector.`);
  const started = Date.now();
  const deadline = started + DEADLINE_MS;
  const definition = intentDefinition(blueprint.intent);
  const topic = (blueprint.entities.subject || blueprint.entities.category || blueprint.query).trim();
  const place = blueprint.entities.location ?? "";

  const docs = await gather(spec.searches(topic, place, blueprint));
  const packed = batches(docs);
  log(`${blueprint.intent}: ${docs.length} pages in ${packed.length} batches after ${Date.now() - started}ms`);

  const lanes = llmLanes();
  const allowed = definition.fields.filter((field) => !["source_url", "last_verified"].includes(field));
  const system =
    SYSTEM +
    ` Return strict JSON: {"records":[{"source": <page number>, "fields": {<only these keys: ${allowed.join(", ")}>}}]}. ` +
    spec.guidance(topic);
  // Each batch starts on its own lane; if that model is rate limited it moves to the next one instead of
  // being dropped, so one busy model can't cost a run a quarter of its results.
  const extract = async (batch: Array<{ index: number; doc: Doc }>, index: number) => {
    const user =
      `Question: "${blueprint.query}"\n\n` + batch.map(({ index: n, doc }) => `[page ${n}] ${doc.title}\nURL: ${doc.url}\n${doc.text}`).join("\n\n");
    for (let attempt = 0; attempt < lanes.length * 2 && Date.now() < deadline; attempt += 1) {
      const lane = lanes[(index + attempt) % lanes.length]!;
      const parsed = await chatJson<{ records?: Extracted[] }>(lane, {
        system,
        user,
        maxTokens: 4000,
        deadline,
        label: `${blueprint.intent.toLowerCase()} batch ${index + 1}/${packed.length} on ${lane.model}`,
        handBack: true,
      });
      if (parsed) return parsed;
      if (attempt >= lanes.length - 1) await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    return null;
  };
  const results = await Promise.all(packed.map((batch, index) => extract(batch, index)));
  if (results.every((result) => result === null)) {
    throw new PipelineError("LLM_UNAVAILABLE", "The AI extraction step is rate limited or unavailable right now. Try again in a minute.", true);
  }

  const records: CollectedRecord[] = [];
  const dropped = { extracted: 0, noIdentity: 0, ungrounded: 0, rejected: 0 };
  for (const result of results) {
    for (const item of result?.records ?? []) {
      const doc = typeof item.source === "number" ? docs[item.source] : undefined;
      if (!doc || !item.fields || typeof item.fields !== "object") continue;
      dropped.extracted += 1;
      const claims: Record<string, string> = {};
      for (const [key, value] of Object.entries(item.fields)) {
        if (allowed.includes(key) && typeof value === "string" && value.trim()) claims[key] = value.trim();
      }
      // A website is only kept when its domain is written on the page AND belongs to the entity itself —
      // an article's own domain or a link aggregator is not the company's site.
      if (claims.website && blueprint.intent !== "EVENT_LOOKUP" && blueprint.intent !== "PAPER_LOOKUP" && !ownWebsite(claims.website, claims.company_name ?? "", doc.text)) {
        delete claims.website;
      }
      // "Best for teams", "Alternative", "Top pick" are article labels, not what the product is.
      if (claims.category && LABEL_NOT_CATEGORY.test(claims.category)) delete claims.category;
      delete claims.profile_url;
      if (spec.identity.some((field) => !claims[field])) {
        dropped.noIdentity += 1;
        continue;
      }
      claims.source_url = doc.url;
      claims.last_verified = doc.publishedAt || collectedAt.slice(0, 10);
      const entityLabel = claims.company_name || claims.event_name || claims.paper_title || claims.person_name;
      const grounded = provenance({
        url: doc.url,
        title: doc.title,
        text: doc.text,
        publishedAt: doc.publishedAt,
        sourceType: /scholar\.google/.test(doc.url) || /arxiv\.org/.test(doc.url) ? "scholar" : /youtube|instagram/.test(doc.url) ? "social" : "web_search",
        extractionMethod: "tavily+llm",
        claims,
        entity: entityLabel,
      });
      if (!grounded || spec.identity.some((field) => !grounded.fields[field])) {
        dropped.ungrounded += 1;
        if (dropped.ungrounded <= 3) log(`  ungrounded: ${spec.identity.map((field) => claims[field]).join(" / ")} (not on ${doc.url})`);
        continue;
      }
      if (spec.reject?.(grounded.fields, topic, doc.url)) {
        dropped.rejected += 1;
        continue;
      }
      // A Google Scholar result is the person's own profile page.
      if (blueprint.intent === "JUDGE_LOOKUP" && /scholar\.google\.[a-z.]+\/citations/.test(doc.url)) {
        grounded.fields.profile_url = doc.url;
      }
      if (blueprint.intent === "PAPER_LOOKUP") {
        if (!grounded.fields.pdf_url) {
          if (/arxiv\.org\/abs\//i.test(doc.url)) {
            grounded.fields.pdf_url = doc.url.replace("/abs/", "/pdf/") + ".pdf";
          } else if (/openreview\.net\/forum\?id=/i.test(doc.url)) {
            grounded.fields.pdf_url = doc.url.replace("/forum?", "/pdf?");
          } else if (/aclanthology\.org/i.test(doc.url) && !doc.url.endsWith(".pdf")) {
            grounded.fields.pdf_url = doc.url.replace(/\/?$/, ".pdf");
          } else if (/\.pdf$/i.test(doc.url)) {
            grounded.fields.pdf_url = doc.url;
          }
        }
        if (!grounded.fields.website) {
          grounded.fields.website = doc.url;
        }
      }
      if (blueprint.intent === "EVENT_LOOKUP" && !grounded.fields.website) {
        grounded.fields.website = doc.url;
      }
      const canonicalEntityId = slug(spec.identity.map((field) => grounded.fields[field]).join(" "));
      if (!canonicalEntityId) continue;
      records.push({ canonicalEntityId, fields: grounded.fields, sources: [grounded.source] });
    }
  }

  log(`${blueprint.intent}: extracted ${dropped.extracted}, kept ${records.length} (no identity ${dropped.noIdentity}, not on page ${dropped.ungrounded}, filtered ${dropped.rejected})`);
  if (blueprint.intent === "LEAD_LOOKUP" && records.length > 0) await addLeadContacts(records, deadline);
  log(`${blueprint.intent}: ${records.length} grounded records in ${Math.round((Date.now() - started) / 1000)}s`);
  if (records.length === 0) {
    throw new PipelineError(
      "NO_RESULTS",
      "Dig searched the web but couldn't find results it could quote from a source page. Try a broader or differently worded question.",
      false,
    );
  }
  return records;
}

const LEAD_CONTACT_LIMIT = Math.min(env.resultCap, 20);

/** Finds each lead's public email/phone/website on its own domain (one cached search per company). */
async function addLeadContacts(records: CollectedRecord[], deadline: number) {
  const byCompany = new Map<string, CollectedRecord[]>();
  for (const record of records) {
    const key = slug(record.fields.company_name ?? "");
    byCompany.set(key, [...(byCompany.get(key) ?? []), record]);
  }
  const companies = [...byCompany.values()].slice(0, LEAD_CONTACT_LIMIT);
  const limit = limiter(4);
  await Promise.all(
    companies.map((group) =>
      limit(async () => {
        if (Date.now() > deadline - 10_000) return;
        const name = group[0]!.fields.company_name!;
        try {
          for (const finding of await findContact(name)) {
            const grounded = provenance({
              url: finding.url,
              title: finding.title,
              text: finding.text,
              publishedAt: finding.publishedAt,
              sourceType: "company_page",
              extractionMethod: "contact_lookup",
              claims: finding.fields,
              entity: name,
            });
            if (!grounded) continue;
            const target = group[0]!;
            for (const [field, value] of Object.entries(grounded.fields)) {
              if (!target.fields[field]) target.fields[field] = value;
            }
            target.sources.push(grounded.source);
          }
        } catch (error) {
          log(`lead contact for ${name} failed:`, errorMessage(error));
        }
      }),
    ),
  );
}
