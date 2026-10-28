import { z } from "zod";

export const INTENT_IDS = [
  "SPONSOR_LOOKUP",
  "JOB_LOOKUP",
  "LEAD_LOOKUP",
  "EVENT_LOOKUP",
  "COMPANY_LOOKUP",
  "COMPETITOR_LOOKUP",
  "PRODUCT_LOOKUP",
  "MARKET_LOOKUP",
  "FUNDING_LOOKUP",
  "VENDOR_LOOKUP",
  "JUDGE_LOOKUP",
  "PAPER_LOOKUP",
] as const;

export const intentIdSchema = z.enum(INTENT_IDS);
export type IntentId = z.infer<typeof intentIdSchema>;

/** The intents that run end to end against the live web. */
export const LIVE_INTENTS: IntentId[] = [...INTENT_IDS];

export const JOB_STATES = [
  "DRAFT",
  "PLANNED",
  "QUEUED",
  "COLLECTING",
  "ENRICHING",
  "IDENTITY_RESOLUTION",
  "TRUST_EVALUATION",
  "NORMALIZING",
  "VALIDATING",
  "DEDUPLICATING",
  "RANKING",
  "ANNOTATING",
  "CONFLICT_REVIEW",
  "COMPLETED",
  "FAILED",
  "PARTIAL",
  "CANCELLED",
] as const;

export const jobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof jobStateSchema>;

export const ACTIVE_STATES: JobState[] = [
  "QUEUED",
  "COLLECTING",
  "ENRICHING",
  "IDENTITY_RESOLUTION",
  "TRUST_EVALUATION",
  "NORMALIZING",
  "VALIDATING",
  "DEDUPLICATING",
  "RANKING",
  "ANNOTATING",
];

export const blueprintSchema = z.object({
  intent: intentIdSchema,
  query: z.string().min(1),
  entities: z.object({
    category: z.string().nullable(),
    location: z.string().nullable(),
    /** What the search is about, as parsed from the question: a product, topic, event type or role. */
    subject: z.string().nullable().optional(),
  }),
  fields: z.array(z.string().min(1)).min(1),
  freshness: z.object({
    required: z.boolean(),
    maxAgeDays: z.number().int().positive().max(3650),
  }),
  sources: z.array(z.string()),
  ranking: z.object({
    strategy: z.string().min(1),
  }),
});

export type CollectionBlueprint = z.infer<typeof blueprintSchema>;

export const scheduleSchema = z.object({
  enabled: z.boolean(),
  cadence: z.enum(["daily", "weekly"]),
  weekday: z.number().int().min(0).max(6).nullable(),
  hour: z.number().int().min(0).max(23),
  timezone: z.string().min(1),
  nextRunAt: z.string().nullable(),
});

export type Schedule = z.infer<typeof scheduleSchema>;

export const createJobSchema = z.object({
  query: z.string().trim().min(4).max(2000),
  name: z.string().trim().min(1).max(180).optional(),
  blueprint: blueprintSchema.optional(),
});

export const renameJobSchema = z.object({
  name: z.string().trim().min(1, "Give the search a name.").max(180),
});

export const OUTREACH_STATUSES = ["pending", "waiting", "interested", "declined"] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const outreachUpdateSchema = z.object({
  status: z.enum(OUTREACH_STATUSES),
  note: z.string().trim().max(280, "Keep the note under 280 characters.").default(""),
});

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(120),
  email: z.string().trim().toLowerCase().min(1, "Enter your email.").email("Enter a valid email address.").max(254),
  password: z.string().min(1, "Enter a password.").min(8, "Use at least 8 characters for your password.").max(200),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Enter your email.").email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(120),
  role: z.string().trim().max(120).default(""),
});

export const FOLDER_KEYS = ["sponsors", "judges", "jobs", "leads", "competitors", "events", "papers"] as const;
export const folderKeySchema = z.enum(FOLDER_KEYS);
export type FolderKey = z.infer<typeof folderKeySchema>;

/** Each event folder holds the results of one intent. */
export const FOLDER_INTENTS: Record<FolderKey, IntentId> = {
  sponsors: "SPONSOR_LOOKUP",
  judges: "JUDGE_LOOKUP",
  jobs: "JOB_LOOKUP",
  leads: "LEAD_LOOKUP",
  competitors: "COMPETITOR_LOOKUP",
  events: "EVENT_LOOKUP",
  papers: "PAPER_LOOKUP",
};

export const eventInputSchema = z.object({
  name: z.string().trim().min(1, "Give the event a name.").max(160),
  description: z.string().trim().max(2000).default(""),
  date: z.string().trim().max(80).default(""),
  targets: z.string().trim().max(400).default(""),
});

export const eventUpdateSchema = eventInputSchema.partial().extend({
  favourite: z.boolean().optional(),
  archived: z.boolean().optional(),
  touched: z.boolean().optional(),
  folderNames: z.record(folderKeySchema, z.string().trim().min(1).max(80)).optional(),
  /** folder → job id, or null to unlink */
  jobs: z.record(folderKeySchema, z.string().uuid().nullable()).optional(),
  /** Folders this event does not need, e.g. Jobs and Leads for a hackathon. Searches inside are kept. */
  hiddenFolders: z.array(folderKeySchema).max(FOLDER_KEYS.length).optional(),
});

export const previewBlueprintSchema = z.object({
  query: z.string().trim().min(4).max(2000),
  blueprint: blueprintSchema.optional(),
});

export const updateBlueprintSchema = z.object({
  blueprint: blueprintSchema,
  name: z.string().trim().min(1).max(180).optional(),
});

export const resolveConflictSchema = z.object({
  decision: z.enum(["NEW", "OLD", "BOTH"]),
});

export const exportQuerySchema = z.object({
  format: z.enum(["csv", "json", "html", "xlsx"]).default("csv"),
});

export const savedViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filters: z.object({
    q: z.string().optional(),
    status: z.string().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    change: z.enum(["added", "changed", "removed", "unchanged", "conflict"]).optional(),
  }),
});

export const scheduleUpdateSchema = z.object({
  enabled: z.boolean(),
  cadence: z.enum(["daily", "weekly"]).default("weekly"),
  weekday: z.number().int().min(0).max(6).nullable().default(1),
  hour: z.number().int().min(0).max(23).default(9),
  timezone: z.string().default("Asia/Kolkata"),
});

export const duplicateJobSchema = z.object({
  location: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(180).optional(),
});

export const FIELD_LABELS: Record<string, string> = {
  company_name: "Company",
  event_name: "Event",
  sponsorship_type: "Sponsorship",
  website: "Website",
  contact: "Contact",
  email: "Email",
  last_verified: "Last verified",
  source_url: "Source URL",
  evidence: "Evidence",
  role_title: "Role",
  location: "Location",
  workplace: "Workplace",
  organizer: "Organizer",
  start_date: "Start date",
  industry: "Industry",
  headquarters: "Headquarters",
  category: "Category",
  pricing_signal: "Pricing signal",
  product_name: "Product",
  vendor: "Vendor",
  segment: "Segment",
  region: "Region",
  signal: "Signal",
  program_name: "Program",
  organization: "Organization",
  amount: "Amount",
  deadline: "Deadline",
  capability: "Capability",
  phone: "Phone",
  person_name: "Name",
  affiliation: "Affiliation",
  expertise: "Expertise",
  profile_url: "Profile",
  linkedin: "LinkedIn",
  github: "GitHub",
  contact_page: "Contact page",
  prize_pool: "Prize pool",
  dates: "Dates",
  paper_title: "Paper title",
  authors: "Authors",
  venue: "Venue",
  year: "Year",
  topic: "Topic",
  pdf_url: "PDF Link",
  citations: "Citations",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replaceAll("_", " ");
}

export const INTENT_LABELS: Record<IntentId, string> = {
  SPONSOR_LOOKUP: "Sponsor lookup",
  JOB_LOOKUP: "Job lookup",
  LEAD_LOOKUP: "Lead lookup",
  EVENT_LOOKUP: "Hackathons & Events",
  COMPANY_LOOKUP: "Company lookup",
  COMPETITOR_LOOKUP: "Competitor lookup",
  PRODUCT_LOOKUP: "Product lookup",
  MARKET_LOOKUP: "Market lookup",
  FUNDING_LOOKUP: "Funding lookup",
  VENDOR_LOOKUP: "Vendor lookup",
  JUDGE_LOOKUP: "Judges, Mentors & Researchers",
  PAPER_LOOKUP: "Research Papers",
};

export function stateLabel(state: JobState): string {
  switch (state) {
    case "CONFLICT_REVIEW":
      return "Needs review";
    case "COMPLETED":
      return "Completed";
    case "NORMALIZING":
      return "Normalizing";
    case "DEDUPLICATING":
      return "Deduplicating";
    case "VALIDATING":
      return "Validating";
    case "COLLECTING":
      return "Collecting";
    case "ENRICHING":
      return "Finding contact paths";
    case "IDENTITY_RESOLUTION":
      return "Matching identities";
    case "TRUST_EVALUATION":
      return "Scoring trust";
    case "RANKING":
      return "Ranking";
    case "ANNOTATING":
      return "Annotating";
    case "QUEUED":
      return "Queued";
    case "PLANNED":
      return "Planned";
    case "DRAFT":
      return "Draft";
    case "FAILED":
      return "Failed";
    case "PARTIAL":
      return "Partial";
    case "CANCELLED":
      return "Cancelled";
    default:
      return state;
  }
}
