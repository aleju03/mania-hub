export const REPLAY_OVERLAY_SETTINGS_STORAGE_KEY = "mania-hub-replay-overlays";
export const REPLAY_OVERLAY_SETTINGS_CHANGE_EVENT = "mania-hub:replay-overlay-settings-change";

export const REPLAY_OVERLAY_IDS = ["keypresses", "kps", "misses", "accuracy", "pp", "judgements", "progress"] as const;

export type ReplayOverlayId = typeof REPLAY_OVERLAY_IDS[number];

export interface ReplayOverlayPlacement {
  enabled: boolean;
  x: number;
  y: number;
  scale: number;
}

export type ReplayOverlaySettings = Record<ReplayOverlayId, ReplayOverlayPlacement>;

export const REPLAY_OVERLAY_MIN_SCALE = 0.5;
export const REPLAY_OVERLAY_MAX_SCALE = 2.5;

export const DEFAULT_REPLAY_OVERLAY_SETTINGS: ReplayOverlaySettings = {
  keypresses: { enabled: false, x: 0.035, y: 0.68, scale: 0.75 },
  kps: { enabled: false, x: 0.035, y: 0.77, scale: 0.75 },
  misses: { enabled: true, x: 0.085, y: 0.77, scale: 1 },
  accuracy: { enabled: true, x: 0.74, y: 0.02, scale: 1 },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.74, y: 0.07, scale: 1.25 },
  progress: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
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
};

const LEGACY_PLAYFIELD_OVERLAY_DEFAULTS: ReplayOverlaySettings = {
  keypresses: { enabled: true, x: 0.22, y: 0.74, scale: 1 },
  kps: { enabled: true, x: 0.14, y: 0.74, scale: 1 },
  misses: { enabled: true, x: 0.22, y: 0.84, scale: 1 },
  accuracy: { enabled: true, x: 0.68, y: 0.02, scale: 1 },
  pp: { enabled: false, x: 0.88, y: 0.02, scale: 1 },
  judgements: { enabled: true, x: 0.68, y: 0.07, scale: 1 },
  progress: { enabled: true, x: 0.03, y: 0.03, scale: 1 },
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
      || (id === "misses" && placementMatches(placement, COMPACT_MISS_OVERLAY_DEFAULT))
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
