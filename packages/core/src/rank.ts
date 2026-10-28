import type { CollectionBlueprint } from "@dig/schemas";
import { clamp, daysBetween, round4 } from "./util.js";
import type { ProvenanceSource } from "./types.js";

export interface ScoreParts {
  recency: number;
  sourceCount: number;
  officialSource: number;
  freshness: number;
}

export interface ConfidenceParts {
  sourceAuthority: number;
  corroboration: number;
  freshness: number;
  extractionQuality: number;
}

export function authorityScore(authority: ProvenanceSource["authority"]): number {
  if (authority === "official") return 1;
  if (authority === "press") return 0.74;
  return 0.62;
}

export function scoreRecord(input: {
  sources: ProvenanceSource[];
  fields: Record<string, string>;
  blueprint: CollectionBlueprint;
  now: Date;
  excerptsCoverValues: boolean;
}): { activityScore: number; activity: ScoreParts; confidence: number; confidenceParts: ConfidenceParts } {
  const newest = input.sources.reduce((best, source) => {
    const time = Date.parse(source.publishedAt);
    if (Number.isNaN(time)) return best;
    return time > best ? time : best;
  }, 0);
  const recency = round4(newest ? clamp(1 - daysBetween(new Date(newest).toISOString(), input.now) / 200, 0.15, 1) : 0.4);
  const officialSource = round4(
    Math.max(...input.sources.map((source) => authorityScore(source.authority)), 0.4),
  );
  const hasOfficial = officialSource >= 0.95;
  const sourceCount = round4(
    input.sources.length >= 3
      ? 1
      : input.sources.length === 2
        ? (hasOfficial ? 0.88 : 0.75)
        : (hasOfficial ? 0.72 : 0.45),
  );
  const verified = input.fields.last_verified || input.fields.deadline || input.fields.start_date;
  const age = verified ? daysBetween(verified, input.now) : input.blueprint.freshness.maxAgeDays;
  const freshness = round4(clamp(1 - age / (input.blueprint.freshness.maxAgeDays * 1.25), 0.2, 1));
  const activity: ScoreParts = { recency, sourceCount, officialSource, freshness };
  const activityScore = round4(recency * 0.4 + sourceCount * 0.2 + officialSource * 0.2 + freshness * 0.2);
  const extractionQuality = input.excerptsCoverValues ? 0.9 : 0.62;
  const confidenceParts: ConfidenceParts = {
    sourceAuthority: officialSource,
    corroboration: sourceCount,
    freshness,
    extractionQuality,
  };
  const confidence = round4(
    officialSource * 0.35 + sourceCount * 0.25 + freshness * 0.2 + extractionQuality * 0.2,
  );
  return { activityScore, activity, confidence, confidenceParts };
}

export function qualityScore(input: {
  validationRate: number;
  completeness: number;
  freshness: number;
  sourceQuality: number;
  duplicateRate: number;
}): number {
  const score =
    input.validationRate * 0.3 +
    input.completeness * 0.2 +
    input.freshness * 0.2 +
    input.sourceQuality * 0.2 +
    (1 - input.duplicateRate) * 0.1;
  return Math.round(score * 100);
}
