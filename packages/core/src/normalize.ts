const SUFFIX =
  /\s+(private limited|pvt\.?\s*ltd\.?|limited|ltd\.?|incorporated|inc\.?|corporation|corp\.?|l\.?l\.?c\.?|llp)\.?$/i;

export function collapseSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function canonicalCompanyName(input: string): string {
  let current = collapseSpace(input).replace(/,/g, "");
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(SUFFIX, "").trim();
  }
  return current;
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProto);
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    const path = url.pathname.replace(/\/$/, "");
    return `${url.protocol}//${url.hostname}${path}${url.search}`;
  } catch {
    return trimmed;
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return trimmed;
  return new Date(parsed).toISOString().slice(0, 10);
}

// Phones keep their written formatting so the value stays a literal substring of its source.
export function normalizePhone(value: string): string {
  return collapseSpace(value);
}

const COMPANY_FIELDS = new Set(["company_name", "vendor", "organization", "organizer"]);
const URL_FIELDS = new Set(["website", "source_url", "pdf_url"]);
const EMAIL_FIELDS = new Set(["email"]);
const DATE_FIELDS = new Set(["last_verified", "start_date", "deadline", "published_at"]);

export function normalizeFields(fields: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(fields)) {
    const value = raw ?? "";
    if (COMPANY_FIELDS.has(key)) next[key] = canonicalCompanyName(value);
    else if (URL_FIELDS.has(key)) next[key] = normalizeUrl(value);
    else if (EMAIL_FIELDS.has(key)) next[key] = normalizeEmail(value);
    else if (DATE_FIELDS.has(key)) next[key] = normalizeDate(value);
    else if (key === "phone") next[key] = normalizePhone(value);
    else next[key] = collapseSpace(value);
  }
  return next;
}

export function identityKey(fields: Record<string, string>, identityFields: string[]): string {
  return identityFields
    .map((field) => (fields[field] ?? "").toLowerCase())
    .join("|");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(current + 1, (row[j - 1] ?? 0) + 1, previous + cost);
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

export function similarity(a: string, b: string): number {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

// Words that describe the kind of event rather than the sponsorship itself ("Hackathon Sponsor" = "Sponsor").
const COMPARE_FILLER = new Set(["hackathon", "hackathons", "event", "events", "by"]);
// The same role written as a verb: "Sponsored by" = "Sponsor", "Partnered with" = "Partner".
const COMPARE_ROLE_VERBS: Record<string, string> = { sponsored: "sponsor", partnered: "partner", with: "" };

/**
 * The form two runs' values are COMPARED in — never stored or displayed. Case, punctuation, plurals and
 * event-kind filler words are presentation noise from extraction ("Co-Sponsors" vs "co-sponsor"), not a
 * change in what the source says, so they must not reach the diff as a disagreement.
 */
export function comparisonKey(field: string, value: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  if (field === "email") return normalizeEmail(raw);
  if (field === "website" || field === "source_url" || field === "pdf_url") return normalizeUrl(raw).toLowerCase();
  if (field === "phone") return raw.replace(/\D/g, "");
  if (field === "last_verified") return normalizeDate(raw);
  const words = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .map((word) => COMPARE_ROLE_VERBS[word] ?? word)
    .filter((word) => word && !COMPARE_FILLER.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return words.join(" ") || raw.toLowerCase();
}
