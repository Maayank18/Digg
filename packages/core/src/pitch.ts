import type { IntentId } from "@dig/schemas";

/** Who is writing, saved in the browser and sent with each request. */
export interface PitchSender {
  name: string;
  role: string;
  organization: string;
  /** One line: what you are asking for or offering ("title sponsor, ₹50k", "our analytics tool for D2C brands"). */
  ask: string;
}

/** The event the search is filed under, from the event page. */
export interface PitchEvent {
  name: string;
  date: string;
  description: string;
}

export interface PitchRequest {
  intent: IntentId;
  recipient: Record<string, string>;
  event: PitchEvent | null;
  sender: PitchSender;
}

const ASKS: Partial<Record<IntentId, string>> = {
  SPONSOR_LOOKUP: "Ask whether they would consider sponsoring or partnering with our event.",
  JUDGE_LOOKUP: "Invite them to judge, mentor or speak at our event, or connect about their research.",
  LEAD_LOOKUP: "Introduce what we offer and ask if a short call makes sense.",
  EVENT_LOOKUP: "Reach out to the organizers regarding participation, partnership, or sponsorship.",
  PAPER_LOOKUP: "Reach out to the authors regarding their research paper and potential collaboration.",
};

/** Search types where a first-contact email makes sense. Jobs and competitors get no pitch button. */
export function pitchSupported(intent: IntentId): boolean {
  return intent in ASKS;
}

const RECIPIENT_FIELDS: Array<[string, string]> = [
  ["person_name", "name"],
  ["authors", "authors / researchers"],
  ["paper_title", "research paper title"],
  ["venue", "publication venue"],
  ["contact", "contact person"],
  ["contact_role", "contact person's role"],
  ["company_name", "company"],
  ["organizer", "organizer / host"],
  ["affiliation", "affiliation"],
  ["category", "what the company does"],
  ["expertise", "expertise"],
  ["event_name", "an event they were listed at (their role there is unknown unless stated)"],
  ["dates", "dates of event"],
  ["prize_pool", "prize pool"],
  ["sponsorship_type", "how they took part"],
];

/** Only the facts Dig sourced, labelled, so the model cannot drift into invented praise. */
export function recipientFacts(fields: Record<string, string>): string[] {
  return RECIPIENT_FIELDS.filter(([key]) => fields[key]?.trim()).map(([key, label]) => `${label}: ${fields[key]!.trim()}`);
}

export const PITCH_SYSTEM =
  "You write a short first-contact email. Rules:\n" +
  "- Body 80 to 140 words, in 2 or 3 short paragraphs, then a sign-off with the sender's name, role and organization.\n" +
  "- Plain, polite, professional. No emojis, no exclamation marks, no hype words (innovative, cutting-edge, synergy, game-changing, thrilled, excited, passionate, leverage).\n" +
  "- Use ONLY the facts given. Never invent numbers, audience sizes, dates, past collaborations, or praise of their work.\n" +
  "- Mention at most one specific fact about the recipient, and only from their facts, to say why you are writing to them. Do not add to a fact: never state their role, track or topic at a past event unless a fact says it.\n" +
  "- One clear ask with a small next step: a reply or a 15-minute call.\n" +
  "- If a fact is missing, write around it. Never use placeholders like [Name] or [Date].\n" +
  "- Greet the contact person by first name if one is given, otherwise greet the team.\n" +
  "- Subject: under 8 words, specific, no clickbait.\n" +
  'Return JSON only: {"subject": "...", "body": "..."}';

export function pitchUserMessage(request: PitchRequest): string {
  const lines = [
    `Goal: ${ASKS[request.intent] ?? "Make a polite first contact."}`,
    "",
    "Recipient facts:",
    ...recipientFacts(request.recipient).map((fact) => `- ${fact}`),
  ];
  if (request.event?.name) {
    lines.push("", "Our event:", `- name: ${request.event.name}`);
    if (request.event.date.trim()) lines.push(`- date: ${request.event.date.trim()}`);
    if (request.event.description.trim()) lines.push(`- about: ${request.event.description.trim().slice(0, 600)}`);
  }
  const sender = request.sender;
  lines.push("", "Sender:");
  if (sender.name.trim()) lines.push(`- name: ${sender.name.trim()}`);
  if (sender.role.trim()) lines.push(`- role: ${sender.role.trim()}`);
  if (sender.organization.trim()) lines.push(`- organization: ${sender.organization.trim()}`);
  if (sender.ask.trim()) lines.push(`- what we are asking for or offering: ${sender.ask.trim()}`);
  return lines.join("\n");
}

const PLACEHOLDER = /\[[A-Z][^\]]{0,30}\]/;

/** A usable draft, or null: both parts present and no leftover placeholders. */
export function cleanPitch(raw: unknown): { subject: string; body: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const { subject, body } = raw as { subject?: unknown; body?: unknown };
  if (typeof subject !== "string" || typeof body !== "string") return null;
  const cleanSubject = subject.replace(/\s+/g, " ").trim();
  const cleanBody = body.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleanSubject || cleanBody.length < 40) return null;
  if (PLACEHOLDER.test(cleanSubject) || PLACEHOLDER.test(cleanBody)) return null;
  return { subject: cleanSubject, body: cleanBody };
}
