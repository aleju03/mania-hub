import { calculateStableAccuracy, getScoreHitCounts } from "../shared/score.js";
import type { OsuScoreStatistics } from "../shared/types.js";
import type { VibroAnalysis, VibroReason, VibroSection } from "./vibro-sections.js";

const CLEAR_EVIDENCE_PATTERNS: ReadonlySet<VibroReason> = new Set([
  "dense_chord_repetition",
  "sustained_chords",
]);

// Anything dense enough to read as a repeated chord at an uprate will touch the
// per-finger ceiling somewhere, and merged sections carry the union of their
// reasons, so a one-second brush against a limit inside a twelve-second chord
// passage looks exactly like a chart built out of limit breaches. Weigh the
// ceiling evidence by what it covers on its own instead. Measured on the report
// fixtures: the incidental case covers 2.2% of a chart, the charts that are
// actually made of it cover 15% and up.
const INCIDENTAL_REASON_SHARE = 0.05;
const INCIDENTAL_CEILING_REASONS: ReadonlySet<VibroReason> = new Set([
  "finger_rate_ceiling", "hand_action_ceiling",
]);

/** Pattern gate only; the caller still requires a PP-backed uprate, a clean
 * base chart, valid structure and qualifying judgement/window evidence. */
export function hasOnlyClearEvidencePatterns(
  sections: readonly VibroSection[],
  reasonShares: VibroAnalysis["reasonShares"] = {},
): boolean {
  if (sections.length === 0) return false;
  const reasons = new Set<VibroReason>();
  for (const section of sections) {
    if (section.reasons.length === 0) return false;
    for (const reason of section.reasons) reasons.add(reason);
  }
  if (![...reasons].some((reason) => CLEAR_EVIDENCE_PATTERNS.has(reason))) return false;
  let ceilingShare = 0;
  for (const reason of reasons) {
    if (CLEAR_EVIDENCE_PATTERNS.has(reason)) continue;
    // Walls, rolls, isolated jacks and split doubles remain hard evidence,
    // even when brief. Only the two empirical ceilings can be incidental.
    if (!INCIDENTAL_CEILING_REASONS.has(reason)) return false;
    // Summing is a conservative upper bound on their combined coverage;
    // separate kinds of breaches must not each get their own 5% allowance.
    ceilingShare += reasonShares[reason] ?? 1;
  }
  return ceilingShare <= INCIDENTAL_REASON_SHARE;
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
 * PP-backed uprate of a clean base chart with dense-chord detections and at
 * most incidental ceiling evidence (never explicit wall/jack/roll evidence).
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
