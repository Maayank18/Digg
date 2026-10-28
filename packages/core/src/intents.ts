import type { IntentId } from "@dig/schemas";

export interface IntentDefinition {
  id: IntentId;
  description: string;
  primaryField: string;
  identityFields: string[];
  protectedFields: string[];
  requiredFields: string[];
  optionalFields: string[];
  fields: string[];
  supportedSources: string[];
  rankingStrategy: string;
  collectionStrategy: string;
  keywords: Array<{ phrase: string; weight: number }>;
}

const sponsorFields = [
  "company_name",
  "event_name",
  "sponsorship_type",
  "website",
  "contact",
  "email",
  "phone",
  "last_verified",
  "source_url",
];

export const INTENTS: Record<IntentId, IntentDefinition> = {
  SPONSOR_LOOKUP: {
    id: "SPONSOR_LOOKUP",
    description: "Organizations actively sponsoring events, with evidence of the sponsorship.",
    primaryField: "company_name",
    identityFields: ["company_name", "event_name"],
    protectedFields: ["contact", "email", "sponsorship_type"],
    requiredFields: ["company_name", "event_name", "source_url"],
    optionalFields: ["sponsorship_type", "website", "contact", "email", "phone", "last_verified"],
    fields: sponsorFields,
    supportedSources: ["search", "event_pages", "company_pages", "press_releases"],
    rankingStrategy: "activity",
    collectionStrategy: "event_and_company_pages",
    keywords: [
      { phrase: "sponsors", weight: 9 },
      { phrase: "sponsor", weight: 8 },
      { phrase: "sponsorship", weight: 8 },
      { phrase: "sponsoring", weight: 8 },
      { phrase: "event partner", weight: 6 },
      { phrase: "event partners", weight: 6 },
      { phrase: "partnerships", weight: 5 },
      { phrase: "hackathon sponsors", weight: 9 },
      { phrase: "hackathon sponsor", weight: 9 },
    ],
  },
  JOB_LOOKUP: {
    id: "JOB_LOOKUP",
    description: "Open roles at named employers, each tied to the job-board or careers page that lists it.",
    primaryField: "role_title",
    identityFields: ["company_name", "role_title"],
    protectedFields: ["location", "workplace"],
    requiredFields: ["company_name", "role_title", "source_url"],
    optionalFields: ["location", "workplace", "website", "last_verified"],
    fields: ["role_title", "company_name", "location", "workplace", "website", "last_verified", "source_url"],
    supportedSources: ["search", "job_boards", "careers_pages"],
    rankingStrategy: "activity",
    collectionStrategy: "job_boards",
    keywords: [
      { phrase: "job opening", weight: 8 },
      { phrase: "job openings", weight: 8 },
      { phrase: "hiring", weight: 6 },
      { phrase: "jobs", weight: 6 },
      { phrase: "job", weight: 5 },
      { phrase: "internship", weight: 6 },
      { phrase: "internships", weight: 6 },
      { phrase: "vacancies", weight: 6 },
      { phrase: "roles", weight: 3 },
    ],
  },

  LEAD_LOOKUP: {
    id: "LEAD_LOOKUP",
    description: "Named companies that fit a target profile, with a public contact point for outreach.",
    primaryField: "company_name",
    identityFields: ["company_name"],
    protectedFields: ["email", "phone"],
    requiredFields: ["company_name", "source_url"],
    optionalFields: ["category", "contact", "email", "phone", "website", "last_verified"],
    fields: ["company_name", "category", "contact", "email", "phone", "website", "last_verified", "source_url"],
    supportedSources: ["search", "directories", "company_pages"],
    rankingStrategy: "activity",
    collectionStrategy: "directories_then_contacts",
    keywords: [
      { phrase: "sales lead", weight: 8 },
      { phrase: "sales leads", weight: 8 },
      { phrase: "leads", weight: 6 },
      { phrase: "lead", weight: 4 },
      { phrase: "prospects", weight: 6 },
      { phrase: "clients", weight: 4 },
      { phrase: "customers", weight: 3 },
    ],
  },

  EVENT_LOOKUP: {
    id: "EVENT_LOOKUP",
    description: "Hackathons, tech conferences, and summits with dates, prize pool, place, and registration links.",
    primaryField: "event_name",
    identityFields: ["event_name"],
    protectedFields: ["dates", "location", "prize_pool"],
    requiredFields: ["event_name", "source_url"],
    optionalFields: ["organizer", "dates", "location", "prize_pool", "website", "description", "last_verified"],
    fields: ["event_name", "organizer", "dates", "location", "prize_pool", "website", "description", "last_verified", "source_url"],
    supportedSources: ["search", "event_pages", "devfolio", "unstop", "hackerearth", "luma"],
    rankingStrategy: "freshness",
    collectionStrategy: "event_pages",
    keywords: [
      { phrase: "hackathons", weight: 10 },
      { phrase: "hackathon", weight: 10 },
      { phrase: "hackfest", weight: 8 },
      { phrase: "datathon", weight: 8 },
      { phrase: "codeathon", weight: 8 },
      { phrase: "devfest", weight: 7 },
      { phrase: "events", weight: 6 },
      { phrase: "conferences", weight: 6 },
      { phrase: "conference", weight: 5 },
      { phrase: "tech summit", weight: 6 },
      { phrase: "summit", weight: 4 },
      { phrase: "meetup", weight: 5 },
      { phrase: "meetups", weight: 5 },
    ],
  },
  COMPANY_LOOKUP: {
    id: "COMPANY_LOOKUP",
    description: "Company profiles with headquarters, industry, and a canonical site.",
    primaryField: "company_name",
    identityFields: ["company_name"],
    protectedFields: ["headquarters", "industry"],
    requiredFields: ["company_name", "source_url"],
    optionalFields: ["industry", "headquarters", "website"],
    fields: ["company_name", "industry", "headquarters", "website", "source_url"],
    supportedSources: ["search", "company_pages"],
    rankingStrategy: "source_authority",
    collectionStrategy: "company_pages",
    keywords: [
      { phrase: "company profile", weight: 7 },
      { phrase: "companies", weight: 4 },
      { phrase: "headquarters", weight: 3 },
    ],
  },
  COMPETITOR_LOOKUP: {
    id: "COMPETITOR_LOOKUP",
    description: "Competing products or companies, each named by a public comparison, review or video source.",
    primaryField: "company_name",
    identityFields: ["company_name"],
    protectedFields: ["category", "pricing_signal"],
    requiredFields: ["company_name", "source_url"],
    optionalFields: ["category", "pricing_signal", "website", "last_verified"],
    fields: ["company_name", "category", "pricing_signal", "website", "last_verified", "source_url"],
    supportedSources: ["search", "review_sites", "youtube", "instagram"],
    rankingStrategy: "activity",
    collectionStrategy: "comparisons_and_social",
    keywords: [
      { phrase: "competitor", weight: 8 },
      { phrase: "competitors", weight: 8 },
      { phrase: "competition", weight: 6 },
      { phrase: "alternatives", weight: 7 },
      { phrase: "alternative to", weight: 7 },
      { phrase: "rivals", weight: 6 },
      { phrase: "landscape", weight: 3 },
    ],
  },

  PRODUCT_LOOKUP: {
    id: "PRODUCT_LOOKUP",
    description: "Products in a category, tied to a vendor and a public page.",
    primaryField: "product_name",
    identityFields: ["product_name", "vendor"],
    protectedFields: ["vendor", "category"],
    requiredFields: ["product_name", "source_url"],
    optionalFields: ["vendor", "category", "website"],
    fields: ["product_name", "vendor", "category", "website", "source_url"],
    supportedSources: ["search", "company_pages"],
    rankingStrategy: "source_authority",
    collectionStrategy: "product_pages",
    keywords: [
      { phrase: "products", weight: 6 },
      { phrase: "product", weight: 4 },
    ],
  },
  MARKET_LOOKUP: {
    id: "MARKET_LOOKUP",
    description: "Market signals for a segment and region, each tied to a source.",
    primaryField: "segment",
    identityFields: ["segment", "region"],
    protectedFields: ["signal"],
    requiredFields: ["segment", "source_url"],
    optionalFields: ["region", "signal", "last_verified"],
    fields: ["segment", "region", "signal", "last_verified", "source_url"],
    supportedSources: ["search", "press_releases", "rss"],
    rankingStrategy: "freshness",
    collectionStrategy: "public_sources",
    keywords: [
      { phrase: "market", weight: 6 },
      { phrase: "landscape", weight: 2 },
      { phrase: "industry trend", weight: 5 },
    ],
  },
  FUNDING_LOOKUP: {
    id: "FUNDING_LOOKUP",
    description: "Funding programs and grants with an amount signal and a deadline when published.",
    primaryField: "program_name",
    identityFields: ["program_name", "organization"],
    protectedFields: ["amount", "deadline"],
    requiredFields: ["program_name", "source_url"],
    optionalFields: ["organization", "amount", "deadline", "website"],
    fields: ["program_name", "organization", "amount", "deadline", "website", "source_url"],
    supportedSources: ["search", "company_pages", "press_releases"],
    rankingStrategy: "freshness",
    collectionStrategy: "program_pages",
    keywords: [
      { phrase: "funding", weight: 8 },
      { phrase: "grant", weight: 6 },
      { phrase: "investment", weight: 3 },
    ],
  },
  VENDOR_LOOKUP: {
    id: "VENDOR_LOOKUP",
    description: "Vendors that sell a capability, with a public site and contact where available.",
    primaryField: "company_name",
    identityFields: ["company_name", "capability"],
    protectedFields: ["capability", "contact"],
    requiredFields: ["company_name", "source_url"],
    optionalFields: ["capability", "website", "contact", "last_verified"],
    fields: ["company_name", "capability", "website", "contact", "last_verified", "source_url"],
    supportedSources: ["search", "company_pages", "press_releases"],
    rankingStrategy: "activity",
    collectionStrategy: "company_pages",
    keywords: [
      { phrase: "vendors", weight: 8 },
      { phrase: "vendor", weight: 6 },
      { phrase: "suppliers", weight: 5 },
    ],
  },
  JUDGE_LOOKUP: {
    id: "JUDGE_LOOKUP",
    description: "People who could judge or mentor at an event: named experts with an affiliation and a public profile.",
    primaryField: "person_name",
    identityFields: ["person_name"],
    protectedFields: ["affiliation", "email"],
    requiredFields: ["person_name", "source_url"],
    optionalFields: ["affiliation", "expertise", "event_name", "email", "profile_url", "last_verified"],
    fields: ["person_name", "affiliation", "expertise", "event_name", "email", "profile_url", "last_verified", "source_url"],
    supportedSources: ["search", "event_pages", "google_scholar"],
    rankingStrategy: "activity",
    collectionStrategy: "event_pages_and_scholar",
    keywords: [
      { phrase: "speakers", weight: 9 },
      { phrase: "speaker", weight: 8 },
      { phrase: "keynote speaker", weight: 9 },
      { phrase: "keynote speakers", weight: 9 },
      { phrase: "guest speaker", weight: 8 },
      { phrase: "guest speakers", weight: 8 },
      { phrase: "keynote", weight: 7 },
      { phrase: "keynotes", weight: 7 },
      { phrase: "judges", weight: 9 },
      { phrase: "judge", weight: 8 },
      { phrase: "jury", weight: 7 },
      { phrase: "mentors", weight: 8 },
      { phrase: "mentor", weight: 7 },
      { phrase: "panelists", weight: 6 },
      { phrase: "panelist", weight: 6 },
      { phrase: "experts", weight: 6 },
      { phrase: "expert", weight: 5 },
      { phrase: "researchers", weight: 8 },
      { phrase: "researcher", weight: 7 },
      { phrase: "professors", weight: 7 },
      { phrase: "professor", weight: 6 },
      { phrase: "scientists", weight: 7 },
      { phrase: "scientist", weight: 6 },
      { phrase: "scholars", weight: 7 },
      { phrase: "scholar", weight: 6 },
      { phrase: "evaluators", weight: 5 },
      { phrase: "evaluator", weight: 5 },
    ],
  },
  PAPER_LOOKUP: {
    id: "PAPER_LOOKUP",
    description: "Published research papers, preprints and academic studies with authors, venue, and downloadable links.",
    primaryField: "paper_title",
    identityFields: ["paper_title"],
    protectedFields: ["authors", "venue", "year"],
    requiredFields: ["paper_title", "source_url"],
    optionalFields: ["authors", "venue", "year", "topic", "pdf_url", "citations", "website", "last_verified"],
    fields: ["paper_title", "authors", "venue", "year", "topic", "pdf_url", "citations", "website", "last_verified", "source_url"],
    supportedSources: ["search", "arxiv", "scholar", "openreview", "paperswithcode"],
    rankingStrategy: "freshness",
    collectionStrategy: "paper_repositories",
    keywords: [
      { phrase: "research papers", weight: 10 },
      { phrase: "research paper", weight: 10 },
      { phrase: "papers", weight: 7 },
      { phrase: "paper", weight: 6 },
      { phrase: "arxiv", weight: 9 },
      { phrase: "preprints", weight: 8 },
      { phrase: "preprint", weight: 8 },
      { phrase: "academic papers", weight: 9 },
      { phrase: "academic paper", weight: 9 },
      { phrase: "scientific papers", weight: 9 },
      { phrase: "conference proceedings", weight: 8 },
      { phrase: "journal paper", weight: 8 },
      { phrase: "publications", weight: 6 },
      { phrase: "publication", weight: 5 },
      { phrase: "literature review", weight: 7 },
    ],
  },
};

export function intentDefinition(id: IntentId): IntentDefinition {
  return INTENTS[id];
}

export interface IntentMatch {
  intent: IntentId;
  confidence: number;
  method: "keyword";
  alternatives: Array<{ intent: IntentId; confidence: number }>;
}

export function matchIntent(query: string): IntentMatch {
  const text = query.toLowerCase();
  const scored = (Object.values(INTENTS) as IntentDefinition[]).map((intent) => {
    let score = 0;
    for (const keyword of intent.keywords) {
      const pattern = new RegExp(`\\b${keyword.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (pattern.test(text)) score += keyword.weight;
    }
    if (intent.id === "EVENT_LOOKUP" && /\b(sponsor|sponsors|sponsoring|judge|judges|mentor|mentors|speaker|speakers|keynote)\b/i.test(text)) score -= 6;
    if (intent.id === "SPONSOR_LOOKUP" && /\b(find hackathons?|upcoming hackathons?|hackathons in|hackathons with)\b/i.test(text) && !/\bsponsor/i.test(text)) score -= 8;
    if (intent.id === "JUDGE_LOOKUP" && /\b(paper|papers|arxiv|preprints?|proceedings|journal)\b/i.test(text)) score -= 8;
    if (intent.id === "MARKET_LOOKUP" && /\b(competitor|sponsor|judge|mentor|speaker|lead|job|hackathon|paper)\b/i.test(text)) score -= 4;
    if (intent.id === "PRODUCT_LOOKUP" && /\bvendor/.test(text)) score -= 3;
    return { intent: intent.id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0] ?? { intent: "MARKET_LOOKUP" as IntentId, score: 0 };
  const alternatives = scored
    .filter((item) => item.intent !== top.intent && item.score > 0)
    .slice(0, 3)
    .map((item) => ({ intent: item.intent, confidence: roundConfidence(item.score / (item.score + 6)) }));
  return {
    intent: top.score > 0 ? top.intent : "MARKET_LOOKUP",
    confidence: top.score > 0 ? roundConfidence(Math.min(0.97, 0.45 + top.score / 16)) : 0.32,
    method: "keyword",
    alternatives,
  };
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}
