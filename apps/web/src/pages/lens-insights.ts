import type { DatasetRecord, Diff } from "../api";

/**
 * Lens: a few insights per kind of list, each counted from the search's own rows and ending
 * in names you can act on. The page and the PDF both render this, so they always agree.
 */

export interface LensBar {
  label: string;
  count: number;
}

export interface LensSection {
  id: string;
  title: string;
  /** One plain sentence: what the numbers mean for you. */
  takeaway: string;
  bars?: LensBar[];
  /** Draw the bars as a pie: one per kind of list, on a section whose parts make a whole. */
  chart?: "pie";
  names?: Array<{ name: string; detail?: string }>;
}

export interface LensView {
  stats: Array<{ label: string; value: string }>;
  sections: LensSection[];
  sources: LensBar[];
  sourcesLine: string;
}

type Mark = { status: string; note?: string };

const OUTREACH_LABEL: Record<string, string> = {
  pending: "Not contacted",
  waiting: "Waiting",
  interested: "Interested",
  declined: "Declined",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INBOX = /^(info|hello|hi|contact|contactus|support|help|sales|team|admin|office|marketing|care|business|enquiries|enquiry|inquiries|press|media|partners|partnerships|sponsor|sponsors|community|events|careers|jobs|hr|woot)$/i;
const ACADEMIA = /universit|institute|\biit\b|\biiit\b|\bnit\b|college|school|academy|professor|\bprof\b|faculty|ph\.?\s?d|research cent(er|re)|\blab\b/i;

function emailOf(record: DatasetRecord): string {
  const value = (record.fields.email || record.contactability?.channels?.email?.value || "").trim();
  return EMAIL.test(value) ? value : "";
}

function nameOf(record: DatasetRecord): string {
  const f = record.fields;
  return f.paper_title || f.event_name || f.person_name || f.company_name || f.role_title || record.label || "Unnamed";
}

function clip(text: string, max = 42): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Counts of each value, biggest first; the long tail folds into "Other". */
function tally(values: string[], top = 6): LensBar[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const raw of values) {
    const label = clip(raw);
    if (!label) continue;
    const key = label.toLowerCase();
    const entry = counts.get(key) ?? { label: label.charAt(0).toUpperCase() + label.slice(1), count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const head = sorted.slice(0, top);
  const rest = sorted.slice(top).reduce((sum, item) => sum + item.count, 0);
  return rest > 0 ? [...head, { label: "Other", count: rest }] : head;
}

/**
 * Free-text columns ("what they do") are often unique per row, and a bar chart of 1s says nothing.
 * When no value repeats, list each row with its value instead.
 */
function barsOrNames(records: DatasetRecord[], field: string): Pick<LensSection, "bars" | "names"> & { repeats: boolean } {
  const bars = tally(records.map((record) => record.fields[field] ?? ""));
  const repeats = bars.some((bar) => bar.label !== "Other" && bar.count > 1);
  if (repeats) return { bars, repeats };
  return {
    repeats,
    names: records
      .filter((record) => record.fields[field]?.trim())
      .slice(0, 8)
      .map((record) => ({ name: nameOf(record), detail: clip(record.fields[field] ?? "", 52) })),
  };
}

/** Expertise is written many ways ("AI/ML", "Artificial Intelligence"); group it into broad topics. */
const TOPICS: Array<[string, RegExp]> = [
  ["AI and machine learning", /\bai\b|artificial intelligence|machine learning|\bml\b|deep learning|neural|llm|generative|nlp|computer vision|agi/i],
  ["Data and analytics", /\bdata\b|analytics|statistic|big data/i],
  ["Security", /secur|cyber|crypto(graphy)?\b|privacy/i],
  ["Cloud and infrastructure", /cloud|devops|infrastructure|distributed|kubernetes|platform engineering/i],
  ["Web and software", /web|full.?stack|front.?end|back.?end|software|developer|engineering/i],
  ["Blockchain and Web3", /blockchain|web3|crypto(currency)?|defi|ethereum/i],
  ["Speech, audio and signals", /speech|audio|signal/i],
  ["Robotics and hardware", /robot|hardware|embedded|iot|electronic/i],
  ["Health and biotech", /health|medic|bio/i],
  ["Product and business", /product|business|strategy|startup|founder|growth|marketing/i],
  ["Research and academia", /research|professor|scientist|academ/i],
];

function topicOf(value: string): string {
  return TOPICS.find(([, pattern]) => pattern.test(value))?.[0] ?? (value.trim() ? "Other" : "");
}

/** "Platinum Partners", "Cloud & Gold Sponsor" and "Co-Sponsors" into a few comparable tiers. */
function tierOf(value: string): string {
  const text = value.toLowerCase();
  if (!text.trim()) return "";
  if (/title|presenting|powered by|main sponsor/.test(text)) return "Title or presenting";
  if (/platinum|diamond/.test(text)) return "Platinum";
  if (/gold/.test(text)) return "Gold";
  if (/silver/.test(text)) return "Silver";
  if (/bronze/.test(text)) return "Bronze";
  if (/co.?sponsor/.test(text)) return "Co-sponsor";
  if (/partner/.test(text)) return "Partner";
  return "Sponsor, tier not stated";
}

/** "Bangalore Urban", "Bengaluru" and "Bangalore • Remote" are the same city. */
const CITY_ALIASES: Array<[RegExp, string]> = [
  [/bangalore|bengaluru/i, "Bengaluru"],
  [/gurgaon|gurugram/i, "Gurugram"],
  [/bombay|mumbai/i, "Mumbai"],
  [/new delhi|\bdelhi\b|ncr/i, "Delhi NCR"],
  [/noida/i, "Noida"],
  [/hyderabad/i, "Hyderabad"],
  [/pune/i, "Pune"],
  [/chennai|madras/i, "Chennai"],
];

function cityOf(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const alias = CITY_ALIASES.find(([pattern]) => pattern.test(text));
  if (alias) return alias[1];
  if (/^remote$/i.test(text)) return "Remote";
  return (text.split(/[•,|/]/)[0] ?? text).trim();
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function outreachOf(record: DatasetRecord, outreach: Record<string, Mark>): string {
  return outreach[record.canonicalEntityId]?.status ?? "pending";
}

function outreachSection(records: DatasetRecord[], outreach: Record<string, Mark>): LensSection {
  const counts = { interested: 0, waiting: 0, declined: 0, pending: 0 } as Record<string, number>;
  for (const record of records) counts[outreachOf(record, outreach)] = (counts[outreachOf(record, outreach)] ?? 0) + 1;
  const contacted = records.length - (counts.pending ?? 0);
  return {
    id: "outreach",
    title: "Outreach progress",
    takeaway: contacted === 0
      ? "No outreach yet. The table lists the most complete rows first, so start from the top."
      : `${contacted} of ${records.length} contacted: ${counts.interested ?? 0} interested, ${counts.waiting ?? 0} waiting on a reply, ${counts.declined ?? 0} declined.`,
    bars: ["interested", "waiting", "declined", "pending"].map((key) => ({ label: OUTREACH_LABEL[key] ?? key, count: counts[key] ?? 0 })),
  };
}

function changesSection(diff: Diff | null): LensSection | null {
  if (!diff || diff.firstVersion) return null;
  const added = diff.added.length;
  const changed = diff.changed.length;
  const removed = diff.removed.length;
  return {
    id: "changes",
    title: "Since the last run",
    takeaway: `${added} added, ${changed} changed, ${removed} no longer found. A row that is no longer found was not on the pages searched this time; it is not proof it is gone.`,
    names: [
      ...diff.added.slice(0, 4).map((item) => ({ name: item.label, detail: "added" })),
      ...diff.changed.slice(0, 3).map((item) => ({ name: item.label, detail: `changed: ${item.fields.map((f) => f.field.replace(/_/g, " ")).join(", ")}` })),
      ...diff.removed.slice(0, 3).map((item) => ({ name: item.label, detail: "no longer found" })),
    ],
  };
}

/** Named person vs. only a shared inbox like info@: named people reply far more often. */
function contactQualitySection(records: DatasetRecord[]): LensSection {
  let named = 0;
  let personal = 0;
  let inbox = 0;
  let none = 0;
  for (const record of records) {
    const email = emailOf(record);
    const local = email.split("@")[0] ?? "";
    if (record.fields.contact?.trim()) named += 1;
    else if (email && !INBOX.test(local)) personal += 1;
    else if (email) inbox += 1;
    else none += 1;
  }
  return {
    id: "contact-quality",
    title: "Who you would be writing to",
    takeaway: `${named + personal} have a named person or personal email; ${inbox} only a shared inbox like info@. Named people reply more often, so start there.`,
    bars: [
      { label: "Named contact", count: named },
      { label: "Personal email", count: personal },
      { label: "Shared inbox only", count: inbox },
      { label: "No email yet", count: none },
    ],
  };
}

function sponsorSections(records: DatasetRecord[], outreach: Record<string, Mark>): LensSection[] {
  const byCompany = new Map<string, { name: string; events: Set<string>; records: DatasetRecord[] }>();
  for (const record of records) {
    const name = record.fields.company_name?.trim();
    if (!name) continue;
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const entry = byCompany.get(key) ?? { name, events: new Set<string>(), records: [] };
    if (record.fields.event_name?.trim()) entry.events.add(record.fields.event_name.trim().toLowerCase());
    entry.records.push(record);
    byCompany.set(key, entry);
  }
  const repeats = [...byCompany.values()].filter((item) => item.events.size >= 2).sort((a, b) => b.events.size - a.events.size);
  const uncontacted = repeats.filter((item) => item.records.every((record) => outreachOf(record, outreach) === "pending"));
  const tiers = tally(records.map((record) => tierOf(record.fields.sponsorship_type ?? "")), 7);
  const sections: LensSection[] = [];
  if (repeats.length > 0) {
    sections.push({
      id: "repeat",
      title: "Repeat sponsors",
      takeaway: `${plural(repeats.length, "company", "companies")} sponsored 2 or more events here. They already back hackathons, so they are your warmest targets${uncontacted.length ? `; ${uncontacted.length} not contacted yet` : ""}.`,
      names: repeats.slice(0, 6).map((item) => ({
        name: item.name,
        detail: `${item.events.size} events · ${OUTREACH_LABEL[outreachOf(item.records[0]!, outreach)] ?? "Not contacted"}`,
      })),
    });
  }
  sections.push(
    {
      id: "tiers",
      title: "Sponsorship tiers",
      takeaway: tiers[0] ? `Most common: ${tiers[0].label.toLowerCase()} (${tiers[0].count}).` : "No sponsorship tier was written on the pages found.",
      bars: tiers,
      chart: "pie",
    },
    contactQualitySection(records),
  );
  return sections;
}

function judgeSections(records: DatasetRecord[]): LensSection[] {
  const expertise = tally(records.map((record) => topicOf(record.fields.expertise ?? "")), 7);
  let academia = 0;
  let industry = 0;
  let unknown = 0;
  for (const record of records) {
    const affiliation = record.fields.affiliation?.trim() ?? "";
    if (!affiliation) unknown += 1;
    else if (ACADEMIA.test(affiliation)) academia += 1;
    else industry += 1;
  }
  let confirmed = 0;
  let check = 0;
  let none = 0;
  for (const record of records) {
    if (emailOf(record) || record.fields.linkedin?.trim()) confirmed += 1;
    else if (record.contactability?.channels?.linkedin?.status === "NEEDS_REVIEW") check += 1;
    else none += 1;
  }
  const gaps = expertise.length <= 2 ? " The mix is narrow; consider a second search for other topics." : "";
  return [
    {
      id: "expertise",
      title: "Expertise mix",
      takeaway: expertise[0] ? `Strongest area: ${expertise[0].label.toLowerCase()} (${expertise[0].count}), grouped from what each person's page says.${gaps}` : "No expertise was found for these people yet.",
      bars: expertise,
    },
    {
      id: "background",
      title: "Academia and industry",
      takeaway: `Likely ${academia} from universities and institutes, ${industry} from companies, judged from their affiliation. A balanced panel usually mixes both.`,
      bars: [
        { label: "Academia (likely)", count: academia },
        { label: "Industry (likely)", count: industry },
        { label: "Affiliation unknown", count: unknown },
      ],
      chart: "pie",
    },
    {
      id: "reach",
      title: "Can you reach them",
      takeaway: `${confirmed} have a confirmed LinkedIn or email. ${check} have a possible LinkedIn match to check before writing.`,
      bars: [
        { label: "Confirmed LinkedIn or email", count: confirmed },
        { label: "Possible match, check first", count: check },
        { label: "No contact path yet", count: none },
      ],
    },
  ];
}

function jobSections(records: DatasetRecord[]): LensSection[] {
  const workplace = (value: string) => {
    if (/remote/i.test(value)) return "Remote";
    if (/hybrid/i.test(value)) return "Hybrid";
    if (/on.?site|office/i.test(value)) return "On-site";
    return "Not stated";
  };
  const modes = tally(records.map((record) => workplace(record.fields.workplace ?? "")), 4);
  const companies = barsOrNames(records, "company_name");
  const places = tally(records.map((record) => cityOf(record.fields.location ?? "")));
  const remote = modes.find((item) => item.label === "Remote")?.count ?? 0;
  return [
    {
      id: "workplace",
      title: "Remote, hybrid or on-site",
      takeaway: `${remote} of ${records.length} roles are remote.`,
      bars: modes,
      chart: "pie",
    },
    {
      id: "companies",
      title: "Who is hiring",
      takeaway: companies.repeats && companies.bars?.[0]
        ? `${companies.bars[0].label} has the most roles here (${companies.bars[0].count}).`
        : "Each company has one role in this list.",
      bars: companies.bars,
      names: companies.names?.map((item, index) => ({ name: item.name, detail: clip(records.filter((record) => record.fields.company_name?.trim())[index]?.fields.role_title ?? "", 48) })),
    },
    {
      id: "locations",
      title: "Where the roles are",
      takeaway: places[0] ? `Most roles are in ${places[0].label}.` : "No locations were written on the listings found.",
      bars: places,
    },
  ];
}

function leadSections(records: DatasetRecord[], outreach: Record<string, Mark>): LensSection[] {
  const segments = barsOrNames(records, "category");
  const next = records
    .filter((record) => outreachOf(record, outreach) === "pending" && (emailOf(record) || record.fields.linkedin))
    .slice(0, 5);
  return [
    {
      id: "segments",
      title: "What kinds of companies",
      takeaway: segments.repeats && segments.bars?.[0]
        ? `Largest group: ${segments.bars[0].label.toLowerCase()} (${segments.bars[0].count}).`
        : "What each company does, as described on its own page.",
      bars: segments.bars,
      names: segments.names,
    },
    { ...contactQualitySection(records), chart: "pie" },
    {
      id: "next",
      title: "Best leads to contact next",
      takeaway: next.length ? "The most complete leads you have not contacted yet, each with a way to reach them." : "Every reachable lead has been contacted.",
      names: next.map((record) => ({ name: nameOf(record), detail: emailOf(record) || (record.fields.linkedin ?? "").replace(/^https?:\/\/(www\.)?/, "") })),
    },
  ];
}

function competitorSections(records: DatasetRecord[]): LensSection[] {
  const priced = records.filter((record) => record.fields.pricing_signal?.trim());
  const free = priced.filter((record) => /free/i.test(record.fields.pricing_signal ?? "")).length;
  const categories = barsOrNames(records, "category");
  const compared = [...records].sort((a, b) => (b.sourceCount ?? 0) - (a.sourceCount ?? 0)).slice(0, 5);
  return [
    {
      id: "pricing",
      title: "Pricing landscape",
      takeaway: priced.length
        ? `${priced.length} of ${records.length} competitors have a price written on a page; ${free} mention a free plan.`
        : "No prices were written on the pages found.",
      bars: [
        { label: "Mentions a free plan", count: free },
        { label: "Price shown, no free plan", count: priced.length - free },
        { label: "No price found", count: records.length - priced.length },
      ],
      chart: "pie",
      names: priced.slice(0, 8).map((record) => ({ name: nameOf(record), detail: clip(record.fields.pricing_signal ?? "", 48) })),
    },
    {
      id: "categories",
      title: "What they compete on",
      takeaway: categories.repeats && categories.bars?.[0]
        ? `Largest group: ${categories.bars[0].label.toLowerCase()} (${categories.bars[0].count}).`
        : "What each competitor offers, as described on the pages found.",
      bars: categories.bars,
      names: categories.names,
    },
    {
      id: "compared",
      title: "Most compared",
      takeaway: "Found on the most comparison pages, so likely the ones customers weigh you against.",
      names: compared.map((record) => ({ name: nameOf(record), detail: plural(record.sourceCount ?? record.sources?.length ?? 0, "page") })),
    },
  ];
}

function eventSections(records: DatasetRecord[]): LensSection[] {
  const withPrize = records.filter((r) => r.fields.prize_pool?.trim());
  const organizers = barsOrNames(records, "organizer");
  const modes = tally(
    records.map((r) => {
      const loc = (r.fields.location || "").toLowerCase();
      if (loc.includes("online") || loc.includes("virtual")) return "Online / Virtual";
      if (loc.includes("hybrid")) return "Hybrid";
      if (loc) return "In-person";
      return "Unspecified";
    }),
  );
  return [
    {
      id: "prizes",
      title: "Prize pool & rewards",
      takeaway: withPrize.length
        ? `${withPrize.length} of ${records.length} hackathons have verified prize money or bounties listed.`
        : "No explicit prize pool amounts were verified on the pages found.",
      names: withPrize.slice(0, 8).map((r) => ({ name: nameOf(r), detail: r.fields.prize_pool })),
    },
    {
      id: "modes",
      title: "Event format",
      takeaway: "Distribution of in-person, virtual, and hybrid hackathons.",
      bars: modes,
      chart: "pie",
    },
    {
      id: "organizers",
      title: "Organizers & hosts",
      takeaway: organizers.repeats && organizers.bars?.[0]
        ? `Most frequent organizer: ${organizers.bars[0].label} (${organizers.bars[0].count}).`
        : "Organizing entities and host platforms.",
      bars: organizers.bars,
      names: organizers.names,
    },
  ];
}

function paperSections(records: DatasetRecord[]): LensSection[] {
  const withPdf = records.filter((r) => r.fields.pdf_url?.trim());
  const venues = barsOrNames(records, "venue");
  const years = tally(records.map((r) => r.fields.year?.trim()).filter(Boolean) as string[], 5);
  return [
    {
      id: "downloads",
      title: "Open access & direct PDFs",
      takeaway: `${withPdf.length} of ${records.length} research papers have direct downloadable PDF links.`,
      names: withPdf.slice(0, 8).map((r) => ({
        name: nameOf(r),
        detail: r.fields.venue ? `${r.fields.venue}${r.fields.year ? ` · ${r.fields.year}` : ""}` : r.fields.year || "PDF available",
      })),
    },
    {
      id: "venues",
      title: "Conferences & archives",
      takeaway: venues.repeats && venues.bars?.[0]
        ? `Top publication venue: ${venues.bars[0].label} (${venues.bars[0].count}).`
        : "Journals, conferences and preprint archives.",
      bars: venues.bars,
      names: venues.names,
    },
    {
      id: "years",
      title: "Publication timeline",
      takeaway: "Distribution of papers across publication years.",
      bars: years,
      chart: "pie",
    },
  ];
}

function sourceBars(records: DatasetRecord[]): LensBar[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const domain of new Set((record.sources ?? []).map((source) => source.domain || ""))) {
      if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));
}

export function buildLens(input: {
  intent: string;
  records: DatasetRecord[];
  outreach: Record<string, Mark>;
  diff: Diff | null;
}): LensView {
  const { intent, records, outreach, diff } = input;
  const withEmail = records.filter((record) => emailOf(record)).length;
  const withLinkedin = records.filter((record) => record.fields.linkedin?.trim()).length;
  const contacted = records.filter((record) => outreachOf(record, outreach) !== "pending").length;
  const isDocOrEvent = intent === "EVENT_LOOKUP" || intent === "PAPER_LOOKUP";
  const withWeb = records.filter((r) => r.fields.website?.trim() || r.fields.pdf_url?.trim()).length;
  const stats = [
    { label: intent === "PAPER_LOOKUP" ? "Papers" : intent === "EVENT_LOOKUP" ? "Events" : "Rows", value: String(records.length) },
    ...(isDocOrEvent
      ? [
          {
            label: intent === "PAPER_LOOKUP" ? "With direct PDF" : "With prize pool",
            value: String(
              intent === "PAPER_LOOKUP"
                ? records.filter((r) => r.fields.pdf_url?.trim()).length
                : records.filter((r) => r.fields.prize_pool?.trim()).length,
            ),
          },
          { label: "With official link", value: String(withWeb) },
        ]
      : [
          { label: "With email", value: String(withEmail) },
          { label: "With LinkedIn", value: String(withLinkedin) },
        ]),
    ...(intent === "COMPETITOR_LOOKUP" || isDocOrEvent ? [] : [{ label: "Contacted", value: String(contacted) }]),
  ];
  const specific =
    intent === "SPONSOR_LOOKUP" ? sponsorSections(records, outreach)
      : intent === "JUDGE_LOOKUP" ? judgeSections(records)
        : intent === "JOB_LOOKUP" ? jobSections(records)
          : intent === "LEAD_LOOKUP" ? leadSections(records, outreach)
            : intent === "COMPETITOR_LOOKUP" ? competitorSections(records)
              : intent === "EVENT_LOOKUP" ? eventSections(records)
                : intent === "PAPER_LOOKUP" ? paperSections(records)
                  : [];
  const sections = [
    ...(intent === "COMPETITOR_LOOKUP" || isDocOrEvent ? [] : [outreachSection(records, outreach)]),
    ...specific,
    ...[changesSection(diff)].filter((section): section is LensSection => Boolean(section)),
  ];
  const sources = sourceBars(records);
  const sourcesLine = sources.length ? `Top sources: ${sources.map((item) => `${item.label} (${item.count})`).join(" · ")}` : "";
  return { stats, sections, sources, sourcesLine };
}
