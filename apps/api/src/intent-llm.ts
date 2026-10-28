import { matchIntent, type ParsedEntities } from "@dig/core";
import { INTENT_IDS, type IntentId } from "@dig/schemas";
import { chatJson, llmLanes, log } from "./collect-live.js";

/*
  Natural-language intent parsing. One small Groq call reads the question, picks the intent and pulls out
  what the search is about (subject), where (location) and the category. If the call fails, times out or
  returns something unusable, the keyword matcher decides instead — a query is never blocked on the LLM.
*/

export interface ParsedQuery {
  intent: IntentId;
  confidence: number;
  method: "llm" | "keyword";
  entities: ParsedEntities;
}

const SYSTEM = `You route research questions for Dig, a tool that finds real, sourced records on the web.
Pick exactly one intent:
- SPONSOR_LOOKUP: companies that sponsor or partner with events/hackathons ("who sponsors hackathons in India", "sponsor search", "start a sponsor search").
- JUDGE_LOOKUP: people to judge, mentor or speak at an event, or academic researchers/professors to connect with ("AI researchers who could judge our hackathon", "researchers in NLP in Delhi", "professors in robotics", "speakers for tech summit").
- EVENT_LOOKUP: hackathons, tech events, conferences, or summits to participate in or attend ("find hackathons in delhi", "AI hackathons 2026", "upcoming hackathons with prize money", "web3 conferences in India").
- PAPER_LOOKUP: academic research papers, scientific studies, arXiv preprints, or conference proceedings ("research papers on diffusion models", "papers on LLM reasoning", "arxiv papers on quantum computing", "latest AI research papers").
- JOB_LOOKUP: open jobs, internships or roles to apply for ("frontend internships in Bangalore").
- LEAD_LOOKUP: companies to sell to or reach out to, with contacts ("D2C skincare brands in Mumbai to pitch our analytics tool").
- COMPETITOR_LOOKUP: competitors or alternatives to a product/company ("competitors of Notion").
- COMPANY_LOOKUP: profiles of companies in general, not for sales or competition ("SaaS companies in Pune").
- PRODUCT_LOOKUP, MARKET_LOOKUP, FUNDING_LOOKUP, VENDOR_LOOKUP: products in a category, market trends, grants/funding, suppliers.
Also extract, copying words from the question where possible:
- subject: what the search is about, short (e.g. "AI", "frontend developer", "diffusion models", "Notion", "D2C skincare brands", "hackathons"). null if none.
  For JUDGE_LOOKUP: the field of expertise ("AI", "cybersecurity", "NLP"), or the event if one is named.
  For EVENT_LOOKUP: the theme or kind of event ("AI", "web3", "hackathon", "fintech").
  For PAPER_LOOKUP: the research topic or subject ("diffusion models", "quantum algorithms", "LLM reasoning").
  For LEAD_LOOKUP: the kind of company to reach out to (the target customers, e.g. "D2C skincare brands", "hospitals", "startups") — NEVER the user's own product. If the target isn't described, use "companies".
  For COMPETITOR_LOOKUP: the product or company whose competitors are wanted.
- location: a city, region or country named in the question, else null.
- category: an industry or domain if named (e.g. "fintech", "AI"), else null.
Return JSON only: {"intent": "...", "confidence": 0-1, "subject": ..., "location": ..., "category": ...}`;

interface LlmAnswer {
  intent?: string;
  confidence?: number;
  subject?: string | null;
  location?: string | null;
  category?: string | null;
}

const cache = new Map<string, ParsedQuery>();

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && !/^(null|none|n\/a)$/i.test(text) ? text.slice(0, 80) : null;
}

export async function parseQuery(query: string): Promise<ParsedQuery> {
  const key = query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const keyword = matchIntent(query);
  const fallback: ParsedQuery = { intent: keyword.intent, confidence: keyword.confidence, method: "keyword", entities: {} };
  let answer: LlmAnswer | null = null;
  try {
    const lanes = llmLanes();
    // The small model answers in well under a second; fall back to the others if it is rate limited.
    const ordered = [...lanes].sort((a, b) => Number(/20b/.test(b.model)) - Number(/20b/.test(a.model)));
    for (const lane of ordered) {
      answer = await chatJson<LlmAnswer>(lane, {
        system: SYSTEM,
        user: `Question: ${query.slice(0, 600)}`,
        maxTokens: 700,
        deadline: Date.now() + 8_000,
        label: "intent",
        handBack: true,
      });
      if (answer) break;
    }
  } catch (error) {
    log("intent: LLM unavailable, using keywords:", error instanceof Error ? error.message : String(error));
  }

  const intent = answer?.intent?.trim().toUpperCase();
  if (!answer || !intent || !(INTENT_IDS as readonly string[]).includes(intent)) {
    if (answer) log("intent: unusable LLM answer, using keywords:", JSON.stringify(answer).slice(0, 200));
    return fallback;
  }
  const parsed: ParsedQuery = {
    intent: intent as IntentId,
    confidence: typeof answer.confidence === "number" ? Math.max(0, Math.min(1, answer.confidence)) : 0.8,
    method: "llm",
    entities: { subject: clean(answer.subject), location: clean(answer.location), category: clean(answer.category) },
  };
  if (cache.size > 500) cache.clear();
  cache.set(key, parsed);
  return parsed;
}
