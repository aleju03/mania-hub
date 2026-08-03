export const REPLAY_OVERLAY_SETTINGS_STORAGE_KEY = "mania-hub-replay-overlays";
export const REPLAY_OVERLAY_SETTINGS_CHANGE_EVENT = "mania-hub:replay-overlay-settings-change";

export const REPLAY_MISS_THUMB_HAND_STORAGE_KEY = "mania-hub-replay-miss-thumb-hand";
export const REPLAY_MISS_THUMB_HAND_CHANGE_EVENT = "mania-hub:replay-miss-thumb-hand-change";

// Odd keymodes have a middle lane that one thumb covers, so the L/R miss split
// depends on which thumb the player uses there. Right is the common setup and
// stays the default; lefties flip it from the overlay's right-click menu.
export type ReplayThumbHand = "left" | "right";

export const DEFAULT_REPLAY_MISS_THUMB_HAND: ReplayThumbHand = "right";

export const REPLAY_OVERLAY_IDS = ["keypresses", "kps", "misses", "accuracy", "pp", "judgements", "progress", "leaderboard"] as const;

export type ReplayOverlayId = typeof REPLAY_OVERLAY_IDS[number];

// Shared by the settings modal and the stage's right-click overlay menu.
export const REPLAY_OVERLAY_LABELS: Record<ReplayOverlayId, string> = {
  keypresses: "Keypresses",
  kps: "KPS counter",
  misses: "L/R miss counter",
  accuracy: "Accuracy",
  pp: "PP counter",
  judgements: "Judgements",
  progress: "Progress pie",
  leaderboard: "Leaderboard",
};

export interface ReplayOverlayPlacement {
  enabled: boolean;
  x: number;
  y: number;
  scale: number;
}

export type ReplayOverlaySettings = Record<ReplayOverlayId, ReplayOverlayPlacement>;

export const REPLAY_OVERLAY_MIN_SCALE = 0.5;
export const REPLAY_OVERLAY_MAX_SCALE = 2.5;

// The fixed osu!-style score block (score + progress pie) owns the top-right
// corner, so accuracy defaults to a big draggable readout on the left and
// the judgement counts sit below the score block.
export const DEFAULT_REPLAY_OVERLAY_SETTINGS: ReplayOverlaySettings = {
  keypresses: { enabled: false, x: 0.035, y: 0.68, scale: 0.75 },
  kps: { enabled: false, x: 0.035, y: 0.77, scale: 0.75 },
  misses: { enabled: true, x: 0.085, y: 0.77, scale: 1 },
  accuracy: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.92, y: 0.2, scale: 1.5 },
  // Below the accuracy readout: the detached pie must not land on top of
  // the cluster it just left, or toggling it looks like a no-op.
  progress: { enabled: false, x: 0.03, y: 0.1, scale: 1 },
  leaderboard: { enabled: true, x: 0, y: 0.24, scale: 1 },
};

// Earlier cuts of the left-side accuracy readout shipped over- and
// under-sized; users still on those exact placements follow the default
// forward.
const PREVIOUS_ACCURACY_OVERLAY_DEFAULTS: ReplayOverlayPlacement[] = [
  { enabled: true, x: 0.03, y: 0.03, scale: 1.5 },
  { enabled: true, x: 0.03, y: 0.03, scale: 1.1 },
  { enabled: true, x: 0.03, y: 0.03, scale: 0.95 },
  { enabled: true, x: 0.03, y: 0.03, scale: 0.8 },
];

// What the defaults were when the ingame-clone HUD first landed (accuracy
// folded into the fixed score block, smaller judgement counts); users still
// on these exact placements follow the defaults forward.
const SCORE_BLOCK_HUD_DEFAULTS: ReplayOverlaySettings = {
  keypresses: { enabled: false, x: 0.035, y: 0.68, scale: 0.75 },
  kps: { enabled: false, x: 0.035, y: 0.77, scale: 0.75 },
  misses: { enabled: true, x: 0.085, y: 0.77, scale: 1 },
  accuracy: { enabled: false, x: 0.74, y: 0.02, scale: 1 },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.92, y: 0.2, scale: 1.25 },
  progress: { enabled: false, x: 0.03, y: 0.03, scale: 1 },
  leaderboard: { enabled: true, x: 0, y: 0.24, scale: 1 },
};

// What the defaults were before the ingame-clone HUD; users still on these
// exact placements follow the defaults forward.
const PRE_INGAME_HUD_DEFAULTS: ReplayOverlaySettings = {
  keypresses: { enabled: false, x: 0.035, y: 0.68, scale: 0.75 },
  kps: { enabled: false, x: 0.035, y: 0.77, scale: 0.75 },
  misses: { enabled: true, x: 0.085, y: 0.77, scale: 1 },
  accuracy: { enabled: true, x: 0.74, y: 0.02, scale: 1 },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.74, y: 0.07, scale: 1.25 },
  progress: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
  // "leaderboard" postdates every legacy layout; matching the current
  // default makes the migration a no-op for it (same in the sets below).
  leaderboard: { enabled: true, x: 0, y: 0.24, scale: 1 },
};

const COMPACT_MISS_OVERLAY_DEFAULT: ReplayOverlayPlacement = { enabled: true, x: 0.085, y: 0.77, scale: 0.75 };

const OVERLAPPING_LEFT_CLUSTER_DEFAULTS: ReplayOverlaySettings = {
  keypresses: { enabled: true, x: 0.05, y: 0.68, scale: 0.82 },
  kps: { enabled: true, x: 0.03, y: 0.68, scale: 0.82 },
  misses: { enabled: true, x: 0.05, y: 0.77, scale: 0.82 },
  accuracy: { enabled: true, x: 0.74, y: 0.02, scale: 1 },
  // "pp" postdates these legacy layouts; matching the current default makes
  // the migration a no-op for it.
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.74, y: 0.07, scale: 1 },
  progress: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
  leaderboard: { enabled: true, x: 0, y: 0.24, scale: 1 },
};

const LEGACY_PLAYFIELD_OVERLAY_DEFAULTS: ReplayOverlaySettings = {
  keypresses: { enabled: true, x: 0.22, y: 0.74, scale: 1 },
  kps: { enabled: true, x: 0.14, y: 0.74, scale: 1 },
  misses: { enabled: true, x: 0.22, y: 0.84, scale: 1 },
  accuracy: { enabled: true, x: 0.68, y: 0.02, scale: 1 },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.68, y: 0.07, scale: 1 },
  progress: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
  leaderboard: { enabled: true, x: 0, y: 0.24, scale: 1 },
};

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizePlacement(value: unknown, fallback: ReplayOverlayPlacement): ReplayOverlayPlacement {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ReplayOverlayPlacement>
    : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    x: normalizeNumber(raw.x, fallback.x, 0, 1),
    y: normalizeNumber(raw.y, fallback.y, 0, 1),
    scale: normalizeNumber(raw.scale, fallback.scale, REPLAY_OVERLAY_MIN_SCALE, REPLAY_OVERLAY_MAX_SCALE),
  };
}

function placementMatches(a: ReplayOverlayPlacement, b: ReplayOverlayPlacement): boolean {
  return a.enabled === b.enabled
    && Math.abs(a.x - b.x) < 0.0001
    && Math.abs(a.y - b.y) < 0.0001
    && Math.abs(a.scale - b.scale) < 0.0001;
}

export function normalizeReplayOverlaySettings(value: unknown): ReplayOverlaySettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<ReplayOverlayId, unknown>>
    : {};
  return REPLAY_OVERLAY_IDS.reduce((settings, id) => {
    const placement = normalizePlacement(raw[id], DEFAULT_REPLAY_OVERLAY_SETTINGS[id]);
    settings[id] = placementMatches(placement, LEGACY_PLAYFIELD_OVERLAY_DEFAULTS[id])
      || placementMatches(placement, OVERLAPPING_LEFT_CLUSTER_DEFAULTS[id])
      || placementMatches(placement, PRE_INGAME_HUD_DEFAULTS[id])
      || placementMatches(placement, SCORE_BLOCK_HUD_DEFAULTS[id])
      || (id === "misses" && placementMatches(placement, COMPACT_MISS_OVERLAY_DEFAULT))
      || (id === "accuracy" && PREVIOUS_ACCURACY_OVERLAY_DEFAULTS.some((previous) => placementMatches(placement, previous)))
      ? DEFAULT_REPLAY_OVERLAY_SETTINGS[id]
      : placement;
    return settings;
  }, {} as ReplayOverlaySettings);
}

export function readReplayOverlaySettings(): ReplayOverlaySettings {
  if (typeof window === "undefined") return DEFAULT_REPLAY_OVERLAY_SETTINGS;

  try {
    const raw = window.localStorage.getItem(REPLAY_OVERLAY_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_REPLAY_OVERLAY_SETTINGS;
    return normalizeReplayOverlaySettings(JSON.parse(raw));
  } catch (error) {
    console.warn("[replay] failed to read replay overlay settings", error);
    return DEFAULT_REPLAY_OVERLAY_SETTINGS;
  }
}

export function normalizeReplayMissThumbHand(value: unknown): ReplayThumbHand {
  return value === "left" ? "left" : DEFAULT_REPLAY_MISS_THUMB_HAND;
}

export function readReplayMissThumbHand(): ReplayThumbHand {
  if (typeof window === "undefined") return DEFAULT_REPLAY_MISS_THUMB_HAND;

  try {
    return normalizeReplayMissThumbHand(window.localStorage.getItem(REPLAY_MISS_THUMB_HAND_STORAGE_KEY));
  } catch (error) {
    console.warn("[replay] failed to read replay miss thumb hand", error);
    return DEFAULT_REPLAY_MISS_THUMB_HAND;
  }
}

export function writeReplayMissThumbHand(hand: ReplayThumbHand): void {
  if (typeof window === "undefined") return;

  try {
    const normalized = normalizeReplayMissThumbHand(hand);
    window.localStorage.setItem(REPLAY_MISS_THUMB_HAND_STORAGE_KEY, normalized);
    if (typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent(REPLAY_MISS_THUMB_HAND_CHANGE_EVENT, { detail: normalized }));
    }
  } catch (error) {
    console.warn("[replay] failed to write replay miss thumb hand", error);
  }
}

export function writeReplayOverlaySettings(settings: ReplayOverlaySettings): void {
  if (typeof window === "undefined") return;

  try {
    const normalized = normalizeReplayOverlaySettings(settings);
    window.localStorage.setItem(REPLAY_OVERLAY_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    if (typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent(REPLAY_OVERLAY_SETTINGS_CHANGE_EVENT, { detail: normalized }));
    }
  } catch (error) {
    console.warn("[replay] failed to write replay overlay settings", error);
  }
}
