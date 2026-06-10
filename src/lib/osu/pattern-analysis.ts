import { createServerFn } from "@tanstack/react-start";
import { fetchBeatmapFile, fetchWithCacheLock } from "../api";
import { parseCachedManiaBeatmap } from "../parsed-beatmap-cache";
import { analyzeManiaPatterns, type ManiaPatternAnalysis } from "../dan-estimator";
import { edgeCache } from "./server";
import { parseBoundedInt } from "./validators";
import type { ManiaBeatmap } from "../beatmap-parser";

const PATTERN_ANALYSIS_CACHE_VERSION = 6;
const PATTERN_ANALYSIS_CACHE_TTL = 365 * 24 * 60 * 60 * 1000;
const PATTERN_ANALYSIS_CACHE_LOCK_TTL = 30_000;
const MIN_ANALYSIS_RATE = 0.5;
const MAX_ANALYSIS_RATE = 2;
const INFERRED_BREAK_MIN_GAP_MS = 5_000;
const LOW_DENSITY_BREAK_WINDOW_MS = 5_000;
const LOW_DENSITY_BREAK_STEP_MS = 1_000;
const LOW_DENSITY_BREAK_MIN_SPAN_MS = 12_000;
const LOW_DENSITY_BREAK_MAX_GROUPS_PER_SECOND = 2.25;
const HIT_OBJECT_GROUP_EPSILON_MS = 32;

export interface BeatmapBreakRange {
  startTime: number;
  endTime: number;
  kind: "declared" | "inferred";
}

export interface BeatmapPatternAnalysisResponse {
  analysis: ManiaPatternAnalysis;
  chart: {
    objects: number;
    avgNps: number;
    peakNps: number;
    od: number;
    breaks: number;
    breakRanges: BeatmapBreakRange[];
    rate: number;
    svCount: number;
  };
}

export const getBeatmapPatternAnalysis = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid beatmap analysis payload.");
    }
    const data = input as Record<string, unknown>;
    const beatmapId = parseBoundedInt(data.beatmapId, "beatmapId", { min: 1, max: 10_000_000 });
    const beatmapsetId = data.beatmapsetId == null || data.beatmapsetId === ""
      ? null
      : parseBoundedInt(data.beatmapsetId, "beatmapsetId", { min: 1, max: 10_000_000 });
    return {
      beatmapId,
      beatmapsetId,
      starRating: parseOptionalNumber(data.starRating),
      totalLength: parseOptionalNumber(data.totalLength),
      rate: normalizeAnalysisRate(parseOptionalNumber(data.rate)),
      version: typeof data.version === "string" ? data.version.slice(0, 120) : undefined,
    };
  })
  .handler(async ({ data }: {
    data: {
      beatmapId: number;
      beatmapsetId: number | null;
      starRating?: number;
      totalLength?: number;
      rate: number;
      version?: string;
    };
  }) => {
    edgeCache(300, 3600);
    const osuFile = await fetchBeatmapFile(data.beatmapId, data.beatmapsetId);
    const input = {
      starRating: data.starRating,
      totalLength: data.totalLength,
      rate: data.rate,
      version: data.version,
    };
    const inputKey = JSON.stringify({
      starRating: input.starRating ?? null,
      totalLength: input.totalLength ?? null,
      rate: input.rate,
      version: input.version ?? "",
    });
    const cacheKey = [
      "beatmap-pattern-analysis",
      `v${PATTERN_ANALYSIS_CACHE_VERSION}`,
      data.beatmapId,
      hashString(osuFile),
      hashString(inputKey),
    ].join(":");

    return fetchWithCacheLock<BeatmapPatternAnalysisResponse>(
      cacheKey,
      PATTERN_ANALYSIS_CACHE_TTL,
      async () => {
        const beatmap = parseCachedManiaBeatmap(data.beatmapId, osuFile);
        const analysis = analyzeManiaPatterns(beatmap, input);
        const baseDurationSeconds = data.totalLength ?? (beatmap.totalLength ? beatmap.totalLength / 1000 : 0);
        const durationSeconds = Math.max(1, baseDurationSeconds / data.rate);
        const objects = analysis.metrics.noteCount || beatmap.notes.length;
        const breakRanges = getChartBreakRanges(beatmap, data.rate);

        return {
          analysis,
          chart: {
            objects,
            avgNps: objects / durationSeconds,
            peakNps: analysis.metrics.peakNps1s,
            od: beatmap.od,
            breaks: breakRanges.length,
            breakRanges,
            rate: data.rate,
            svCount: beatmap.scrollVelocities.filter((sv) => Math.abs(sv.multiplier - 1) > 0.001).length,
          },
        };
      },
      PATTERN_ANALYSIS_CACHE_LOCK_TTL,
    );
  });

export function countChartBreaks(beatmap: Pick<ManiaBeatmap, "breakPeriods" | "notes" | "totalLength">, rate = 1): number {
  return getChartBreakRanges(beatmap, rate).length;
}

export function getChartBreakRanges(beatmap: Pick<ManiaBeatmap, "breakPeriods" | "notes" | "totalLength">, rate = 1): BeatmapBreakRange[] {
  const normalizedRate = normalizeAnalysisRate(rate);
  const gameplayBounds = getDenseGameplayBounds(beatmap.notes, normalizedRate);
  const ranges: BeatmapBreakRange[] = beatmap.breakPeriods
    .filter((period) => period.endTime > period.startTime)
    .map((period) => ({ startTime: period.startTime, endTime: period.endTime, kind: "declared" }));
  const notes = beatmap.notes;

  for (let index = 1; index < notes.length; index++) {
    const previous = notes[index - 1];
    const current = notes[index];
    const startTime = previous.endTime;
    const endTime = current.time;
    if (endTime - startTime < INFERRED_BREAK_MIN_GAP_MS * normalizedRate) continue;
    if (!isWithinDenseGameplay(startTime, endTime, gameplayBounds)) continue;

    const overlapsDeclaredBreak = ranges.some((period) => (
      Math.max(period.startTime, startTime) < Math.min(period.endTime, endTime)
    ));
    if (!overlapsDeclaredBreak) ranges.push({ startTime, endTime, kind: "inferred" });
  }

  ranges.push(...inferLowDensityBreaks(beatmap, normalizedRate));

  return mergeBreakRanges(ranges);
}

function mergeBreakRanges(ranges: BeatmapBreakRange[]): BeatmapBreakRange[] {
  ranges.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  const merged: BeatmapBreakRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.startTime <= previous.endTime) {
      previous.endTime = Math.max(previous.endTime, range.endTime);
      if (previous.kind !== range.kind) previous.kind = "inferred";
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function getDenseGameplayBounds(notes: ManiaBeatmap["notes"], rate: number): { startTime: number; endTime: number } | null {
  const groupedStarts = getGroupedHitObjectStarts(notes);
  if (groupedStarts.length < 2) return null;

  const windowMs = LOW_DENSITY_BREAK_WINDOW_MS * rate;
  const maxGroupsPerWindow = LOW_DENSITY_BREAK_MAX_GROUPS_PER_SECOND * (LOW_DENSITY_BREAK_WINDOW_MS / 1000);
  let left = 0;
  let right = 0;
  let firstDenseStart: number | null = null;
  let lastDenseEnd: number | null = null;

  for (let windowStart = groupedStarts[0]; windowStart + windowMs <= groupedStarts[groupedStarts.length - 1]; windowStart += LOW_DENSITY_BREAK_STEP_MS * rate) {
    const windowEnd = windowStart + windowMs;
    while (left < groupedStarts.length && groupedStarts[left] < windowStart) left++;
    while (right < groupedStarts.length && groupedStarts[right] < windowEnd) right++;

    if (right - left > maxGroupsPerWindow) {
      firstDenseStart ??= windowStart;
      lastDenseEnd = windowEnd;
    }
  }

  if (firstDenseStart == null || lastDenseEnd == null || lastDenseEnd <= firstDenseStart) return null;
  return { startTime: firstDenseStart, endTime: lastDenseEnd };
}

function isWithinDenseGameplay(startTime: number, endTime: number, bounds: { startTime: number; endTime: number } | null): boolean {
  return bounds != null && startTime >= bounds.startTime && endTime <= bounds.endTime;
}

function inferLowDensityBreaks(beatmap: Pick<ManiaBeatmap, "notes" | "totalLength">, rate: number): BeatmapBreakRange[] {
  const groupedStarts = getGroupedHitObjectStarts(beatmap.notes);
  if (groupedStarts.length < 2) return [];

  const firstTime = groupedStarts[0];
  const lastTime = Math.max(groupedStarts[groupedStarts.length - 1], beatmap.totalLength);
  const windowMs = LOW_DENSITY_BREAK_WINDOW_MS * rate;
  const stepMs = LOW_DENSITY_BREAK_STEP_MS * rate;
  const minSpanMs = LOW_DENSITY_BREAK_MIN_SPAN_MS * rate;
  const maxGroupsPerWindow = LOW_DENSITY_BREAK_MAX_GROUPS_PER_SECOND * (LOW_DENSITY_BREAK_WINDOW_MS / 1000);
  const ranges: BeatmapBreakRange[] = [];
  let activeStart: number | null = null;
  let activeEnd = 0;
  let left = 0;
  let right = 0;
  let hasSeenDenseGameplay = false;

  for (let windowStart = firstTime; windowStart + windowMs <= lastTime; windowStart += stepMs) {
    const windowEnd = windowStart + windowMs;
    while (left < groupedStarts.length && groupedStarts[left] < windowStart) left++;
    while (right < groupedStarts.length && groupedStarts[right] < windowEnd) right++;

    const lowDensity = right - left <= maxGroupsPerWindow;
    if (lowDensity) {
      if (hasSeenDenseGameplay) {
        activeStart ??= windowStart;
        activeEnd = windowEnd;
      }
      continue;
    }

    if (activeStart != null && activeEnd - activeStart >= minSpanMs) {
      ranges.push({ startTime: activeStart, endTime: activeEnd, kind: "inferred" });
    }
    hasSeenDenseGameplay = true;
    activeStart = null;
    activeEnd = 0;
  }

  return ranges;
}

function getGroupedHitObjectStarts(notes: ManiaBeatmap["notes"]): number[] {
  const starts = notes.map((note) => note.time).sort((a, b) => a - b);
  const grouped: number[] = [];
  for (const start of starts) {
    if (!grouped.length || start - grouped[grouped.length - 1] > HIT_OBJECT_GROUP_EPSILON_MS) {
      grouped.push(start);
    }
  }
  return grouped;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeAnalysisRate(value: number | undefined): number {
  if (value == null) return 1;
  return Math.min(MAX_ANALYSIS_RATE, Math.max(MIN_ANALYSIS_RATE, value));
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
