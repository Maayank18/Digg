import type { IntentId } from "@dig/schemas";
import type { CollectedRecord } from "../types.js";
import { domainOf } from "../util.js";
import { literalOnPage, type IdentityEntity } from "./identity.js";
import { entityOrganization } from "./links.js";

/** A page about one row's company or person, kept from enrichment searches. */
export interface PageNote {
  url: string;
  title: string;
  text: string;
}

export function describeFieldFor(intent: IntentId): string | null {
  if (intent === "LEAD_LOOKUP" || intent === "COMPETITOR_LOOKUP") return "category";
  if (intent === "JUDGE_LOOKUP") return "expertise";
  if (intent === "EVENT_LOOKUP") return "description";
  if (intent === "PAPER_LOOKUP") return "topic";
  return null;
}

/**
 * Pages that are about this exact row. A person's page must name them and, when their
 * organization is known, the organization too, so a namesake's page is never used.
 */
export function relevantNotes(entity: IdentityEntity, notes: PageNote[]): PageNote[] {
  const org = entityOrganization(entity);
  const person = entity.kind !== "company";
  return notes.filter((note) => {
    const text = `${note.title}\n${note.text}`;
    const named = Boolean(entity.name) && literalOnPage(entity.name, text);
    if (!person) return named;
    return named && (!org || literalOnPage(org, text));
  });
}

/** The title plus the text around the name: short enough to send many rows in one model call. */
export function noteSnippet(entity: IdentityEntity, note: PageNote, width = 320): PageNote {
  const text = note.text.replace(/\s+/g, " ").trim();
  const at = Math.max(0, text.toLowerCase().indexOf(entity.name.toLowerCase()));
  const start = Math.max(0, at - Math.floor(width / 3));
  return { url: note.url, title: note.title.trim(), text: text.slice(start, start + width) };
}

/**
 * Keep a model's phrase only when it is copied from one of the pages: a few words, not the
 * name or organization itself. The value comes back in the page's own spelling.
 */
export function acceptDescription(
  raw: unknown,
  entity: IdentityEntity,
  notes: PageNote[],
): { value: string; note: PageNote } | null {
  if (typeof raw !== "string") return null;
  const phrase = raw.trim().replace(/^["'“‘]+|["'”’.,;:]+$/g, "").trim();
  if (phrase.length < 2 || phrase.length > 60 || phrase.split(/\s+/).length > 6) return null;
  const lower = phrase.toLowerCase();
  if (lower === entity.name.toLowerCase() || lower === entity.company.toLowerCase()) return null;
  for (const note of notes) {
    const page = `${note.title}\n${note.text}`;
    const at = page.toLowerCase().indexOf(lower);
    if (at >= 0) return { value: page.slice(at, at + phrase.length), note };
  }
  return null;
}

/** Fill an empty field and cite the page it was copied from, so the evidence panel shows the real quote. */
export function applyDescription<T extends CollectedRecord>(record: T, field: string, value: string, note: PageNote): T {
  if (record.fields[field]?.trim()) return record;
  return {
    ...record,
    fields: { ...record.fields, [field]: value },
    sources: [
      ...record.sources,
      {
        url: note.url,
        title: note.title,
        domain: domainOf(note.url),
        publishedAt: "",
        sourceType: "profile_page",
        authority: "secondary",
        excerpt: `${note.title}\n${note.text}`,
        fieldNames: [field],
        extractionMethod: "tavily+llm-describe",
        demo: false,
      },
    ],
  };
}

export function describePrompt(field: string): string {
  const what =
    field === "expertise"
      ? "the person's field of expertise or work (for example \"machine learning\", \"AI safety research\", \"cloud infrastructure\")"
      : "what the company does or sells (for example \"skincare products\", \"note-taking app\", \"payments platform\")";
  return (
    `For each numbered item, read its page text and copy ONE short phrase (1 to 5 words) that says ${what}. ` +
    `Copy the words exactly as they appear in that item's text. Do not paraphrase, translate, combine or invent. ` +
    `Never return the name, the organization name, a location, or a bare job title like "CEO" or "Founder". ` +
    `If the text does not say it, use null. Return JSON only: {"items":[{"id":"1","value":"..."}]}`
  );
}
