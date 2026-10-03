import type { ManiaBeatmap } from "../chart/beatmap";
import {
  LN_EFFECTIVE_KEY_COUNTS, LN_EFFECTIVE_MIN_RATIO, LN_SAME_MOTION_TOLERANCE_MS, LN_TRACKED_MIN_SHARE, analyzeEffectiveLn, chartIsLn,
} from "../dan-estimator/ln-effective";
import { lnPrimaryMinRatioFor } from "../dan-estimator/ln";
import { lnSkillOfWorkload } from "../ln/skill";
import { buildLnWorkload, type LnWorkload } from "../ln/workload";

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
 * other two; only the ratings order them (+3.0 against -0.2 and -5.0 then,
 * +7.5 against +5.1 and +1.8 on the score-fitted LN scale). Since the tap
 * gate (LN_TRACKED_MIN_SHARE) the other two stay rice before the rating is
 * read, as does any chart whose holds are tapped through, one whose
 * heaviest sections pin no finger (LN_HELD_PEAK_QUANTILE), and one that
 * only same-lane chains lift past the tap gate while its hardest stretches
 * hold nothing through other presses (LN_HELD_THROUGH_MIN_SHARE).
 *
 * The stored `lnEffectiveRatio` is lifted to the identity line so the one
 * stored share keeps answering every consumer; `lnStructuralRatio` keeps the
 * measured number and `lnRatingIdentity` says the rating decided.
 */
export const LN_RATING_IDENTITY_MARGIN = 1;

/**
 * The chain exemption lifts the tap gate on a chart whose chained short
 * holds are a tenth of its notes (dan-estimator/ln-effective.ts), and the
 * rating then prices every one of those holds. On a jumpstream written in
 * holds, each held until the next row's press, that read 6 points over
 * Overall at 1.5x on a chart labeled fast jumpstream. What the chains
 * labeled LN have and that chart lacks is a finger held down while the other
 * columns press on two or more separate rows.
 *
 * Read on the hardest fifth of the chart's 2s windows (by the workload's
 * demand), as a share of their notes, since a hybrid's LN sits in its
 * hardest stretches and its rice elsewhere dilutes a whole-chart share. A
 * chart under the tap line whose share is under LN_HELD_THROUGH_MIN_SHARE
 * stays rice, however its rating compares to Overall.
 *
 * Fitted 2026-10-03 on hand-labeled charts. Among the charts only chains lift
 * past the tap line, the rice labels read 0.000 to 0.018 and the LN labels
 * 0.026 and up; charts past the tap line (holds a tap cannot release, 0.10+)
 * are untouched, so slow hold-and-release charts and LN walls whose holds
 * span one press row stay LN. Over the cached 4K charts it returns 23 of 662
 * tiebreak LN verdicts to rice, and no labeled LN play.
 */
export const LN_HELD_THROUGH_MIN_SHARE = 0.022;
export const LN_HELD_THROUGH_MIN_ROWS = 2;
const HELD_THROUGH_WINDOW_MS = 2000;
const HELD_THROUGH_TOP_SHARE = 0.2;
const HELD_THROUGH_MIN_NOTES = 4;

/** See LN_HELD_THROUGH_MIN_SHARE: in the hardest fifth of the 2s windows, the
 * share of notes that are holds kept down through other columns' presses on
 * LN_HELD_THROUGH_MIN_ROWS separate rows. */
export function lnHeldThroughShare(workload: LnWorkload): number {
  const objects = [...workload.timeline.objects].sort((a, b) => a.startMs - b.startMs);
  if (!objects.length || !workload.sections.length) return 0;
  const origin = objects[0].startMs;
  const windows = new Map<number, { notes: number; held: number; demand: number }>();
  const windowAt = (timeMs: number) => {
    const key = Math.floor((timeMs - origin) / HELD_THROUGH_WINDOW_MS);
    let window = windows.get(key);
    if (!window) windows.set(key, window = { notes: 0, held: 0, demand: 0 });
    return window;
  };
  const tolerance = LN_SAME_MOTION_TOLERANCE_MS;
  objects.forEach((object, index) => {
    const window = windowAt(object.startMs);
    window.notes += 1;
    if (object.kind !== "hold") return;
    const rows = new Set<number>();
    for (let next = index + 1; next < objects.length && objects[next].startMs < object.endMs - tolerance; next += 1) {
      const other = objects[next];
      if (other.lane !== object.lane && other.startMs > object.startMs + tolerance) rows.add(Math.round(other.startMs));
    }
    if (rows.size >= LN_HELD_THROUGH_MIN_ROWS) window.held += 1;
  });
  // Section times count from the first row with a head (ln-workload.ts).
  const sectionOrigin = objects.find((object) => object.kind === "hold")?.startMs ?? origin;
  for (const section of workload.sections) {
    const window = windowAt(sectionOrigin + section.timeMs);
    window.demand = Math.max(window.demand, section.demand);
  }
  const ranked = [...windows.values()].filter((window) => window.notes >= HELD_THROUGH_MIN_NOTES).sort((a, b) => b.demand - a.demand);
  const top = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * HELD_THROUGH_TOP_SHARE)));
  const notes = top.reduce((sum, window) => sum + window.notes, 0);
  return notes > 0 ? top.reduce((sum, window) => sum + window.held, 0) / notes : 0;
}

export interface LnIdentityShares {
  lnRatio: number | null | undefined;
  lnEffectiveRatio?: number | null | undefined;
  /** Its holds are tapped through (ln-effective.ts); the rating cannot make it LN. */
  lnTapCovered?: boolean;
  /** Its heaviest sections hold no finger down (ln-effective.ts); the rating cannot make it LN. */
  lnHeldPeakLight?: boolean;
}

export interface LnIdentityResolution {
  lnEffectiveRatio: number | undefined;
  lnRatingIdentity: boolean;
  /** The measured share when the rating lifted it; absent otherwise. */
  lnStructuralRatio?: number;
  /** Holds carrying identity work over all holds (ln-effective.ts). */
  lnWorkShare?: number;
  lnRiceShare?: number;
}

/** Whether the rating tiebreak can still change this chart's identity. */
export function lnRatingIdentityUndecided(keyCount: number | null | undefined, shares: LnIdentityShares): boolean {
  if (keyCount == null || !LN_EFFECTIVE_KEY_COUNTS.has(keyCount) || shares.lnTapCovered === true || shares.lnHeldPeakLight === true) return false;
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
  // One workload answers the structure, the rice share and the rating, the
  // rating on the pricing the tiebreak lines were drawn on (ln-workload.ts).
  const workload = buildLnWorkload(map, { rate: options.rate, od, pricing: "identity" });
  const valid = workload?.timeline.valid === true;
  const analysis = valid ? workload.effective : analyzeEffectiveLn(map.notes, { rate: options.rate, od, keyCount: map.keyCount });
  const holdRatio = options.holdRatio != null && Number.isFinite(Number(options.holdRatio)) ? Number(options.holdRatio) : analysis.holdRatio;
  const shares = { lnRatio: holdRatio, lnEffectiveRatio: analysis.effectiveLnRatio, lnTapCovered: analysis.tapCovered, lnHeldPeakLight: analysis.heldPeakLight };
  const measured = { holdRatio, lnWorkShare: analysis.identityWorkShare, lnRiceShare: valid ? workload.riceShare : undefined };
  const chainsOnly = analysis.trackedShare < LN_TRACKED_MIN_SHARE;
  if (!workload || !lnRatingIdentityUndecided(map.keyCount, shares) || options.overall == null
    || (chainsOnly && lnHeldThroughShare(workload) < LN_HELD_THROUGH_MIN_SHARE)) {
    return { ...measured, lnEffectiveRatio: analysis.effectiveLnRatio, lnRatingIdentity: false };
  }
  const skill = lnSkillOfWorkload(map, workload, { includeSkillsets: false });
  return { ...measured, ...resolveLnIdentityShare(map.keyCount, shares, { lnRating: skill.rating, rated: skill.rated, overall: options.overall }) };
}
