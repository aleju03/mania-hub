import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

export const REPLAY_OVERLAY_SETTINGS_STORAGE_KEY = "mania-hub-replay-overlays";
export const REPLAY_OVERLAY_SETTINGS_CHANGE_EVENT = "mania-hub:replay-overlay-settings-change";

export const REPLAY_MISS_THUMB_HAND_STORAGE_KEY = "mania-hub-replay-miss-thumb-hand";
export const REPLAY_MISS_THUMB_HAND_CHANGE_EVENT = "mania-hub:replay-miss-thumb-hand-change";

// Odd keymodes have a middle lane that one thumb covers, so per-hand stats
// depend on which thumb the player uses there. Right is the common setup and
// stays the default; lefties flip it from either hand overlay's right-click menu.
export type ReplayThumbHand = "left" | "right";

export const DEFAULT_REPLAY_MISS_THUMB_HAND: ReplayThumbHand = "right";

export const REPLAY_MASTER_MIN_SCROLL_SPEED = 0.25;
export const REPLAY_MASTER_MAX_SCROLL_SPEED = 3;
export const DEFAULT_REPLAY_MASTER_SCROLL_SPEED = 1;

export function normalizeReplayMasterScrollSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_REPLAY_MASTER_SCROLL_SPEED;
  return Math.max(REPLAY_MASTER_MIN_SCROLL_SPEED, Math.min(REPLAY_MASTER_MAX_SCROLL_SPEED, value));
}

export const REPLAY_OVERLAY_IDS = ["keypresses", "kps", "misses", "accuracy", "handAccuracy", "pp", "judgements", "hitError", "progress", "leaderboard", "replayMaster"] as const;

export type ReplayOverlayId = typeof REPLAY_OVERLAY_IDS[number];

// Shared by the settings modal and the stage's right-click overlay menu.
export const REPLAY_OVERLAY_LABELS: Record<ReplayOverlayId, MessageDescriptor> = {
  keypresses: msg`Keypresses`,
  kps: msg`KPS counter`,
  misses: msg`L/R miss counter`,
  accuracy: msg`Accuracy`,
  handAccuracy: msg`Per-hand accuracy`,
  pp: msg`PP counter`,
  judgements: msg`Judgements`,
  hitError: msg`Hit error bar`,
  progress: msg`Progress pie`,
  leaderboard: msg`Leaderboard`,
  replayMaster: msg`Mania Replay Master`,
};

// Hand overlays carry their selected shape with the saved placement.
export const REPLAY_HAND_ACCURACY_STYLES = ["meters", "plain", "rings", "balance"] as const;

export type ReplayHandAccuracyStyle = typeof REPLAY_HAND_ACCURACY_STYLES[number];

export const DEFAULT_REPLAY_HAND_ACCURACY_STYLE: ReplayHandAccuracyStyle = "meters";

export const REPLAY_HAND_ACCURACY_STYLE_LABELS: Record<ReplayHandAccuracyStyle, MessageDescriptor> = {
  meters: msg`Meters`,
  plain: msg`Numbers only`,
  rings: msg`Rings`,
  balance: msg`Balance bar`,
};

export function normalizeReplayHandAccuracyStyle(value: unknown): ReplayHandAccuracyStyle {
  return REPLAY_HAND_ACCURACY_STYLES.includes(value as ReplayHandAccuracyStyle)
    ? value as ReplayHandAccuracyStyle
    : DEFAULT_REPLAY_HAND_ACCURACY_STYLE;
}

export const REPLAY_MISS_STYLES = ["compact", "stacked", "plain"] as const;
export type ReplayMissStyle = typeof REPLAY_MISS_STYLES[number];
export const DEFAULT_REPLAY_MISS_STYLE: ReplayMissStyle = "plain";
export const REPLAY_MISS_STYLE_LABELS: Record<ReplayMissStyle, MessageDescriptor> = {
  compact: msg`Hit circles`,
  stacked: msg`Leaderboard`,
  plain: msg`Classic`,
};

export function normalizeReplayMissStyle(value: unknown): ReplayMissStyle {
  return REPLAY_MISS_STYLES.includes(value as ReplayMissStyle)
    ? value as ReplayMissStyle
    : DEFAULT_REPLAY_MISS_STYLE;
}

// An overlay whose default position is a computed anchor rather than a
// fraction of the stage stores this in x/y until it is first dragged; the
// stage then keeps drawing it where it always sat.
export const REPLAY_OVERLAY_ANCHORED_COORD = -1;
// Leave -1 reserved for anchored placements. The lazer leaderboard may cross the
// left edge; keep a small visible strip available for dragging it back.
export const REPLAY_LEADERBOARD_MIN_X = -0.95;

export function getReplayOverlayMinX(id: ReplayOverlayId, width: number, stageWidth: number, isLazer: boolean): number {
  if (!isLazer || id !== "leaderboard" || width <= 32) return 0;
  return Math.max(REPLAY_LEADERBOARD_MIN_X, -Math.max(0, width - 32) / Math.max(1, stageWidth));
}

export interface ReplayOverlayPlacement {
  enabled: boolean;
  x: number;
  y: number;
  scale: number;
  /** Stage geometry when this placement was authored; keeps it stable across aspect ratios. */
  reference?: ReplayOverlayReference;
  /** Each hand overlay normalizes against its own set of styles. */
  style?: ReplayHandAccuracyStyle | ReplayMissStyle;
  /** Mania Replay Master scroll multiplier; independent of replay playback. */
  scrollSpeed?: number;
  /** Show Replay Master's marks directly over the stage. */
  transparentBackground?: boolean;
}

export interface ReplayOverlayReference {
  width: number;
  height: number;
  playfieldX: number;
  playfieldWidth: number;
  hudScale: number;
  /** Scale of fixed HUD spacing in this reference, independent of font scaling. */
  spacingScale?: number;
}

export type ReplayOverlayPosition = Pick<ReplayOverlayPlacement, "x" | "y" | "scale" | "reference">;

export type ReplayOverlaySettings = Record<ReplayOverlayId, ReplayOverlayPlacement> & {
  leaderboard: ReplayOverlayPlacement & {
    /** Stable uses the outer placement; lazer keeps its own geometry. Visibility is shared. */
    lazerPosition?: ReplayOverlayPosition;
  };
};

export function getReplayOverlayPlacement(settings: ReplayOverlaySettings, id: ReplayOverlayId, isLazer: boolean): ReplayOverlayPlacement {
  const placement = settings[id];
  const position = id === "leaderboard" && isLazer ? settings.leaderboard.lazerPosition : undefined;
  return position ? { ...placement, ...position, reference: position.reference } : placement;
}

export function updateReplayOverlayPlacement(
  settings: ReplayOverlaySettings,
  id: ReplayOverlayId,
  patch: Partial<ReplayOverlayPlacement>,
  isLazer: boolean,
): ReplayOverlaySettings {
  if (id !== "leaderboard" || !isLazer) {
    return { ...settings, [id]: { ...settings[id], ...patch } };
  }
  const { x, y, scale, reference } = { ...getReplayOverlayPlacement(settings, id, true), ...patch };
  const { x: _x, y: _y, scale: _scale, reference: _reference, ...shared } = patch;
  return {
    ...settings,
    leaderboard: { ...settings.leaderboard, ...shared, lazerPosition: { x, y, scale, reference } },
  };
}

export const REPLAY_OVERLAY_MIN_SCALE = 0.5;
export const REPLAY_OVERLAY_MAX_SCALE = 2.5;

// The fixed osu!-style score block (score + progress pie) owns the top-right
// corner, so accuracy defaults to a big draggable readout on the left and
// the judgement counts sit below the score block.
export const DEFAULT_REPLAY_OVERLAY_SETTINGS: ReplayOverlaySettings = {
  replayMaster: { enabled: false, x: 0.72, y: 0.25, scale: 0.75, scrollSpeed: DEFAULT_REPLAY_MASTER_SCROLL_SPEED, transparentBackground: false },
  keypresses: { enabled: false, x: 0.035, y: 0.68, scale: 0.75 },
  kps: { enabled: false, x: 0.035, y: 0.77, scale: 0.75 },
  misses: { enabled: true, x: 0.085, y: 0.77, scale: 1, style: DEFAULT_REPLAY_MISS_STYLE },
  accuracy: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
  handAccuracy: { enabled: false, x: 0.03, y: 0.16, scale: 1, style: DEFAULT_REPLAY_HAND_ACCURACY_STYLE },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.92, y: 0.2, scale: 1.5 },
  // Anchored under the receptors until dragged, where it has always sat.
  hitError: { enabled: true, x: REPLAY_OVERLAY_ANCHORED_COORD, y: REPLAY_OVERLAY_ANCHORED_COORD, scale: 1 },
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
const SCORE_BLOCK_HUD_DEFAULTS: Partial<ReplayOverlaySettings> = {
  keypresses: { enabled: false, x: 0.035, y: 0.68, scale: 0.75 },
  kps: { enabled: false, x: 0.035, y: 0.77, scale: 0.75 },
  misses: { enabled: true, x: 0.085, y: 0.77, scale: 1 },
  accuracy: { enabled: false, x: 0.74, y: 0.02, scale: 1 },
  handAccuracy: { enabled: false, x: 0.03, y: 0.16, scale: 1 },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.92, y: 0.2, scale: 1.25 },
  progress: { enabled: false, x: 0.03, y: 0.03, scale: 1 },
  leaderboard: { enabled: true, x: 0, y: 0.24, scale: 1 },
};

// What the defaults were before the ingame-clone HUD; users still on these
// exact placements follow the defaults forward.
const PRE_INGAME_HUD_DEFAULTS: Partial<ReplayOverlaySettings> = {
  keypresses: { enabled: false, x: 0.035, y: 0.68, scale: 0.75 },
  kps: { enabled: false, x: 0.035, y: 0.77, scale: 0.75 },
  misses: { enabled: true, x: 0.085, y: 0.77, scale: 1 },
  accuracy: { enabled: true, x: 0.74, y: 0.02, scale: 1 },
  handAccuracy: { enabled: false, x: 0.03, y: 0.16, scale: 1 },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.74, y: 0.07, scale: 1.25 },
  progress: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
  // "leaderboard" postdates every legacy layout; matching the current
  // default makes the migration a no-op for it (same in the sets below).
  leaderboard: { enabled: true, x: 0, y: 0.24, scale: 1 },
};

const COMPACT_MISS_OVERLAY_DEFAULT: ReplayOverlayPlacement = { enabled: true, x: 0.085, y: 0.77, scale: 0.75 };

const OVERLAPPING_LEFT_CLUSTER_DEFAULTS: Partial<ReplayOverlaySettings> = {
  keypresses: { enabled: true, x: 0.05, y: 0.68, scale: 0.82 },
  kps: { enabled: true, x: 0.03, y: 0.68, scale: 0.82 },
  misses: { enabled: true, x: 0.05, y: 0.77, scale: 0.82 },
  accuracy: { enabled: true, x: 0.74, y: 0.02, scale: 1 },
  handAccuracy: { enabled: false, x: 0.03, y: 0.16, scale: 1 },
  // "pp" postdates these legacy layouts; matching the current default makes
  // the migration a no-op for it.
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.74, y: 0.07, scale: 1 },
  progress: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
  leaderboard: { enabled: true, x: 0, y: 0.24, scale: 1 },
};

const LEGACY_PLAYFIELD_OVERLAY_DEFAULTS: Partial<ReplayOverlaySettings> = {
  keypresses: { enabled: true, x: 0.22, y: 0.74, scale: 1 },
  kps: { enabled: true, x: 0.14, y: 0.74, scale: 1 },
  misses: { enabled: true, x: 0.22, y: 0.84, scale: 1 },
  accuracy: { enabled: true, x: 0.68, y: 0.02, scale: 1 },
  handAccuracy: { enabled: false, x: 0.03, y: 0.16, scale: 1 },
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

function normalizeCoord(value: unknown, fallback: number, min = 0): number {
  if (value === REPLAY_OVERLAY_ANCHORED_COORD) return REPLAY_OVERLAY_ANCHORED_COORD;
  return normalizeNumber(value, fallback, min, 1);
}

function normalizePlacement(value: unknown, fallback: ReplayOverlayPlacement, minX = 0): ReplayOverlayPlacement {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ReplayOverlayPlacement>
    : {};
  const reference = normalizeOverlayReference(raw.reference);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    x: normalizeCoord(raw.x, fallback.x, minX),
    y: normalizeCoord(raw.y, fallback.y),
    scale: normalizeNumber(raw.scale, fallback.scale, REPLAY_OVERLAY_MIN_SCALE, REPLAY_OVERLAY_MAX_SCALE),
    ...(reference ? { reference } : {}),
  };
}

function normalizeOverlayReference(value: unknown): ReplayOverlayReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { width, height, playfieldX, playfieldWidth, hudScale, spacingScale } = value as ReplayOverlayReference;
  if (![width, height, playfieldX, playfieldWidth, hudScale].every((number) => typeof number === "number" && Number.isFinite(number))) return undefined;
  if (width <= 0 || height <= 0 || playfieldX < 0 || playfieldWidth <= 0
    || playfieldX + playfieldWidth > width + 0.001 || hudScale <= 0) return undefined;
  if (spacingScale !== undefined && (typeof spacingScale !== "number" || !Number.isFinite(spacingScale) || spacingScale <= 0)) return undefined;
  return { width, height, playfieldX, playfieldWidth, hudScale, ...(spacingScale === undefined ? {} : { spacingScale }) };
}

function placementMatches(a: ReplayOverlayPlacement, b: ReplayOverlayPlacement | undefined): boolean {
  return !a.reference && b !== undefined && a.enabled === b.enabled
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
    if (id === "handAccuracy") {
      const rawStyle = raw[id] && typeof raw[id] === "object" ? (raw[id] as { style?: unknown }).style : undefined;
      placement.style = normalizeReplayHandAccuracyStyle(rawStyle);
    }
    if (id === "misses") {
      const rawStyle = raw[id] && typeof raw[id] === "object" ? (raw[id] as { style?: unknown }).style : undefined;
      placement.style = normalizeReplayMissStyle(rawStyle);
    }
    if (id === "replayMaster") {
      const rawSpeed = raw[id] && typeof raw[id] === "object" ? (raw[id] as { scrollSpeed?: unknown }).scrollSpeed : undefined;
      placement.scrollSpeed = normalizeReplayMasterScrollSpeed(rawSpeed);
      placement.transparentBackground = (raw[id] as { transparentBackground?: unknown } | undefined)?.transparentBackground === true;
    }
    settings[id] = placementMatches(placement, LEGACY_PLAYFIELD_OVERLAY_DEFAULTS[id])
      || placementMatches(placement, OVERLAPPING_LEFT_CLUSTER_DEFAULTS[id])
      || placementMatches(placement, PRE_INGAME_HUD_DEFAULTS[id])
      || placementMatches(placement, SCORE_BLOCK_HUD_DEFAULTS[id])
      || (id === "misses" && placementMatches(placement, COMPACT_MISS_OVERLAY_DEFAULT))
      || (id === "accuracy" && PREVIOUS_ACCURACY_OVERLAY_DEFAULTS.some((previous) => placementMatches(placement, previous)))
      ? { ...DEFAULT_REPLAY_OVERLAY_SETTINGS[id], ...(placement.style ? { style: placement.style } : {}) }
      : placement;
    if (id === "leaderboard") {
      // Old settings had one placement for both modes. Seed lazer from it
      // before stable's left-edge clamp, then persist the two independently.
      const legacy = normalizePlacement(raw[id], DEFAULT_REPLAY_OVERLAY_SETTINGS[id], REPLAY_LEADERBOARD_MIN_X);
      const savedLazer = (raw[id] as ReplayOverlaySettings["leaderboard"] | undefined)?.lazerPosition;
      const { x, y, scale, reference } = normalizePlacement(savedLazer ?? legacy, legacy, REPLAY_LEADERBOARD_MIN_X);
      settings.leaderboard.lazerPosition = { x, y, scale, ...(reference ? { reference } : {}) };
    }
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
