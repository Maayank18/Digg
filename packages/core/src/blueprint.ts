import type { CollectionBlueprint, IntentId } from "@dig/schemas";
import { intentDefinition, matchIntent, type IntentMatch } from "./intents.js";

const PLACES: Array<[string, string]> = [
  ["delhi ncr", "Delhi NCR"],
  ["bengaluru", "Bengaluru"],
  ["bangalore", "Bangalore"],
  ["new delhi", "New Delhi"],
  ["hyderabad", "Hyderabad"],
  ["mumbai", "Mumbai"],
  ["chennai", "Chennai"],
  ["pune", "Pune"],
  ["delhi", "Delhi"],
  ["india", "India"],
  ["ncr", "NCR"],
];

export function extractLocation(query: string): string | null {
  const text = query.toLowerCase();
  const found = PLACES.find(([needle]) => text.includes(needle));
  return found ? found[1] : null;
}

export function extractCategory(query: string): string | null {
  const text = query.toLowerCase();
  if (text.includes("project management")) return "SaaS";
  if (text.includes("machine learning") || (/\bai\b/.test(text) && /\bml\b/.test(text))) return "AI/ML";
  if (text.includes("technology")) return "technology";
  if (text.includes("fintech")) return "fintech";
  if (/\bsaas\b/.test(text)) return "SaaS";
  if (text.includes("analytics")) return "analytics";
  if (/\bai\b/.test(text)) return "AI";
  if (text.includes("enterprise")) return "enterprise";
  return null;
}

/** "AI researchers" → "AI", "frontend internships" stays — drops words the name already says. */
function trimSubject(subject: string | undefined, noise: RegExp): string | undefined {
  const trimmed = subject?.replace(noise, " ").replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function titleCase(text: string): string {
  return text.replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
}

export function suggestJobName(blueprint: CollectionBlueprint): string {
  const location = blueprint.entities.location;
  const category = blueprint.entities.category;
  const subject = blueprint.entities.subject?.trim();
  const place = location ? ` — ${location}` : "";
  switch (blueprint.intent) {
    case "JUDGE_LOOKUP": {
      const field = trimSubject(subject, /\b(researchers?|experts?|people|persons?|judges?|mentors?|jury|members?|speakers?|professionals?|who|could|be)\b/gi);
      const isSpeaker = /\b(speakers?|keynotes?|talks?)\b/i.test(blueprint.query);
      const title = isSpeaker ? "Speakers & Mentors" : "Judges & Mentors";
      return `${field ? `${titleCase(field)} ` : ""}${title}${place}`;
    }
    case "SPONSOR_LOOKUP": {
      const kind = /hackathon/i.test(blueprint.query) ? "Hackathon" : "Event";
      if (!category) return `${kind} Sponsors${place}`;
      return `${category === "technology" ? "Technology" : category} ${kind} Sponsors${place}`;
    }
    case "JOB_LOOKUP": {
      const role = trimSubject(subject, /\b(jobs?|roles?|positions?|openings?|vacanc(y|ies))\b/gi);
      if (role && /\bintern(ship)?s?\b/i.test(role)) return `${titleCase(role)}${place}`;
      return `${role ? titleCase(role) : category ?? "Open"} Jobs${place}`;
    }
    case "COMPETITOR_LOOKUP":
      if (subject) return `${titleCase(subject)} Competitors`;
      return category === "SaaS" ? "SaaS Competitor Landscape" : `${category ?? "Market"} Competitor Landscape`;
    case "FUNDING_LOOKUP":
      return "Startup Funding Opportunities";
    case "VENDOR_LOOKUP":
      return /enterprise/i.test(blueprint.query) || category === "AI" ? "Enterprise AI Vendors" : `${category ?? "Enterprise"} Vendors`;
    case "LEAD_LOOKUP": {
      const target = trimSubject(subject, /\b(companies|leads?|prospects?)\b/gi);
      return `${target ? `${titleCase(target)} ` : "Sales "}Leads${place}`;
    }
    case "EVENT_LOOKUP": {
      const isHackathon = /\bhackathon/i.test(blueprint.query);
      const kind = isHackathon ? "Hackathons" : "Events & Conferences";
      const cleanSubject = trimSubject(subject, /\b(hackathons?|events?|conferences?|competitions?|gatherings?|meetups?)\b/gi);
      return `${cleanSubject ? `${titleCase(cleanSubject)} ` : ""}${kind}${place}`;
    }
    case "PAPER_LOOKUP": {
      const topic = subject || category || "Research";
      return `${titleCase(topic)} Research Papers`;
    }
    case "COMPANY_LOOKUP":
      return category === "SaaS" ? `SaaS Companies${place}` : `Companies${place}`;
    case "PRODUCT_LOOKUP":
      return /enterprise/i.test(blueprint.query) ? "Enterprise AI Products" : `${category ?? "Product"} Products`;
    case "MARKET_LOOKUP":
      return `${category ?? "Market"} Landscape${place}`;
    default:
      return "Collection";
  }
}

/** Entities parsed from the question by the LLM classifier; any of them may be missing. */
export interface ParsedEntities {
  subject?: string | null;
  location?: string | null;
  category?: string | null;
}

export function buildBlueprint(
  query: string,
  intentOverride?: IntentId,
  parsed?: ParsedEntities,
): {
  blueprint: CollectionBlueprint;
  match: IntentMatch;
} {
  const match = matchIntent(query);
  const intent = intentOverride ?? match.intent;
  const definition = intentDefinition(intent);
  const freshnessRequired = /\b(active|current|open|upcoming)\b/i.test(query);
  const blueprint: CollectionBlueprint = {
    intent,
    query,
    entities: {
      category: parsed?.category?.trim() || extractCategory(query),
      location: parsed?.location?.trim() || extractLocation(query),
      subject: parsed?.subject?.trim() || null,
    },
    fields: definition.fields,
    freshness: {
      required: freshnessRequired,
      maxAgeDays: freshnessRequired ? 90 : 365,
    },
    sources: definition.supportedSources,
    ranking: { strategy: definition.rankingStrategy },
  };
  return { blueprint, match: intentOverride ? { ...match, intent } : match };
}

export function withLocation(blueprint: CollectionBlueprint, location: string): CollectionBlueprint {
  return {
    ...blueprint,
    entities: { ...blueprint.entities, location },
    query: blueprint.query.replace(blueprint.entities.location ?? "______", location),
  };
}
