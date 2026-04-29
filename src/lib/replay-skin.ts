export const REPLAY_SKIN_STORAGE_KEY = "mania-hub-replay-skin-v1";

export type ReplaySkinStyle = "bars" | "circles";

export interface ReplaySkinSettings {
  version: 1;
  style: ReplaySkinStyle;
  tapColor: string;
  lnHeadColor: string;
  lnBodyColor: string;
  percy: boolean;
}

export const DEFAULT_REPLAY_SKIN_SETTINGS: ReplaySkinSettings = {
  version: 1,
  style: "bars",
  tapColor: "#9cf2ae",
  lnHeadColor: "#dfffe6",
  lnBodyColor: "#8b8b93",
  percy: false,
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

export function normalizeReplaySkinSettings(value: unknown): ReplaySkinSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_REPLAY_SKIN_SETTINGS;
  }

  const raw = value as Partial<Record<keyof ReplaySkinSettings, unknown>>;
  return {
    version: 1,
    style: raw.style === "circles" || raw.style === "bars"
      ? raw.style
      : DEFAULT_REPLAY_SKIN_SETTINGS.style,
    tapColor: normalizeHexColor(raw.tapColor) ?? DEFAULT_REPLAY_SKIN_SETTINGS.tapColor,
    lnHeadColor: normalizeHexColor(raw.lnHeadColor) ?? DEFAULT_REPLAY_SKIN_SETTINGS.lnHeadColor,
    lnBodyColor: normalizeHexColor(raw.lnBodyColor) ?? DEFAULT_REPLAY_SKIN_SETTINGS.lnBodyColor,
    percy: typeof raw.percy === "boolean" ? raw.percy : DEFAULT_REPLAY_SKIN_SETTINGS.percy,
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
