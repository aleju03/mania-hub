import { calculateStableAccuracy, getScoreHitCounts } from "../shared/score.js";
import type { OsuScoreStatistics } from "../shared/types.js";
import type { VibroReason, VibroSection } from "./vibro-sections.js";

const CLEAR_EVIDENCE_PATTERNS: ReadonlySet<VibroReason> = new Set([
  "dense_chord_repetition",
  "sustained_chords",
]);

/** Pattern gate only; the caller still requires a PP-backed uprate, a clean
 * base chart, valid structure and qualifying judgement/window evidence. */
export function hasOnlyClearEvidencePatterns(sections: readonly VibroSection[]): boolean {
  return sections.length > 0 && sections.every((section) => section.reasons.length > 0
    && section.reasons.every((reason) => CLEAR_EVIDENCE_PATTERNS.has(reason)));
}

export interface VibroClearEvidence {
  version: 1;
  stableAccuracy: number;
  /** Null denotes a positive MAX count with no possible 300s. */
  max300Ratio: number | null;
  ratioIsLowerBound: boolean;
  od: number;
  /** Keep exact evidence after the source score ages out. */
  statistics?: OsuScoreStatistics;
}

export type VibroClearEvidenceSummary = Omit<VibroClearEvidence, "statistics">;

export interface VibroClearInput {
  statistics?: OsuScoreStatistics;
  stableAccuracy?: number | null;
  customAccuracy?: number | null;
  missShare?: number | null;
  widenedWindows: boolean;
}

/** A score-quality exception, not a claim that judgements prove hand technique.
 * This checks the score evidence only. The caller must also require a
 * PP-backed uprate of a clean base chart with dense-chord-only detections.
 * Applies at the player layer only; chart classification never reads this. */
export function assessVibroClear(input: VibroClearInput, od: number): VibroClearEvidence | undefined {
  if (!Number.isFinite(od) || od < 9 || input.widenedWindows !== false) return undefined;
  const counts = getScoreHitCounts({ statistics: input.statistics ?? {} });
  const values = Object.values(counts);
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total > 0) {
    const stableAccuracy = calculateStableAccuracy(input.statistics!);
    if (stableAccuracy < 0.95 || counts.max <= 0 || counts.max < 2 * counts.great) return undefined;
    return {
      version: 1, stableAccuracy, od,
      max300Ratio: counts.great > 0 ? counts.max / counts.great : null,
      ratioIsLowerBound: false,
      statistics: { perfect: counts.max, great: counts.great, good: counts.good,
        ok: counts.ok, meh: counts.meh, miss: counts.miss },
    };
  }

  // Older durable plays kept three judgement-derived summaries, not counts.
  // 320*custom - 300*stable = 20*MAX share exactly. Known misses account
  // for their own loss; every other non-MAX/non-300 costs at most 5/6.
  // This gives an UPPER bound on 300 share, hence a LOWER bound on MAX:300.
  // Never substitute displayed accuracy or infer an exact judgement split.
  const stable = input.stableAccuracy;
  const custom = input.customAccuracy;
  const misses = input.missShare;
  if (typeof stable !== "number" || typeof custom !== "number" || typeof misses !== "number"
    || ![stable, custom, misses].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    || stable < 0.95) return undefined;
  const maxShare = (320 * custom - 300 * stable) / 20;
  const loss = 1 - stable;
  const epsilon = 1e-9;
  if (maxShare <= 0 || maxShare > stable + epsilon || maxShare + misses > 1 + epsilon
    || misses > loss + epsilon) return undefined;
  const otherShareMin = Math.max(0, (loss - misses) / (5 / 6));
  const greatShareMax = 1 - maxShare - misses - otherShareMin;
  if (greatShareMax < -epsilon || maxShare + epsilon < 2 * Math.max(0, greatShareMax)) return undefined;
  return {
    version: 1, stableAccuracy: stable, od, ratioIsLowerBound: true,
    max300Ratio: greatShareMax > epsilon ? maxShare / greatShareMax : null,
  };
}

export function summarizeVibroClear(evidence: VibroClearEvidence): VibroClearEvidenceSummary {
  const { statistics: _statistics, ...summary } = evidence;
  return summary;
}
