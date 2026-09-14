import { parseManiaBeatmap, type ManiaBeatmap } from "./beatmap-parser.js";
import { analyzeEffectiveLn, chartIsLn, effectiveHoldMask, LN_SAME_MOTION_TOLERANCE_MS } from "./dan-estimator/ln-effective.js";
import { analyzeLnTimeline4K, lnAnalysisCacheKey, summarizeLnStructure4K, type LnStructureSummary4K } from "./ln-analysis/index.js";
import { buildLnTimeline4K } from "./ln-analysis/timeline.js";
import { beatLengthLookup } from "./ln-analysis/search-evidence.js";

/** Mania Hub's LN strain model, independent of MinaCalc and dan verdicts.
 * Version the chart artifacts, retained plays and percentile population together.
 * See docs/ln-skill.md for the model, scale calibration and limitations. */
// v4 consumes exact lossless rows, rejects invalid topology and uses a
// separate release-aware performance goal. v3 scoped v2 artifacts to 4K.
// v5: tap-covered geometric overlaps are not mandatory hold/release work.
// v6: recurring near-window same-lane holds retain rearticulation work.
export const LN_SKILL_VERSION = 6;
export const LN_SKILL_KEY_COUNTS: ReadonlySet<number> = new Set([4]);
export function isLnSkillSupported(keyCount: number): boolean {
  return LN_SKILL_KEY_COUNTS.has(keyCount);
}
export const LN_SKILL_SCORE_GOAL = 0.93;

const SECTION_MS = 500;
const HALF_LIFE_MS = 700;
const CHORD_TOLERANCE_MS = 5;
const RECOVERY_MS = 180;
// Only 4K has a course-validated scale fit. Other keymodes retain the legacy
// Overall-on-LN axis and must never receive independent LN artifacts.
export const LN_SKILL_SCALE = 4.818919597751967;
export const LN_SKILL_EXPONENT = 0.5277221146076253;

export function lnSkillCalibrationFor(keyCount: number): { scale: number; exponent: number } {
  if (!isLnSkillSupported(keyCount)) throw new Error("Independent LN skill is only supported for 4K");
  return { scale: LN_SKILL_SCALE, exponent: LN_SKILL_EXPONENT };
}

export interface LnSkillResult {
  version: number;
  keyCount: number;
  rating: number | null;
  structureKey?: string;
  /** Interval evidence is stored per chart/rate, not duplicated per player play. */
  structure?: LnStructureSummary4K;
  /** Unscaled LN strain; exposed for reproducible calibration diagnostics. */
  strain: number;
  eligible: boolean;
  effectiveRatio: number;
  effectiveHolds: number;
  rate: number;
  od: number;
  scoreGoal: number;
}

interface Event { time: number; column: number; tail: boolean; hold: boolean; end?: number }
interface Section { demand: number; weight: number }

function bits(mask: number): number {
  let count = 0;
  for (; mask; mask &= mask - 1) count += 1;
  return count;
}

/** Solve the skill at which the LN sections' expected score reaches the goal.
 * At skill == section demand that section predicts 93%. Hard sections saturate
 * at a loss of 100%; spare accuracy on easy sections cannot earn extra points. */
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

export function analyzeLnSkill(
  map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od"> & Partial<Pick<ManiaBeatmap, "bpm" | "timingPoints">>,
  options: { rate?: number; od?: number | null; scoreGoal?: number; includeStructure?: boolean } = {},
): LnSkillResult | null {
  if (!isLnSkillSupported(map.keyCount)) return null;
  const keyCount = map.keyCount;
  const rate = Number.isFinite(options.rate) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const rawOd = options.od ?? map.od;
  const od = Number.isFinite(rawOd) ? Math.max(0, Math.min(10, rawOd)) : 8;
  const scoreGoal = Number.isFinite(options.scoreGoal)
    ? Math.max(0, Math.min(0.999, Number(options.scoreGoal))) : LN_SKILL_SCORE_GOAL;
  const timeline = buildLnTimeline4K(map.notes, { rate, scoring: { client: "stable-scorev2", od, accuracyGoal: scoreGoal } });
  const structureKey = lnAnalysisCacheKey(timeline);
  const structure = options.includeStructure === false ? undefined
    : summarizeLnStructure4K(analyzeLnTimeline4K(timeline), 128, beatLengthLookup(map, rate, timeline.originMs));
  if (!timeline.valid) return {
    version: LN_SKILL_VERSION, keyCount, rating: null, strain: 0, eligible: false,
    effectiveRatio: 0, effectiveHolds: 0, rate, od, scoreGoal, structureKey, ...(structure ? { structure } : {}),
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
  const effective = analyzeEffectiveLn(notes, { rate, od });
  const result: LnSkillResult = {
    version: LN_SKILL_VERSION, keyCount, rating: 0, strain: 0,
    structureKey, ...(structure ? { structure } : {}),
    // Keep each keymode's established identity rule. The effective mask
    // measures work everywhere; a completely free chart never earns LN credit.
    eligible: effective.effectiveHolds > 0 && chartIsLn(keyCount, { lnRatio: effective.holdRatio, lnEffectiveRatio: effective.effectiveLnRatio }) === true,
    effectiveRatio: effective.effectiveLnRatio, effectiveHolds: effective.effectiveHolds,
    rate, od, scoreGoal,
  };
  if (!effective.effectiveHolds || scoreGoal === 0) return result;
  const mask = effectiveHoldMask(notes, { rate, od });
  const effectiveNotes = new Set(notes.filter((_note, index) => mask[index]));
  const events: Event[] = [];
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
  // the whole chart. Evaluate both fixed assignments, never double-count it
  // or switch hands opportunistically per event. This also preserves mirrors.
  const splits = [...new Set([Math.floor(keyCount / 2), Math.ceil(keyCount / 2)])];
  result.strain = Math.min(...splits.map(split => strainAtSplit(events, keyCount, split, scoreGoal)));
  const calibration = lnSkillCalibrationFor(keyCount);
  result.rating = calibration.scale * Math.pow(result.strain, calibration.exponent);
  return result;
}

function strainAtSplit(events: Event[], keyCount: number, split: number, scoreGoal: number): number {
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
    // A release/head chord is one motion. Coordination requires a held finger
    // strictly inside its body, outside the shared-motion tolerance at either end.
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
      // Simultaneous releases share a motion; staggering those same releases
      // costs separate impulses. Holding the adjacent finger adds independence.
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
  const endurance = 1 + Math.min(0.18, 0.04 * Math.log1p(sections.size * SECTION_MS / 30_000));
  return ratingAtGoal([...sections.values()], scoreGoal) * endurance;
}

export function analyzeLnSkillFromText(osuText: string, options: Parameters<typeof analyzeLnSkill>[1] = {}): LnSkillResult | null {
  return analyzeLnSkill(parseManiaBeatmap(osuText), options);
}
