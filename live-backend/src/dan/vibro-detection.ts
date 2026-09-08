import type { ManiaBeatmap } from "./beatmap-parser.js";
import { analyzeVibroSections, usesSectionVibro } from "./vibro-sections.js";

// Detection entry points shared by chart analysis and player ratings.
// 4K rice delegates to the section detector; the remaining rules preserve
// the legacy policy for hold-heavy charts and other key counts.

// LN vibro: chart-wide staggered hold spam (the "gabe power" shape - dense LN
// rolls you play by shaking, not reading). The longjack detector only sees
// rice jack clusters, so these charts sailed through with inflated LN dans.
// A p75 row gap this tight sustained over a whole chart is beyond any legit
// LN chart: the densest ranked LN dumps (Denouement) sit at ~75ms rows, the
// calibration corpus bottoms out at 54ms p50 / 76ms p75, vibro at 22ms.
const LN_VIBRO_MIN_ROWS = 150;
const LN_VIBRO_MIN_HOLD_RATIO = 0.5;
const LN_VIBRO_MAX_P75_ROW_GAP_MS = 40;

// Rice vibro measured directly from note timing, because the longjack-cluster
// detector only fires on clusters labeled "Longjacks": chord-wall vibro reads
// as chordjack/quadstream and sailed through (Tamania's "impossible vibro pack"
// indexed as beta++ jack). Thresholds were calibrated against the local corpus:
// vibro-titled packs vs ranked jack files and celebrated dense charts
// (Gengaozo Innocence 1.05x, STRONG 280 1.1x, hurricanic 1.2x all stay clean).
//
// Tier 1 (any keymode): sustained same-column hammering. A run of 24+ hits with
// gaps <= 92ms (~11/s) is beyond human jacking when a quarter of the chart's
// column gaps are that fast; legit speedjack bursts stay under ~16 hits and
// ranked jack files measure runs <= 6.
const RICE_VIBRO_MIN_NOTES = 300;
const RICE_VIBRO_COLUMN_GAP_MS = 92;
const RICE_VIBRO_COLUMN_MIN_RUN = 24;
const RICE_VIBRO_COLUMN_MIN_RATIO = 0.25;
// Tier 2 (4K only): slower chord-wall vibro (~97-105ms quads you shake, not
// jack). Needs both recurring 4-note wall rows and a chart soaked in fast
// column repeats; dense legit 4K charts top out at ~3.3% wall rows, and the
// legit charts that do carry wall rows keep their column repeats at 105ms+,
// so their <=98ms column ratio measures 0.0 - the 0.32 floor has full margin.
const RICE_VIBRO_WALL_GAP_MS = 105;
const RICE_VIBRO_WALL_MIN_ROWS = 12;
const RICE_VIBRO_WALL_MIN_ROW_RATIO = 0.035;
const RICE_VIBRO_WALL_COLUMN_GAP_MS = 98;
const RICE_VIBRO_WALL_COLUMN_MIN_RATIO = 0.32;

// Tier 3 (any keymode): burst-soak vibro. Packs full of 8-23-note same-column
// bursts at <=100ms slip tiers 1-2 (runs too short for tier 1, no quad walls
// for tier 2), but a chart where a fifth of all column gaps sit inside such
// runs is nothing but bursts. Legit files with occasional speedjack stay far
// under: the calibration corpus's densest unflagged charts (William Tell EX
// piano rolls, Gengaozo 7K Z O) measure ~0.13, ranked jack files ~0.
const RICE_VIBRO_BURST_MIN_NOTES = 200;
const RICE_VIBRO_BURST_GAP_MS = 100;
const RICE_VIBRO_BURST_MIN_RUN = 8;
const RICE_VIBRO_BURST_MIN_RUNS = 4;
const RICE_VIBRO_BURST_MIN_FRACTION = 0.2;

// Tier 4 (any keymode): superhuman row density. Tiers 1-3 all measure repeats
// within a column, so a chart that sprays its spam across columns as jumps or
// quads slips every one of them - the "Hello (BPM) 2023" shape, where 4
// seconds of 15ms jumps closing an otherwise ordinary LN chart carry 19% of
// the notes and drag MinaCalc's chordjack from 22 to 76 (at the 0.93 goal the
// SSR chisel cannot write off a section holding that many points, so it rates
// the file for the spam). Rows rather than notes, because a wide chord is one
// action: 7K "This Future" peaks at 91 notes/s but only 13 rows/s and is
// entirely legit. Measured across every analyzed ranked and loved 4/6/7K chart
// (n=27,892), peak rows/s tops out at 55 (4K), 57 (7K) and 49 (6K), so 65
// clears the corpus by 14%; it fires on 88 of 128,784 analyzed charts, none of
// them ranked or loved.
const RICE_VIBRO_ROW_RATE_WINDOW_MS = 1000;
const RICE_VIBRO_MAX_ROWS_PER_SECOND = 65;

// Tier 5 (any keymode): chord jacks faster than a hand can jack. Tier 2 only
// counts *quad* pairs, so a 280BPM file alternating triples and quads slips
// it (the "Buddah Attachments [280BPM CJ]" shape measures 0.027 against that
// tier's 0.035 floor) while tier 1's run test misses because no single column
// ever holds 24 consecutive fast gaps - the chart spreads them. Measuring
// chord rows directly catches the whole jack-pack family: adjacent rows that
// both carry a near-full chord inside 70ms, which is a 214BPM chord jack, as
// a share of all row transitions. Chord size scales with the keymode because
// a 3-note chord is a wall in 4K and everyday density in 7K. Across every
// analyzed ranked and loved chart this tops out at 0.0040 (4K, n=20,735),
// 0.0000 (6K) and 0.0006 (7K), so 0.02 clears the corpus five times over; it
// fires on 0.32% of analyzed 4K charts, none of them ranked or loved.
const RICE_VIBRO_CHORD_WALL_GAP_MS = 70;
const RICE_VIBRO_CHORD_WALL_MIN_RATIO = 0.02;

// Tier 6 (4K only): roll vibro, the per-finger speed of the chart's rolls at
// the played rate. A 163BPM 1/16 four-column roll hits each finger every 92ms
// and breaks every 8-9 notes, which every tier above lets through (runs too
// short for tiers 1 and 3, no chords for 2 and 5, the breaks hold tier 4 under
// its row cap) - and at 1.5x it is a 61ms per-finger shake nobody rolls. Two
// measures, both at the played rate, and both have to hold. The original
// four-column calibration used these cutoffs (expanded below):
//  - per-finger: the share of all column gaps at or under 65ms (~15/s per
//    finger). Ranked and loved 4K at 1.0x (n=23,545) top out at 0.114; the
//    motivating chart measures 0.47 at 1.5x and 0.00 at 1.0x.
//  - roll: the share of row transitions at or under 20ms that move to other
//    columns (same-column flams like skalop's 8ms doubles do not count). This
//    is what keeps
//    the per-finger measure honest: 230-240BPM 1/4 jack files and fast
//    minijack charts also put a quarter of their column gaps under 65ms
//    (Overdose Party [230JACK], The Finale (Zero), skalop) but their rows sit
//    64ms+ apart - a jack is one finger, a roll is the whole hand cycling.
//    Ranked and loved 4K at 1.0x stay under 0.30 (a loved chart tier 1
//    already flags), p99.9 at 0.11; the motivating chart measures 0.67 at
//    1.5x (23ms rows) and 0.00 at 1.0x.
// No ranked or loved 4K chart meets both at 1.0x. 4K only: ranked 7K carries
// 55ms column repeats routinely (0.48 on VIVID), so the per-finger measure
// says nothing there.
// Three-column rolls need a slightly wider timing envelope than the original
// four-column calibration: 100ms repeats / 33-34ms rows become 66-67ms /
// 22-23ms at DT. Requiring both chart-wide shares still separates these from
// fast jacks and isolated flams; neither signal alone proves roll vibro.
// Across 111,502 cached 4K charts and 23,593 stored uprates, the expansion
// adds no ranked/loved charts at 1.0x and reaches 16 additional uprate pairs.
// The reported pattern measures 0.283 column share and 0.506 row share at DT.
const RICE_VIBRO_ROLL_GAP_MS = 70;
const RICE_VIBRO_ROLL_MIN_RATIO = 0.25;
const RICE_VIBRO_ROLL_ROW_GAP_MS = 25;
const RICE_VIBRO_ROLL_MIN_ROW_RATIO = 0.3;

function columnFastGaps(map: ManiaBeatmap, cutoffMs: number): { maxRun: number; ratio: number } {
  const byColumn = new Map<number, number[]>();
  for (const note of map.notes) {
    const list = byColumn.get(note.column) ?? [];
    list.push(note.time);
    byColumn.set(note.column, list);
  }
  let maxRun = 0;
  let fast = 0;
  let total = 0;
  for (const times of byColumn.values()) {
    times.sort((a, b) => a - b);
    let run = 0;
    for (let index = 1; index < times.length; index++) {
      const gap = times[index] - times[index - 1];
      if (gap <= 0) continue;
      total++;
      if (gap <= cutoffMs) {
        fast++;
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
  }
  return { maxRun, ratio: total > 0 ? fast / total : 0 };
}

// Same per-column scan, but measuring how much of the chart sits inside fast
// runs of at least minRun hits (the tier-3 burst-soak signal).
/**
 * Share of row-to-row transitions at or under cutoffMs that move to other
 * columns. A roll cycles the hand, so consecutive rows share no column; a
 * same-column pair that close is a flam (skalop's 8ms doubles) or a stack,
 * which is not the shape this measures.
 */
function fastRollRowShare(map: ManiaBeatmap, cutoffMs: number): number {
  const rows = new Map<number, Set<number>>();
  for (const note of map.notes) {
    const columns = rows.get(note.time) ?? new Set<number>();
    columns.add(note.column);
    rows.set(note.time, columns);
  }
  const times = [...rows.keys()].sort((a, b) => a - b);
  if (times.length < 2) return 0;
  let fast = 0;
  for (let index = 1; index < times.length; index++) {
    if (times[index] - times[index - 1] > cutoffMs) continue;
    const previous = rows.get(times[index - 1])!;
    let shared = false;
    for (const column of rows.get(times[index])!) if (previous.has(column)) { shared = true; break; }
    if (!shared) fast++;
  }
  return fast / (times.length - 1);
}

function columnBurstRuns(map: ManiaBeatmap, cutoffMs: number, minRun: number): { runs: number; fraction: number } {
  const byColumn = new Map<number, number[]>();
  for (const note of map.notes) {
    const list = byColumn.get(note.column) ?? [];
    list.push(note.time);
    byColumn.set(note.column, list);
  }
  let runs = 0;
  let inRuns = 0;
  let total = 0;
  for (const times of byColumn.values()) {
    times.sort((a, b) => a - b);
    let run = 0;
    const flush = () => {
      if (run >= minRun) {
        runs++;
        inRuns += run;
      }
      run = 0;
    };
    for (let index = 1; index < times.length; index++) {
      const gap = times[index] - times[index - 1];
      if (gap <= 0) continue;
      total++;
      if (gap <= cutoffMs) run++;
      else flush();
    }
    flush();
  }
  return { runs, fraction: total > 0 ? inRuns / total : 0 };
}

function quadWallRows(map: ManiaBeatmap, cutoffMs: number): { rows: number; ratio: number } {
  const rowSizes = new Map<number, number>();
  for (const note of map.notes) rowSizes.set(note.time, (rowSizes.get(note.time) ?? 0) + 1);
  const times = [...rowSizes.keys()].sort((a, b) => a - b);
  let rows = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap <= 0 || gap > cutoffMs) continue;
    if ((rowSizes.get(times[index]) ?? 0) >= 4 && (rowSizes.get(times[index - 1]) ?? 0) >= 4) rows++;
  }
  return { rows, ratio: times.length > 1 ? rows / (times.length - 1) : 0 };
}

// Share of row transitions where both rows carry a near-full chord and sit
// inside cutoffMs (the tier-5 chord-jack signal).
function chordWallRatio(map: ManiaBeatmap, cutoffMs: number): number {
  const rowSizes = new Map<number, number>();
  for (const note of map.notes) rowSizes.set(note.time, (rowSizes.get(note.time) ?? 0) + 1);
  const times = [...rowSizes.keys()].sort((a, b) => a - b);
  if (times.length < 2) return 0;
  const minChord = Math.max(2, map.keyCount - 1);
  let walls = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index] - times[index - 1];
    if (gap <= 0 || gap > cutoffMs) continue;
    if ((rowSizes.get(times[index]) ?? 0) >= minChord && (rowSizes.get(times[index - 1]) ?? 0) >= minChord) walls++;
  }
  return walls / (times.length - 1);
}

// Peak count of distinct hit instants inside any one real-time second. The
// window is chart time, so a rate widens it: 1500ms of a 1.5x chart is a
// second of play.
function peakRowsPerSecond(map: ManiaBeatmap, windowMs: number): number {
  const times = [...new Set(map.notes.map((note) => note.time))].sort((a, b) => a - b);
  let peak = 0;
  let start = 0;
  for (let index = 0; index < times.length; index++) {
    while (times[index] - times[start] > windowMs) start++;
    const rows = index - start + 1;
    if (rows > peak) peak = rows;
  }
  return peak;
}

/** Tier 6 on its own; detectRateVibro combines the play-side-safe tiers. */
export function detectRollVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (map.keyCount !== 4 || map.notes.length < RICE_VIBRO_MIN_NOTES) return false;
  return columnFastGaps(map, RICE_VIBRO_ROLL_GAP_MS * rate).ratio >= RICE_VIBRO_ROLL_MIN_RATIO
    && fastRollRowShare(map, RICE_VIBRO_ROLL_ROW_GAP_MS * rate) >= RICE_VIBRO_ROLL_MIN_ROW_RATIO;
}

// A rate can also turn ordinary chordjack into vibro without ever looking like
// a roll: 128BPM chord walls become 218BPM at 1.7x, and in the reported shape
// 68% of all row transitions are then near-full chords inside tier 5's 70ms
// window. The ordinary tier-5 floor (2%) is deliberately too broad for
// play-side rate checks: scaling it catches a small fast chordjack burst in
// otherwise legit DT files. Requiring half of the whole chart says the
// superhuman chord wall IS the chart. Measured over 24,407 stored uprate pairs,
// this reaches five pairs (three from one short vibro-pack chart) rather than
// the 165 the 2% floor reaches, while retaining 0.18 margin under the reported
// chart's 0.68.
const RATE_VIBRO_CHORD_WALL_MIN_RATIO = 0.5;

// Repeated chords can reload two fingers on every row while rotating the
// third finger out. Individual jack runs stay short and near-full chord pairs
// need not occupy half the chart. Require speed, prevalence and sustained work
// together so isolated DT bursts and ordinary fast chordjack stay eligible.
// Calibrated on 4K rice (<=10% holds): no matches among 8,090 unique ranked/
// loved charts at 1.0x or 5,599 with a recorded 96%+ DT clear. The same shape
// occurs in fast chord-vibro packs; titles never participate in the detector.
// Faster repeats need less chart-wide coverage, but must satisfy all three
// requirements at that faster cutoff. A 36% share of 55ms chord repeats must
// not be treated like 36% of 67ms repeats in a legitimate fast jack chart.
const SUSTAINED_CHORD_VIBRO_BANDS = [
  { gapMs: 70, columnShare: 0.4 },
  { gapMs: 60, columnShare: 0.35 },
] as const;
const SUSTAINED_CHORD_VIBRO_MIN_ROW_SHARE = 0.2;
// 32 consecutive chord rows are about two seconds near the 70ms boundary.
// Count repetitions so a faster rate cannot make an already-vibro section
// pass merely by shortening its real-time duration below two seconds.
const SUSTAINED_CHORD_VIBRO_MIN_ROWS = 32;
const SUSTAINED_CHORD_VIBRO_MAX_HOLD_RATIO = 0.1;

/** A row qualifies when at least two distinct fingers each re-hit within
 * the band's time window. A continuous section contains only such rows. */
export function detectSustainedChordVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (map.keyCount !== 4 || map.notes.length < RICE_VIBRO_MIN_NOTES || !Number.isFinite(rate) || rate <= 0) return false;
  const rows = new Map<number, number>();
  let holds = 0;
  for (const note of map.notes) {
    rows.set(note.time, (rows.get(note.time) ?? 0) | (1 << note.column));
    if (note.isHold) holds++;
  }
  if (holds / map.notes.length > SUSTAINED_CHORD_VIBRO_MAX_HOLD_RATIO) return false;

  const times = [...rows.keys()].sort((a, b) => a - b);
  for (const band of SUSTAINED_CHORD_VIBRO_BANDS) {
    const lastColumnTimes = new Array<number>(4).fill(-Infinity);
    const cutoff = band.gapMs * rate;
    let columnGaps = 0;
    let fastColumnGaps = 0;
    let chordRows = 0;
    let consecutiveRows = 0;
    let longestRun = 0;
    for (const time of times) {
      const mask = rows.get(time)!;
      let fastFingers = 0;
      for (let column = 0; column < 4; column++) {
        if (!(mask & (1 << column))) continue;
        const gap = time - lastColumnTimes[column];
        if (Number.isFinite(gap) && gap > 0) {
          columnGaps++;
          if (gap <= cutoff) {
            fastColumnGaps++;
            fastFingers++;
          }
        }
        lastColumnTimes[column] = time;
      }
      if (fastFingers >= 2) {
        chordRows++;
        consecutiveRows++;
        longestRun = Math.max(longestRun, consecutiveRows);
      } else {
        consecutiveRows = 0;
      }
    }
    if (columnGaps > 0
      && fastColumnGaps / columnGaps >= band.columnShare
      && chordRows / rows.size >= SUSTAINED_CHORD_VIBRO_MIN_ROW_SHARE
      && longestRun >= SUSTAINED_CHORD_VIBRO_MIN_ROWS) return true;
  }
  return false;
}

/**
 * Full-map exclusion at the played rate. 4K rice shares the section policy
 * with normal-speed chart analysis; adjusted charts return false here.
 *
 * The legacy path for other charts must not use all of detectRiceVibro's
 * tiers at rate. Tiers 1-4 were
 * calibrated at 1.0x and the widened cutoffs call real 210-256BPM DT jack
 * clears vibro. The roll and sustained-chord tiers are rate-calibrated
 * directly; the chord-wall arm adds chart-soaked near-full walls.
 */
export function detectRateVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (usesSectionVibro(map)) return analyzeVibroSections(map, rate).status === "excluded";
  if (detectRollVibro(map, rate)) return true;
  if (detectSustainedChordVibro(map, rate)) return true;
  if (map.notes.length < RICE_VIBRO_BURST_MIN_NOTES) return false;
  return chordWallRatio(map, RICE_VIBRO_CHORD_WALL_GAP_MS * rate) >= RATE_VIBRO_CHORD_WALL_MIN_RATIO;
}

export function detectRiceVibro(map: ManiaBeatmap, rate = 1): boolean {
  if (usesSectionVibro(map)) return analyzeVibroSections(map, rate).status === "excluded";
  if (map.notes.length >= RICE_VIBRO_MIN_NOTES) {
    const sustained = columnFastGaps(map, RICE_VIBRO_COLUMN_GAP_MS * rate);
    if (sustained.maxRun >= RICE_VIBRO_COLUMN_MIN_RUN && sustained.ratio >= RICE_VIBRO_COLUMN_MIN_RATIO) return true;
    if (detectSustainedChordVibro(map, rate)) return true;

    // The wall tier's chord-size floor assumes 4 columns; wider keymodes carry
    // legit 4-note chords constantly, so it stays 4K-scoped.
    if (map.keyCount === 4) {
      const walls = quadWallRows(map, RICE_VIBRO_WALL_GAP_MS * rate);
      if (walls.rows >= RICE_VIBRO_WALL_MIN_ROWS && walls.ratio >= RICE_VIBRO_WALL_MIN_ROW_RATIO) {
        const fast = columnFastGaps(map, RICE_VIBRO_WALL_COLUMN_GAP_MS * rate);
        if (fast.ratio >= RICE_VIBRO_WALL_COLUMN_MIN_RATIO) return true;
      }
      if (detectRollVibro(map, rate)) return true;
    }
  }

  // Tiers 3 and 4 share a lower size floor: TV-size burst packs sit under the
  // tier-1 floor but their soak fraction is unambiguous.
  if (map.notes.length >= RICE_VIBRO_BURST_MIN_NOTES) {
    const bursts = columnBurstRuns(map, RICE_VIBRO_BURST_GAP_MS * rate, RICE_VIBRO_BURST_MIN_RUN);
    if (bursts.runs >= RICE_VIBRO_BURST_MIN_RUNS && bursts.fraction >= RICE_VIBRO_BURST_MIN_FRACTION) return true;

    // Tier 4 shares that floor: the shape is a burst, so chart length says
    // nothing about it, and the smallest chart the sweep flags carries 217
    // notes.
    if (peakRowsPerSecond(map, RICE_VIBRO_ROW_RATE_WINDOW_MS * rate) >= RICE_VIBRO_MAX_ROWS_PER_SECOND) return true;

    if (chordWallRatio(map, RICE_VIBRO_CHORD_WALL_GAP_MS * rate) >= RICE_VIBRO_CHORD_WALL_MIN_RATIO) return true;
  }
  return false;
}

export function detectLnVibro(map: ManiaBeatmap, rate = 1): boolean {
  let holds = 0;
  const rowTimes = new Set<number>();
  for (const note of map.notes) {
    if (note.isHold && note.endTime > note.time) holds++;
    rowTimes.add(note.time);
  }
  if (map.notes.length === 0 || rowTimes.size < LN_VIBRO_MIN_ROWS) return false;
  if (holds / map.notes.length < LN_VIBRO_MIN_HOLD_RATIO) return false;
  const times = [...rowTimes].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index++) gaps.push(times[index] - times[index - 1]);
  gaps.sort((a, b) => a - b);
  const p75 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.75))];
  // Gaps are chart-time; a rate rescales what the player experiences.
  return p75 <= LN_VIBRO_MAX_P75_ROW_GAP_MS * rate;
}
