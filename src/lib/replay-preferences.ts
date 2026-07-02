export const REPLAY_VOLUME_STORAGE_KEY = "mania-hub-replay-volume";
export const REPLAY_INPUT_OVERLAY_STORAGE_KEY = "mania-hub-replay-input-overlay";
export const REPLAY_INPUT_ONLY_STORAGE_KEY = "mania-hub-replay-input-only";
export const REPLAY_INPUT_KEY_HISTORY_STORAGE_KEY = "mania-hub-replay-input-key-history";
export const REPLAY_INPUT_COLOR_STORAGE_KEY = "mania-hub-replay-input-color";
export const REPLAY_BG_DIM_STORAGE_KEY = "mania-hub-replay-bg-dim";
export const REPLAY_HITSOUNDS_STORAGE_KEY = "mania-hub-replay-hitsounds";
export const REPLAY_HITSOUND_VOLUME_STORAGE_KEY = "mania-hub-replay-hitsound-volume";
export const REPLAY_BEATMAP_HITSOUNDS_STORAGE_KEY = "mania-hub-replay-beatmap-hitsounds";
export const REPLAY_COMBOBREAK_SOUND_STORAGE_KEY = "mania-hub-replay-combobreak-sound";
export const DEFAULT_REPLAY_VOLUME = 0.5;
export const DEFAULT_REPLAY_BG_DIM = 80;
export const DEFAULT_REPLAY_HITSOUND_VOLUME = 0.5;

function parseStoredNumber(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeReplayVolume(value: unknown): number {
  const parsed = parseStoredNumber(value, DEFAULT_REPLAY_VOLUME);
  return Math.min(1, Math.max(0, parsed));
}

export function normalizeReplayBackgroundDim(value: unknown): number {
  const parsed = parseStoredNumber(value, DEFAULT_REPLAY_BG_DIM);
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

export function normalizeEditableHex(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed.toLowerCase()}`;
  return null;
}

export function normalizeReplayInputColor(value: string | null): string {
  return normalizeEditableHex(value ?? "") ?? "#a855f7";
}

export function readReplayVolume(): number {
  if (typeof window === "undefined") return DEFAULT_REPLAY_VOLUME;
  return normalizeReplayVolume(window.localStorage.getItem(REPLAY_VOLUME_STORAGE_KEY));
}

export function writeReplayVolume(volume: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REPLAY_VOLUME_STORAGE_KEY, String(normalizeReplayVolume(volume)));
}

export function readReplayBackgroundDim(): number {
  if (typeof window === "undefined") return DEFAULT_REPLAY_BG_DIM;
  return normalizeReplayBackgroundDim(window.localStorage.getItem(REPLAY_BG_DIM_STORAGE_KEY));
}

export function writeReplayBackgroundDim(dim: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REPLAY_BG_DIM_STORAGE_KEY, String(normalizeReplayBackgroundDim(dim)));
}

export function readReplayInputOverlay(): boolean {
  if (typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(REPLAY_INPUT_OVERLAY_STORAGE_KEY);
  return stored == null ? false : stored === "true";
}

export function writeReplayInputOverlay(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REPLAY_INPUT_OVERLAY_STORAGE_KEY, String(enabled));
}

export function readReplayInputOnly(): boolean {
  if (typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(REPLAY_INPUT_ONLY_STORAGE_KEY);
  return stored == null ? false : stored === "true";
}

export function writeReplayInputOnly(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REPLAY_INPUT_ONLY_STORAGE_KEY, String(enabled));
}

export function readReplayInputKeyHistory(): boolean {
  if (typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(REPLAY_INPUT_KEY_HISTORY_STORAGE_KEY);
  return stored == null ? false : stored === "true";
}

export function writeReplayInputKeyHistory(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REPLAY_INPUT_KEY_HISTORY_STORAGE_KEY, String(enabled));
}

export function readReplayInputColor(): string {
  if (typeof window === "undefined") return "#a855f7";
  return normalizeReplayInputColor(window.localStorage.getItem(REPLAY_INPUT_COLOR_STORAGE_KEY));
}

export function writeReplayInputColor(color: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REPLAY_INPUT_COLOR_STORAGE_KEY, normalizeReplayInputColor(color));
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  return stored == null ? fallback : stored === "true";
}

function writeStoredBoolean(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, String(value));
}

export function normalizeReplayHitsoundVolume(value: unknown): number {
  const parsed = parseStoredNumber(value, DEFAULT_REPLAY_HITSOUND_VOLUME);
  return Math.min(1, Math.max(0, parsed));
}

export function readReplayHitsoundsEnabled(): boolean {
  return readStoredBoolean(REPLAY_HITSOUNDS_STORAGE_KEY, true);
}

export function writeReplayHitsoundsEnabled(enabled: boolean): void {
  writeStoredBoolean(REPLAY_HITSOUNDS_STORAGE_KEY, enabled);
}

export function readReplayHitsoundVolume(): number {
  if (typeof window === "undefined") return DEFAULT_REPLAY_HITSOUND_VOLUME;
  return normalizeReplayHitsoundVolume(window.localStorage.getItem(REPLAY_HITSOUND_VOLUME_STORAGE_KEY));
}

export function writeReplayHitsoundVolume(volume: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REPLAY_HITSOUND_VOLUME_STORAGE_KEY, String(normalizeReplayHitsoundVolume(volume)));
}

export function readReplayBeatmapHitsounds(): boolean {
  return readStoredBoolean(REPLAY_BEATMAP_HITSOUNDS_STORAGE_KEY, true);
}

export function writeReplayBeatmapHitsounds(enabled: boolean): void {
  writeStoredBoolean(REPLAY_BEATMAP_HITSOUNDS_STORAGE_KEY, enabled);
}

export function readReplayComboBreakSound(): boolean {
  return readStoredBoolean(REPLAY_COMBOBREAK_SOUND_STORAGE_KEY, true);
}

export function writeReplayComboBreakSound(enabled: boolean): void {
  writeStoredBoolean(REPLAY_COMBOBREAK_SOUND_STORAGE_KEY, enabled);
}

export interface ReplayAudioSettings {
  hitsoundsEnabled: boolean;
  hitsoundVolume: number;
  beatmapHitsounds: boolean;
  comboBreakSound: boolean;
}

export function readReplayAudioSettings(): ReplayAudioSettings {
  return {
    hitsoundsEnabled: readReplayHitsoundsEnabled(),
    hitsoundVolume: readReplayHitsoundVolume(),
    beatmapHitsounds: readReplayBeatmapHitsounds(),
    comboBreakSound: readReplayComboBreakSound(),
  };
}

export function writeReplayAudioSettings(settings: ReplayAudioSettings): void {
  writeReplayHitsoundsEnabled(settings.hitsoundsEnabled);
  writeReplayHitsoundVolume(settings.hitsoundVolume);
  writeReplayBeatmapHitsounds(settings.beatmapHitsounds);
  writeReplayComboBreakSound(settings.comboBreakSound);
}
