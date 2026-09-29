// Parses a mania .osu file into the note list every rating module reads:
// columns, note and hold times, key count, OD, breaks, red-line timing, and
// the scroll velocity changes the player sees (normalized so the chart's main
// tempo scrolls at 1.0x).

export interface ManiaNote {
  column: number; // 0-indexed
  time: number; // start time, ms
  endTime: number; // end time, ms (equals time for a tap, later for a hold)
  isHold: boolean;
}

export interface ManiaScrollVelocity {
  time: number;
  multiplier: number;
}

export interface ManiaBreakPeriod {
  startTime: number;
  endTime: number;
}

export interface ManiaTimingPoint {
  time: number;
  beatLength: number;
}

export interface ManiaBeatmap {
  title: string;
  artist: string;
  version: string;
  creator: string;
  keyCount: number;
  od: number;
  bpm: number;
  notes: ManiaNote[];
  totalLength: number;
  beatmapsetId?: number | null;
  audioFilename: string;
  previewTime: number;
  backgroundFilename: string;
  breakPeriods: ManiaBreakPeriod[];
  scrollVelocities: ManiaScrollVelocity[];
  /** Uninherited (red line) timing points in file order; optional so hand-built maps need none. */
  timingPoints?: ManiaTimingPoint[];
}

type TimingPoint = { time: number; beatLength: number };
type ParsedControlPoint =
  | { kind: "timing"; order: number; time: number; beatLength: number }
  | { kind: "effect"; order: number; time: number; scrollSpeed: number };

const DEFAULT_BEAT_LENGTH = 1000;
// Scroll multipliers this close to 1 (or to the previous one) count as no change.
const SCROLL_MULTIPLIER_EPSILON = 1e-4;

export function parseManiaBeatmap(content: string): ManiaBeatmap {
  const lines = content.split("\n").map((line) => line.trim());

  let title = "";
  let artist = "";
  let version = "";
  let creator = "";
  let circleSize = 4; // CS is the key count in mania
  let overallDifficulty = 8;
  let beatmapsetId: number | null = null;
  let audioFilename = "";
  let previewTime = 0;
  let backgroundFilename = "";
  let section = "";
  const notes: ManiaNote[] = [];
  const breakPeriods: ManiaBreakPeriod[] = [];
  const timingPoints: TimingPoint[] = [];
  const controlPoints: ParsedControlPoint[] = [];
  let controlPointOrder = 0;

  for (const line of lines) {
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }

    if (section === "General") {
      if (line.startsWith("AudioFilename:")) audioFilename = line.slice(14).trim();
      if (line.startsWith("PreviewTime:")) previewTime = parseInt(line.split(":")[1].trim(), 10) || 0;
    }

    if (section === "Metadata") {
      if (line.startsWith("Title:")) title = line.slice(6).trim();
      if (line.startsWith("Artist:")) artist = line.slice(7).trim();
      if (line.startsWith("Version:")) version = line.slice(8).trim();
      if (line.startsWith("Creator:")) creator = line.slice(8).trim();
      if (line.startsWith("BeatmapSetID:")) {
        const parsed = Number(line.slice(13).trim());
        beatmapsetId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      }
    }

    if (section === "Events") {
      if (!backgroundFilename) {
        const match = line.match(/^0,0,"([^"]+)"/);
        if (match) backgroundFilename = match[1];
      }

      const breakMatch = line.match(/^2,(\d+),(\d+)/);
      if (breakMatch) {
        const startTime = Number(breakMatch[1]);
        const endTime = Number(breakMatch[2]);
        if (endTime > startTime) breakPeriods.push({ startTime, endTime });
      }
    }

    if (section === "Difficulty") {
      if (line.startsWith("CircleSize:")) circleSize = parseFloat(line.split(":")[1].trim());
      if (line.startsWith("OverallDifficulty:")) overallDifficulty = parseFloat(line.split(":")[1].trim());
    }

    if (section === "TimingPoints" && line.includes(",")) {
      const parts = line.split(",");
      if (parts.length >= 2) {
        const time = parseFloat(parts[0]);
        const beatLength = parseFloat(parts[1]);
        // Old files have no uninherited flag, so a short line is a red line.
        const uninherited = parts.length < 7 || parts[6].trim() !== "0";
        if (beatLength > 0 && uninherited) {
          timingPoints.push({ time, beatLength });
          // A red line also resets the green-line scroll speed to 1.
          controlPoints.push({ kind: "timing", order: controlPointOrder++, time, beatLength });
          controlPoints.push({ kind: "effect", order: controlPointOrder++, time, scrollSpeed: 1 });
        } else if (beatLength < 0 && !uninherited) {
          controlPoints.push({
            kind: "effect",
            order: controlPointOrder++,
            time,
            scrollSpeed: Math.max(0.01, Math.min(20, -100 / beatLength)),
          });
        }
      }
    }

    if (section === "HitObjects" && line.includes(",")) {
      const parts = line.split(",");
      if (parts.length >= 5) {
        const x = parseInt(parts[0], 10);
        const time = parseInt(parts[2], 10);
        const type = parseInt(parts[3], 10);
        const keyCount = normalizeKeyCount(circleSize);
        const column = Math.floor((x * keyCount) / 512);
        const isHold = (type & 128) !== 0;
        let endTime = time;

        if (isHold && parts.length >= 6) {
          // A hold stores its end in the extras field as "endTime:hitSample".
          const extras = parts[5].split(":");
          endTime = parseInt(extras[0], 10) || time;
        }

        notes.push({ column: Math.min(column, keyCount - 1), time, endTime, isHold });
      }
    }
  }

  // Nominal BPM is the first red line in file order.
  const bpm = timingPoints.length > 0 ? Math.round(60000 / timingPoints[0].beatLength) : 0;

  // Last note end. A loop rather than Math.max(...notes): hour-long charts
  // have 100k+ notes, which overflows the call stack as spread arguments.
  let totalLength = 0;
  for (const note of notes) {
    if (note.endTime > totalLength) totalLength = note.endTime;
  }
  const sortedNotes = notes.sort((a, b) => a.time - b.time);

  return {
    title,
    artist,
    version,
    creator,
    keyCount: normalizeKeyCount(circleSize),
    od: overallDifficulty,
    bpm,
    notes: sortedNotes,
    totalLength,
    beatmapsetId,
    audioFilename,
    previewTime,
    backgroundFilename,
    breakPeriods,
    scrollVelocities: buildManiaScrollVelocities(timingPoints, controlPoints, totalLength),
    timingPoints,
  };
}

// Missing or invalid CS reads as 4K; fractional CS rounds up; clamped to 1-18 keys.
function normalizeKeyCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 4;
  return Math.max(1, Math.min(18, Number.isInteger(value) ? value : Math.ceil(value)));
}

// The beat length that covers the most playing time, which osu! uses as the
// 1.0x reference for mania scroll speed.
function getMostCommonBeatLength(timingPoints: TimingPoint[], lastObjectTime: number): number {
  if (timingPoints.length === 0) return DEFAULT_BEAT_LENGTH;

  const lastTime = lastObjectTime > 0 ? lastObjectTime : timingPoints.at(-1)?.time ?? 0;
  const durations = new Map<number, number>();

  for (let i = 0; i < timingPoints.length; i++) {
    const point = timingPoints[i];
    if (point.time > lastTime) {
      // Note: this key is the unrounded beat length, while the timed entries
      // below use the length rounded to 0.001ms.
      durations.set(point.beatLength, durations.get(point.beatLength) ?? 0);
      continue;
    }

    // osu! treats the first timing point as starting at 0 for mania scroll speed.
    const currentTime = i === 0 ? 0 : point.time;
    const nextTime = i === timingPoints.length - 1 ? lastTime : timingPoints[i + 1].time;
    const duration = Math.max(0, nextTime - currentTime);
    const roundedBeatLength = Math.round(point.beatLength * 1000) / 1000;
    durations.set(roundedBeatLength, (durations.get(roundedBeatLength) ?? 0) + duration);
  }

  let mostCommonBeatLength = 0;
  let longestDuration = -1;
  for (const [beatLength, duration] of durations) {
    if (duration > longestDuration) {
      mostCommonBeatLength = beatLength;
      longestDuration = duration;
    }
  }

  if (mostCommonBeatLength <= 0) return DEFAULT_BEAT_LENGTH;

  // Single pass rather than spreading into Math.min/max, which overflows on
  // charts with a huge number of timing points.
  let minBeatLength = Infinity;
  let maxBeatLength = -Infinity;
  for (const point of timingPoints) {
    if (point.beatLength < minBeatLength) minBeatLength = point.beatLength;
    if (point.beatLength > maxBeatLength) maxBeatLength = point.beatLength;
  }
  return Math.max(minBeatLength, Math.min(maxBeatLength, mostCommonBeatLength));
}

// Effective scroll multiplier over time: green-line speed times the tempo
// ratio against the chart's main beat length, clamped to 0.01-20. Points at
// the same time collapse to the last one, and points that do not change the
// multiplier are dropped.
function buildManiaScrollVelocities(
  timingPoints: TimingPoint[],
  controlPoints: ParsedControlPoint[],
  lastObjectTime: number,
): ManiaScrollVelocity[] {
  if (controlPoints.length === 0 || timingPoints.length === 0) return [];

  const baseBeatLength = getMostCommonBeatLength(timingPoints, lastObjectTime);
  const collapsed: ManiaScrollVelocity[] = [];
  let currentBeatLength = DEFAULT_BEAT_LENGTH;
  let currentScrollSpeed = 1;

  for (const point of [...controlPoints].sort((a, b) => a.time - b.time || a.order - b.order)) {
    if (point.time > lastObjectTime) break;

    if (point.kind === "timing") currentBeatLength = point.beatLength;
    else currentScrollSpeed = point.scrollSpeed;

    const rawMultiplier = Math.max(0.01, Math.min(20, currentScrollSpeed * baseBeatLength / currentBeatLength));
    const multiplier = Math.abs(rawMultiplier - 1) <= SCROLL_MULTIPLIER_EPSILON ? 1 : rawMultiplier;
    const previous = collapsed[collapsed.length - 1];

    if (previous && previous.time === point.time) {
      previous.multiplier = multiplier;
    } else {
      collapsed.push({ time: point.time, multiplier });
    }
  }

  const output: ManiaScrollVelocity[] = [];
  let previousMultiplier = 1;

  for (const point of collapsed) {
    if (Math.abs(point.multiplier - previousMultiplier) <= SCROLL_MULTIPLIER_EPSILON) continue;
    output.push(point);
    previousMultiplier = point.multiplier;
  }

  return output;
}
