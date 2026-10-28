import type { CollectionBlueprint, JobState } from "@dig/schemas";

export interface Session {
  workspace: { id: string; name: string };
  user: { id: string; name: string; email: string };
}

export interface DiffSummary {
  firstVersion: boolean;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  conflicts: number;
}

export interface JobSummary {
  id: string;
  name: string;
  intent: string;
  status: JobState;
  query: string;
  demo: boolean;
  updatedAt: string;
  versionNumber: number | null;
  rowCount: number;
  sourceCount: number;
  qualityScore: number | null;
  avgConfidence: number | null;
  lastRunAt: string | null;
  pendingConflicts: number;
  diff: DiffSummary | null;
  blueprint: CollectionBlueprint;
  schedule: { enabled: boolean; cadence: string; hour: number; weekday: number | null; nextRunAt: string | null; timezone: string } | null;
}

export interface Progress {
  stage: string;
  percent: number;
  sourcesPlanned: number;
  sourcesScanned: number;
  documents: number;
  records: number;
  valid: number;
  duplicates: number;
  conflicts: number;
}

/** The intents Dig researches end to end; the API refuses anything else with UNSUPPORTED_INTENT. */
export const SUPPORTED_INTENTS = [
  "SPONSOR_LOOKUP",
  "JUDGE_LOOKUP",
  "JOB_LOOKUP",
  "LEAD_LOOKUP",
  "COMPETITOR_LOOKUP",
  "EVENT_LOOKUP",
  "PAPER_LOOKUP",
  "COMPANY_LOOKUP",
  "VENDOR_LOOKUP",
  "PRODUCT_LOOKUP",
  "FUNDING_LOOKUP",
  "MARKET_LOOKUP",
];

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** The form field the error is about, when the server says so. */
    readonly field: string | null = null,
  ) {
    super(message);
  }
}

type ErrorBody = { error?: { message: string; code?: string; details?: { field?: string | null } } };

async function readError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  if (!body?.error) {
    const offline = response.status >= 500 && response.status < 600;
    return new ApiError(
      offline ? "Dig’s server isn’t responding. Check that the API is running, then try again." : `Request failed (${response.status}).`,
      offline ? "SERVER_UNAVAILABLE" : "ERROR",
      response.status,
    );
  }
  return new ApiError(body.error.message, body.error.code ?? "ERROR", response.status, body.error.details?.field ?? null);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiError("Can’t reach Dig’s server. Check your connection and try again.", "NETWORK", 0);
  }
  if (!response.ok) {
    const error = await readError(response);
    // A session that ended mid-use: drop the cached user so the app sends them back to log in.
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      const { queryClient } = await import("./query");
      queryClient.setQueryData(["me"], null);
    }
    throw error;
  }
  const body = (await response.json()) as { success: boolean; data: T };
  return body.data;
}

/** Downloads a file from the API, surfacing the API's error message instead of saving an error page. */
export async function download(path: string, fallbackName: string) {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw await readError(response);
  const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Datasets the signed-in user can attach to a workflow, newest finished search first. */
export function datasetChoices(jobs: JobSummary[]) {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.name, (counts.get(job.name) ?? 0) + 1);
  return [...jobs]
    .sort((a, b) => {
      const ready = Number(b.versionNumber != null) - Number(a.versionNumber != null);
      if (ready !== 0) return ready;
      return (b.lastRunAt ?? b.updatedAt).localeCompare(a.lastRunAt ?? a.updatedAt);
    })
    .map((job) => {
      const rows = job.versionNumber == null ? "no results yet" : `${job.rowCount} records`;
      const query = (counts.get(job.name) ?? 0) > 1 && job.query ? ` · ${job.query.slice(0, 48)}` : "";
      return { id: job.id, name: job.name, label: `${job.name} · ${rows}${query}` };
    });
}

export function ago(iso: string | null | undefined) {
  if (!iso) return "Not run";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (Number.isNaN(minutes)) return "—";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function pct(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

export interface SourceRef {
  url: string;
  title: string;
  domain: string;
  publishedAt: string;
  authority: "official" | "secondary" | "press";
  excerpt: string;
  fieldNames: string[];
}

export interface Evidence {
  id: string;
  fieldName: string;
  value: string;
  sourceUrl: string;
  sourceTitle: string;
  excerpt: string;
  collectedAt: string;
  publishedAt: string;
  authority: "official" | "secondary" | "press";
  confidence: number;
}

export type RecordStatus = "verified" | "needs_review" | "possible_duplicate" | "incomplete";

export type ContactChannelStatus = "VERIFIED" | "IDENTITY_MATCHED" | "PROVIDER_MATCHED" | "LIKELY" | "NEEDS_REVIEW" | "NOT_FOUND";

export interface ContactChannel {
  value: string | null;
  status: ContactChannelStatus;
  confidence: number;
  provider: string | null;
  sourceUrl: string | null;
  verificationStatus: string | null;
  matchingEvidence: string | null;
  sourceType?: "official" | "secondary" | "press" | "provider_enrichment";
}

export interface Contactability {
  score: number;
  status: "NONE" | "PARTIAL" | "READY";
  channels: {
    email: ContactChannel;
    phone: ContactChannel;
    linkedin: ContactChannel;
    github: ContactChannel;
    website: ContactChannel;
    contactPage: ContactChannel;
  };
}

export interface TrustDecision {
  identityConfidence: number;
  evidenceConfidence: number;
  contactConfidence: number;
  overallTrust: number;
  needsReviewProbability: number;
  status: "HIGH_TRUST" | "MEDIUM_TRUST" | "NEEDS_REVIEW" | "UNTRUSTED";
  provider: string;
  model: string;
}

export interface DatasetRecord {
  id: string;
  canonicalEntityId: string;
  fields: Record<string, string>;
  rank: number;
  confidence: number;
  confidenceComponents?: {
    sourceAuthority: number;
    corroboration: number;
    freshness: number;
    extractionQuality: number;
  };
  status: RecordStatus;
  sourceCount: number;
  flags: string[];
  sources: SourceRef[];
  evidence: Evidence[];
  label: string;
  change: "initial" | "added" | "changed" | "conflict" | "unchanged";
  contactability?: Contactability;
  trust?: TrustDecision;
}

export interface DatasetVersion {
  id: string;
  /** the run that produced this version — its conflicts are the live ones */
  runId: string;
  versionNumber: number;
  createdAt: string;
  rowCount: number;
  sourceCount: number;
  status: string;
  qualityScore: number | null;
  avgConfidence: number | null;
}

export interface Dataset {
  version: DatasetVersion | null;
  records: DatasetRecord[];
}

export interface Conflict {
  id: string;
  jobId: string;
  runId: string;
  recordId: string | null;
  canonicalEntityId: string;
  label: string;
  field: string;
  oldValue: string;
  newValue: string;
  oldEvidence: Evidence | null;
  newEvidence: Evidence | null;
  detectedAt: string;
  status: "PENDING" | "AUTO_RESOLVED" | "RESOLVED" | string;
  decision: string | null;
  confidence: number | null;
  reason: string | null;
  resolvedAt: string | null;
}

export interface DiffEntry {
  canonicalEntityId: string;
  label: string;
  detail: string;
  fields: Array<{ field: string; from: string; to: string }>;
}

export interface Diff {
  firstVersion: boolean;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  unchanged: DiffEntry[];
  conflictIds: string[];
}

export interface JobProgress {
  status: string;
  runId: string | null;
  runNumber: number | null;
  progress: Progress;
  error: string | null;
}

export interface JobDetail {
  job: JobSummary;
  version: unknown;
  progress: JobProgress;
}

export const ACTIVE_STATES = ["QUEUED", "COLLECTING", "ENRICHING", "IDENTITY_RESOLUTION", "TRUST_EVALUATION", "NORMALIZING", "VALIDATING", "DEDUPLICATING", "RANKING", "ANNOTATING"];
