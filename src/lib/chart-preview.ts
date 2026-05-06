import type { ManiaBeatmap, ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";

export const RANDOM_REPLAY_PREVIEW_MS = 10_000;
export const RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS = 1_200;

const RANDOM_REPLAY_TAP_HOLD_MS = 48;
const DENSE_PREVIEW_LEAD_IN_MS = 1_000;
const MAX_PREVIEW_CACHE_ENTRIES_PER_MAP = 20;

type ChartPreviewAudioMode = "set-preview" | "selected-file";

export type ChartPreviewPlaybackPlan = {
  beatmap: ManiaBeatmap;
  startTimeMs: number;
  timeScale: number;
  audioMode: ChartPreviewAudioMode;
};

const previewNotesCache = new WeakMap<ManiaBeatmap, Map<string, ManiaNote[]>>();
const previewComboCache = new WeakMap<ManiaBeatmap, Map<number, number>>();
const previewScrollVelocityCache = new WeakMap<ManiaBeatmap, Map<string, ManiaBeatmap["scrollVelocities"]>>();

function getPreviewCacheKey(startTimeMs: number, timeScale = 1): string {
  return `${Math.round(startTimeMs || 0)}:${Math.round(Math.max(0.1, timeScale) * 1000)}`;
}

function getBoundedPreviewMap<T, K>(cache: WeakMap<ManiaBeatmap, Map<K, T>>, beatmap: ManiaBeatmap): Map<K, T> {
  let map = cache.get(beatmap);
  if (!map) {
    map = new Map<K, T>();
    cache.set(beatmap, map);
  }
  return map;
}

function setBoundedPreviewCache<K, T>(map: Map<K, T>, key: K, value: T): T {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_PREVIEW_CACHE_ENTRIES_PER_MAP) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
  return value;
}

export function hasMappedPreviewTime(previewTimeMs: number): boolean {
  return Number.isFinite(previewTimeMs) && previewTimeMs > 0;
}

export function pickPreviewStartTime(primaryTimeMs: number, fallbackTimeMs = 0): number {
  if (Number.isFinite(primaryTimeMs) && primaryTimeMs > 0) return primaryTimeMs;
  if (Number.isFinite(fallbackTimeMs) && fallbackTimeMs > 0) return fallbackTimeMs;
  return 0;
}

export function hasPreviewNotes(beatmap: ManiaBeatmap, startTimeMs = beatmap.previewTime, timeScale = 1): boolean {
  return getPreviewNotes(beatmap, startTimeMs, timeScale).length > 0;
}

export function findDensestPreviewStartTime(beatmap: ManiaBeatmap, timeScale = 1): number {
  if (!beatmap.notes.length) return 0;

  const notes = [...beatmap.notes].sort((a, b) => a.time - b.time);
  const scale = Math.max(0.1, timeScale);
  const playbackWindowMs = RANDOM_REPLAY_PREVIEW_MS * scale;
  let bestStart = Math.max(0, notes[0].time - DENSE_PREVIEW_LEAD_IN_MS);
  let bestScore = -1;
  let windowLeft = 0;
  let right = 0;

  for (let i = 0; i < notes.length; i++) {
    const start = Math.max(0, notes[i].time - DENSE_PREVIEW_LEAD_IN_MS);
    const end = start + playbackWindowMs;

    while (windowLeft < notes.length && notes[windowLeft].time < start) {
      windowLeft++;
    }

    while (right < notes.length && notes[right].time <= end) {
      right++;
    }

    const score = right - windowLeft;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  return Math.max(0, Math.round(bestStart));
}

export function getChartPreviewPlaybackPlan({
  selectedBeatmap,
  referenceBeatmap = selectedBeatmap,
  usesSetPreviewForAudio,
  timedRateVariant,
  selectedDifficultyRate,
}: {
  selectedBeatmap: ManiaBeatmap;
  referenceBeatmap?: ManiaBeatmap;
  usesSetPreviewForAudio: boolean;
  timedRateVariant: boolean;
  selectedDifficultyRate: number;
}): ChartPreviewPlaybackPlan {
  let beatmap = timedRateVariant ? referenceBeatmap : selectedBeatmap;
  const referenceStartMs = pickPreviewStartTime(referenceBeatmap.previewTime, selectedBeatmap.previewTime);
  const shouldUseSelectedAudio = !usesSetPreviewForAudio;
  let startTimeMs = shouldUseSelectedAudio
    ? pickPreviewStartTime(selectedBeatmap.previewTime)
    : timedRateVariant
    ? referenceStartMs
    : usesSetPreviewForAudio
    ? pickPreviewStartTime(selectedBeatmap.previewTime, referenceStartMs)
    : pickPreviewStartTime(selectedBeatmap.previewTime);
  let timeScale = timedRateVariant ? selectedDifficultyRate : 1;
  let audioMode: ChartPreviewAudioMode = shouldUseSelectedAudio ? "selected-file" : "set-preview";
  const hasMappedPreview = hasMappedPreviewTime(selectedBeatmap.previewTime) || (
    usesSetPreviewForAudio && hasMappedPreviewTime(referenceBeatmap.previewTime)
  );
  const canUseUnmappedSetPreview = usesSetPreviewForAudio && timedRateVariant;

  if ((!hasMappedPreview && !canUseUnmappedSetPreview) || !hasPreviewNotes(beatmap, startTimeMs, timeScale)) {
    beatmap = selectedBeatmap;
    startTimeMs = findDensestPreviewStartTime(selectedBeatmap);
    timeScale = 1;
    audioMode = "selected-file";
  }

  return { beatmap, startTimeMs, timeScale, audioMode };
}

export function getPreviewNotes(beatmap: ManiaBeatmap, startTimeMs = beatmap.previewTime, timeScale = 1): ManiaNote[] {
  const cache = getBoundedPreviewMap(previewNotesCache, beatmap);
  const cacheKey = getPreviewCacheKey(startTimeMs, timeScale);
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }

  const start = Math.max(0, startTimeMs || 0);
  const scale = Math.max(0.1, timeScale);
  const visualEnd = start + ((RANDOM_REPLAY_PREVIEW_MS + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS) * scale);
  const playbackEnd = RANDOM_REPLAY_PREVIEW_MS + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS;

  const notes = beatmap.notes
    .filter((note) => note.endTime >= start && note.time <= visualEnd)
    .map((note) => ({
      ...note,
      time: Math.max(0, (note.time - start) / scale),
      endTime: Math.min(playbackEnd, Math.max(0, (note.endTime - start) / scale)),
    }))
    .filter((note) => note.endTime >= 0 && note.time <= playbackEnd);
  return setBoundedPreviewCache(cache, cacheKey, notes);
}

export function getPreviewInitialCombo(beatmap: ManiaBeatmap, startTimeMs = beatmap.previewTime): number {
  const cache = getBoundedPreviewMap(previewComboCache, beatmap);
  const cacheKey = Math.round(startTimeMs || 0);
  const cached = cache.get(cacheKey);
  if (cached != null) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }

  const start = Math.max(0, startTimeMs || 0);
  const combo = beatmap.notes.reduce((total, note) => total + (note.time < start ? 1 : 0), 0);
  return setBoundedPreviewCache(cache, cacheKey, combo);
}

export function getPreviewScrollVelocities(beatmap: ManiaBeatmap, startTimeMs = beatmap.previewTime, timeScale = 1): ManiaBeatmap["scrollVelocities"] {
  const cache = getBoundedPreviewMap(previewScrollVelocityCache, beatmap);
  const cacheKey = getPreviewCacheKey(startTimeMs, timeScale);
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }

  const start = Math.max(0, startTimeMs || 0);
  const scale = Math.max(0.1, timeScale);
  const visualEnd = start + ((RANDOM_REPLAY_PREVIEW_MS + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS) * scale);
  const sourceVelocities = beatmap.scrollVelocities ?? [];
  let initialMultiplier = 1;

  for (const point of sourceVelocities) {
    if (point.time > start) break;
    initialMultiplier = point.multiplier;
  }

  const previewVelocities = [
    { time: 0, multiplier: initialMultiplier },
    ...sourceVelocities
      .filter((point) => point.time > start && point.time <= visualEnd)
      .map((point) => ({ ...point, time: (point.time - start) / scale })),
  ];
  return setBoundedPreviewCache(cache, cacheKey, previewVelocities);
}

export function buildAutoplayFrames(notes: ManiaNote[], keyCount: number): ReplayFrame[] {
  const events: Array<{ time: number; column: number; pressed: boolean }> = [];

  for (const note of notes) {
    if (note.time > RANDOM_REPLAY_PREVIEW_MS) continue;
    const column = Math.max(0, Math.min(keyCount - 1, note.column));
    const start = Math.max(0, Math.round(note.time));
    const end = Math.max(start + 1, Math.round(note.isHold ? note.endTime : note.time + RANDOM_REPLAY_TAP_HOLD_MS));
    events.push({ time: start, column, pressed: true });
    events.push({ time: Math.min(RANDOM_REPLAY_PREVIEW_MS, end), column, pressed: false });
  }

  events.sort((a, b) => a.time - b.time || (a.pressed === b.pressed ? 0 : a.pressed ? -1 : 1));

  const frames: ReplayFrame[] = [{ time: 0, keyState: 0 }];
  let keyState = 0;
  let i = 0;
  while (i < events.length) {
    const time = events[i].time;
    while (i < events.length && events[i].time === time) {
      const bit = 1 << events[i].column;
      keyState = events[i].pressed ? keyState | bit : keyState & ~bit;
      i++;
    }
    frames.push({ time, keyState });
  }
  frames.push({ time: RANDOM_REPLAY_PREVIEW_MS, keyState: 0 });
  return frames;
}
