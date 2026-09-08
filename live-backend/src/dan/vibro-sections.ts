import { parseManiaBeatmap, type ManiaBeatmap } from "./beatmap-parser.js";

export const VIBRO_SECTION_VERSION = 1;

export type VibroReason =
  | "repeated_wall"
  | "sustained_jack"
  | "repeated_jack_stream"
  | "repeated_chord"
  | "rapid_jack_burst"
  | "isolated_jack"
  | "sustained_chords"
  | "dense_chord_repetition"
  | "fast_roll"
  | "extreme_density";

export interface VibroSection {
  /** Original chart timestamps, before applying the music rate. */
  startTime: number;
  endTime: number;
  reasons: VibroReason[];
}

export interface VibroAnalysis {
  version: number;
  status: "clean" | "adjusted" | "excluded";
  sections: VibroSection[];
  excludedDurationMs: number;
  activeDurationMs: number;
  timeShare: number;
  noteShare: number;
  /** Upper bound on the removed share of judgement weight (hold tails included).
   * Used to assign all observed accuracy loss to the retained material. */
  judgementShare: number;
  remainingNotes: number;
}

export function usesSectionVibro(map: ManiaBeatmap): boolean {
  return map.keyCount === 4 && map.notes.length > 0
    && map.notes.filter((note) => note.isHold).length / map.notes.length <= 0.1;
}

const bitCount = (mask: number) => {
  let count = 0;
  for (; mask; mask &= mask - 1) count++;
  return count;
};

/** Locate vibro at the actual played speed, then measure the retained chart.
 * Identity and metadata never participate in the decision. */
export function analyzeVibroSections(map: ManiaBeatmap, rate = 1): VibroAnalysis {
  const result: VibroAnalysis = {
    version: VIBRO_SECTION_VERSION, status: "clean", sections: [],
    excludedDurationMs: 0, activeDurationMs: 0, timeShare: 0,
    noteShare: 0, judgementShare: 0, remainingNotes: map.notes.length,
  };
  if (!usesSectionVibro(map) || !Number.isFinite(rate) || rate <= 0) return result;
  const scan = buildVibroScan(map, rate);
  result.activeDurationMs = measureActiveDuration(scan);

  scanRepeatedRows(scan);
  scanRepeatedJackStreams(scan);
  scanRepeatedPairs(scan);
  scanFixedFingerWindows(scan);
  scanIsolatedJacks(scan);
  const repeatedFingers = countFastFingerReturns(scan, 70);
  scanSustainedChords(scan, repeatedFingers);
  scanDenseChords(scan);
  scanFastRolls(scan, repeatedFingers);
  scanExtremeDensity(scan);

  result.sections = mergeSections(scan.intervals);
  if (result.sections.length > 0) measureSectionCoverage(result, map, scan);
  return result;
}

interface VibroScan {
  readonly times: readonly number[];
  readonly rows: readonly number[];
  readonly prefixNotes: readonly number[];
  readonly rate: number;
  readonly intervals: VibroSection[];
}

function buildVibroScan(map: ManiaBeatmap, rate: number): VibroScan {
  const masks = new Map<number, number>();
  for (const note of map.notes) masks.set(note.time, (masks.get(note.time) ?? 0) | (1 << note.column));
  const times = [...masks.keys()].sort((a, b) => a - b);
  const rows = times.map((time) => masks.get(time)!);
  const prefixNotes = [0];
  for (const mask of rows) prefixNotes.push(prefixNotes.at(-1)! + bitCount(mask));
  return { times, rows, prefixNotes, rate, intervals: [] };
}

function addSection(scan: VibroScan, start: number, end: number, reason: VibroReason): void {
  if (end > start) scan.intervals.push({ startTime: start, endTime: end, reasons: [reason] });
}

function scanConsecutiveRows(
  scan: VibroScan,
  matches: (index: number) => boolean,
  minTransitions: number,
  reason: VibroReason,
): void {
  const { times } = scan;
  let start = 1;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && matches(i)) continue;
    if (i - start >= minTransitions) addSection(scan, times[start - 1], times[i - 1], reason);
    start = i + 1;
  }
}

const repeatedRowGapMs = (mask: number) => mask === 15 ? 105 : 92;

function scanRepeatedRows(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  // Repeated full row shapes distinguish a wall from diverse chordjack.
  scanConsecutiveRows(scan, (i) => rows[i] === rows[i - 1] && bitCount(rows[i]) >= 2
    && times[i] - times[i - 1] <= repeatedRowGapMs(rows[i]) * rate,
  11, "repeated_wall");
  scanConsecutiveRows(scan, (i) => rows[i] === rows[i - 1] && times[i] - times[i - 1] <= 92 * rate,
  24, "sustained_jack");
}

function scanRepeatedJackStreams(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  // A sustained stream of short fixed-shape jacks is repetition too. Quads
  // on the accents and a different repeated jump in the next beat must not
  // reset the evidence for the entire passage. Measure rows participating in
  // 3..11-hit repetitions across 64 uninterrupted fast rows, with substantial
  // repeated-chord work. Single-finger triples with occasional chord accents
  // are ordinary minijack; doubles alone do not qualify either. Longer walls
  // already have their own detector and must not expand into surrounding
  // ordinary chordjack through this window. Short repetitions use the same
  // speed floor as long walls: accumulating slower jump-jack bursts does not
  // make them vibro just because the passage lasts longer. Quad repetitions
  // retain their wider cutoff, still bounded by the 100ms continuous stream.
  const burstRows = new Uint8Array(times.length);
  let repeatStart = 0;
  let maxRepeatGap = 0;
  for (let i = 1; i <= times.length; i++) {
    // Keep phrase boundaries at the stream cutoff. Splitting a long jack on
    // rounded 92/93ms gaps would manufacture qualifying short repetitions.
    if (i < times.length && rows[i] === rows[i - 1] && times[i] - times[i - 1] <= 100 * rate) {
      maxRepeatGap = Math.max(maxRepeatGap, times[i] - times[i - 1]);
      continue;
    }
    const count = i - repeatStart;
    if (count >= 3 && count < 12 && maxRepeatGap <= repeatedRowGapMs(rows[repeatStart]) * rate) {
      burstRows.fill(1, repeatStart, i);
    }
    repeatStart = i;
    maxRepeatGap = 0;
  }
  let fastStart = 0;
  let repeatedInWindow = 0;
  let repeatedChordsInWindow = 0;
  const burstWindowRows = 64;
  for (let i = 0; i < times.length; i++) {
    if (i > 0 && times[i] - times[i - 1] > 100 * rate) fastStart = i;
    repeatedInWindow += burstRows[i];
    repeatedChordsInWindow += burstRows[i] && bitCount(rows[i]) >= 2 ? 1 : 0;
    if (i >= burstWindowRows) repeatedInWindow -= burstRows[i - burstWindowRows];
    if (i >= burstWindowRows) repeatedChordsInWindow -= burstRows[i - burstWindowRows] && bitCount(rows[i - burstWindowRows]) >= 2 ? 1 : 0;
    if (i - fastStart + 1 >= burstWindowRows && repeatedInWindow / burstWindowRows >= 0.7
      && repeatedChordsInWindow / burstWindowRows >= 0.35) {
      addSection(scan, times[i - burstWindowRows + 1], times[i], "repeated_jack_stream");
    }
  }
}

function scanRepeatedPairs(scan: VibroScan): void {
  const { times, rows, rate } = scan;
  // An occasional accent must not disguise an otherwise fixed two-finger
  // repetition. Require the same pair throughout, not a different shared
  // pair on each changing chord.
  for (const pair of [3, 5, 6, 9, 10, 12]) {
    scanConsecutiveRows(scan, (i) => (rows[i] & pair) === pair && (rows[i - 1] & pair) === pair
      && times[i] - times[i - 1] <= 70 * rate,
    11, "repeated_chord");
  }
}

interface RepetitionBand {
  gapMs: number;
  averageGapMs: number;
  minHits: number;
  minShare: number;
  reason: VibroReason;
}

const SINGLE_FINGER_BANDS: readonly RepetitionBand[] = [
  { gapMs: 30, averageGapMs: 30, minHits: 4, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 85, averageGapMs: 55, minHits: 9, minShare: 0, reason: "rapid_jack_burst" },
];
const PAIR_BANDS: readonly RepetitionBand[] = [
  { gapMs: 55, averageGapMs: 55, minHits: 4, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 60, averageGapMs: 60, minHits: 6, minShare: 0, reason: "rapid_jack_burst" },
  { gapMs: 92, averageGapMs: 92, minHits: 12, minShare: 0.7, reason: "repeated_chord" },
];
const QUAD_BANDS: readonly RepetitionBand[] = [
  { gapMs: 92, averageGapMs: 92, minHits: 8, minShare: 0, reason: "repeated_wall" },
];

function scanFixedFingerWindows(scan: VibroScan): void {
  const { times, rows, prefixNotes, rate } = scan;
  // Follow fixed fingers through chord accents and intervening rows. Each
  // window must meet its own physical speed and repetition requirements;
  // adding slower context cannot dilute a fast local window. At moderate
  // speeds a fixed pair must dominate the local heads, so a shared pair in
  // otherwise varied chordjack is not enough. Quads need fewer repetitions.
  // Irregular fast single-finger runs allow brief slower gaps only while
  // their average return interval remains extremely short.
  for (const mask of [1, 2, 4, 8, 3, 5, 6, 9, 10, 12, 15]) {
    const fingers = bitCount(mask);
    const indices = rows.flatMap((row, i) => (row & mask) === mask ? [i] : []);
    const bands = fingers === 1 ? SINGLE_FINGER_BANDS : fingers === 4 ? QUAD_BANDS : PAIR_BANDS;
    for (const band of bands) {
      let phraseStart = 0;
      for (let i = 0; i < indices.length; i++) {
        if (i > 0 && times[indices[i]] - times[indices[i - 1]] > band.gapMs * rate) phraseStart = i;
        const firstHit = i - band.minHits + 1;
        if (firstHit < phraseStart) continue;
        const first = indices[firstHit];
        const last = indices[i];
        if (times[last] - times[first] > (band.minHits - 1) * band.averageGapMs * rate) continue;
        const localNotes = prefixNotes[last + 1] - prefixNotes[first];
        if (band.minHits * fingers / localNotes >= band.minShare) addSection(scan, times[first], times[last], band.reason);
      }
    }
  }
}

function scanIsolatedJacks(scan: VibroScan): void {
  const { times, rows, prefixNotes, rate, intervals } = scan;
  // A long single-finger run is only decisive when it dominates its local
  // note content. A busy finger underneath changing chords is ordinary CJ.
  const bursts: VibroSection[] = [];
  let isolatedBurstNotes = 0;
  for (let column = 0; column < 4; column++) {
    const indices = rows.flatMap((mask, i) => mask & (1 << column) ? [i] : []);
    let start = 0;
    for (let i = 1; i <= indices.length; i++) {
      if (i < indices.length && times[indices[i]] - times[indices[i - 1]] <= 100 * rate) continue;
      const count = i - start;
      if (count >= 9) {
        const first = indices[start];
        const last = indices[i - 1];
        const localNotes = prefixNotes[last + 1] - prefixNotes[first];
        if (count / localNotes >= 0.65) {
          const section: VibroSection = { startTime: times[first], endTime: times[last], reasons: ["isolated_jack"] };
          bursts.push(section);
          isolatedBurstNotes += count;
          if (count >= 25 && (times[last] - times[first]) / (count - 1) <= 92 * rate) intervals.push(section);
        }
      }
      start = i;
    }
  }
  // Repeated short isolated bursts are evidence together, not a reason to
  // carve a lone speedjack burst out of an otherwise varied chart.
  if (bursts.length >= 4 && isolatedBurstNotes / prefixNotes.at(-1)! >= 0.2) intervals.push(...bursts);
}

function countFastFingerReturns(scan: VibroScan, gapMs: number): number[] {
  const { times, rows, rate } = scan;
  const lastTimes = new Array<number>(4).fill(-Infinity);
  const repeatedFingers: number[] = [];
  for (let i = 0; i < times.length; i++) {
    let fast = 0;
    for (let column = 0; column < 4; column++) {
      if (!(rows[i] & (1 << column))) continue;
      if (times[i] - lastTimes[column] <= gapMs * rate) fast++;
      lastTimes[column] = times[i];
    }
    repeatedFingers.push(fast);
  }
  return repeatedFingers;
}

function scanSustainedChords(scan: VibroScan, repeatedFingers: readonly number[]): void {
  scanConsecutiveRows(scan, (i) => repeatedFingers[i] >= 2, 32, "sustained_chords");
}

function scanDenseChords(scan: VibroScan): void {
  const { times, prefixNotes, rate } = scan;
  // Dense overlapping chords can keep reloading the same fingers while
  // changing the full row shape or inserting a light row/breather. Requiring
  // 32 consecutive heavy rows misses those passages. Measure both the share
  // of rows reloading multiple fingers and the share of all heads returning
  // quickly, over 64 rows. Faster repeats need less chord-row coverage, but
  // still must dominate the note load. Ordinary fast changing chordjack does
  // not qualify through speed alone.
  const denseWindowRows = 64;
  for (const band of [
    { gapMs: 75, chordShare: 0.65, noteShare: 0.7 },
    { gapMs: 50, chordShare: 0.4, noteShare: 0.65 },
  ]) {
    const fastCounts = countFastFingerReturns(scan, band.gapMs);
    let phraseStart = 0;
    let chordRows = 0;
    let fastHeads = 0;
    for (let i = 0; i < times.length; i++) {
      if (i > 0 && times[i] - times[i - 1] > 1000 * rate) phraseStart = i;
      const fast = fastCounts[i];
      chordRows += fast >= 2 ? 1 : 0;
      fastHeads += fast;
      if (i >= denseWindowRows) {
        chordRows -= fastCounts[i - denseWindowRows] >= 2 ? 1 : 0;
        fastHeads -= fastCounts[i - denseWindowRows];
      }
      const first = i - denseWindowRows + 1;
      if (first >= phraseStart && times[i] - times[first] <= (denseWindowRows - 1) * 100 * rate
        && chordRows / denseWindowRows >= band.chordShare
        && fastHeads / (prefixNotes[i + 1] - prefixNotes[first]) >= band.noteShare) {
        addSection(scan, times[first], times[i], "dense_chord_repetition");
      }
    }
  }
}

function scanFastRolls(scan: VibroScan, repeatedFingers: readonly number[]): void {
  const { times, rows, prefixNotes, rate, intervals } = scan;
  // Disjoint fast rows alone also include flams. Require sustained fast
  // per-finger returns in the same run, not elsewhere in the chart.
  let rollStart = 1;
  const rollBursts: VibroSection[] = [];
  let rollBurstNotes = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i < times.length && !(rows[i] & rows[i - 1]) && times[i] - times[i - 1] <= 25 * rate) continue;
    if (i - rollStart >= 8) {
      const fast = repeatedFingers.slice(rollStart, i).reduce((a, b) => a + b, 0);
      const notes = prefixNotes[i] - prefixNotes[rollStart];
      if (fast / notes >= 0.25) {
        const section: VibroSection = { startTime: times[rollStart - 1], endTime: times[i - 1], reasons: ["fast_roll"] };
        if (i - rollStart >= 24) intervals.push(section);
        rollBursts.push(section);
        rollBurstNotes += notes;
      }
    }
    rollStart = i + 1;
  }
  if (rollBursts.length >= 4 && rollBurstNotes / prefixNotes.at(-1)! >= 0.2) intervals.push(...rollBursts);
}

function scanExtremeDensity(scan: VibroScan): void {
  const { times, rate } = scan;
  let windowStart = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[windowStart] > 1000 * rate) windowStart++;
    if (i - windowStart + 1 >= 65) addSection(scan, times[windowStart], times[i], "extreme_density");
  }
}

function mergeSections(intervals: VibroSection[]): VibroSection[] {
  const sections: VibroSection[] = [];
  for (const section of intervals.sort((a, b) => a.startTime - b.startTime)) {
    const previous = sections.at(-1);
    if (previous && section.startTime <= previous.endTime) {
      previous.endTime = Math.max(previous.endTime, section.endTime);
      previous.reasons = [...new Set([...previous.reasons, ...section.reasons])];
    } else sections.push({ ...section });
  }
  return sections;
}

function measureActiveDuration({ times, rate }: VibroScan): number {
  // Empty intros, breaks and padding must not dilute a dominant spam section.
  let duration = 0;
  for (let i = 1; i < times.length; i++) {
    duration += Math.min(times[i] - times[i - 1], 1000 * rate) / rate;
  }
  return duration;
}

function measureSectionCoverage(result: VibroAnalysis, map: ManiaBeatmap, scan: VibroScan): void {
  const { times, rate } = scan;
  let removedNotes = 0;
  let removedWeight = 0;
  for (const note of map.notes) {
    if (!overlapsVibro(note.time, note.endTime, result.sections)) continue;
    removedNotes++;
    removedWeight += note.isHold ? 2 : 1;
  }
  result.remainingNotes -= removedNotes;
  result.noteShare = removedNotes / map.notes.length;
  result.judgementShare = removedWeight / (removedWeight + result.remainingNotes);
  let sectionIndex = 0;
  for (let i = 1; i < times.length; i++) {
    while (sectionIndex < result.sections.length && result.sections[sectionIndex].endTime < times[i - 1]) sectionIndex++;
    for (let j = sectionIndex; j < result.sections.length && result.sections[j].startTime < times[i]; j++) {
      const section = result.sections[j];
      const overlap = Math.min(times[i], section.endTime) - Math.max(times[i - 1], section.startTime);
      if (overlap > 0) result.excludedDurationMs += Math.min(overlap, 1000 * rate) / rate;
    }
  }
  result.timeShare = result.activeDurationMs > 0 ? result.excludedDurationMs / result.activeDurationMs : 1;
  // Both time and note coverage matter. The remaining chart is recomputed,
  // so easy padding cannot retain the original spam-inflated difficulty.
  result.status = result.timeShare <= 0.15 && result.noteShare <= 0.25
    && result.remainingNotes >= 300 && result.activeDurationMs - result.excludedDurationMs >= 20_000
    ? "adjusted" : "excluded";
}

function overlapsVibro(start: number, end: number, sections: VibroSection[]): boolean {
  let low = 0;
  let high = sections.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sections[mid].endTime < start) low = mid + 1;
    else high = mid;
  }
  return low < sections.length && sections[low].startTime <= end;
}

/** Preserve all timestamps, metadata and breaks. Only remove hit objects;
 * stitching the remaining notes together would create artificial stamina. */
export function removeVibroSections(osuText: string, sections: VibroSection[]): string {
  let hitObjects = false;
  return osuText.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) hitObjects = trimmed === "[HitObjects]";
    if (!hitObjects || !trimmed.includes(",")) return true;
    const parts = trimmed.split(",");
    const start = Number(parts[2]);
    const end = Number(parts[3]) & 128 ? Number(parts[5]?.split(":")[0]) : start;
    return !overlapsVibro(start, end, sections);
  }).join("\n");
}

export function prepareVibroChart(osuText: string, rate = 1, map = parseManiaBeatmap(osuText)) {
  const analysis = analyzeVibroSections(map, rate);
  return {
    analysis,
    osuText: analysis.status === "adjusted" ? removeVibroSections(osuText, analysis.sections) : osuText,
  };
}

/** Lower bound on retained-note accuracy: assume the removed notes were
 * perfect and all losses occurred in the remainder. Input/output are 0..1. */
export function conservativeVibroAccuracy(accuracy: number, removedShare: number): number {
  if (!Number.isFinite(accuracy) || !Number.isFinite(removedShare) || removedShare >= 1) return 0;
  return Math.max(0, Math.min(1, 1 - (1 - accuracy) / (1 - Math.max(0, removedShare))));
}
