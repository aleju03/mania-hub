// Note-weighted song tempo at 1.0x: the median BPM in effect at the
// hit-object start times. The osu! API's nominal bpm field is the most-common
// timing point by wall-clock duration, which misreads marathons/medleys,
// charts with long off-tempo intros or breaks, and BPM-gimmick timing - the
// player never plays those tempos. Taking the median over the notes instead of
// the clock reads "the tempo under the notes you actually hit" while keeping
// song-tempo units (unlike pattern-cluster BPM, whose conventions read
// jumptrills at ~2x). Only [TimingPoints] and [HitObjects] start times are
// parsed; this stays deliberately lighter than beatmap-parser.ts.

// Inflated-timing fold. Mappers time gimmick and chordjack charts at an
// integer multiple of the song tempo (Camellia's Flandre-S remix is timed 666
// = 2 x 333; rate-edit chordjack uploads read 300-400 nominal for what their
// own titles call "160 chordjack" / "182 bpm"; a 999-timed ranked 7K set
// whose thread worked out the real tempo as 999 / 4 = 249.75). Two questions,
// answered from the note gaps inside the section:
//
// 1. Fold at all? A tempo in (300, 500] folds only when its dominant note gap
//    is coarse (half-beat-or-coarser on the inflated grid): genuinely fast
//    charts (stamina/speedcore dans up to ~440) stream on 1/4 snaps, and the
//    corpus check (July 2026) found every sampled >300-nominal chart with
//    1/4-snap notes was a real stamina chart, every folded one a gimmick or
//    chordjack rate-edit. Above 500 no song exists, so the fold is mandatory
//    however fine the snaps read: 1/4 notes of a 999 grid are 15ms vibro, not
//    a stream.
// 2. How far? Candidate divisors run from the first that lands at or under
//    FOLD_TARGET_MAX_BPM down to FOLD_MIN_BPM, and each candidate grid is
//    scored by how much of the gap evidence it explains with snaps a mapper
//    actually places: binary snaps (k/16 of a beat) count in full, triplet
//    snaps (k/12) half, anything else nothing. The shallowest candidate wins
//    unless a deeper one explains clearly more (FOLD_DEEPER_MARGIN), so a chart
//    whose only gap is one half-beat keeps the conservative /2 reading, while
//    the 999 set folds past 333 (where its 20ms and 40ms rows would be 1/9 and
//    2/9 notes) to 249.75, where every row sits on 1/16, 1/12, 1/8, 1/4, 1/2
//    or 1/1.
//
// Trigger and target bands differ on purpose: chordjack rate-edits crowd the
// 302-350 nominal band (fold them), yet real songs exist up to ~333 (Camellia
// speedcore - honest sibling timings of the 666 remix read 333/266.4), so a
// fold may legitimately land in (300, 350].
const FOLD_TRIGGER_BPM = 300;
// Above this no song tempo exists: fold regardless of snap evidence.
const FOLD_MANDATORY_BPM = 500;
// Candidate divisors walked past the first plausible one. Real inflation is
// 2x-8x; the cap keeps a beatLength-1 meme point (60000 BPM, first divisor
// 172) from walking hundreds of divisors that all read garbage.
const FOLD_MAX_CANDIDATES = 16;
// Beyond a 1ms beat the timing is a number, not a tempo (SV gimmick charts
// carry 1e11 and 1e24 points): no fold, the clamp takes it. Also keeps the
// divisor walk in exact-integer range; at 1e24 `divisor + 1 === divisor`.
const FOLD_MAX_RAW_BPM = 60000;
const FOLD_TARGET_MAX_BPM = 350;
// Deepest fold considered; inflated timing below this is not a thing.
const FOLD_MIN_BPM = 100;
const COARSE_GAP_BEATS = 0.45;
// Gaps between consecutive rows a mapper places, in beats: binary snaps and
// the triplet ones. Deliberately sparse (not every k/16): a dense grid gives a
// deeper, longer-beat candidate chance credit for almost any gap.
const BINARY_ROW_GAPS = [1 / 16, 1 / 8, 3 / 16, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1, 1.5, 2, 3, 4];
const TRIPLET_ROW_GAPS = [1 / 12, 1 / 6, 1 / 3, 2 / 3];
// Gaps longer than this are pauses, not rhythm, and carry no snap evidence.
const MAX_EVIDENCE_GAP_BEATS = 4;
// Sections with fewer gaps than this keep their raw tempo: too little snap
// evidence to call the timing inflated (their few notes barely move the
// median anyway).
const MIN_FOLD_EVIDENCE_GAPS = 8;
// A gap sits on a snap when it lands within this share of the snap's length
// (never under 1ms: osu! stores note times as integers).
const SNAP_TOLERANCE = 0.03;
const SNAP_TOLERANCE_MIN_MS = 1;
const TRIPLET_SNAP_WEIGHT = 0.5;
// A deeper fold must explain at least this much more of the evidence than the
// shallowest candidate to take over.
const FOLD_DEEPER_MARGIN = 0.1;

// Final safety clamp for tempos the fold cannot make sense of (e.g. 10000-BPM
// meme charts whose notes are fine-snapped vibro).
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

  // Walk notes and timing points together; the first timing point applies
  // retroactively to notes before it, matching osu!'s behavior.
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

// Gaps between consecutive distinct note rows inside one timing section
// (chords collapse to a single row; a gap spanning a section boundary belongs
// to neither section).
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

  if (rawBpm > FOLD_TRIGGER_BPM && rawBpm <= FOLD_MAX_RAW_BPM && rowGaps.length >= MIN_FOLD_EVIDENCE_GAPS) {
    if (rawBpm > FOLD_MANDATORY_BPM || dominantGapIsCoarse(point.beatLength, rowGaps)) {
      bpm = foldInflatedTempo(rawBpm, point.beatLength, rowGaps);
    }
  }

  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

function dominantGapIsCoarse(beatLength: number, rowGaps: number[]): boolean {
  // Snap evidence: gaps in beats on a 1/12 grid (covers 1/3 + 1/4 rhythms).
  const gapCounts = new Map<number, number>();
  for (const gap of rowGaps) {
    const beats = Math.round((gap / beatLength) * 12) / 12;
    if (beats <= 0 || beats > MAX_EVIDENCE_GAP_BEATS) continue;
    gapCounts.set(beats, (gapCounts.get(beats) ?? 0) + 1);
  }
  // Tie-break toward the finer gap: a chart that streams as much as it
  // jacks reads as genuinely timed and keeps its tempo.
  const dominant = [...gapCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return dominant != null && dominant[0] >= COARSE_GAP_BEATS;
}

function foldInflatedTempo(rawBpm: number, beatLength: number, rowGaps: number[]): number {
  const firstDivisor = Math.max(2, Math.ceil(rawBpm / FOLD_TARGET_MAX_BPM));

  let bestDivisor = firstDivisor;
  let bestScore = snapGridScore(beatLength * firstDivisor, rowGaps);
  const lastDivisor = firstDivisor + FOLD_MAX_CANDIDATES;
  for (let divisor = firstDivisor + 1; divisor <= lastDivisor && rawBpm / divisor >= FOLD_MIN_BPM; divisor += 1) {
    const score = snapGridScore(beatLength * divisor, rowGaps);
    if (score >= bestScore + FOLD_DEEPER_MARGIN) {
      bestDivisor = divisor;
      bestScore = score;
    }
  }
  return rawBpm / bestDivisor;
}

// Share of the gap evidence a candidate beat length explains with snaps a
// mapper places: binary snaps in full, triplets at TRIPLET_SNAP_WEIGHT. Gaps
// beyond MAX_EVIDENCE_GAP_BEATS of the candidate grid are pauses and count
// neither way.
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
