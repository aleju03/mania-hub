import type { ManiaBeatmap, ManiaNote } from "./beatmap-parser";
import type { ReplayFrame } from "./types";

export const RANDOM_REPLAY_PREVIEW_MS = 10_000;
export const RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS = 1_200;

const RANDOM_REPLAY_TAP_HOLD_MS = 48;
const DENSE_PREVIEW_LEAD_IN_MS = 1_000;
const MAX_PREVIEW_CACHE_ENTRIES_PER_MAP = 20;

export type ChartPreviewAudioMode = "set-preview" | "selected-file";

export type ChartPreviewPlaybackPlan = {
  beatmap: ManiaBeatmap;
  startTimeMs: number;
  timeScale: number;
  audioMode: ChartPreviewAudioMode;
};

// Just enough of a beatmapset difficulty to decide how to source preview audio.
// Structural so both the maps route and the preview panel can pass their own
// richer entries straight in.
export type ChartPreviewDifficulty = {
  version: string;
  difficultyRating: number;
  totalLength: number;
  cs: number;
};

// Rate variants label themselves in the difficulty name: "1.1x", "x1.2",
// "[1,05x Rate]". Comma decimals are common from non-English mappers, so both
// separators are accepted and normalised before parsing. A bare number glued to
// letters is part of the name, not a rate: "2mnd" is the second dan course.
const RATE_IN_VERSION = /(^|[^\da-z])(?:x\s*)?([01](?:[.,]\d{1,3})|2(?:[.,]0{1,3})?)(?:\s*[x×]|(?=$|[^\da-z]))(?=$|[^\d])/gi;

export function parseDifficultyRate(version: string): number {
  const matches = [...version.matchAll(RATE_IN_VERSION)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const value = Number.parseFloat(matches[i][2].replace(",", "."));
    if (Number.isFinite(value) && value >= 0.5 && value <= 2) return value;
  }
  return 1;
}

export function parseBracketBpm(version: string): number | null {
  const matches = [...version.matchAll(/\[(\d{2,3})\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const value = Number.parseInt(matches[i][1], 10);
    if (Number.isFinite(value) && value >= 60 && value <= 400) return value;
  }
  return null;
}

function stripRateVariantDecorations(version: string): string {
  return version
    .toLowerCase()
    .replace(/\[[^\]]*?\b\d+k\b[^\]]*?\]/gi, " ")
    .replace(/\b\d+k\b/gi, " ")
    .replace(/(^|[^\da-z])x?\s*(?:[01](?:[.,]\d{1,3})|2(?:[.,]0{1,3})?)(?:\s*[x×]|(?=$|[^\da-z]))(?=$|[^\d])/gi, "$1 ")
    .replace(/\b\d{2,3}\s*bpm\b/gi, " ")
    .replace(/\brate\b/gi, " ")
    .trim();
}

function normalizeRateVariantVersion(version: string): string {
  return stripRateVariantDecorations(version)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeBracketBpmVariantVersion(version: string): string {
  return version
    .toLowerCase()
    .replace(/\[[^\]]*?\b\d+k\b[^\]]*?\]/gi, " ")
    .replace(/\b\d+k\b/gi, " ")
    .replace(/\[\d{2,3}\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isLikelyRateVariantSet(beatmaps: ChartPreviewDifficulty[]): boolean {
  if (beatmaps.length <= 1) return false;
  const names = new Set(beatmaps.map((beatmap) => normalizeRateVariantVersion(beatmap.version)).filter(Boolean));
  const hasRateVariant = beatmaps.some((beatmap) => parseDifficultyRate(beatmap.version) !== 1);
  if (names.size === 1 && hasRateVariant) return true;
  const keyCounts = new Set(beatmaps.map((beatmap) => Math.round(beatmap.cs)).filter((keyCount) => Number.isFinite(keyCount)));
  return (
    names.size === 0 &&
    hasRateVariant &&
    keyCounts.size <= 1 &&
    beatmaps.every((beatmap) => !/[a-z0-9]/i.test(stripRateVariantDecorations(beatmap.version)))
  );
}

export function isLikelyBracketBpmVariantSet(beatmaps: ChartPreviewDifficulty[]): boolean {
  if (beatmaps.length <= 1) return false;
  const variants = beatmaps
    .map((beatmap) => ({
      bpm: parseBracketBpm(beatmap.version),
      name: normalizeBracketBpmVariantVersion(beatmap.version),
    }))
    .filter((variant) => variant.bpm !== null && variant.name);
  if (variants.length !== beatmaps.length) return false;
  const names = new Set(variants.map((variant) => variant.name));
  const bpms = new Set(variants.map((variant) => variant.bpm));
  return names.size === 1 && bpms.size > 1;
}

export function getBracketBpmBase(beatmaps: ChartPreviewDifficulty[]): number | null {
  const bpms = beatmaps
    .map((beatmap) => parseBracketBpm(beatmap.version))
    .filter((bpm): bpm is number => bpm !== null)
    .sort((a, b) => a - b);
  if (!bpms.length) return null;
  return bpms.includes(130) ? 130 : bpms[0];
}

export function isLikelyTimedRateVariantSet(beatmaps: ChartPreviewDifficulty[]): boolean {
  const meaningfulBeatmaps = beatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5);
  return isLikelyRateVariantSet(meaningfulBeatmaps) || isLikelyBracketBpmVariantSet(meaningfulBeatmaps);
}

export function parseSelectedDifficultyRate(
  selected: ChartPreviewDifficulty | null,
  beatmaps: ChartPreviewDifficulty[],
): number {
  if (!selected) return 1;
  const bracketBpm = parseBracketBpm(selected.version);
  const baseBpm = isLikelyBracketBpmVariantSet(beatmaps) ? getBracketBpmBase(beatmaps) : null;
  if (bracketBpm && baseBpm) return bracketBpm / baseBpm;
  return parseDifficultyRate(selected.version);
}

// The diff whose audio the set preview clip actually corresponds to: the 1.0x
// or base-BPM member of a rate-variant set. Null means "no stand-in needed".
export function getSetPreviewReferenceBeatmap<T extends ChartPreviewDifficulty>(beatmaps: T[]): T | null {
  const meaningfulBeatmaps = beatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5);
  if (!meaningfulBeatmaps.length) return beatmaps[0] ?? null;

  if (isLikelyBracketBpmVariantSet(meaningfulBeatmaps)) {
    const baseBpm = getBracketBpmBase(meaningfulBeatmaps);
    return meaningfulBeatmaps.find((beatmap) => parseBracketBpm(beatmap.version) === baseBpm) ?? meaningfulBeatmaps[0] ?? null;
  }

  if (isLikelyRateVariantSet(meaningfulBeatmaps)) {
    return meaningfulBeatmaps.find((beatmap) => parseDifficultyRate(beatmap.version) === 1) ?? meaningfulBeatmaps.at(-1) ?? null;
  }

  return null;
}

// A pack, dan course or practice compilation puts several different songs in
// one beatmapset, so the set's 30s preview clip only matches whichever song it
// was cut from. Everything else in a set is the same song, and the clip is
// correct for every difficulty.
//
// The signal is length, not naming. Difficulties of one song end up within a
// few seconds of each other; a pack's difficulties are different songs and
// their lengths scatter. Measured over 8843 multi-difficulty mania sets (with
// ground truth read from the cached .osu files: a shared AudioFilename, or an
// identical first uninherited timing point where each diff ships its own copy
// of the audio), this lands 97.6% correct against 59.5% for the difficulty-name
// heuristics it replaces, and cuts needless full-song downloads from 40% of
// sets to 2%.
const SET_PREVIEW_LENGTH_TOLERANCE_RATIO = 0.08;
const SET_PREVIEW_LENGTH_TOLERANCE_SECONDS = 5;

// Names that mean "compilation" even when the lengths happen to line up, which
// is how sets of same-length TV-size songs and equal-length dan courses slip
// past the length check.
const COMPILATION_WORDS = /\b(pack|practice|collection)\b/i;

function spansOneSongLength(lengths: number[]): boolean {
  if (lengths.length < 2) return true;
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  const tolerance = Math.max(SET_PREVIEW_LENGTH_TOLERANCE_SECONDS, min * SET_PREVIEW_LENGTH_TOLERANCE_RATIO);
  return max - min <= tolerance;
}

export function hasOneSongLengthSpread(beatmaps: ChartPreviewDifficulty[]): boolean {
  const meaningfulBeatmaps = beatmaps.filter((beatmap) => beatmap.difficultyRating >= 0.5);
  const pool = meaningfulBeatmaps.length >= 2 ? meaningfulBeatmaps : beatmaps;
  if (pool.length <= 1) return true;

  const lengths = pool.map((beatmap) => beatmap.totalLength).filter((value) => Number.isFinite(value) && value > 0);
  if (lengths.length < 2) return true;
  if (spansOneSongLength(lengths)) return true;

  // Rate variants are one song at several speeds, so their lengths differ by
  // exactly the rate ratio. Undo each difficulty's own rate and re-check.
  if (!isLikelyTimedRateVariantSet(pool)) return false;
  const baseBpm = isLikelyBracketBpmVariantSet(pool) ? getBracketBpmBase(pool) : null;
  const unscaled = pool
    .map((beatmap) => {
      const bracketBpm = parseBracketBpm(beatmap.version);
      const rate = bracketBpm && baseBpm ? bracketBpm / baseBpm : parseDifficultyRate(beatmap.version);
      return beatmap.totalLength * rate;
    })
    .filter((value) => Number.isFinite(value) && value > 0);
  return spansOneSongLength(unscaled);
}

export function shouldUseSetPreviewForReplayAudio(title: string, beatmaps: ChartPreviewDifficulty[]): boolean {
  if (beatmaps.length <= 1) return true;
  if (!hasOneSongLengthSpread(beatmaps)) return false;
  if (COMPILATION_WORDS.test(title)) return false;
  return !beatmaps.some((beatmap) => COMPILATION_WORDS.test(beatmap.version));
}

// This used to force the full song download whenever the set had more than one
// difficulty, on the theory that a set worth browsing could not be trusted to
// the shared clip. shouldUseSetPreviewForReplayAudio decides that properly now,
// so a multi-difficulty set starts on the clip like any other and only pays for
// the download when the user scrubs (which switches the mode on demand).
export function resolveInitialChartPreviewAudioMode({
  plannedAudioMode,
  hasSelectedAudioFile,
  hasSetPreviewAudio,
}: {
  plannedAudioMode: ChartPreviewAudioMode;
  hasSelectedAudioFile: boolean;
  hasSetPreviewAudio: boolean;
}): ChartPreviewAudioMode {
  if (plannedAudioMode !== "set-preview" || !hasSelectedAudioFile) {
    return plannedAudioMode;
  }
  return hasSetPreviewAudio ? "set-preview" : "selected-file";
}

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

export function getPreviewNotes(
  beatmap: ManiaBeatmap,
  startTimeMs = beatmap.previewTime,
  timeScale = 1,
  windowMs = RANDOM_REPLAY_PREVIEW_MS,
): ManiaNote[] {
  const cache = getBoundedPreviewMap(previewNotesCache, beatmap);
  const cacheKey = `${getPreviewCacheKey(startTimeMs, timeScale)}:${Math.round(windowMs)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }

  const start = Math.max(0, startTimeMs || 0);
  const scale = Math.max(0.1, timeScale);
  const window = Math.max(0, windowMs);
  const visualEnd = start + ((window + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS) * scale);
  const playbackEnd = window + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS;

  const notes = beatmap.notes
    .filter((note) => note.time >= start && note.time <= visualEnd)
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

export function getPreviewScrollVelocities(
  beatmap: ManiaBeatmap,
  startTimeMs = beatmap.previewTime,
  timeScale = 1,
  windowMs = RANDOM_REPLAY_PREVIEW_MS,
): ManiaBeatmap["scrollVelocities"] {
  const cache = getBoundedPreviewMap(previewScrollVelocityCache, beatmap);
  const cacheKey = `${getPreviewCacheKey(startTimeMs, timeScale)}:${Math.round(windowMs)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }

  const start = Math.max(0, startTimeMs || 0);
  const scale = Math.max(0.1, timeScale);
  const visualEnd = start + ((Math.max(0, windowMs) + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS) * scale);
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

export function buildAutoplayFrames(
  notes: ManiaNote[],
  keyCount: number,
  windowMs = RANDOM_REPLAY_PREVIEW_MS,
): ReplayFrame[] {
  const window = Math.max(0, windowMs);
  // Notes in the lookahead tail are rendered and judged, so they must be
  // played too, or every preview ends on a string of phantom misses.
  const playEnd = window + RANDOM_REPLAY_PREVIEW_LOOKAHEAD_MS;

  // Build presses per column, in time order, so each release clamps to
  // strictly before the next same-column press. Judgement needs a fresh press
  // edge per note; the old fixed 48ms tap hold (and hold tails ending exactly
  // on the next head) swallowed the re-press whenever the gap was tighter,
  // and frame coalescing turned the collision into a straight miss - the
  // "autoplay" broke combo on any dense jack/LN chart.
  const byColumn = new Map<number, Array<{ start: number; end: number }>>();
  const ordered = [...notes].sort((a, b) => a.time - b.time || a.endTime - b.endTime);
  for (const note of ordered) {
    if (note.time > playEnd) continue;
    const column = Math.max(0, Math.min(keyCount - 1, note.column));
    let presses = byColumn.get(column);
    if (!presses) byColumn.set(column, (presses = []));
    const start = Math.max(0, Math.round(note.time));
    const previous = presses[presses.length - 1];
    if (previous) {
      // Stacked duplicates can't both get a press edge at ms resolution.
      if (start <= previous.start) continue;
      previous.end = Math.max(previous.start + 1, Math.min(previous.end, start - 1));
    }
    const end = Math.max(start + 1, Math.round(note.isHold ? note.endTime : note.time + RANDOM_REPLAY_TAP_HOLD_MS));
    presses.push({ start, end });
  }

  const events: Array<{ time: number; column: number; pressed: boolean }> = [];
  for (const [column, presses] of byColumn) {
    for (const press of presses) {
      events.push({ time: press.start, column, pressed: true });
      events.push({ time: press.end, column, pressed: false });
    }
  }
  events.sort((a, b) => a.time - b.time);

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
  const lastEventTime = events.length > 0 ? events[events.length - 1].time : 0;
  frames.push({ time: Math.max(playEnd, lastEventTime), keyState: 0 });
  return frames;
}

export type ClockStallWatch = {
  /**
   * Feed the clock's current position. Returns true once the position has sat
   * still for a whole window, and re-baselines so the next report is another
   * full window away.
   */
  observe(position: number, nowMs: number): boolean;
  reset(nowMs: number): void;
};

/**
 * Watches a clock that is supposed to advance on its own (a media element's
 * currentTime, a renderer's playhead) and reports when it has stopped.
 *
 * The window is wall-clock time since the last observed advance, never a
 * per-sample delta. A sampler can easily run faster than the clock it watches
 * updates - a 240Hz frame loop reading an audio element, a half-rate preview -
 * and a per-sample test then reads a perfectly healthy clock as stalled on
 * every sample. Whatever recovery that triggers is what a viewer sees as a
 * stutter, so the sampling rate must not enter into the decision at all.
 */
export function createClockStallWatch(stallWindowMs: number, advanceEpsilon: number): ClockStallWatch {
  let lastAdvancePosition: number | null = null;
  let lastAdvanceAtMs = 0;
  const baseline = (position: number, nowMs: number) => {
    lastAdvancePosition = position;
    lastAdvanceAtMs = nowMs;
  };
  return {
    reset(nowMs) {
      lastAdvancePosition = null;
      lastAdvanceAtMs = nowMs;
    },
    observe(position, nowMs) {
      if (lastAdvancePosition == null || position > lastAdvancePosition + advanceEpsilon) {
        baseline(position, nowMs);
        return false;
      }
      if (nowMs - lastAdvanceAtMs < stallWindowMs) return false;
      baseline(position, nowMs);
      return true;
    },
  };
}
