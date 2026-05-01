export const REPLAY_SKIN_STORAGE_KEY = "mania-hub-replay-skin-v1";

export type ReplaySkinStyle = "bars" | "circles";

export interface ReplaySkinKeymodeProfile {
  tapColor: string;
  tapColors: string[];
  lnHeadColor: string;
  lnHeadColors: string[];
  columnWidth: number;
}

export interface ReplaySkinSettings {
  version: 2;
  style: ReplaySkinStyle;
  tapColor: string;
  tapColors: string[];
  lnHeadColor: string;
  lnHeadColors: string[];
  lnBodyColor: string;
  percy: boolean;
  upscroll: boolean;
  columnWidth: number;
  hitPosition: number;
  keymodeProfiles: Record<string, ReplaySkinKeymodeProfile>;
}

export const REPLAY_SKIN_MAX_COLUMNS = 10;
export const REPLAY_SKIN_MIN_COLUMN_WIDTH = 20;
export const REPLAY_SKIN_MAX_COLUMN_WIDTH = 160;
export const REPLAY_SKIN_DEFAULT_COLUMN_WIDTH = 50;
export const REPLAY_SKIN_DEFAULT_HIT_POSITION = 110;
export const OSU_MANIA_MIN_HIT_POSITION = 0;
export const OSU_MANIA_MAX_HIT_POSITION = 480;
const OSU_MANIA_COORDINATE_SCALE = 768 / 480;

export const DEFAULT_REPLAY_SKIN_PROFILE: ReplaySkinKeymodeProfile = {
  tapColor: "#9cf2ae",
  tapColors: [],
  lnHeadColor: "#dfffe6",
  lnHeadColors: [],
  columnWidth: REPLAY_SKIN_DEFAULT_COLUMN_WIDTH,
};

export const DEFAULT_REPLAY_SKIN_SETTINGS: ReplaySkinSettings = {
  version: 2,
  style: "bars",
  tapColor: DEFAULT_REPLAY_SKIN_PROFILE.tapColor,
  tapColors: [],
  lnHeadColor: DEFAULT_REPLAY_SKIN_PROFILE.lnHeadColor,
  lnHeadColors: [],
  lnBodyColor: "#8b8b93",
  percy: false,
  upscroll: false,
  columnWidth: DEFAULT_REPLAY_SKIN_PROFILE.columnWidth,
  hitPosition: REPLAY_SKIN_DEFAULT_HIT_POSITION,
  keymodeProfiles: {},
};

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    return `#${short[1].split("").map((c) => c + c).join("").toLowerCase()}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

function normalizeColumnColors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, REPLAY_SKIN_MAX_COLUMNS)
    .map((color) => normalizeHexColor(color) ?? "")
    .map((color) => color || "");
}

function normalizeColumnWidth(value: unknown, persistedVersion = 2): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_REPLAY_SKIN_PROFILE.columnWidth;
  const migrated = persistedVersion < 2 ? parsed / 2 : parsed;
  return Math.max(REPLAY_SKIN_MIN_COLUMN_WIDTH, Math.min(REPLAY_SKIN_MAX_COLUMN_WIDTH, Math.round(migrated)));
}

function normalizeHitPosition(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return REPLAY_SKIN_DEFAULT_HIT_POSITION;
  return Math.max(0, Math.min(768, Math.round(parsed)));
}

export function osuManiaHitPositionToReplayHitPosition(hitPosition: number): number {
  const normalized = Math.max(OSU_MANIA_MIN_HIT_POSITION, Math.min(OSU_MANIA_MAX_HIT_POSITION, Math.round(hitPosition)));
  return Math.round((OSU_MANIA_MAX_HIT_POSITION - normalized) * OSU_MANIA_COORDINATE_SCALE);
}

export function replayHitPositionToOsuManiaHitPosition(hitPosition: number): number {
  const normalized = normalizeHitPosition(hitPosition);
  return Math.round(OSU_MANIA_MAX_HIT_POSITION - (normalized / OSU_MANIA_COORDINATE_SCALE));
}

function normalizeKeymodeProfile(value: unknown, fallback?: Partial<ReplaySkinKeymodeProfile>, persistedVersion = 2): ReplaySkinKeymodeProfile {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof ReplaySkinKeymodeProfile, unknown>>
    : {};
  return {
    tapColor: normalizeHexColor(raw.tapColor) ?? fallback?.tapColor ?? DEFAULT_REPLAY_SKIN_PROFILE.tapColor,
    tapColors: normalizeColumnColors(raw.tapColors),
    lnHeadColor: normalizeHexColor(raw.lnHeadColor) ?? fallback?.lnHeadColor ?? DEFAULT_REPLAY_SKIN_PROFILE.lnHeadColor,
    lnHeadColors: normalizeColumnColors(raw.lnHeadColors),
    columnWidth: normalizeColumnWidth(raw.columnWidth ?? fallback?.columnWidth, persistedVersion),
  };
}

function normalizeKeymodeProfiles(value: unknown, fallback: ReplaySkinKeymodeProfile, persistedVersion: number): Record<string, ReplaySkinKeymodeProfile> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const profiles: Record<string, ReplaySkinKeymodeProfile> = {};
  for (const [key, profile] of Object.entries(value)) {
    const keyCount = Number(key);
    if (!Number.isInteger(keyCount) || keyCount < 1 || keyCount > REPLAY_SKIN_MAX_COLUMNS) continue;
    profiles[String(keyCount)] = normalizeKeymodeProfile(profile, fallback, persistedVersion);
  }
  return profiles;
}

export function getReplaySkinProfile(settings: ReplaySkinSettings, keyCount: number): ReplaySkinKeymodeProfile {
  const normalized = normalizeReplaySkinSettings(settings);
  const fallback = normalizeKeymodeProfile({
    tapColor: normalized.tapColor,
    tapColors: normalized.tapColors,
    lnHeadColor: normalized.lnHeadColor,
    lnHeadColors: normalized.lnHeadColors,
    columnWidth: normalized.columnWidth,
  });
  return normalized.keymodeProfiles[String(keyCount)] ?? fallback;
}

export function getReplaySkinColumnColor(
  settings: ReplaySkinSettings,
  kind: "tap" | "lnHead",
  column: number,
  keyCount = 4,
): string {
  const profile = getReplaySkinProfile(settings, keyCount);
  const colors = kind === "tap" ? profile.tapColors : profile.lnHeadColors;
  const fallback = kind === "tap" ? profile.tapColor : profile.lnHeadColor;
  return colors[column] || fallback;
}

export function normalizeReplaySkinSettings(value: unknown): ReplaySkinSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_REPLAY_SKIN_SETTINGS;
  }

  const raw = value as Partial<Record<keyof ReplaySkinSettings, unknown>>;
  const persistedVersion = raw.version === 1 ? 1 : 2;
  const fallbackProfile = normalizeKeymodeProfile({
    tapColor: raw.tapColor,
    tapColors: raw.tapColors,
    lnHeadColor: raw.lnHeadColor,
    lnHeadColors: raw.lnHeadColors,
    columnWidth: raw.columnWidth,
  }, undefined, persistedVersion);
  return {
    version: 2,
    style: raw.style === "circles" || raw.style === "bars"
      ? raw.style
      : DEFAULT_REPLAY_SKIN_SETTINGS.style,
    tapColor: fallbackProfile.tapColor,
    tapColors: fallbackProfile.tapColors,
    lnHeadColor: fallbackProfile.lnHeadColor,
    lnHeadColors: fallbackProfile.lnHeadColors,
    lnBodyColor: normalizeHexColor(raw.lnBodyColor) ?? DEFAULT_REPLAY_SKIN_SETTINGS.lnBodyColor,
    percy: typeof raw.percy === "boolean" ? raw.percy : DEFAULT_REPLAY_SKIN_SETTINGS.percy,
    upscroll: typeof raw.upscroll === "boolean" ? raw.upscroll : DEFAULT_REPLAY_SKIN_SETTINGS.upscroll,
    columnWidth: fallbackProfile.columnWidth,
    hitPosition: normalizeHitPosition(raw.hitPosition),
    keymodeProfiles: normalizeKeymodeProfiles(raw.keymodeProfiles, fallbackProfile, persistedVersion),
  };
}

export function readReplaySkinSettings(): ReplaySkinSettings {
  if (typeof window === "undefined") return DEFAULT_REPLAY_SKIN_SETTINGS;

  try {
    const raw = window.localStorage.getItem(REPLAY_SKIN_STORAGE_KEY);
    if (!raw) return DEFAULT_REPLAY_SKIN_SETTINGS;
    return normalizeReplaySkinSettings(JSON.parse(raw));
  } catch (error) {
    console.warn("[replay] failed to read replay skin settings", error);
    return DEFAULT_REPLAY_SKIN_SETTINGS;
  }
}

export function writeReplaySkinSettings(settings: ReplaySkinSettings): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      REPLAY_SKIN_STORAGE_KEY,
      JSON.stringify(normalizeReplaySkinSettings(settings)),
    );
  } catch (error) {
    console.warn("[replay] failed to write replay skin settings", error);
  }
}
