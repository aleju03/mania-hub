import type { ManiaBeatmap } from "../chart/beatmap";
import { LN_SAME_MOTION_TOLERANCE_MS, readEffectiveHolds, type EffectiveLnAnalysis } from "../dan-estimator/ln-effective";
import { buildLnTimeline4K, type LnTimeline4K } from "./timeline";

export const LN_SKILLSET_IDS = ["lnhybrid", "lntechnical", "lnwalls", "lnspeed"] as const;
export type LnSkillsetId = typeof LN_SKILLSET_IDS[number];
export type LnFamilyVector = Record<LnSkillsetId, number>;
export const emptyLnFamilyVector = (): LnFamilyVector => ({ lnhybrid: 0, lntechnical: 0, lnwalls: 0, lnspeed: 0 });

export const LN_SECTION_MS = 500;

export const LN_STRAIN_HALF_LIFE_MS = 700;
const SUSTAIN_RATIO = 4;

const RELEASE_WORK = 1 / 3;
const CROSS_HAND_RELEASE = 0.5;

const JACK_UNITS = 8;
const JACK_WINDOW_MS = 200;

const IDENTITY_RELEASE_WORK = 1 / 1.5;
const TOLERANCE = LN_SAME_MOTION_TOLERANCE_MS;
const HANDS = [3, 12];

export function combineLnDemand(leftFast: number, leftSustain: number, rightFast: number, rightSustain: number): number {
  const left = Math.hypot(leftFast, leftSustain) / Math.SQRT2;
  const right = Math.hypot(rightFast, rightSustain) / Math.SQRT2;
  return Math.max(left, right) + 0.3 * Math.min(left, right);
}

export interface LnWorkSection {
  timeMs: number;
  demand: number;
  work: number;
}
export interface LnWorkload {
  timeline: LnTimeline4K;
  od: number;
  effective: EffectiveLnAnalysis;
  sections: LnWorkSection[];
  riceShare: number;
}

const bits = (mask: number) => { let n = 0; for (; mask; mask &= mask - 1) n += 1; return n; };
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const laneMask = (ids: number[], lane: Int8Array) => { let mask = 0; for (const id of ids) mask |= 1 << lane[id]; return mask; };

function timingConflict(gap: number, headWindow: number, tailWindow: number): number {
  if (!(gap > TOLERANCE)) return 0;
  return clamp((gap - TOLERANCE) / headWindow) * clamp((headWindow + tailWindow - gap) / headWindow);
}

function riceShareOf(timeline: LnTimeline4K, effective: boolean[], lane: Int8Array, end: Float64Array): number {
  const held = [-1, -1, -1, -1];
  let last = 0, runObjects = 0, runRows = 0, riceObjects = 0;
  const flush = () => {
    if (runRows >= 4) riceObjects += runObjects;
    runObjects = 0; runRows = 0;
  };
  for (const row of timeline.rows) {
    const heads = row.headIds.filter(id => effective[id]), tails = row.tailIds.filter(id => effective[id]);
    const taps = [...row.tapIds, ...row.headIds.filter(id => !effective[id])];
    if (!heads.length && !tails.length && !taps.length) continue;
    if (Math.max(0, row.timeMs - last) > LN_STRAIN_HALF_LIFE_MS * SUSTAIN_RATIO) flush();
    last = row.timeMs;
    const active = held.some(id => id >= 0 && end[id] > row.timeMs);
    if (heads.length || tails.length || active) flush();
    else if (taps.length) { runObjects += bits(laneMask(taps, lane)); runRows += 1; }
    for (const id of tails) held[lane[id]] = -1;
    for (const id of heads) held[lane[id]] = id;
  }
  flush();
  return timeline.objects.length ? riceObjects / timeline.objects.length : 0;
}

export function buildLnWorkload(
  map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">,
  options: { rate?: number; od?: number | null; pricing?: "rating" | "identity" } = {},
): LnWorkload | null {
  if (map.keyCount !== 4) return null;
  const rate = Number.isFinite(options.rate) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const rawOd = options.od ?? map.od;
  const od = Number.isFinite(rawOd) ? Math.max(0, Math.min(10, rawOd)) : 8;
  const timeline = buildLnTimeline4K(map.notes, rate);
  const identityPricing = options.pricing === "identity";
  const holds = readEffectiveHolds(timeline.valid ? map.notes : [], { rate, od, keyCount: 4 }, { weights: false });
  const result: LnWorkload = { timeline, od, effective: holds.analysis, sections: [], riceShare: 0 };
  if (!timeline.valid) return result;

  const count = map.notes.length;
  const lane = new Int8Array(count), start = new Float64Array(count), end = new Float64Array(count);
  const isHold = new Uint8Array(count), next = new Int32Array(count).fill(-1);
  const lastInLane = [-1, -1, -1, -1];
  for (const object of timeline.objects) {
    lane[object.id] = object.lane;
    start[object.id] = object.startMs;
    end[object.id] = object.kind === "hold" ? object.endMs : object.startMs;
    isHold[object.id] = object.kind === "hold" ? 1 : 0;
    if (lastInLane[object.lane] >= 0) next[lastInLane[object.lane]] = object.id;
    lastInLane[object.lane] = object.id;
  }
  result.riceShare = riceShareOf(timeline, holds.mask, lane, end);
  const rows = timeline.rows.map(row => ({
    timeMs: row.timeMs, heads: row.headIds, tails: row.tailIds, taps: row.tapIds,
    headMask: laneMask(row.headIds, lane), tailMask: laneMask(row.tailIds, lane), tapMask: laneMask(row.tapIds, lane),
  })).filter(row => row.heads.length || row.tails.length || row.taps.length);

  const headWindow = 64 - 3 * od, tailWindow = headWindow * 1.5;
  const handPressTimes = HANDS.map(hand => rows.filter(row => (row.headMask | row.tapMask) & hand).map(row => row.timeMs));
  const handPressCursor = [0, 0];
  const held = [-1, -1, -1, -1], previous = [-1, -1, -1, -1];
  const releaseAt = Array<number>(4).fill(-Infinity);
  const fast = [0, 0], sustain = [0, 0];
  const sections = new Map<number, LnWorkSection>();
  const origin = rows.find(row => row.heads.length)?.timeMs ?? 0;
  let last = 0;
  let time = 0, hand = 0, handMask = 0, headMask = 0, tailMask = 0, inside = 0, work = 0;
  const add = (units: number) => {
    if (!(units > 0)) return;
    fast[hand] += units; sustain[hand] += units / SUSTAIN_RATIO;
    work += units;
  };
  const relevant = (l: number, id: number) => {
    const shield = next[id] >= 0 && isHold[next[id]] && start[next[id]] - time <= headWindow * 2;
    return shield || time - releaseAt[l] <= tailWindow || (inside & (1 << (l ^ 1))) !== 0
      || ((headMask | tailMask) & handMask) !== 0;
  };

  for (const row of rows) {
    time = row.timeMs;
    const elapsed = Math.max(0, time - last);
    const decay = Math.pow(0.5, elapsed / LN_STRAIN_HALF_LIFE_MS);
    const slowDecay = Math.pow(0.5, elapsed / (LN_STRAIN_HALF_LIFE_MS * SUSTAIN_RATIO));
    last = time;
    headMask = row.headMask; tailMask = row.tailMask;
    inside = 0;
    for (let l = 0; l < 4; l += 1) {
      const id = held[l];
      if (id >= 0 && end[id] > time && time - start[id] > TOLERANCE && end[id] - time > TOLERANCE) inside |= 1 << l;
    }

    work = 0;
    for (hand = 0; hand < 2; hand += 1) {
      fast[hand] *= decay; sustain[hand] *= slowDecay;
      handMask = HANDS[hand];
      let presses = headMask & handMask;
      for (const id of row.taps) if (handMask & (1 << lane[id]) && relevant(lane[id], id)) presses |= 1 << lane[id];
      for (let l = hand * 2; l < hand * 2 + 2 && !identityPricing; l += 1) {
        if (!(presses & (1 << l)) || previous[l] < 0 || isHold[previous[l]]) continue;
        add(JACK_UNITS * clamp(1 - (time - start[previous[l]]) / JACK_WINDOW_MS));
      }
      const releases = tailMask & handMask, moves = presses | releases;
      if (!moves) continue;
      add(bits(presses));
      const otherHandPresses = (row.headMask | row.tapMask) & HANDS[hand ^ 1];
      add(identityPricing ? IDENTITY_RELEASE_WORK * bits(releases)
        : (otherHandPresses && !(presses & ~releases) ? CROSS_HAND_RELEASE : 1) * RELEASE_WORK * bits(releases));
      for (let l = hand * 2; l < hand * 2 + 2; l += 1) {
        const bit = 1 << l;
        if (!(moves & bit)) continue;
        if (held[l ^ 1] >= 0 && (inside & (1 << (l ^ 1)))) add(1);
        if (!(presses & bit)) continue;
        add(tailMask & bit ? 1 : clamp(1 - (time - releaseAt[l]) / tailWindow));
        if (previous[l] >= 0 && !isHold[previous[l]] && headMask & bit) add(clamp(1 - (time - start[previous[l]]) / (headWindow * 2)));
      }
      const pressOnly = presses & ~releases;
      const partners = ((pressOnly & 5) << 1) | ((pressOnly & 10) >> 1);
      if (partners & releases & ~presses) add(1);
      if (!releases) continue;
      const times = handPressTimes[hand];
      while (handPressCursor[hand] < times.length && times[handPressCursor[hand]] < time) handPressCursor[hand] += 1;
      const cursor = handPressCursor[hand];
      const gap = Math.min(time - (times[cursor - 1] ?? -Infinity), Math.abs((times[cursor] ?? Infinity) - time));
      add(timingConflict(gap, headWindow, tailWindow));
      const split = row.tails.some(id => handMask & (1 << lane[id]) && held.some(other => other >= 0 && !(handMask & (1 << lane[other]))
        && Math.abs(start[other] - start[id]) <= TOLERANCE && end[other] - time > TOLERANCE));
      if (split) add(1 / 2);
    }
    if (work > 0) {
      const slot = Math.floor((time - origin) / LN_SECTION_MS);
      let section = sections.get(slot);
      if (!section) sections.set(slot, section = { timeMs: slot * LN_SECTION_MS, demand: 0, work: 0 });
      section.demand = Math.max(section.demand, combineLnDemand(fast[0], sustain[0], fast[1], sustain[1]));
      section.work += work;
    }
    for (const id of row.tails) { releaseAt[lane[id]] = time; held[lane[id]] = -1; }
    for (const id of row.heads) { previous[lane[id]] = id; held[lane[id]] = id; }
    for (const id of row.taps) previous[lane[id]] = id;
  }
  result.sections = [...sections.values()];
  return result;
}
