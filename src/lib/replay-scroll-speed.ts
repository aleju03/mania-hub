export const DEFAULT_REPLAY_SCROLL_SPEED = 20;
export const REPLAY_SCROLL_SPEED_CHANGE_EVENT = "mania-hub:replay-scroll-speed-change";

const REPLAY_SCROLL_SPEED_STORAGE_KEY = "mania-hub-replay-scroll-speed";
const REPLAY_SCROLL_SPEED_MIGRATION_KEY = "mania-hub-replay-scroll-speed-v2";

export function normalizeReplayScrollSpeed(scrollSpeed: number): number {
  return Math.max(1, Math.min(40, Math.round(scrollSpeed)));
}

export function readReplayScrollSpeed(): number {
  if (typeof window === "undefined") return DEFAULT_REPLAY_SCROLL_SPEED;

  const raw = window.localStorage.getItem(REPLAY_SCROLL_SPEED_STORAGE_KEY);
  const migrated = window.localStorage.getItem(REPLAY_SCROLL_SPEED_MIGRATION_KEY) === "1";
  if (raw == null) return DEFAULT_REPLAY_SCROLL_SPEED;

  const stored = Number(raw);
  if (!Number.isFinite(stored)) return DEFAULT_REPLAY_SCROLL_SPEED;
  if (!migrated && Math.round(stored) === 1) return DEFAULT_REPLAY_SCROLL_SPEED;
  return normalizeReplayScrollSpeed(stored);
}

export function writeReplayScrollSpeed(scrollSpeed: number) {
  if (typeof window === "undefined") return;
  const normalized = normalizeReplayScrollSpeed(scrollSpeed);
  window.localStorage.setItem(REPLAY_SCROLL_SPEED_STORAGE_KEY, String(normalized));
  window.localStorage.setItem(REPLAY_SCROLL_SPEED_MIGRATION_KEY, "1");
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(REPLAY_SCROLL_SPEED_CHANGE_EVENT, { detail: normalized }));
  }
}
