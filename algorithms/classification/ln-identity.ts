import type { ManiaBeatmap } from "../chart/beatmap";
import { LN_EFFECTIVE_KEY_COUNTS, LN_EFFECTIVE_MIN_RATIO, LN_SAME_MOTION_TOLERANCE_MS, LN_TRACKED_MIN_SHARE, analyzeEffectiveLn, chartIsLn } from "../dan-estimator/ln-effective";
import { lnPrimaryMinRatioFor } from "../dan-estimator/ln";
import { lnSkillOfWorkload } from "../ln/skill";
import { buildLnWorkload, type LnWorkload } from "../ln/workload";

export const LN_RATING_IDENTITY_MARGIN = 1;

export const LN_HELD_THROUGH_MIN_SHARE = 0.022;
export const LN_HELD_THROUGH_MIN_ROWS = 2;
const HELD_THROUGH_WINDOW_MS = 2000;
const HELD_THROUGH_TOP_SHARE = 0.2;
const HELD_THROUGH_MIN_NOTES = 4;

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
  lnTapCovered?: boolean;
  lnHeldPeakLight?: boolean;
}

export interface LnIdentityResolution {
  lnEffectiveRatio: number | undefined;
  lnRatingIdentity: boolean;
  lnStructuralRatio?: number;
  lnWorkShare?: number;
  lnRiceShare?: number;
}

export function lnRatingIdentityUndecided(keyCount: number | null | undefined, shares: LnIdentityShares): boolean {
  if (keyCount == null || !LN_EFFECTIVE_KEY_COUNTS.has(keyCount) || shares.lnTapCovered === true || shares.lnHeldPeakLight === true) return false;
  const effective = shares.lnEffectiveRatio == null ? Number.NaN : Number(shares.lnEffectiveRatio);
  const hold = shares.lnRatio == null ? Number.NaN : Number(shares.lnRatio);
  if (!Number.isFinite(effective) || !Number.isFinite(hold)) return false;
  return hold >= lnPrimaryMinRatioFor(keyCount) && chartIsLn(keyCount, shares) !== true;
}

export function resolveLnIdentityShare(
  keyCount: number | null | undefined,
  shares: LnIdentityShares,
  ratings: { lnRating: number | null | undefined; rated: boolean; overall: number | null | undefined },
): LnIdentityResolution {
  const effective = shares.lnEffectiveRatio == null ? undefined : Number(shares.lnEffectiveRatio);
  const base: LnIdentityResolution = { lnEffectiveRatio: Number.isFinite(effective) ? effective : undefined, lnRatingIdentity: false };
  if (!lnRatingIdentityUndecided(keyCount, shares)) return base;
  if (ratings.lnRating == null || ratings.overall == null) return base;
  const ln = Number(ratings.lnRating), overall = Number(ratings.overall);
  if (!ratings.rated || !Number.isFinite(ln) || !Number.isFinite(overall) || !(ln >= overall + LN_RATING_IDENTITY_MARGIN)) return base;
  return { lnEffectiveRatio: LN_EFFECTIVE_MIN_RATIO, lnRatingIdentity: true, lnStructuralRatio: base.lnEffectiveRatio };
}

export function resolveChartLnIdentity(
  map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">,
  options: { rate: number; od?: number | null; holdRatio?: number | null; overall: number | null | undefined },
): LnIdentityResolution & { holdRatio: number } {
  const od = options.od ?? map.od;
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
