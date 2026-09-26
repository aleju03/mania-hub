// The independent 4K LN difficulty number. It reads the exact LN timeline,
// drops holds that demand no release at the played rate and OD, and prices
// what is left (releases, same-hand held-finger coordination, hold starts,
// release-to-repress recovery) as two hand strains. It does not read MinaCalc,
// dan verdicts, pp or any chart identity. Only 4K has a fitted scale.

import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { analyzeEffectiveLn, chartIsLn, effectiveHoldMask, LN_MIN_WORK_SHARE, LN_SAME_MOTION_TOLERANCE_MS } from "../dan-estimator/ln-effective";
import { lnPrimaryMinRatioFor } from "../dan-estimator/ln";
import { buildLnTimeline4K } from "./timeline";

export const LN_SKILL_KEY_COUNTS: ReadonlySet<number> = new Set([4]);

/** Chart difficulty is the skill at which the LN sections reach this score. */
export const LN_SKILL_SCORE_GOAL = 0.93;

/**
 * Strain-to-rating scale: rating = scale * strain^exponent. Fitted on the
 * nine odd-level 4K LN dan courses against native MinaCalc Overall, with the
 * eight even-level courses held out as a check; this only aligns the number
 * range with native MSD. On all 17 courses the resulting order has Spearman
 * 0.990 against course level, and the held-out even courses sit 1.35 MSD
 * from native Overall on average. The scale does not transfer to other
 * keymodes, which keep Overall as their LN axis.
 */
export const LN_SKILL_SCALE = 3.9707727589870347;
export const LN_SKILL_EXPONENT = 0.548325895663114;

/**
 * How the rating responds to playback rate on a chart whose holds all keep
 * their work: rating ~ rate^0.77. Strain grows linearly with rate (the same
 * impulses land 1.5x as often under a fixed half-life), so the scale alone
 * would answer as rate^0.55 and price HT and DT plays too close to their
 * 1.0x chart. Native 4K Overall on 150 LN charts with DT and HT ratings
 * moves as rate^0.75 at 1.5x and rate^0.80 at 0.75x, and LN
 * sits on that scale, so it follows the same curve. 1.0x ratings are
 * unaffected. Holds a rate makes free are still stripped first, so a DT
 * rating can stay under Overall when the chart's short holds turn into taps.
 */
export const LN_SKILL_RATE_RESPONSE = 0.77;

/**
 * Weight of the chart's hardest half-second against the skill that reaches
 * the score goal over the whole chart (a geometric mean of the two). The goal
 * skill alone averages the 93% over everything, so a long chart with one
 * brutal drop reads like its moderate minutes: a 5:38 chart whose drop peaks
 * at demand 36 solved to 21.3 while a 1:30 chart peaking at 31 solved to
 * 20.3. With the peak at half weight the held-out courses fit better and
 * course order is unchanged; rating only the hardest 30-90 seconds instead
 * put course 16 under course 15, so it stays a blend.
 */
export const LN_SKILL_PEAK_WEIGHT = 0.5;

const SECTION_MS = 500;
/** Hand strain halves every 700 ms without new work. */
const HALF_LIFE_MS = 700;
/** A repress closer than this to the release is the same motion, not recovery. */
const CHORD_TOLERANCE_MS = 5;
/** A repress within this long of the lane's release adds recovery work, falling linearly to zero at 180 ms. */
const RECOVERY_MS = 180;

export interface LnSkillResult {
  keyCount: number;
  /** Null when the chart's topology is invalid (overlaps, taps inside holds, duplicates). */
  rating: number | null;
  /** Unscaled LN strain. */
  strain: number;
  /** LN identity at this rate: the play files under the LN axis and the LN dan. */
  eligible: boolean;
  /** The chart carries enough working holds for its LN number to be shown. */
  rated: boolean;
  holdRatio: number;
  effectiveRatio: number;
  effectiveHolds: number;
  rate: number;
  od: number;
  scoreGoal: number;
}

export function isLnSkillSupported(keyCount: number): boolean {
  return LN_SKILL_KEY_COUNTS.has(keyCount);
}

export function lnSkillCalibrationFor(keyCount: number): { scale: number; exponent: number } {
  if (!isLnSkillSupported(keyCount)) throw new Error("Independent LN skill is only supported for 4K");
  return { scale: LN_SKILL_SCALE, exponent: LN_SKILL_EXPONENT };
}

/**
 * LN rating of a chart at a rate and OD. `scoreGoal` defaults to the chart
 * goal (0.93); a player's LN SSR passes the play's release-aware accuracy
 * instead (see ./ssr). A goal of 0 gives a rating of 0.
 */
export function analyzeLnSkill(
  map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od"> & Partial<Pick<ManiaBeatmap, "bpm" | "timingPoints">>,
  options: { rate?: number; od?: number | null; scoreGoal?: number } = {},
): LnSkillResult | null {
  if (!isLnSkillSupported(map.keyCount)) return null;
  const keyCount = map.keyCount;
  const rate = Number.isFinite(options.rate) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const rawOd = options.od ?? map.od;
  const od = Number.isFinite(rawOd) ? Math.max(0, Math.min(10, rawOd)) : 8;
  const scoreGoal = Number.isFinite(options.scoreGoal)
    ? Math.max(0, Math.min(0.999, Number(options.scoreGoal))) : LN_SKILL_SCORE_GOAL;
  const timeline = buildLnTimeline4K(map.notes, { rate, scoring: { client: "stable-scorev2", od, accuracyGoal: scoreGoal } });
  // Broken topology is reported as unavailable, never repaired.
  if (!timeline.valid) return {
    keyCount, rating: null, strain: 0, eligible: false, rated: false, holdRatio: 0,
    effectiveRatio: 0, effectiveHolds: 0, rate, od, scoreGoal,
  };

  // Deduplicate stacked objects before measuring effort; a simultaneous copy
  // cannot demand another action from the same finger.
  const unique = new Map<string, typeof map.notes[number]>();
  for (const note of map.notes) {
    if (!Number.isFinite(note.time) || !Number.isFinite(note.endTime)
      || !Number.isInteger(note.column) || note.column < 0 || note.column >= keyCount) continue;
    const key = `${note.column}:${note.time}`;
    const previous = unique.get(key);
    if (!previous || note.endTime > previous.endTime) unique.set(key, note);
  }
  const notes = [...unique.values()].sort((a, b) => a.time - b.time || a.column - b.column);
  const effective = analyzeEffectiveLn(notes, { rate, od, keyCount });
  const result: LnSkillResult = {
    keyCount, rating: 0, strain: 0,
    // Identity needs at least one working hold plus the keymode's LN identity
    // rule (on 4K: the 45% hold line and the 0.40 effective share).
    eligible: effective.effectiveHolds > 0 && chartIsLn(keyCount, { lnRatio: effective.holdRatio, lnEffectiveRatio: effective.effectiveLnRatio }) === true,
    // A hold-heavy chart whose bodies are free at this rate still gets an LN
    // number beside its native values; identity alone decides the axis.
    // Holds that are notation (vibro spam, one long hold in a thousand) do
    // not: a tenth of the holds have to be work (LN_MIN_WORK_SHARE).
    rated: effective.effectiveHolds > 0 && effective.holdRatio >= lnPrimaryMinRatioFor(keyCount)
      && effective.identityWorkShare >= LN_MIN_WORK_SHARE,
    holdRatio: effective.holdRatio,
    effectiveRatio: effective.effectiveLnRatio, effectiveHolds: effective.effectiveHolds,
    rate, od, scoreGoal,
  };
  if (!effective.effectiveHolds || scoreGoal === 0) return result;

  // Free holds play as ordinary presses: their head stays an event, their
  // release does not, and they add no release or recovery strain.
  const mask = effectiveHoldMask(notes, { rate, od, keyCount });
  const effectiveNotes = new Set(notes.filter((_note, index) => mask[index]));
  const events: StrainEvent[] = [];
  for (const row of timeline.rows) {
    for (const id of row.tailIds) {
      const note = map.notes[id];
      if (effectiveNotes.has(note)) events.push({ time: row.timeMs, column: note.column, tail: true, hold: true });
    }
    for (const id of [...row.tapIds, ...row.headIds]) {
      const note = map.notes[id];
      events.push({ time: row.timeMs, column: note.column, tail: false, hold: effectiveNotes.has(note),
        end: (note.endTime - timeline.originMs) / rate });
    }
  }

  // The .osu format does not record physical bindings. Even layouts use
  // equal contiguous groups; an odd layout's center belongs to one hand for
  // the whole chart. Both fixed assignments are evaluated and the easier one
  // kept, never double-counting the center or switching hands per event.
  // This also keeps mirrored charts equal.
  const splits = [...new Set([Math.floor(keyCount / 2), Math.ceil(keyCount / 2)])];
  result.strain = Math.min(...splits.map((split) => strainAtSplit(events, keyCount, split, scoreGoal)));
  const calibration = lnSkillCalibrationFor(keyCount);
  result.rating = calibration.scale * Math.pow(result.strain, calibration.exponent)
    * Math.pow(rate, LN_SKILL_RATE_RESPONSE - calibration.exponent);
  return result;
}

export function analyzeLnSkillFromText(osuText: string, options: Parameters<typeof analyzeLnSkill>[1] = {}): LnSkillResult | null {
  return analyzeLnSkill(parseManiaBeatmap(osuText), options);
}

interface StrainEvent { time: number; column: number; tail: boolean; hold: boolean; end?: number }
interface Section { demand: number; weight: number }

/**
 * LN strain for one hand assignment. Each timestamp adds, per hand:
 * - release work: releases^0.7 (a release chord is one motion, staggered
 *   releases are separate impulses), times 1 + 0.3 per finger held through it;
 * - coordination: 0.65 per press made while a same-hand finger is held;
 * - recovery: up to 0.6 per lane repressed within 180 ms of its release;
 * - hold starts: 0.35 * starts^0.7.
 * Hand strains decay with a 700 ms half-life. A 500 ms section's demand is
 * its peak of (harder hand + 0.3 * easier hand), and only sections with LN
 * work exist, so a hard rice section supplies neither strain nor endurance.
 */
function strainAtSplit(events: StrainEvent[], keyCount: number, split: number, scoreGoal: number): number {
  const sections = new Map<number, Section>();
  const strain = [0, 0];
  const releaseAt = Array<number>(keyCount).fill(-Infinity);
  const startedAt = Array<number>(keyCount).fill(-Infinity);
  const endsAt = Array<number>(keyCount).fill(-Infinity);
  const leftMask = (1 << split) - 1;
  const handMasks = [leftMask, ((1 << keyCount) - 1) ^ leftMask];
  const origin = events.find((event) => event.hold)!.time;
  let last = origin;
  let active = 0;
  for (let i = 0; i < events.length;) {
    const time = events[i].time;
    let heads = 0, starts = 0, tails = 0;
    let j = i;
    for (; j < events.length && events[j].time === time; j += 1) {
      const event = events[j];
      if (event.tail) tails |= 1 << event.column;
      else {
        heads |= 1 << event.column;
        if (event.hold) starts |= 1 << event.column;
      }
    }
    const decay = Math.pow(0.5, Math.max(0, time - last) / HALF_LIFE_MS);
    strain[0] *= decay;
    strain[1] *= decay;
    last = time;
    // A held finger counts only strictly inside its body, more than the
    // shared-motion tolerance from its own head and release; a press chorded
    // with a hold's head or tail is the same motion.
    let inside = 0;
    for (let column = 0; column < keyCount; column += 1) {
      if ((active & (1 << column)) && time - startedAt[column] > LN_SAME_MOTION_TOLERANCE_MS
        && endsAt[column] - time > LN_SAME_MOTION_TOLERANCE_MS) inside |= 1 << column;
    }
    let weight = 0;
    for (let hand = 0; hand < 2; hand += 1) {
      const handMask = handMasks[hand];
      const releases = bits(tails & handMask);
      const held = bits(inside & handMask);
      const presses = bits(heads & handMask & ~inside);
      const holdStarts = bits(starts & handMask);
      const releaseWork = Math.pow(releases, 0.7) * (1 + 0.3 * held);
      const coordination = held > 0 ? 0.65 * presses : 0;
      let recovery = 0;
      for (let column = hand === 0 ? 0 : split; column < (hand === 0 ? split : keyCount); column += 1) {
        if (!(heads & (1 << column))) continue;
        if (tails & (1 << column)) continue;
        const gap = time - releaseAt[column];
        if (gap > CHORD_TOLERANCE_MS && gap < RECOVERY_MS) recovery += 0.6 * (1 - gap / RECOVERY_MS);
      }
      const work = releaseWork + coordination + recovery + 0.35 * Math.pow(holdStarts, 0.7);
      strain[hand] += work;
      weight += work;
    }
    if (weight > 0) {
      const slot = Math.floor((time - origin) / SECTION_MS);
      const section = sections.get(slot) ?? { demand: 0, weight: 0 };
      section.demand = Math.max(section.demand, Math.max(...strain) + 0.3 * Math.min(...strain));
      section.weight += weight;
      sections.set(slot, section);
    }
    for (let column = 0; column < keyCount; column += 1) {
      if (tails & (1 << column)) releaseAt[column] = time;
    }
    active &= ~tails;
    for (let k = i; k < j; k += 1) {
      const event = events[k];
      if (!event.tail && event.hold) {
        active |= 1 << event.column;
        startedAt[event.column] = event.time;
        endsAt[event.column] = event.end!;
      }
    }
    i = j;
  }
  // Endurance: up to +18%, growing with the log of the time covered by LN sections.
  const endurance = 1 + Math.min(0.18, 0.04 * Math.log1p(sections.size * SECTION_MS / 30_000));
  const demands = [...sections.values()];
  const peak = demands.reduce((max, section) => Math.max(max, section.demand), 0);
  return Math.pow(ratingAtGoal(demands, scoreGoal), 1 - LN_SKILL_PEAK_WEIGHT) * Math.pow(peak, LN_SKILL_PEAK_WEIGHT) * endurance;
}

/**
 * The skill at which the weighted expected score over LN sections reaches
 * the goal. A section's expected score is 0.93^((demand / skill)^4): at
 * skill equal to its demand it scores 93%, far above its demand it tends to
 * 100%, far below it tends to 0. Sections are weighted by their LN work.
 * Solved by 40 bisection steps between 0 and 10x the peak demand.
 */
function ratingAtGoal(sections: Section[], goal: number): number {
  if (!sections.length) return 0;
  const total = sections.reduce((sum, section) => sum + section.weight, 0);
  let hi = sections.reduce((max, section) => Math.max(max, section.demand), 0) * 10;
  let lo = 0;
  for (let i = 0; i < 40; i += 1) {
    const skill = (lo + hi) / 2;
    const score = sections.reduce((sum, section) => sum + section.weight
      * Math.exp(Math.log(LN_SKILL_SCORE_GOAL) * Math.pow(section.demand / Math.max(skill, 1e-9), 4)), 0) / total;
    if (score < goal) lo = skill;
    else hi = skill;
  }
  return (lo + hi) / 2;
}

function bits(mask: number): number {
  let count = 0;
  for (; mask; mask &= mask - 1) count += 1;
  return count;
}
