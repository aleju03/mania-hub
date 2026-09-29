// The rating tiebreak on 4K LN identity.
// Structure decides whether a chart is LN first (dan-estimator/ln-effective).
// A chart past the hold-share line whose structural share still falls short
// is LN anyway when its LN work is the harder half: its LN rating sits at
// least LN_RATING_IDENTITY_MARGIN above native MSD Overall at the same rate.
import type { ManiaBeatmap } from "../chart/beatmap";
import { LN_EFFECTIVE_KEY_COUNTS, LN_EFFECTIVE_MIN_RATIO, analyzeEffectiveLn, chartIsLn } from "../dan-estimator/ln-effective";
import { lnPrimaryMinRatioFor } from "../dan-estimator/ln";
import { analyzeLnSkill } from "../ln/skill";

// Why a rating and not one more structural reading: take a 160 BPM chart of
// 1/4 and 1/2 holds with 1/4 same-lane gaps, half inverse and half minijacks
// under a held note. At 1.5x it plays as LN. A 1/4-held jumpstream chart and a
// full-LN roll at the same rate play as jumpstream. Every structural number
// (long share, chain share, notes under an active hold, occupancy) puts the
// first chart at or below the other two; only the ratings order them (LN
// rating minus Overall: +3.0 against -0.2 and -5.0).
//
// When the rating decides, lnEffectiveRatio is lifted to the identity line so
// that one share keeps answering every consumer; lnStructuralRatio keeps the
// measured number and lnRatingIdentity records that the rating decided.
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
  /** Holds carrying identity work over all holds (ln-effective). */
  lnWorkShare?: number;
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
  const ln = Number(ratings.lnRating);
  const overall = Number(ratings.overall);
  if (!ratings.rated || !Number.isFinite(ln) || !Number.isFinite(overall) || !(ln >= overall + LN_RATING_IDENTITY_MARGIN)) return base;
  return { lnEffectiveRatio: LN_EFFECTIVE_MIN_RATIO, lnRatingIdentity: true, lnStructuralRatio: base.lnEffectiveRatio };
}

/**
 * Identity from the notes: the structural share, then the tiebreak against
 * native Overall when the caller has it. With `overall` null, structure alone
 * decides; callers fetch MSD for charts in the undecided band before calling.
 */
export function resolveChartLnIdentity(
  map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">,
  options: { rate: number; od?: number | null; holdRatio?: number | null; overall: number | null | undefined },
): LnIdentityResolution & { holdRatio: number } {
  const od = options.od ?? map.od;
  const analysis = analyzeEffectiveLn(map.notes, { rate: options.rate, od, keyCount: map.keyCount });
  const holdRatio = options.holdRatio != null && Number.isFinite(Number(options.holdRatio)) ? Number(options.holdRatio) : analysis.holdRatio;
  const shares = { lnRatio: holdRatio, lnEffectiveRatio: analysis.effectiveLnRatio };
  const lnWorkShare = analysis.identityWorkShare;
  if (!lnRatingIdentityUndecided(map.keyCount, shares) || options.overall == null) {
    return { holdRatio, lnEffectiveRatio: analysis.effectiveLnRatio, lnRatingIdentity: false, lnWorkShare };
  }
  const skill = analyzeLnSkill(map, { rate: options.rate, od });
  return {
    holdRatio,
    lnWorkShare,
    ...resolveLnIdentityShare(map.keyCount, shares, { lnRating: skill?.rating, rated: skill?.rated === true, overall: options.overall }),
  };
}
