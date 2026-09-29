// Note-weighted song tempo at 1.0x: the median BPM at each note's start time.
// The osu! API bpm field takes the longest timing point, which misreads
// marathons, medleys, long off-tempo intros and gimmick timing. Only
// [TimingPoints] and [HitObjects] start times are parsed.
//
// Some charts are timed at a multiple of the song tempo. A section above 300
// folds when its most common note gap is half a beat or coarser, and always
// folds above 500. The shallowest divisor wins unless a deeper grid explains
// clearly more of the note gaps. Folds may land up to 350 because real songs
// reach about 333.

const FOLD = {
  TRIGGER_BPM: 300,
  // No song is this fast, so fold regardless of snap evidence.
  MANDATORY_BPM: 500,
  // Divisors tried past the first plausible one. Real inflation is 2x-8x.
  MAX_CANDIDATES: 16,
  // A 1ms beat. Faster timing is left to the clamp. This also keeps the
  // divisor walk in exact-integer range.
  MAX_RAW_BPM: 60000,
  TARGET_MAX_BPM: 350,
  // Deepest fold considered.
  MIN_BPM: 100,
  // Extra share of the gaps a deeper fold must explain to win.
  DEEPER_MARGIN: 0.1,
};

// A dominant gap of at least this many beats reads as coarse.
const COARSE_GAP_BEATS = 0.45;
// Row gaps in beats that mappers use. Kept sparse because a dense grid
// credits deeper folds for almost any gap.
const BINARY_ROW_GAPS = [1 / 16, 1 / 8, 3 / 16, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1, 1.5, 2, 3, 4];
const TRIPLET_ROW_GAPS = [1 / 12, 1 / 6, 1 / 3, 2 / 3];
const TRIPLET_SNAP_WEIGHT = 0.5;
// Longer gaps are pauses and carry no snap evidence.
const MAX_EVIDENCE_GAP_BEATS = 4;
// Sections with fewer gaps keep their raw tempo.
const MIN_FOLD_EVIDENCE_GAPS = 8;
// Share of the snap length a gap may miss by. Never under 1ms because osu!
// stores integer note times.
const SNAP_TOLERANCE = 0.03;
const SNAP_TOLERANCE_MIN_MS = 1;

// Final clamp for tempos the fold cannot resolve.
const MIN_BPM = 10;
const MAX_BPM = 1200;

interface TimingSection {
  time: number;
  beatLength: number;
}

export function computeNoteBpm(osuText: string): number | null {
  const timingPoints: TimingSection[] = [];
  const noteTimes: number[] = [];

  let section = "";
  for (const rawLine of osuText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }

    if (section === "TimingPoints" && line.includes(",")) {
      const parts = line.split(",");
      if (parts.length >= 2) {
        const time = parseFloat(parts[0]);
        const beatLength = parseFloat(parts[1]);
        const uninherited = parts.length < 7 || parts[6].trim() !== "0";
        if (Number.isFinite(time) && beatLength > 0 && uninherited) {
          timingPoints.push({ time, beatLength });
        }
      }
    }

    if (section === "HitObjects" && line.includes(",")) {
      const parts = line.split(",");
      if (parts.length >= 5) {
        const time = parseInt(parts[2], 10);
        if (Number.isFinite(time)) noteTimes.push(time);
      }
    }
  }

  if (timingPoints.length === 0 || noteTimes.length === 0) return null;

  timingPoints.sort((a, b) => a.time - b.time);
  noteTimes.sort((a, b) => a - b);

  // The first timing point also covers notes before it, as in osu!.
  const sectionIndexPerNote: number[] = [];
  let pointIndex = 0;
  for (const time of noteTimes) {
    while (pointIndex + 1 < timingPoints.length && timingPoints[pointIndex + 1].time <= time) {
      pointIndex += 1;
    }
    sectionIndexPerNote.push(pointIndex);
  }

  const sectionBpms = timingPoints.map((point, index) =>
    resolveSectionBpm(point, collectSectionRowGaps(noteTimes, sectionIndexPerNote, index)),
  );

  const bpms = sectionIndexPerNote.map((index) => sectionBpms[index]);
  bpms.sort((a, b) => a - b);
  const mid = Math.floor(bpms.length / 2);
  const median = bpms.length % 2 === 1 ? bpms[mid] : (bpms[mid - 1] + bpms[mid]) / 2;
  return Math.round(median * 100) / 100;
}

// Gaps in ms between rows inside one timing section. Chords count as one row.
// Gaps across a section boundary are dropped.
function collectSectionRowGaps(noteTimes: number[], sectionIndexPerNote: number[], sectionIndex: number): number[] {
  const gaps: number[] = [];
  let previousTime: number | null = null;
  for (let i = 0; i < noteTimes.length; i++) {
    if (sectionIndexPerNote[i] !== sectionIndex) {
      previousTime = null;
      continue;
    }
    if (previousTime != null && noteTimes[i] > previousTime) {
      gaps.push(noteTimes[i] - previousTime);
    }
    previousTime = noteTimes[i];
  }
  return gaps;
}

function resolveSectionBpm(point: TimingSection, rowGaps: number[]): number {
  const rawBpm = 60000 / point.beatLength;
  let bpm = rawBpm;

  if (rawBpm > FOLD.TRIGGER_BPM && rawBpm <= FOLD.MAX_RAW_BPM && rowGaps.length >= MIN_FOLD_EVIDENCE_GAPS) {
    if (rawBpm > FOLD.MANDATORY_BPM || dominantGapIsCoarse(point.beatLength, rowGaps)) {
      bpm = foldInflatedTempo(rawBpm, point.beatLength, rowGaps);
    }
  }

  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

function dominantGapIsCoarse(beatLength: number, rowGaps: number[]): boolean {
  // Gaps in beats, rounded to a 1/12 grid.
  const gapCounts = new Map<number, number>();
  for (const gap of rowGaps) {
    const beats = Math.round((gap / beatLength) * 12) / 12;
    if (beats <= 0 || beats > MAX_EVIDENCE_GAP_BEATS) continue;
    gapCounts.set(beats, (gapCounts.get(beats) ?? 0) + 1);
  }
  // Ties go to the finer gap, so a chart that streams as much as it jacks
  // keeps its tempo.
  const dominant = [...gapCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return dominant != null && dominant[0] >= COARSE_GAP_BEATS;
}

function foldInflatedTempo(rawBpm: number, beatLength: number, rowGaps: number[]): number {
  const firstDivisor = Math.max(2, Math.ceil(rawBpm / FOLD.TARGET_MAX_BPM));

  let bestDivisor = firstDivisor;
  let bestScore = snapGridScore(beatLength * firstDivisor, rowGaps);
  const lastDivisor = firstDivisor + FOLD.MAX_CANDIDATES;
  for (let divisor = firstDivisor + 1; divisor <= lastDivisor && rawBpm / divisor >= FOLD.MIN_BPM; divisor += 1) {
    const score = snapGridScore(beatLength * divisor, rowGaps);
    if (score >= bestScore + FOLD.DEEPER_MARGIN) {
      bestDivisor = divisor;
      bestScore = score;
    }
  }
  return rawBpm / bestDivisor;
}

// Share of the gaps a candidate beat length explains. Triplet snaps count
// half.
function snapGridScore(beatLength: number, rowGaps: number[]): number {
  let weight = 0;
  let evidence = 0;
  for (const gap of rowGaps) {
    if (gap > beatLength * MAX_EVIDENCE_GAP_BEATS) continue;
    evidence += 1;
    if (sitsOnSnap(gap, beatLength, BINARY_ROW_GAPS)) weight += 1;
    else if (sitsOnSnap(gap, beatLength, TRIPLET_ROW_GAPS)) weight += TRIPLET_SNAP_WEIGHT;
  }
  return evidence === 0 ? 0 : weight / evidence;
}

function sitsOnSnap(gap: number, beatLength: number, snaps: number[]): boolean {
  for (const snap of snaps) {
    const snapMs = snap * beatLength;
    if (Math.abs(gap - snapMs) <= Math.max(SNAP_TOLERANCE_MIN_MS, snapMs * SNAP_TOLERANCE)) return true;
  }
  return false;
}
