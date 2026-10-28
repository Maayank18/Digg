import { randomUUID } from "node:crypto";
import { fieldLabel, type CollectionBlueprint } from "@dig/schemas";
import { dedupeRecords } from "./dedupe.js";
import { diffDatasets } from "./diff.js";
import { intentDefinition } from "./intents.js";
import { acceptedFieldNames } from "./enrichment/index.js";
import { applyThreshold, containmentDecision, mockJevProvider, type JevProvider } from "./jev.js";
import { comparisonKey, normalizeFields } from "./normalize.js";
import { qualityScore, scoreRecord } from "./rank.js";
import type {
  CollectedRecord,
  ConflictDraft,
  DiffResult,
  EvidenceItem,
  IntelligenceReport,
  PipelineResult,
  PipelineStats,
  ProvenanceSource,
  PublishedRecord,
} from "./types.js";
import { sha256, stable } from "./util.js";
import { validateFields } from "./validate.js";

/** Provenance bookkeeping that legitimately moves every run; a change in it is not a change in the data. */
const UNCOMPARED_FIELDS = new Set(["last_verified", "source_url"]);

export interface AnnotationBatch {
  annotations: Array<{ recordId: string; remark: string; reasoning: string; confidence: number }>;
  summary: string;
  observations: string[];
}

export interface PipelineInput {
  blueprint: CollectionBlueprint;
  collected: CollectedRecord[];
  previous?: PublishedRecord[] | null;
  now: Date;
  threshold?: number;
  jev?: JevProvider;
  demo?: boolean;
  llm?: {
    enabled: boolean;
    model: string;
    readCache: (hash: string) => AnnotationBatch | null;
    writeCache: (hash: string, batch: AnnotationBatch) => void;
    generate: (input: { records: PublishedRecord[]; reportFacts: string }) => Promise<AnnotationBatch> | AnnotationBatch;
  };
}

interface Draft {
  id: string;
  canonicalEntityId: string;
  fields: Record<string, string>;
  sources: ProvenanceSource[];
  flags: string[];
  ambiguousFields: string[];
  evidence: EvidenceItem[];
  validation: PublishedRecord["validation"];
  activityScore: number;
  activityComponents: PublishedRecord["activityComponents"];
  confidence: number;
  confidenceComponents: PublishedRecord["confidenceComponents"];
  status: PublishedRecord["status"];
  alternates: PublishedRecord["alternates"];
  contactability?: PublishedRecord["contactability"];
  trust?: PublishedRecord["trust"];
}

export interface StageProgress {
  sources: number;
  documents: number;
  records: number;
  valid: number;
  duplicates: number;
  conflicts: number;
}

export async function runPipeline(
  input: PipelineInput,
  onStage?: (stage: string, progress: StageProgress) => Promise<void> | void,
): Promise<PipelineResult> {
  const definition = intentDefinition(input.blueprint.intent);
  const threshold = input.threshold ?? 0.85;
  const jev = input.jev ?? mockJevProvider;
  const nowIso = input.now.toISOString();
  const countSources = (records: Array<{ sources: ProvenanceSource[] }>) =>
    new Set(records.flatMap((record) => record.sources.map((source) => source.url))).size;
  const discovered = countSources(input.collected);
  if (onStage) {
    await onStage("COLLECTING", {
      sources: discovered,
      documents: discovered,
      records: input.collected.length,
      valid: 0,
      duplicates: 0,
      conflicts: 0,
    });
  }

  const normalized: CollectedRecord[] = input.collected.map((record) => ({
    ...record,
    fields: normalizeFields(record.fields),
  }));
  if (onStage) {
    await onStage("NORMALIZING", {
      sources: discovered,
      documents: discovered,
      records: normalized.length,
      valid: 0,
      duplicates: 0,
      conflicts: 0,
    });
  }
  const deduped = dedupeRecords(normalized, definition.identityFields);
  const dedupedSources = countSources(deduped.records);
  if (onStage) {
    await onStage("DEDUPLICATING", {
      sources: dedupedSources,
      documents: dedupedSources,
      records: deduped.records.length,
      valid: 0,
      duplicates: deduped.merged,
      conflicts: 0,
    });
  }

  const drafts: Draft[] = deduped.records.map((record) => {
    const validation = validateFields(record.fields, input.blueprint.intent);
    const evidence = buildEvidence(record, nowIso);
    const covered = covers(record.fields, record.sources, definition.requiredFields);
    const scores = scoreRecord({
      sources: record.sources,
      fields: record.fields,
      blueprint: input.blueprint,
      now: input.now,
      excerptsCoverValues: covered,
    });
    const flags = [...record.flags];
    let status: Draft["status"] = "verified";
    if (!validation.valid) status = "incomplete";
    else if (flags.includes("POSSIBLE_DUPLICATE")) status = "possible_duplicate";
    else if (scores.confidence < 0.7) status = "needs_review";
    return {
      id: randomUUID(),
      canonicalEntityId: record.canonicalEntityId,
      fields: record.fields,
      sources: record.sources,
      flags,
      ambiguousFields: record.ambiguousFields ?? [],
      evidence,
      validation,
      activityScore: scores.activityScore,
      activityComponents: scores.activity,
      confidence: scores.confidence,
      confidenceComponents: scores.confidenceParts,
      status,
      alternates: [],
      contactability: record.contactability,
      trust: record.trust,
    };
  });

  const filled = (draft: Draft) => filledCount(draft.fields, input.blueprint.fields);
  const byCompleteness = (a: Draft, b: Draft) =>
    filled(b) - filled(a) || b.activityScore - a.activityScore || b.confidence - a.confidence || label(a).localeCompare(label(b));
  drafts.sort(byCompleteness);
  if (onStage) {
    await onStage("VALIDATING", {
      sources: dedupedSources,
      documents: dedupedSources,
      records: drafts.length,
      valid: drafts.filter((draft) => draft.validation.valid).length,
      duplicates: deduped.merged,
      conflicts: 0,
    });
    await onStage("RANKING", {
      sources: dedupedSources,
      documents: dedupedSources,
      records: drafts.length,
      valid: drafts.filter((draft) => draft.validation.valid).length,
      duplicates: deduped.merged,
      conflicts: 0,
    });
  }

  const previous = input.previous ?? null;
  // The diff compares comparison keys, not display values, so casing/plural noise between runs is not a
  // change (and never becomes a Jev conflict). Bookkeeping fields that move every run are not compared.
  const keyed = (record: { canonicalEntityId: string; fields: Record<string, string> }) => ({
    canonicalEntityId: record.canonicalEntityId,
    fields: Object.fromEntries(Object.entries(record.fields).map(([field, value]) => [field, comparisonKey(field, value)])),
  });
  const diff = diffDatasets({
    previous: previous?.map(keyed) ?? null,
    current: drafts.map(keyed),
    compareFields: [...new Set([...input.blueprint.fields, ...acceptedFieldNames()])].filter((field) => !UNCOMPARED_FIELDS.has(field)),
  });
  // Hand the original values back to everything downstream (conflicts, Jev, the diff panel).
  {
    const priorById = new Map((previous ?? []).map((record) => [record.canonicalEntityId, record]));
    const draftById = new Map(drafts.map((record) => [record.canonicalEntityId, record]));
    for (const entry of [...diff.added, ...diff.changed, ...diff.unchanged, ...diff.removed]) {
      const original = draftById.get(entry.canonicalEntityId) ?? priorById.get(entry.canonicalEntityId);
      if (original) entry.label = label(original);
    }
    for (const change of diff.changed) {
      const prior = priorById.get(change.canonicalEntityId);
      const current = draftById.get(change.canonicalEntityId);
      for (const fieldDiff of change.fields) {
        fieldDiff.from = prior?.fields[fieldDiff.field] ?? "";
        fieldDiff.to = current?.fields[fieldDiff.field] ?? "";
      }
    }
  }

  const previousById = new Map((previous ?? []).map((record) => [record.canonicalEntityId, record]));
  const conflicts: ConflictDraft[] = [];

  if (previous) {
    for (const change of diff.changed) {
      const current = drafts.find((record) => record.canonicalEntityId === change.canonicalEntityId);
      const prior = previousById.get(change.canonicalEntityId);
      if (!current || !prior) continue;
      for (const fieldDiff of change.fields) {
        if (!definition.protectedFields.includes(fieldDiff.field)) continue;
        if (!fieldDiff.from || !fieldDiff.to) continue;
        const oldEvidence = prior.evidence.find((item) => item.fieldName === fieldDiff.field && item.value === fieldDiff.from) ?? prior.evidence.find((item) => item.fieldName === fieldDiff.field) ?? null;
        const newEvidence = current.evidence.find((item) => item.fieldName === fieldDiff.field && item.value === fieldDiff.to) ?? current.evidence.find((item) => item.fieldName === fieldDiff.field) ?? null;
        const decision = containmentDecision(fieldDiff.from, fieldDiff.to) ?? await jev.decide({
          field: fieldDiff.field,
          oldValue: fieldDiff.from,
          newValue: fieldDiff.to,
          oldEvidence,
          newEvidence,
          ambiguous: current.ambiguousFields.includes(fieldDiff.field),
          question: `Which ${fieldLabel(fieldDiff.field).toLowerCase()} is current?`,
        });
        const gated = applyThreshold(decision, threshold);
        const conflict: ConflictDraft = {
          id: randomUUID(),
          canonicalEntityId: current.canonicalEntityId,
          field: fieldDiff.field,
          oldValue: fieldDiff.from,
          newValue: fieldDiff.to,
          oldEvidence,
          newEvidence,
          detectedAt: nowIso,
          status: gated.status,
          decision: decision.decision,
          confidence: decision.confidence,
          reason: decision.reason,
          ambiguous: current.ambiguousFields.includes(fieldDiff.field),
          provider: decision.provider,
        };
        conflicts.push(conflict);
        change.conflictIds.push(conflict.id);
        if (gated.status === "PENDING" || decision.decision === "OLD" || decision.decision === "BOTH") {
          current.fields = { ...current.fields, [fieldDiff.field]: fieldDiff.from };
          const retained = (prior.evidence ?? [])
            .filter((item) => item.fieldName === fieldDiff.field && item.value === fieldDiff.from)
            .map((item) => ({ ...item, id: randomUUID() }));
          current.evidence = [
            ...current.evidence.filter((item) => item.fieldName !== fieldDiff.field),
            ...retained,
          ];
          if (decision.decision === "BOTH" && gated.status === "AUTO_RESOLVED") {
            current.alternates.push({ field: fieldDiff.field, value: fieldDiff.to });
          }
          if (gated.status === "PENDING") current.status = "needs_review";
        }
      }
    }
  }

  diff.conflictIds = conflicts.map((conflict) => conflict.id);
  if (onStage) {
    await onStage("ANNOTATING", {
      sources: dedupedSources,
      documents: dedupedSources,
      records: drafts.length,
      valid: drafts.filter((draft) => draft.validation.valid).length,
      duplicates: deduped.merged,
      conflicts: conflicts.length,
    });
  }

  // Conflict review can put an old value back, so rank on the fields as they will be published.
  drafts.sort(byCompleteness);
  const records: PublishedRecord[] = drafts.map((draft, index) => {
    const pending = conflicts.filter((conflict) => conflict.canonicalEntityId === draft.canonicalEntityId && conflict.status === "PENDING");
    const annotation = remarkFor(draft, pending, index + 1, filled(draft));
    return {
      id: draft.id,
      canonicalEntityId: draft.canonicalEntityId,
      fields: draft.fields,
      rank: index + 1,
      activityScore: draft.activityScore,
      activityComponents: draft.activityComponents,
      confidence: draft.confidence,
      confidenceComponents: draft.confidenceComponents,
      status: draft.status,
      validation: draft.validation,
      sourceCount: draft.sources.length,
      contentHash: sha256(stable(draft.fields)),
      flags: draft.flags,
      alternates: draft.alternates,
      sources: draft.sources,
      evidence: draft.evidence,
      annotation,
      contactability: draft.contactability,
      trust: draft.trust,
    };
  });

  const stats = summarize(records, deduped.merged, deduped.possible, conflicts);
  const annotationHash = sha256(
    stable(
      records.map((record) => ({
        id: record.canonicalEntityId,
        fields: record.fields,
        rank: record.rank,
        evidence: record.evidence.map((item) => [item.fieldName, item.value, item.excerpt]),
      })),
    ),
  );

  let model = "deterministic";
  let llmCalls = 0;
  let cacheHit = false;
  if (input.llm?.enabled) {
    try {
      const cachedBatch = input.llm.readCache(annotationHash);
      const batch =
        cachedBatch ??
        (await input.llm.generate({ records, reportFacts: facts(records, diff, input.blueprint) }));
      if (!cachedBatch) input.llm.writeCache(annotationHash, batch);
      cacheHit = Boolean(cachedBatch);
      llmCalls = cacheHit ? 0 : 1;
      model = input.llm.model;
      const byId = new Map(batch.annotations.map((item) => [item.recordId, item]));
      for (const record of records) {
        const next = byId.get(record.id) ?? byId.get(record.canonicalEntityId);
        if (!next?.remark) continue;
        record.annotation = {
          remark: next.remark,
          reasoning: next.reasoning || record.annotation.reasoning,
          confidence: record.confidence,
        };
      }
    } catch {
      model = "deterministic";
      llmCalls = 0;
      cacheHit = false;
    }
  }
  stats.llmCalls = llmCalls;
  stats.llmCacheHit = cacheHit;
  stats.annotationModel = model;

  const report = buildReport({
    blueprint: input.blueprint,
    records,
    diff,
    conflicts,
    stats,
    now: input.now,
    demo: input.demo ?? true,
  });

  return {
    records,
    conflicts,
    diff,
    report,
    stats,
    annotationHash,
    model,
  };
}

function buildEvidence(record: CollectedRecord, collectedAt: string): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const source of record.sources) {
    for (const fieldName of source.fieldNames) {
      const value = record.fields[fieldName];
      if (!value) continue;
      if (source.excerpt && !source.excerpt.toLowerCase().includes(value.toLowerCase()) && !["website", "last_verified", "source_url"].includes(fieldName)) {
        continue;
      }
      items.push({
        id: randomUUID(),
        fieldName,
        value,
        sourceUrl: source.url,
        sourceTitle: source.title,
        excerpt: source.excerpt,
        collectedAt,
        publishedAt: source.publishedAt,
        authority: source.authority,
        confidence: source.authority === "official" ? 0.94 : source.authority === "press" ? 0.78 : 0.74,
      });
    }
  }
  return items;
}

function covers(fields: Record<string, string>, sources: ProvenanceSource[], required: string[]): boolean {
  return required.every((field) => {
    const value = fields[field];
    if (!value || field === "source_url") return true;
    return sources.some((source) => source.excerpt.toLowerCase().includes(value.toLowerCase()));
  });
}

const UNRANKED_FIELDS = new Set(["source_url", "last_verified"]);
const CONTACT_FIELDS = ["email", "phone", "linkedin", "github", "website"];

/** How many details a row has: its search type's fields plus contact paths. Rows with more rank first. */
export function filledCount(fields: Record<string, string>, blueprintFields: string[]): number {
  let count = 0;
  for (const key of new Set([...blueprintFields, ...CONTACT_FIELDS])) {
    if (!UNRANKED_FIELDS.has(key) && fields[key]?.trim()) count += 1;
  }
  return count;
}

function label(record: { fields: Record<string, string> }): string {
  const f = record.fields;
  if (f.person_name) return f.person_name;
  if (f.role_title) return f.company_name ? `${f.role_title} — ${f.company_name}` : f.role_title;
  if (f.paper_title) return f.paper_title;
  return f.company_name || f.event_name || f.program_name || f.product_name || f.segment || "Record";
}

function remarkFor(record: Draft, pending: ConflictDraft[], rank: number, filled: number): PublishedRecord["annotation"] {
  const name = label(record);
  const sources = record.sources.length;
  if (pending.length) {
    const conflict = pending[0];
    return {
      remark: `${name}: ${fieldLabel(conflict?.field ?? "field")} stays "${conflict?.oldValue}" until review. A later source proposes "${conflict?.newValue}".`,
      reasoning: `Rank #${rank}, ${filled} details filled. ${sources} source${sources === 1 ? "" : "s"}. The newer value was not applied because decision confidence is below the auto-resolve threshold.`,
      confidence: record.confidence,
    };
  }
  const detail = record.fields.sponsorship_type
    ? `${record.fields.sponsorship_type} sponsor of ${record.fields.event_name}`
    : record.fields.role_title
      ? record.fields.role_title
      : record.fields.capability || record.fields.category || record.fields.segment || "listed in this collection";
  return {
    remark: `${name} is recorded as ${detail}. Activity score ${record.activityScore.toFixed(2)} from ${sources} source${sources === 1 ? "" : "s"}.`,
    reasoning: `Ranked #${rank}: ${filled} details filled. Ties are broken by activity, from recency ${record.activityComponents.recency}, source coverage ${record.activityComponents.sourceCount}, authority ${record.activityComponents.officialSource}, and freshness ${record.activityComponents.freshness}.`,
    confidence: record.confidence,
  };
}

function summarize(records: PublishedRecord[], merged: number, possible: number, conflicts: ConflictDraft[]): PipelineStats {
  const valid = records.filter((record) => record.validation.valid).length;
  const warnings = records.reduce((sum, record) => sum + record.validation.warnings.length, 0);
  const completeness =
    records.length === 0
      ? 1
      : records.reduce((sum, record) => {
          const values = Object.values(record.fields).filter(Boolean).length;
          const total = Math.max(Object.keys(record.fields).length, 1);
          return sum + values / total;
        }, 0) / records.length;
  const avgFreshness =
    records.length === 0 ? 0 : records.reduce((sum, record) => sum + record.activityComponents.freshness, 0) / records.length;
  const sourceQuality =
    records.length === 0 ? 0 : records.reduce((sum, record) => sum + record.confidenceComponents.sourceAuthority, 0) / records.length;
  const avgConfidence = records.length === 0 ? 0 : records.reduce((sum, record) => sum + record.confidence, 0) / records.length;
  const duplicateRate = records.length + merged === 0 ? 0 : merged / (records.length + merged);
  return {
    records: records.length,
    sources: new Set(records.flatMap((record) => record.sources.map((source) => source.url))).size,
    documents: new Set(records.flatMap((record) => record.sources.map((source) => source.url))).size,
    valid,
    duplicates: merged,
    possibleDuplicates: possible,
    conflicts: conflicts.length,
    pendingConflicts: conflicts.filter((conflict) => conflict.status === "PENDING").length,
    autoResolved: conflicts.filter((conflict) => conflict.status === "AUTO_RESOLVED").length,
    warnings,
    llmCalls: 0,
    llmCacheHit: false,
    annotationModel: "deterministic",
    qualityScore: qualityScore({
      validationRate: records.length ? valid / records.length : 1,
      completeness,
      freshness: avgFreshness,
      sourceQuality,
      duplicateRate,
    }),
    avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    avgFreshness: Math.round(avgFreshness * 1000) / 1000,
  };
}

function facts(records: PublishedRecord[], diff: DiffResult, blueprint: CollectionBlueprint): string {
  const top = records.slice(0, 5).map((record) => `${label(record)} rank ${record.rank} score ${record.activityScore}`);
  return [`intent ${blueprint.intent}`, `records ${records.length}`, ...top, `added ${diff.added.length}`, `changed ${diff.changed.length}`].join("\n");
}

export function deterministicBatch(records: PublishedRecord[], diff: DiffResult, blueprint: CollectionBlueprint): AnnotationBatch {
  const top = records[0];
  const place = blueprint.entities.location ? ` in ${blueprint.entities.location}` : "";
  return {
    summary: top
      ? `${records.length} records matched ${blueprint.intent.replaceAll("_", " ").toLowerCase()}${place}. Highest activity is ${label(top)} at ${top.activityScore.toFixed(2)}.`
      : "No records were collected.",
    observations: [
      diff.firstVersion ? "This is the first snapshot, so there is no prior version to diff." : `${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed.`,
    ],
    annotations: records.map((record) => ({
      recordId: record.canonicalEntityId,
      remark: record.annotation.remark,
      reasoning: record.annotation.reasoning,
      confidence: record.confidence,
    })),
  };
}

function buildReport(input: {
  blueprint: CollectionBlueprint;
  records: PublishedRecord[];
  diff: DiffResult;
  conflicts: ConflictDraft[];
  stats: PipelineStats;
  now: Date;
  demo: boolean;
}): IntelligenceReport {
  const top = input.records.slice(0, 5);
  const place = input.blueprint.entities.location ? ` for ${input.blueprint.entities.location}` : "";
  const lead = top[0];
  const findings = [
    {
      text: `${input.records.length} records are in this snapshot${place}. ${input.stats.valid} passed validation.`,
      evidenceIds: top.flatMap((record) => record.evidence.slice(0, 1).map((item) => item.id)),
    },
  ];
  if (lead) {
    findings.push({
      text: `${label(lead)} ranks first with activity ${lead.activityScore.toFixed(2)} across ${lead.sourceCount} sources.`,
      evidenceIds: lead.evidence.slice(0, 3).map((item) => item.id),
    });
  }
  if (!input.diff.firstVersion) {
    findings.push({
      text: `Since the previous snapshot: ${input.diff.added.length} added, ${input.diff.changed.length} changed, ${input.diff.removed.length} removed, ${input.conflicts.length} conflicts.`,
      evidenceIds: input.conflicts.flatMap((conflict) => [conflict.newEvidence?.id, conflict.oldEvidence?.id].filter((id): id is string => Boolean(id))),
    });
  }
  const date = input.now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const definition = intentDefinition(input.blueprint.intent);
  return {
    title: input.blueprint.entities.category
      ? `${input.blueprint.entities.category === "technology" ? "Technology" : input.blueprint.entities.category} intelligence`
      : "Collection intelligence",
    generatedAt: input.now.toISOString(),
    demo: input.demo,
    summary: deterministicBatch(input.records, input.diff, input.blueprint).summary,
    findings,
    annotations: input.records.map((record) => ({
      recordId: record.id,
      remark: record.annotation.remark,
      reasoning: record.annotation.reasoning,
      confidence: record.annotation.confidence,
    })),
    topRecords: top.map((record) => ({
      canonicalEntityId: record.canonicalEntityId,
      label: label(record),
      rank: record.rank,
      reason: record.annotation.reasoning,
    })),
    changes: {
      firstVersion: input.diff.firstVersion,
      added: input.diff.added.length,
      removed: input.diff.removed.length,
      changed: input.diff.changed.length,
      unchanged: input.diff.unchanged.length,
      conflicts: input.conflicts.length,
    },
    methodology: [
      `Intent: ${definition.id}. ${definition.description}`,
      `Sources: ${input.blueprint.sources.join(", ")}.`,
      `Validation required ${definition.requiredFields.join(", ")}.`,
      `Deduplication key: ${definition.identityFields.join(" + ")}.`,
      `Ranking: activity = recency 0.40 + source count 0.20 + official source 0.20 + freshness 0.20.`,
      `Conflicts on ${definition.protectedFields.join(", ") || "no protected fields"} use a typed decision. Auto-apply only at confidence ≥ 0.85.`,
    ],
    limitations: [
      `Results reflect sources collected on ${date}. Absence from the dataset does not establish that an organization is inactive.`,
      input.demo
        ? "This run used the demo source adapter. Records are deterministic sample data and are not a live reading of the public web."
        : "Only sources the adapters successfully fetched are included.",
    ],
    sources: uniqueSources(input.records),
  };
}

function uniqueSources(records: PublishedRecord[]): IntelligenceReport["sources"] {
  const seen = new Map<string, IntelligenceReport["sources"][number]>();
  for (const record of records) {
    for (const source of record.sources) {
      if (seen.has(source.url)) continue;
      seen.set(source.url, {
        title: source.title,
        url: source.url,
        collectedAt: source.publishedAt,
        purpose: source.sourceType.replaceAll("_", " "),
        demo: source.demo,
      });
    }
  }
  return [...seen.values()];
}

export function renderCsv(records: PublishedRecord[], fields: string[]): string {
  const columns = ["record_id", "rank", ...fields, "confidence", "activity_score", "status", "collected_at"];
  const lines = [columns.join(",")];
  for (const record of records) {
    const collected = record.evidence[0]?.collectedAt ?? "";
    const values = [
      record.canonicalEntityId,
      String(record.rank),
      ...fields.map((field) => record.fields[field] ?? ""),
      String(record.confidence),
      String(record.activityScore),
      record.status,
      collected,
    ];
    lines.push(values.map(csvCell).join(","));
  }
  return lines.join("\n");
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function renderReportHtml(report: IntelligenceReport): string {
  const finding = report.findings
    .map((item, index) => `<li>${escapeHtml(item.text)} <sup>[${index + 1}]</sup></li>`)
    .join("");
  const sources = report.sources
    .map(
      (source, index) =>
        `<li id="src-${index + 1}"><strong>${escapeHtml(source.title)}</strong> — <span>${escapeHtml(source.url)}</span></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<title>${escapeHtml(report.title)}</title>
<style>
  body { font-family: Georgia, serif; color: #1b1916; margin: 48px auto; max-width: 760px; line-height: 1.5; }
  h1 { font-family: Inter, Helvetica, sans-serif; font-weight: 560; letter-spacing: -0.03em; }
  .meta { font-family: ui-monospace, monospace; font-size: 12px; color: #6f6a62; }
  li { margin: 8px 0; }
</style>
<h1>${escapeHtml(report.title)}</h1>
<p class="meta">Generated ${escapeHtml(report.generatedAt)}${report.demo ? " · Demo data" : ""}</p>
<h2>Executive summary</h2>
<p>${escapeHtml(report.summary)}</p>
<h2>Key findings</h2>
<ol>${finding}</ol>
<h2>Methodology</h2>
<ul>${report.methodology.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
<h2>Limitations</h2>
<ul>${report.limitations.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
<h2>Source registry</h2>
<ol>${sources}</ol>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function collectionPlan(blueprint: CollectionBlueprint, estimate: { records: number; sources: number }, llmEnabled: boolean) {
  const definition = intentDefinition(blueprint.intent);
  return {
    sourceTypes: blueprint.sources,
    maxRecords: estimate.records,
    fields: blueprint.fields.length,
    dedupe: definition.identityFields.join(" + "),
    rank: definition.rankingStrategy,
    annotate: llmEnabled ? "1 batched annotation pass" : "Deterministic annotations (LLM off)",
    conflictPolicy: "Typed decision, auto-apply at 0.85, otherwise human review",
    estimatedLlmCalls: llmEnabled ? 1 : 0,
    estimatedSources: estimate.sources,
    estimatedRecords: estimate.records,
    estimatedCost: "Not available",
  };
}
