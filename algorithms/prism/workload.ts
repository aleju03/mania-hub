import type { ManiaNote } from "../chart/beatmap";
import { readEffectiveHolds } from "../dan-estimator/ln-effective";

export const PRISM_SECTION_MS = 500;

const MAX_CHART_SPAN_MS = 20 * 60 * 1000;

const MOTION_MAX_GAP_MS = 250;

const SPEED_REF_MS = 125;

const ACTION_CEILING_MS = 1000 / 23;
const CEILING_ACTIONS = 4;

const HAND_PRESS_MS = 30;

const PRESS_GAP_SHARE = 0.4;
const PRESS_MAX_MS = 60;

const HAND_REPEAT = 1;

const SWEEP_SPAN_MS = 90;
const SWEEP_ROW_GAP_MS = 25;
const SWEEP_MIN_ROWS = 3;
const SWEEP_PAUSE = 2;
const SWEEP_CHAIN = 4;
const SWEEP_CHAIN_GAP_MS = MOTION_MAX_GAP_MS;

const SPEED_FULL_MS = 60;
const SPEED_NONE_MS = 140;

const CARRIED_RATIOS = [1, 2, 0.5, 1.5, 2 / 3, 3, 1 / 3, 4, 0.25];
const RATIO_TOLERANCE = 0.08;

const RHYTHM_ROWS = 24;
const RHYTHM_BUCKET_MS = 5;
const RHYTHM_CLASSES = 3;

export const PATTERNS = ["stream", "chordstream", "bracket", "jack", "chordjack", "ln", "technical", "speed"] as const;
export type PrismPattern = typeof PATTERNS[number];
const STREAM = 0, CHORDSTREAM = 1, BRACKET = 2, JACK = 3, CHORDJACK = 4, LN = 5, TECHNICAL = 6, SPEED = 7;

export interface PrismWorkloadParams {
  chordUnits: number;
  jackUnits: number;
  jackWindowMs: number;
  graceMs: number;
  graceDiscount: number;
  speedFullMs?: number;
  speedNoneMs?: number;
  handRepeat?: number;
  independenceHeldPower?: number;
  heldBodyFullMs?: number;
  releaseLongUnits?: number;
  releaseLongFullMs?: number;
  releaseRepressMs?: number;
  releaseRepressDiscount?: number;
  jackAfterHoldUnits?: number;
  odPower?: number;
  flamUnits?: number;
  jackChordShare?: number;
  rollDiscount: number;
  speedPower: number;
  shapeUnits: number;
  bracketUnits: number;
  centreUnits: number;
  independenceUnits: number;
  releaseUnits: number;
  halfLifeMs: number;
  sustainRatio: number;
  sustainWeight: number;
  staminaHalfLifeMs: number;
  staminaWeight: number;
  handShare: number;
}

export interface PrismChart {
  keyCount: number;
  rate: number;
  time: Float64Array;
  press: Uint8Array;
  release: Uint8Array;
  held: Uint8Array;
  heldBody: Float32Array;
  od: number;
  objects: number;
  holds: number;
}

export interface PrismSection {
  timeMs: number;
  demand: number;
  work: number;
  mix: Float64Array;
}

const bits = (mask: number) => { let n = 0; for (; mask; mask &= mask - 1) n += 1; return n; };
const lowest = (mask: number) => 31 - Math.clz32(mask & -mask);
const highest = (mask: number) => 31 - Math.clz32(mask);

const rollsPast = (a: number, b: number) => highest(a) < lowest(b) || lowest(a) > highest(b);
const clamp01 = (n: number) => (n <= 0 ? 0 : n >= 1 ? 1 : n);

export function prismHands(keyCount: number, centreHand: 0 | 1 = 0): [number, number] {
  const half = Math.floor(keyCount / 2);
  const left = (1 << half) - 1;
  const right = ((1 << keyCount) - 1) & ~((1 << (keyCount - half)) - 1);
  const centre = keyCount % 2 === 1 ? 1 << half : 0;
  return centreHand === 0 ? [left | centre, right] : [left, right | centre];
}

export function buildPrismChart(notes: readonly ManiaNote[], keyCount: number, rate = 1, od?: number | null): PrismChart {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const effective = od != null && Number.isFinite(od)
    ? readEffectiveHolds(notes as ManiaNote[], { rate: 1, od, keyCount }, { weights: false }).mask : null;
  const valid = notes.map((note, index) => ({ ...note, isHold: note.isHold && (effective == null || effective[index] === true) }))
    .filter((n) => Number.isInteger(n.column) && n.column >= 0 && n.column < keyCount && Number.isFinite(n.time))
    .sort((a, b) => a.time - b.time || a.column - b.column);
  const origin = valid[0]?.time ?? 0;
  const busyUntil = new Array<number>(keyCount).fill(-Infinity);
  const lastStart = new Array<number>(keyCount).fill(-Infinity);
  const events = new Map<number, { press: number; release: number }>();
  const at = (t: number) => { let e = events.get(t); if (!e) events.set(t, e = { press: 0, release: 0 }); return e; };
  const spans: Array<[number, number, number]> = [];
  let objects = 0, holds = 0;
  for (const note of valid) {
    if (note.time - origin > MAX_CHART_SPAN_MS) break;
    const lane = note.column;
    if (note.time === lastStart[lane] || note.time < busyUntil[lane]) continue;
    const start = (note.time - origin) / r;
    lastStart[lane] = note.time;
    objects += 1;
    at(start).press |= 1 << lane;
    if (note.isHold && Number.isFinite(note.endTime) && note.endTime > note.time) {
      holds += 1;
      busyUntil[lane] = note.endTime;
      const end = (note.endTime - origin) / r;
      at(end).release |= 1 << lane;
      spans.push([lane, start, end]);
    }
  }
  const times = [...events.keys()].sort((a, b) => a - b);
  const n = times.length;
  const time = new Float64Array(n), press = new Uint8Array(n), release = new Uint8Array(n), held = new Uint8Array(n);
  const heldBody = new Float32Array(n * keyCount);
  const index = new Map<number, number>();
  times.forEach((t, i) => {
    const e = events.get(t)!;
    time[i] = t; press[i] = e.press; release[i] = e.release;
    index.set(t, i);
  });
  for (const [lane, start, end] of spans) {
    for (let i = index.get(start)! + 1, last = index.get(end)!; i < last; i += 1) {
      held[i] |= 1 << lane;
      heldBody[i * keyCount + lane] = end - start;
    }
  }
  const chartOd = od != null && Number.isFinite(od) ? Math.max(0, Math.min(10, od)) : 8;
  return { keyCount, rate: r, time, press, release, held, heldBody, od: chartOd, objects, holds };
}

export function keyboardSweeps(chart: PrismChart): Int32Array {
  const { keyCount, time, press } = chart;
  const end = new Int32Array(time.length).fill(-1);
  const all = (1 << keyCount) - 1;
  const found: Array<[number, number]> = [];
  let chainFrom = 0;
  const close = (upTo: number) => {
    if (upTo - chainFrom >= SWEEP_CHAIN) {
      for (let s = chainFrom; s < upTo; s += 1) for (let k = found[s][0]; k <= found[s][1]; k += 1) end[k] = found[s][1];
    }
    chainFrom = upTo;
  };
  for (let i = 0; i < time.length;) {
    if (!press[i]) { i += 1; continue; }
    let lanes = press[i], last = i, rows = 1, widest = 0;
    for (let k = i + 1; k < time.length && time[k] - time[i] <= SWEEP_SPAN_MS; k += 1) {
      if (!press[k]) continue;
      if (press[k] & lanes) break;
      widest = Math.max(widest, time[k] - time[last]);
      lanes |= press[k];
      last = k;
      rows += 1;
    }
    let before = Infinity, after = Infinity;
    for (let k = i - 1; k >= 0; k -= 1) if (press[k]) { before = time[i] - time[k]; break; }
    for (let k = last + 1; k < time.length; k += 1) if (press[k]) { after = time[k] - time[last]; break; }
    if (rows >= SWEEP_MIN_ROWS && lanes === all && widest <= SWEEP_ROW_GAP_MS
      && Math.min(before, after) >= SWEEP_PAUSE * widest) {
      if (found.length > chainFrom && time[i] - time[found[found.length - 1][1]] > SWEEP_CHAIN_GAP_MS) close(found.length);
      found.push([i, last]);
      i = last + 1;
    } else i += 1;
  }
  close(found.length);
  return end;
}

export function prismSections(chart: PrismChart, centreHand: 0 | 1, p: PrismWorkloadParams): PrismSection[] {
  const { keyCount, time, press, release, held, heldBody } = chart;
  const heldBodyFullMs = p.heldBodyFullMs ?? 0;
  const releaseLongUnits = p.releaseLongUnits ?? 0, releaseLongFullMs = p.releaseLongFullMs ?? 1;
  const releaseRepressMs = p.releaseRepressMs ?? 0, repressShare = 1 - (p.releaseRepressDiscount ?? 0);
  const lanePresses: number[][] = Array.from({ length: keyCount }, () => []);
  if (releaseRepressMs > 0) {
    for (let r = 0; r < time.length; r += 1) for (let lane = 0; lane < keyCount; lane += 1) if (press[r] & (1 << lane)) lanePresses[lane].push(time[r]);
  }
  const repressedWithin = (lane: number, t: number) => {
    const xs = lanePresses[lane];
    let lo = 0, hi = xs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] <= t) lo = m + 1; else hi = m; }
    return lo < xs.length && xs[lo] - t <= releaseRepressMs;
  };
  const hands = prismHands(keyCount, centreHand);
  const centreBit = keyCount % 2 === 1 ? 1 << Math.floor(keyCount / 2) : 0;
  const lastPress = new Float64Array(keyCount).fill(-Infinity);
  const releasedSince = new Uint8Array(keyCount);
  const jackAfterHoldUnits = p.jackAfterHoldUnits ?? p.jackUnits;
  const lastAction = [-Infinity, -Infinity], lastGap = [0, 0], lastShape = [0, 0], shapeBefore = [0, 0], lastStep = [0, 0];
  const pressStart = [-Infinity, -Infinity], pressMask = [0, 0], openGap = [0, 0];
  const lastNote = [-Infinity, -Infinity];
  const writtenMs = Math.max(1, chart.rate);
  const flamUnits = p.flamUnits ?? 0, jackChordShare = p.jackChordShare ?? 1;
  const previousPress = [0, 0], repeating = [false, false];
  const repeatWaiver = p.handRepeat ?? HAND_REPEAT;
  const sweepEnd = keyboardSweeps(chart);
  const slamming = [false, false], slamEnd = [0, 0], slamMask = [0, 0];
  const recent = [new Float64Array(CEILING_ACTIONS).fill(-Infinity), new Float64Array(CEILING_ACTIONS).fill(-Infinity)];
  const recentAt = [0, 0];
  const fast = [0, 0], sustain = [0, 0], stamina = [0, 0];
  const mix = new Float64Array(PATTERNS.length);
  let row1 = 0, row2 = 0, row1At = -Infinity;
  const gapRing = new Int32Array(RHYTHM_ROWS).fill(-1), gapCount = new Map<number, number>();
  let gapAt = 0, offRhythm = false;
  const sections: PrismSection[] = [];
  let section: PrismSection | null = null;
  let last = 0;
  for (let i = 0; i < time.length; i += 1) {
    const t = time[i];
    const elapsed = t - last;
    last = t;
    const decay = Math.pow(0.5, elapsed / p.halfLifeMs);
    const slow = Math.pow(0.5, elapsed / (p.halfLifeMs * p.sustainRatio));
    const endurance = Math.pow(0.5, elapsed / p.staminaHalfLifeMs);
    const row = press[i], chordRow = bits(row) >= 2;
    let pattern = STREAM;
    offRhythm = false;
    if (row && Number.isFinite(row1At) && t - row1At <= MOTION_MAX_GAP_MS * 2) {
      const bucket = Math.round((t - row1At) / RHYTHM_BUCKET_MS);
      let filled = 0;
      for (const n of gapCount.values()) filled += n;
      if (filled >= RHYTHM_ROWS / 2) {
        const mine = gapCount.get(bucket) ?? 0;
        let above = 0;
        for (const n of gapCount.values()) if (n > mine) above += 1;
        offRhythm = above >= RHYTHM_CLASSES;
      }
      const old = gapRing[gapAt];
      if (old >= 0) { const n = gapCount.get(old)! - 1; if (n > 0) gapCount.set(old, n); else gapCount.delete(old); }
      gapRing[gapAt] = bucket; gapCount.set(bucket, (gapCount.get(bucket) ?? 0) + 1);
      gapAt = (gapAt + 1) % RHYTHM_ROWS;
    }
    if (row) {
      const close = t - row1At <= MOTION_MAX_GAP_MS;
      if (close && (row & row1)) pattern = chordRow ? CHORDJACK : JACK;
      else if (close && chordRow && bits(row1) >= 2 && bits(row2) >= 2 && !(row2 & row1) && !(row1 & row)
        && !rollsPast(row2, row1) && !rollsPast(row1, row)) pattern = BRACKET;
      else if (chordRow) pattern = CHORDSTREAM;
    }
    mix.fill(0);
    let work = 0;
    for (let h = 0; h < 2; h += 1) {
      fast[h] *= decay; sustain[h] *= slow; stamina[h] *= endurance;
      const mask = hands[h], rl = release[i] & mask;
      let pr = press[i] & mask;
      if (!pr && !rl) continue;
      let units = 0;
      const window = Math.max(HAND_PRESS_MS, Math.min(PRESS_MAX_MS, PRESS_GAP_SHARE * openGap[h]));
      const inSlam = slamming[h] && t <= slamEnd[h] && !(pressMask[h] & pr) && (pr & ~slamMask[h]) === 0;
      if (pr && (inSlam || (!slamming[h] && t - pressStart[h] <= window && !(pressMask[h] & pr)))) {
        const again = repeating[h] && (pr & ~previousPress[h]) === 0;
        let flam = 0;
        if (t > pressStart[h] && flamUnits > 0) {
          const span = (t - recent[h][recentAt[h]]) / CEILING_ACTIONS;
          flam = flamUnits * (span < ACTION_CEILING_MS ? span / ACTION_CEILING_MS : 1);
        }
        const joined = slamming[h] ? 0 : (p.chordUnits + flam) * (again ? 1 - repeatWaiver : 1) * bits(pr);
        pressMask[h] |= pr;
        lastShape[h] |= pr;
        for (let lane = 0; lane < keyCount; lane += 1) if (pr & (1 << lane)) { if (!slamming[h]) lastPress[lane] = t; releasedSince[lane] = 0; }
        mix[pattern] += joined;
        const after = (t - lastNote[h]) * writtenMs;
        if ((t - pressStart[h]) * writtenMs > HAND_PRESS_MS && bits(pr) <= 2 && pattern !== JACK && pattern !== CHORDJACK) {
          const full = p.speedFullMs ?? SPEED_FULL_MS, none = p.speedNoneMs ?? SPEED_NONE_MS;
          mix[SPEED] += joined * (bits(pr) === 1 ? 1 : 0.5) * clamp01((none - after) / (none - full));
        }
        lastNote[h] = t;
        units += joined;
      } else if (pr) {
        previousPress[h] = pressMask[h];
        openGap[h] = Number.isFinite(pressStart[h]) ? t - pressStart[h] : 0;
        pressStart[h] = t;
        pressMask[h] = pr;
        let swept = pr, end = t;
        for (let j = i + 1; j <= sweepEnd[i]; j += 1) {
          const m = press[j] & mask;
          if (m && !(m & swept)) { swept |= m; end = time[j]; }
        }
        slamming[h] = swept !== pr;
        slamEnd[h] = end; slamMask[h] = swept;
        pr = swept;
        repeating[h] = bits(previousPress[h]) >= 2 && (pr & ~previousPress[h]) === 0 && lastAction[1 - h] > lastAction[h];
        const waive = repeating[h] ? 1 - repeatWaiver : 1;
        const gap = t - lastAction[h];
        let action = 1 + p.chordUnits * (bits(pr) - 1) * waive;
        if (gap < p.graceMs) action *= 1 - p.graceDiscount * (1 - gap / p.graceMs);
        let step = 0;
        if (bits(pr) === 1 && bits(lastShape[h]) === 1 && gap <= MOTION_MAX_GAP_MS) {
          step = pr === lastShape[h] << 1 ? 1 : pr === lastShape[h] >> 1 ? -1 : 0;
          if (step !== 0 && step === lastStep[h]) action *= 1 - p.rollDiscount;
        }
        lastStep[h] = step;
        if (pr & centreBit) action += p.centreUnits;
        if (Number.isFinite(gap)) action *= Math.pow(SPEED_REF_MS / Math.max(gap, ACTION_CEILING_MS), p.speedPower);
        const span = (t - recent[h][recentAt[h]]) / CEILING_ACTIONS;
        const vibrated = span < ACTION_CEILING_MS ? span / ACTION_CEILING_MS : 1;
        action *= vibrated;
        recent[h][recentAt[h]] = t;
        recentAt[h] = (recentAt[h] + 1) % CEILING_ACTIONS;
        const bracket = shapeBefore[h] !== 0 && !(lastShape[h] & pr) && (shapeBefore[h] & pr) !== 0 && !(shapeBefore[h] & lastShape[h])
          && bits(pr | lastShape[h]) >= 3 && gap <= MOTION_MAX_GAP_MS;
        mix[pattern] += action;
        const fingers = bits(pr);
        const noteGap = (t - lastNote[h]) * writtenMs;
        lastNote[h] = t;
        if (fingers <= 2 && pattern !== JACK && pattern !== CHORDJACK && Number.isFinite(noteGap)) {
          const full = p.speedFullMs ?? SPEED_FULL_MS, none = p.speedNoneMs ?? SPEED_NONE_MS;
          mix[SPEED] += action * (fingers === 1 ? 1 : 0.5) * clamp01((none - noteGap) / (none - full));
        }
        let irregular = gap < p.graceMs || offRhythm;
        if (!irregular && Number.isFinite(gap) && lastGap[h] > 0 && gap <= MOTION_MAX_GAP_MS * 2) {
          const ratio = gap / lastGap[h];
          irregular = !CARRIED_RATIOS.some((carried) => Math.abs(ratio - carried) <= carried * RATIO_TOLERANCE);
        }
        if (irregular) mix[TECHNICAL] += action;
        lastGap[h] = Number.isFinite(gap) ? gap : 0;
        units += action;
        let jack = 0, oneFinger = 0;
        for (let lane = 0; lane < keyCount; lane += 1) {
          if (!(pr & (1 << lane))) continue;
          const lone = vibrated * (releasedSince[lane] ? jackAfterHoldUnits : p.jackUnits) * clamp01(1 - (t - lastPress[lane]) / p.jackWindowMs);
          releasedSince[lane] = 0;
          jack += lone;
          oneFinger = Math.max(oneFinger, lone);
          lastPress[lane] = t;
        }
        if (jackChordShare !== 1) jack = oneFinger + jackChordShare * (jack - oneFinger);
        if (repeating[h]) jack = waive * jack + (1 - waive) * oneFinger;
        const shape = lastShape[h] && lastShape[h] !== pr && (lastShape[h] & pr) ? vibrated * p.shapeUnits * waive : 0;
        const bracketWork = bracket ? vibrated * p.bracketUnits : 0;
        mix[pattern] += jack + shape + bracketWork;
        units += jack + shape + bracketWork;
        shapeBefore[h] = lastShape[h];
        lastShape[h] = pr;
        if (held[i] & mask & ~pr) {
          const heldMask = held[i] & mask & ~pr;
          let heldFingers = bits(heldMask);
          if (heldBodyFullMs > 0) {
            heldFingers = 0;
            for (let lane = 0; lane < keyCount; lane += 1) {
              if (heldMask & (1 << lane)) heldFingers += Math.min(1, heldBody[i * keyCount + lane] / heldBodyFullMs);
            }
          }
          const independence = vibrated * p.independenceUnits * bits(pr) * Math.pow(heldFingers, p.independenceHeldPower ?? 0);
          mix[LN] += independence;
          units += independence;
        }
        lastAction[h] = t;
      }
      if (rl) {
        for (let lane = 0; lane < keyCount; lane += 1) if (rl & (1 << lane)) releasedSince[lane] = 1;
        let releases = p.releaseUnits * bits(rl);
        if (releaseLongUnits > 0) {
          for (let lane = 0; lane < keyCount; lane += 1) {
            if (!(rl & (1 << lane))) continue;
            const share = releaseRepressMs > 0 && repressedWithin(lane, t) ? repressShare : 1;
            releases += share * releaseLongUnits * Math.min(1, (t - lastPress[lane]) / releaseLongFullMs);
          }
        }
        mix[LN] += releases;
        units += releases;
      }
      fast[h] += units;
      sustain[h] += units / p.sustainRatio;
      stamina[h] += units * (p.halfLifeMs / p.staminaHalfLifeMs);
      work += units;
    }
    if (row) { row2 = row1; row1 = row; row1At = t; }
    if (!(work > 0)) continue;
    const slot = Math.floor(t / PRISM_SECTION_MS);
    if (!section || section.timeMs !== slot * PRISM_SECTION_MS) {
      sections.push(section = { timeMs: slot * PRISM_SECTION_MS, demand: 0, work: 0, mix: new Float64Array(PATTERNS.length) });
    }
    const long = [0, 1].map((h) => p.sustainWeight * sustain[h] + p.staminaWeight * stamina[h]);
    const left = (1 - p.sustainWeight) * fast[0] + long[0];
    const right = (1 - p.sustainWeight) * fast[1] + long[1];
    const demand = Math.max(left, right) + p.handShare * Math.min(left, right);
    if (demand > section.demand) section.demand = demand;
    section.work += work;
    for (let k = 0; k < PATTERNS.length; k += 1) section.mix[k] += mix[k];
  }
  if (p.odPower) {
    const factor = Math.pow((64 - 3 * chart.od) / 40, -p.odPower);
    for (const s of sections) s.demand *= factor;
  }
  return sections;
}
