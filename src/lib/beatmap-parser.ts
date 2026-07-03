// Parse .osu file format for mania note data. osu!standard files (Mode 0) are
// run through the lazer/stable convert algorithm in mania-convert.ts so the
// resulting chart matches what a player actually plays in mania.

import {
  convertStdBeatmapToMania,
  getConvertColumnCount,
  HITSOUND_CLAP,
  HITSOUND_FINISH,
  HITSOUND_WHISTLE,
  type ConvertDifficultyPoint,
  type ConvertEffectPoint,
  type ConvertSampleInfo,
  type ConvertTimingPoint,
  type StdConvertBeatmap,
  type StdHitObject,
} from "./mania-convert";

export type ManiaSampleBank = "normal" | "soft" | "drum";

export interface ManiaNoteSample {
  bank: ManiaSampleBank;         // bank for the hitnormal sample
  additionBank: ManiaSampleBank; // bank for whistle/finish/clap additions
  index: number;                 // custom sample index (0 = skin, 1 = map folder, >=2 = suffixed map file)
  volume: number;                // resolved 0-100 (object volume, else timing point volume)
  additions: number;             // hitSound bitmask additions (whistle=2, finish=4, clap=8)
  normalIsLayered: boolean;      // additions present without the Normal bit (silent in native mania)
  filename?: string;             // per-note keysound file, replaces the hitnormal sample
}

export interface ManiaNote {
  column: number;  // 0-indexed column
  time: number;    // start time in ms
  endTime: number; // end time in ms (same as time for regular notes, > time for holds)
  isHold: boolean;
  sample?: ManiaNoteSample;
}

export interface ManiaScrollVelocity {
  time: number;
  multiplier: number;
}

export interface ManiaBreakPeriod {
  startTime: number;
  endTime: number;
}

export interface ManiaBeatmap {
  title: string;
  artist: string;
  version: string;
  creator: string;
  keyCount: number;
  /** True when this chart came from converting an osu!standard (Mode 0) file. */
  isConvert?: boolean;
  od: number;
  bpm: number;
  stableScrollBpm?: number;
  notes: ManiaNote[];
  totalLength: number;
  beatmapsetId?: number | null;
  audioFilename: string;
  previewTime: number;
  backgroundFilename: string;
  breakPeriods: ManiaBreakPeriod[];
  scrollVelocities: ManiaScrollVelocity[];
}

export interface ParseManiaBeatmapOptions {
  /** For mania files: overrides the column mapping key count. For osu!standard
   *  files: forces the convert's target column count (the xK keymod); when
   *  omitted the lazer convert column formula decides. */
  keyCount?: number | null;
}

type TimingPoint = { time: number; beatLength: number };
type ParsedControlPoint =
  | { kind: "timing"; order: number; time: number; beatLength: number }
  | { kind: "effect"; order: number; time: number; scrollSpeed: number };
type SampleControlPoint = { time: number; bank: ManiaSampleBank | null; index: number; volume: number };

const DEFAULT_BEAT_LENGTH = 1000;
const SCROLL_MULTIPLIER_EPSILON = 1e-4;
// osu! resolves an object's sample control point slightly after its end time.
const SAMPLE_CONTROL_POINT_LENIENCY_MS = 5;

function parseSampleBankNumber(value: number | null): ManiaSampleBank | null {
  if (value === 1) return "normal";
  if (value === 2) return "soft";
  if (value === 3) return "drum";
  return null;
}

function parseSampleBankName(value: string | undefined): ManiaSampleBank | null {
  const lower = value?.trim().toLowerCase();
  if (lower === "normal") return "normal";
  if (lower === "soft") return "soft";
  if (lower === "drum") return "drum";
  return null;
}

function sampleControlPointAt(points: SampleControlPoint[], time: number): SampleControlPoint | null {
  if (points.length === 0 || time < points[0].time) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  return points[lo];
}

function normalizeKeyCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 4;
  return Math.max(1, Math.min(18, Number.isInteger(value) ? value : Math.ceil(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  return Math.fround(Math.min(Math.max(value, min), max));
}

type LegacyBankInfo = {
  bank: ManiaSampleBank | null;
  additionBank: ManiaSampleBank | null;
  index: number;
  volume: number;
  filename?: string;
};

function parseLegacyBankValue(value: number): ManiaSampleBank | null {
  if (!Number.isFinite(value) || value === 0) return null; // none, or unparseable
  if (value === 2) return "soft";
  if (value === 3) return "drum";
  // 1 and any out-of-enum value fall back to normal, matching lazer.
  return "normal";
}

/** Port of ConvertHitObjectParser.readCustomSampleBanks. */
function readLegacySampleBanks(str: string | undefined, info: LegacyBankInfo, banksOnly = false): void {
  if (!str) return;
  const split = str.split(":");
  info.bank = parseLegacyBankValue(parseInt(split[0] ?? "", 10));
  info.additionBank = parseLegacyBankValue(parseInt(split[1] ?? "", 10)) ?? info.bank;
  if (banksOnly) return;
  if (split.length > 2) {
    const index = parseInt(split[2], 10);
    info.index = Number.isFinite(index) ? index : 0;
  }
  if (split.length > 3) {
    const volume = parseInt(split[3], 10);
    info.volume = Math.max(0, Number.isFinite(volume) ? volume : 0);
  }
  info.filename = split.length > 4 && split[4] ? split[4].replace(/\\/g, "/") : undefined;
}

/** Port of ConvertHitObjectParser.convertSoundType into the flat sample model. */
function buildConvertSampleInfo(soundType: number, info: LegacyBankInfo): ConvertSampleInfo {
  if (info.filename) {
    return {
      additions: 0,
      hasNormal: false,
      normalIsLayered: false,
      bank: info.bank,
      additionBank: info.additionBank,
      index: info.index,
      volume: info.volume,
      filename: info.filename,
    };
  }
  return {
    additions: soundType & (HITSOUND_WHISTLE | HITSOUND_FINISH | HITSOUND_CLAP),
    hasNormal: true,
    normalIsLayered: soundType !== 0 && (soundType & 1) === 0,
    bank: info.bank,
    additionBank: info.additionBank,
    index: info.index,
    volume: info.volume,
  };
}

/** Detects lazer's zero-length-slider heuristic: a path whose control points all
 *  sit on the head position has zero geometric distance regardless of curve type. */
function sliderPathIsZeroLength(curve: string | undefined, headX: number, headY: number): boolean {
  if (!curve) return true;
  const segments = curve.split("|");
  for (let i = 1; i < segments.length; i++) {
    const point = segments[i].split(":");
    const px = parseFloat(point[0]);
    const py = parseFloat(point[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (Math.fround(px) !== Math.fround(headX) || Math.fround(py) !== Math.fround(headY)) return false;
  }
  return true;
}

/** Builds a lazer-equivalent legacy hit object from an osu!standard HitObjects line. */
function parseStdHitObject(parts: string[]): StdHitObject | null {
  const x = Math.trunc(parseFloat(parts[0]));
  const y = Math.trunc(parseFloat(parts[1]));
  const startTime = parseFloat(parts[2]);
  const type = parseInt(parts[3], 10);
  const soundType = parseInt(parts[4], 10) || 0;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(startTime) || !Number.isFinite(type)) return null;

  const bankInfo: LegacyBankInfo = { bank: null, additionBank: null, index: 0, volume: 0 };

  if (type & 1) {
    // Hit circle.
    readLegacySampleBanks(parts[5], bankInfo);
    return {
      kind: "circle",
      startTime,
      x,
      y,
      endTime: startTime,
      samples: buildConvertSampleInfo(soundType, bankInfo),
      repeatCount: 0,
      length: null,
      nodeSamples: null,
    };
  }

  if (type & 2) {
    // Slider.
    const repeatRaw = parseInt(parts[6] ?? "", 10);
    let repeatCount = Math.max(0, Math.min(Number.isFinite(repeatRaw) ? repeatRaw : 0, 9000) - 1);

    let length: number | null = null;
    if (parts.length > 7) {
      const parsed = parseFloat(parts[7]);
      const capped = Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : 0, 131072));
      length = capped === 0 ? null : capped;
    }

    if (parts.length > 10) readLegacySampleBanks(parts[10], bankInfo, true);

    // One node for each repeat + the start and end nodes.
    const nodes = repeatCount + 2;
    const nodeBankInfos: LegacyBankInfo[] = Array.from({ length: nodes }, () => ({ ...bankInfo }));
    if (parts.length > 9 && parts[9].length > 0) {
      const sets = parts[9].split("|");
      for (let i = 0; i < nodes && i < sets.length; i++) readLegacySampleBanks(sets[i], nodeBankInfos[i]);
    }

    const nodeSoundTypes: number[] = new Array(nodes).fill(soundType);
    if (parts.length > 8 && parts[8].length > 0) {
      const adds = parts[8].split("|");
      for (let i = 0; i < nodes && i < adds.length; i++) {
        const sound = parseInt(adds[i], 10);
        nodeSoundTypes[i] = Number.isFinite(sound) ? sound : 0;
      }
    }

    let nodeSamples = nodeSoundTypes.map((sound, i) => buildConvertSampleInfo(sound, nodeBankInfos[i]));

    // Zero-length sliders get their repeats reset (lazer exploit heuristic).
    if (sliderPathIsZeroLength(parts[5], x, y)) {
      repeatCount = 0;
      nodeSamples = [nodeSamples[0], nodeSamples[nodeSamples.length - 1]];
    }

    return {
      kind: "slider",
      startTime,
      x,
      y,
      endTime: startTime,
      samples: buildConvertSampleInfo(soundType, bankInfo),
      repeatCount,
      length,
      nodeSamples,
    };
  }

  if (type & 8) {
    // Spinner.
    const rawEndTime = parseFloat(parts[5] ?? "");
    const endTime = Math.max(startTime, Number.isFinite(rawEndTime) ? rawEndTime : startTime);
    readLegacySampleBanks(parts[6], bankInfo);
    return {
      kind: "spinner",
      startTime,
      x: 256,
      y: 192,
      endTime,
      samples: buildConvertSampleInfo(soundType, bankInfo),
      repeatCount: 0,
      length: null,
      nodeSamples: null,
    };
  }

  if (type & 128) {
    // Hold (BMS-style, inside a non-mania file).
    let endTime = startTime;
    const extras = parts[5]?.split(":") ?? [];
    if (extras.length > 0) {
      const parsedEnd = parseFloat(extras[0]);
      if (Number.isFinite(parsedEnd)) endTime = Math.max(startTime, parsedEnd);
      readLegacySampleBanks(extras.slice(1).join(":"), bankInfo);
    }
    return {
      kind: "hold",
      startTime,
      x,
      y,
      endTime,
      samples: buildConvertSampleInfo(soundType, bankInfo),
      repeatCount: 0,
      length: null,
      nodeSamples: null,
    };
  }

  return null;
}

function getMostCommonBeatLength(timingPoints: TimingPoint[], lastObjectTime: number): number {
  if (timingPoints.length === 0) return DEFAULT_BEAT_LENGTH;

  const lastTime = lastObjectTime > 0 ? lastObjectTime : timingPoints.at(-1)?.time ?? 0;
  const durations = new Map<number, number>();

  for (let i = 0; i < timingPoints.length; i++) {
    const point = timingPoints[i];
    if (point.time > lastTime) {
      durations.set(point.beatLength, durations.get(point.beatLength) ?? 0);
      continue;
    }

    // osu! forces the first timing point to act from 0 for mania scroll speed.
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

  const rawBeatLengths = timingPoints.map((point) => point.beatLength);
  return Math.max(Math.min(...rawBeatLengths), Math.min(Math.max(...rawBeatLengths), mostCommonBeatLength));
}

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

export function parseManiaBeatmap(content: string, options: ParseManiaBeatmapOptions = {}): ManiaBeatmap {
  const lines = content.split("\n").map((l) => l.trim());

  let title = "";
  let artist = "";
  let version = "";
  let creator = "";
  let mode = 0; // osu! file format default is osu!standard
  let circleSize = 4; // CS = key count in mania
  let overallDifficulty = 8;
  let circleSizeSpecified = false;
  let overallDifficultySpecified = false;
  let hpDrainRate: number | null = null;
  let approachRate: number | null = null;
  let sliderMultiplier: number | null = null;
  let beatmapsetId: number | null = null;
  let audioFilename = "";
  let previewTime = 0;
  let backgroundFilename = "";
  let section = "";
  let defaultSampleBank: ManiaSampleBank = "normal";
  const notes: ManiaNote[] = [];
  const breakPeriods: ManiaBreakPeriod[] = [];
  const timingPoints: TimingPoint[] = [];
  const controlPoints: ParsedControlPoint[] = [];
  const sampleControlPoints: SampleControlPoint[] = [];
  type RawNoteSample = { additions: number; hasNormalFlag: boolean; bank: ManiaSampleBank | null; additionBank: ManiaSampleBank | null; index: number; volume: number; filename?: string };
  const rawNoteSamples: RawNoteSample[] = [];
  let controlPointOrder = 0;
  // Raw HitObjects parts plus lazer-shaped control points, kept for the
  // std -> mania convert pipeline (only used when Mode is 0).
  const rawHitObjectParts: string[][] = [];
  const convertTimingPoints: ConvertTimingPoint[] = [];
  const convertDifficultyPoints: (ConvertDifficultyPoint & { fromGreen: boolean })[] = [];
  const convertEffectPoints: (ConvertEffectPoint & { fromGreen: boolean })[] = [];

  for (const line of lines) {
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }

    if (section === "General") {
      if (line.startsWith("AudioFilename:")) audioFilename = line.slice(14).trim();
      if (line.startsWith("PreviewTime:")) previewTime = parseInt(line.split(":")[1].trim(), 10) || 0;
      if (line.startsWith("SampleSet:")) defaultSampleBank = parseSampleBankName(line.slice(10)) ?? defaultSampleBank;
      if (line.startsWith("Mode:")) mode = parseInt(line.slice(5).trim(), 10) || 0;
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

      const breakMatch = line.match(/^2,(-?[\d.]+),(-?[\d.]+)/);
      if (breakMatch) {
        const startTime = Number(breakMatch[1]);
        const endTime = Number(breakMatch[2]);
        if (endTime > startTime) breakPeriods.push({ startTime, endTime });
      }
    }

    if (section === "Difficulty") {
      if (line.startsWith("CircleSize:")) {
        circleSize = parseFloat(line.split(":")[1].trim());
        circleSizeSpecified = Number.isFinite(circleSize);
      }
      if (line.startsWith("OverallDifficulty:")) {
        overallDifficulty = parseFloat(line.split(":")[1].trim());
        overallDifficultySpecified = Number.isFinite(overallDifficulty);
      }
      if (line.startsWith("HPDrainRate:")) hpDrainRate = parseFloat(line.split(":")[1].trim());
      if (line.startsWith("ApproachRate:")) approachRate = parseFloat(line.split(":")[1].trim());
      if (line.startsWith("SliderMultiplier:")) sliderMultiplier = parseFloat(line.split(":")[1].trim());
    }

    if (section === "TimingPoints" && line.includes(",")) {
      const parts = line.split(",");
      if (parts.length >= 2) {
        const time = parseFloat(parts[0]);
        const beatLength = parseFloat(parts[1]);
        const uninherited = parts.length < 7 || parts[6].trim() !== "0";
        if (Number.isFinite(time)) {
          const sampleSet = parts.length >= 4 ? parseInt(parts[3], 10) : NaN;
          const sampleIndex = parts.length >= 5 ? parseInt(parts[4], 10) : NaN;
          const sampleVolume = parts.length >= 6 ? parseInt(parts[5], 10) : NaN;
          sampleControlPoints.push({
            time,
            bank: parseSampleBankNumber(Number.isFinite(sampleSet) ? sampleSet : null),
            index: Number.isFinite(sampleIndex) && sampleIndex > 0 ? sampleIndex : 0,
            volume: Number.isFinite(sampleVolume) ? Math.max(0, Math.min(100, sampleVolume)) : 100,
          });
        }
        if (beatLength > 0 && uninherited) {
          timingPoints.push({ time, beatLength });
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

        // Lazer-shaped control points for the std -> mania convert pipeline.
        if (Number.isFinite(time)) {
          const effectFlags = parts.length >= 8 ? parseInt(parts[7], 10) : 0;
          const kiai = ((Number.isFinite(effectFlags) ? effectFlags : 0) & 1) !== 0;
          if (uninherited) {
            if (Number.isFinite(beatLength)) {
              convertTimingPoints.push({ time, beatLength: Math.min(Math.max(beatLength, 6), 60000) });
            }
            convertDifficultyPoints.push({ time, sliderVelocity: 1, fromGreen: false });
            convertEffectPoints.push({ time, kiai, fromGreen: false });
          } else {
            const sliderVelocity = beatLength < 0 ? Math.min(Math.max(100 / -beatLength, 0.1), 10) : 1;
            convertDifficultyPoints.push({ time, sliderVelocity, fromGreen: true });
            convertEffectPoints.push({ time, kiai, fromGreen: true });
          }
        }
      }
    }

    if (section === "HitObjects" && line.includes(",")) {
      const parts = line.split(",");
      if (parts.length >= 5) {
        rawHitObjectParts.push(parts);
        const x = parseInt(parts[0], 10);
        const time = parseInt(parts[2], 10);
        const type = parseInt(parts[3], 10);
        const hitSound = parseInt(parts[4], 10) || 0;
        const keyCount = normalizeKeyCount(options.keyCount ?? circleSize);

        // In mania, column is determined by x position: column = floor(x * keyCount / 512)
        const column = Math.floor((x * keyCount) / 512);

        // Check if it's a hold note (type bit 7 = 128)
        const isHold = (type & 128) !== 0;
        let endTime = time;

        // Extras field: `bank:additionBank:index:volume:filename` for taps,
        // `endTime:bank:additionBank:index:volume:filename` for holds.
        const extraFields = parts.length >= 6 ? parts[5].split(":") : [];
        if (isHold && extraFields.length > 0) {
          endTime = parseInt(extraFields[0], 10) || time;
        }
        const sampleFields = isHold ? extraFields.slice(1) : extraFields;
        const rawBank = parseInt(sampleFields[0] ?? "", 10);
        const rawAdditionBank = parseInt(sampleFields[1] ?? "", 10);
        const rawIndex = parseInt(sampleFields[2] ?? "", 10);
        const rawVolume = parseInt(sampleFields[3] ?? "", 10);
        const rawFilename = sampleFields.slice(4).join(":").trim();
        rawNoteSamples.push({
          additions: hitSound & (2 | 4 | 8),
          hasNormalFlag: (hitSound & 1) !== 0,
          bank: parseSampleBankNumber(Number.isFinite(rawBank) ? rawBank : null),
          additionBank: parseSampleBankNumber(Number.isFinite(rawAdditionBank) ? rawAdditionBank : null),
          index: Number.isFinite(rawIndex) && rawIndex > 0 ? rawIndex : 0,
          volume: Number.isFinite(rawVolume) && rawVolume > 0 ? Math.min(100, rawVolume) : 0,
          filename: rawFilename ? rawFilename.replace(/\\/g, "/") : undefined,
        });

        notes.push({ column: Math.min(column, keyCount - 1), time, endTime, isHold });
      }
    }
  }

  // osu!standard files: replace the naive x-position column mapping with the
  // real lazer/stable mania conversion so converts (and xK keymod charts)
  // match what the player actually played.
  let convertKeyCount: number | null = null;
  let isConvert = false;
  if (mode === 0) {
    try {
      const finiteOr = (value: number | null, fallback: number): number =>
        value != null && Number.isFinite(value) ? value : fallback;

      const stdObjects = rawHitObjectParts
        .map(parseStdHitObject)
        .filter((obj): obj is StdHitObject => obj !== null)
        .sort((a, b) => a.startTime - b.startTime);

      const dedupeByTime = <T extends { time: number; fromGreen?: boolean }>(points: T[]): T[] => {
        const byTime = new Map<number, T>();
        for (const point of points) {
          const existing = byTime.get(point.time);
          // Green-line values win over red-line resets at the same timestamp.
          if (!existing || point.fromGreen || !existing.fromGreen) byTime.set(point.time, point);
        }
        return [...byTime.values()].sort((a, b) => a.time - b.time);
      };

      const defaultOd = overallDifficultySpecified && Number.isFinite(overallDifficulty) ? overallDifficulty : 5;
      const stdBeatmap: StdConvertBeatmap = {
        hitObjects: stdObjects,
        timingPoints: dedupeByTime(convertTimingPoints),
        difficultyPoints: dedupeByTime(convertDifficultyPoints),
        effectPoints: dedupeByTime(convertEffectPoints),
        drainRate: clampFloat(finiteOr(hpDrainRate, 5), 0, 10),
        circleSize: clampFloat(circleSizeSpecified && Number.isFinite(circleSize) ? circleSize : 5, 0, 10),
        overallDifficulty: clampFloat(defaultOd, 0, 10),
        approachRate: clampFloat(finiteOr(approachRate, defaultOd), 0, 10),
        sliderMultiplier: Math.min(Math.max(finiteOr(sliderMultiplier, 1.4), 0.4), 3.6),
        totalBreakTime: breakPeriods.reduce((sum, period) => sum + (period.endTime - period.startTime), 0),
      };

      const targetColumns = options.keyCount != null
        ? normalizeKeyCount(options.keyCount)
        : getConvertColumnCount(stdBeatmap);
      const converted = convertStdBeatmapToMania(stdBeatmap, targetColumns);

      notes.length = 0;
      rawNoteSamples.length = 0;
      for (const generated of converted) {
        notes.push({
          column: generated.column,
          time: generated.startTime,
          endTime: generated.isHold ? generated.endTime : generated.startTime,
          isHold: generated.isHold,
        });
        const sample = generated.sample;
        rawNoteSamples.push(sample
          ? {
            additions: sample.additions,
            hasNormalFlag: sample.hasNormal && !sample.normalIsLayered,
            bank: sample.bank,
            additionBank: sample.additionBank,
            index: sample.index,
            volume: sample.volume,
            filename: sample.filename,
          }
          : { additions: 0, hasNormalFlag: true, bank: null, additionBank: null, index: 0, volume: 0 });
      }
      convertKeyCount = targetColumns;
      isConvert = true;
    } catch {
      // Keep the naive x-position parse if the conversion fails; a misaligned
      // chart still beats an empty viewer.
    }
  }

  // Resolve each note's final sample info against the sample control point that
  // is active slightly after the object (matching osu!'s leniency), filling any
  // fields the object line left unspecified.
  const sortedSamplePoints = [...sampleControlPoints].sort((a, b) => a.time - b.time);
  for (let i = 0; i < notes.length; i++) {
    const raw = rawNoteSamples[i];
    if (!raw) continue;
    const point = sampleControlPointAt(sortedSamplePoints, notes[i].endTime + SAMPLE_CONTROL_POINT_LENIENCY_MS);
    const bank = raw.bank ?? point?.bank ?? defaultSampleBank;
    notes[i].sample = {
      bank,
      additionBank: raw.additionBank ?? bank,
      index: raw.index > 0 ? raw.index : point?.index ?? 0,
      volume: raw.volume > 0 ? raw.volume : point?.volume ?? 100,
      additions: raw.additions,
      normalIsLayered: raw.additions !== 0 && !raw.hasNormalFlag,
      filename: raw.filename,
    };
  }

  // Calculate BPM from first timing point
  const bpm = timingPoints.length > 0 ? Math.round(60000 / timingPoints[0].beatLength) : 0;

  // Total length = last note's end time
  const totalLength = notes.length > 0
    ? Math.max(...notes.map((n) => n.endTime))
    : 0;
  const sortedNotes = notes.sort((a, b) => a.time - b.time);
  const stableScrollBeatLength = timingPoints.length > 0
    ? getMostCommonBeatLength(timingPoints, totalLength)
    : 0;
  const stableScrollBpm = stableScrollBeatLength > 0
    ? Math.round(60000 / stableScrollBeatLength)
    : bpm;

  return {
    title,
    artist,
    version,
    creator,
    keyCount: convertKeyCount ?? normalizeKeyCount(options.keyCount ?? circleSize),
    isConvert,
    od: overallDifficulty,
    bpm,
    stableScrollBpm,
    notes: sortedNotes,
    totalLength,
    beatmapsetId,
    audioFilename,
    previewTime,
    backgroundFilename,
    breakPeriods,
    scrollVelocities: buildManiaScrollVelocities(timingPoints, controlPoints, totalLength),
  };
}
