import type { ManiaBeatmap } from "./beatmap-parser.js";
import { LN_EFFECTIVE_KEY_COUNTS, LN_EFFECTIVE_MIN_RATIO, analyzeEffectiveLn, chartIsLn } from "./dan-estimator/ln-effective.js";
import { lnPrimaryMinRatioFor } from "./dan-estimator/ln.js";
import { analyzeLnSkill } from "./ln-skill.js";

/**
 * The rating tiebreak on 4K LN identity.
 *
 * Structure decides identity first (dan-estimator/ln-effective.ts). A chart
 * past the 45% hold line whose section shares fall short can still be LN
 * when its LN work is the harder half: the independent LN rating at least
 * LN_RATING_IDENTITY_MARGIN above native Overall at the same rate.
 *
 * Why a rating and not another structural reading (2026-09-18): a 160 bpm
 * chart of 1/4 and 1/2 holds with 1/4 same-lane gaps, half inverse and half
 * minijacks under a held note, is LN at 1.5x to anyone who plays it, while
 * a 1/4-held jumpstream chart and a full-LN roll at the same rate play as
 * jumpstream. Every structural number (long share, chain share, notes
 * under an active hold, occupancy) puts the first chart at or below the
 * other two; only the ratings order them (+3.0 against -0.2 and -5.0).
 *
 * The stored `lnEffectiveRatio` is lifted to the identity line so the one
 * stored share keeps answering every consumer; `lnStructuralRatio` keeps the
 * measured number and `lnRatingIdentity` says the rating decided.
 */
export const LN_RATING_IDENTITY_MARGIN = 1;

export interface LnIdentityShares {
  lnRatio: number | null | undefined;
  lnEffectiveRatio?: number | null | undefined;
}

export interface LnIdentityResolution {
  lnEffectiveRatio: number | undefined;
  lnRatingIdentity: boolean;
  /** The measured share when the rating lifted it; absent otherwise. */
  lnStructuralRatio?: number;
}

/** Whether the rating tiebreak can still change this chart's identity. */
export function lnRatingIdentityUndecided(keyCount: number | null | undefined, shares: LnIdentityShares): boolean {
  if (keyCount == null || !LN_EFFECTIVE_KEY_COUNTS.has(keyCount)) return false;
  const effective = shares.lnEffectiveRatio == null ? Number.NaN : Number(shares.lnEffectiveRatio);
  const hold = shares.lnRatio == null ? Number.NaN : Number(shares.lnRatio);
  if (!Number.isFinite(effective) || !Number.isFinite(hold)) return false;
  return hold >= lnPrimaryMinRatioFor(keyCount) && chartIsLn(keyCount, shares) !== true;
}

/** Apply the tiebreak to a measured share, given the two ratings at the same rate. */
export function resolveLnIdentityShare(
  keyCount: number | null | undefined,
  shares: LnIdentityShares,
  ratings: { lnRating: number | null | undefined; rated: boolean; overall: number | null | undefined },
): LnIdentityResolution {
  const effective = shares.lnEffectiveRatio == null ? undefined : Number(shares.lnEffectiveRatio);
  const base: LnIdentityResolution = { lnEffectiveRatio: Number.isFinite(effective) ? effective : undefined, lnRatingIdentity: false };
  if (!lnRatingIdentityUndecided(keyCount, shares)) return base;
  // Number(null) is 0, which would read a missing Overall as a chart with no rice.
  if (ratings.lnRating == null || ratings.overall == null) return base;
  const ln = Number(ratings.lnRating), overall = Number(ratings.overall);
  if (!ratings.rated || !Number.isFinite(ln) || !Number.isFinite(overall) || !(ln >= overall + LN_RATING_IDENTITY_MARGIN)) return base;
  return { lnEffectiveRatio: LN_EFFECTIVE_MIN_RATIO, lnRatingIdentity: true, lnStructuralRatio: base.lnEffectiveRatio };
}

/**
 * Identity from the notes: the structural share, then the tiebreak against
 * native Overall when the caller holds it. `overall` null leaves structure
 * in charge; the classifier's async adapter obtains MSD for the undecided
 * band before it gets here.
 */
export function resolveChartLnIdentity(
  map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">,
  options: { rate: number; od?: number | null; holdRatio?: number | null; overall: number | null | undefined },
): LnIdentityResolution & { holdRatio: number } {
  const od = options.od ?? map.od;
  const analysis = analyzeEffectiveLn(map.notes, { rate: options.rate, od });
  const holdRatio = options.holdRatio != null && Number.isFinite(Number(options.holdRatio)) ? Number(options.holdRatio) : analysis.holdRatio;
  const shares = { lnRatio: holdRatio, lnEffectiveRatio: analysis.effectiveLnRatio };
  if (!lnRatingIdentityUndecided(map.keyCount, shares) || options.overall == null) {
    return { holdRatio, lnEffectiveRatio: analysis.effectiveLnRatio, lnRatingIdentity: false };
  }
  const skill = analyzeLnSkill(map, { rate: options.rate, od });
  return { holdRatio, ...resolveLnIdentityShare(map.keyCount, shares, { lnRating: skill?.rating, rated: skill?.rated === true, overall: options.overall }) };
}
