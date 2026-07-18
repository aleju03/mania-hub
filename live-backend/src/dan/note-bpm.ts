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
// own titles call "160 chordjack" / "182 bpm"). The tell in the timing data:
// those sections place notes dominantly on half-beat-or-coarser snaps of
// their inflated grid, while genuinely fast charts (stamina/speedcore dans up
// to ~440) stream on 1/4 snaps. So a section folds - divides by the smallest
// integer that lands at or under FOLD_TARGET_MAX_BPM - only when its tempo is
// implausible as a song tempo AND its dominant note gap is coarse. Corpus
// check (July 2026): every sampled >300-nominal chart with 1/4-snap notes was
// a real stamina chart, every folded one a gimmick or chordjack rate-edit.
//
// Trigger and target bands differ on purpose: chordjack rate-edits crowd the
// 302-350 nominal band (fold them), yet real songs exist up to ~333 (Camellia
// speedcore - honest sibling timings of the 666 remix read 333/266.4), so a
// fold may legitimately land in (300, 350].
const FOLD_TRIGGER_BPM = 300;
const FOLD_TARGET_MAX_BPM = 350;
const COARSE_GAP_BEATS = 0.45;
// Gaps longer than this are pauses, not rhythm, and carry no snap evidence.
const MAX_EVIDENCE_GAP_BEATS = 4;
// Sections with fewer gaps than this keep their raw tempo: too little snap
// evidence to call the timing inflated (their few notes barely move the
// median anyway).
const MIN_FOLD_EVIDENCE_GAPS = 8;

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

  if (rawBpm > FOLD_TRIGGER_BPM && rowGaps.length >= MIN_FOLD_EVIDENCE_GAPS) {
    // Snap evidence: gaps in beats on a 1/12 grid (covers 1/3 + 1/4 rhythms).
    const gapCounts = new Map<number, number>();
    for (const gap of rowGaps) {
      const beats = Math.round((gap / point.beatLength) * 12) / 12;
      if (beats <= 0 || beats > MAX_EVIDENCE_GAP_BEATS) continue;
      gapCounts.set(beats, (gapCounts.get(beats) ?? 0) + 1);
    }
    // Tie-break toward the finer gap: a chart that streams as much as it
    // jacks reads as genuinely timed and keeps its tempo.
    const dominant = [...gapCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (dominant && dominant[0] >= COARSE_GAP_BEATS) {
      let divisor = 2;
      while (rawBpm / divisor > FOLD_TARGET_MAX_BPM) divisor += 1;
      bpm = rawBpm / divisor;
    }
  }

  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}
