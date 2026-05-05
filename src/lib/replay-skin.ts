export const REPLAY_SKIN_STORAGE_KEY = "mania-hub-replay-skin-v1";
export const REPLAY_SKIN_PRESETS_STORAGE_KEY = "mania-hub-replay-skin-presets-v1";

export type ReplaySkinStyle = "bars" | "circles" | "arrows";

export interface ReplaySkinImageAsset {
  name: string;
  src: string;
  path?: string;
  width?: number;
  height?: number;
  scale?: number;
}

export interface ReplaySkinColumnAssets {
  tap?: ReplaySkinImageAsset;
  lnHead?: ReplaySkinImageAsset;
  lnBody?: ReplaySkinImageAsset;
  lnTail?: ReplaySkinImageAsset;
  receptor?: ReplaySkinImageAsset;
  receptorPressed?: ReplaySkinImageAsset;
}

export interface ReplaySkinJudgementAssets {
  hit0?: ReplaySkinImageAsset;
  hit50?: ReplaySkinImageAsset;
  hit100?: ReplaySkinImageAsset;
  hit200?: ReplaySkinImageAsset;
  hit300?: ReplaySkinImageAsset;
  hit300g?: ReplaySkinImageAsset;
}

export interface ReplaySkinComboAssets {
  prefix: string;
  overlap: number;
  digits: Array<ReplaySkinImageAsset | null>;
  x?: ReplaySkinImageAsset;
}

export interface ReplaySkinKeymodeAssets {
  columns: ReplaySkinColumnAssets[];
  judgements: ReplaySkinJudgementAssets;
  combo: ReplaySkinComboAssets | null;
}

export interface ReplaySkinKeymodeProfile {
  tapColor: string;
  tapColors: string[];
  lnHeadColor: string;
  lnHeadColors: string[];
  columnWidth: number;
  columnSpacing: number;
  columnWidths: number[];
  columnSpacings: number[];
  noteHeightScale: number;
  assets: ReplaySkinKeymodeAssets;
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
  keysUnderNotes: boolean;
  columnWidth: number;
  columnSpacing: number;
  noteHeightScale: number;
  hitPosition: number;
  scorePosition: number;
  comboPosition: number;
  keymodeProfiles: Record<string, ReplaySkinKeymodeProfile>;
}

export interface ReplaySkinPreset {
  id: string;
  name: string;
  settings: ReplaySkinSettings;
  createdAt: number;
  updatedAt: number;
}

export interface ReplaySkinSharePayload {
  type: "mania-hub-replay-settings";
  version: 1;
  name: string;
  settings: ReplaySkinSettings;
}

export const REPLAY_SKIN_MAX_COLUMNS = 10;
export const REPLAY_SKIN_MIN_COLUMN_WIDTH = 20;
export const REPLAY_SKIN_MAX_COLUMN_WIDTH = 160;
export const REPLAY_SKIN_DEFAULT_COLUMN_WIDTH = 50;
export const REPLAY_SKIN_MIN_COLUMN_SPACING = 0;
export const REPLAY_SKIN_MAX_COLUMN_SPACING = 40;
export const REPLAY_SKIN_DEFAULT_COLUMN_SPACING = 0;
export const REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE = 10;
export const REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE = 200;
export const REPLAY_SKIN_DEFAULT_HIT_POSITION = 110;
export const OSU_MANIA_DEFAULT_SCORE_POSITION = 206;
export const OSU_MANIA_DEFAULT_COMBO_POSITION = 177;
export const OSU_MANIA_MIN_HIT_POSITION = 0;
export const OSU_MANIA_MAX_HIT_POSITION = 480;
const OSU_MANIA_COORDINATE_SCALE = 768 / 480;

export const EMPTY_REPLAY_SKIN_ASSETS: ReplaySkinKeymodeAssets = {
  columns: [],
  judgements: {},
  combo: null,
};

export const DEFAULT_REPLAY_SKIN_PROFILE: ReplaySkinKeymodeProfile = {
  tapColor: "#9cf2ae",
  tapColors: [],
  lnHeadColor: "#dfffe6",
  lnHeadColors: [],
  columnWidth: REPLAY_SKIN_DEFAULT_COLUMN_WIDTH,
  columnSpacing: REPLAY_SKIN_DEFAULT_COLUMN_SPACING,
  columnWidths: [],
  columnSpacings: [],
  noteHeightScale: REPLAY_SKIN_DEFAULT_COLUMN_WIDTH,
  assets: EMPTY_REPLAY_SKIN_ASSETS,
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
  keysUnderNotes: false,
  columnWidth: DEFAULT_REPLAY_SKIN_PROFILE.columnWidth,
  columnSpacing: DEFAULT_REPLAY_SKIN_PROFILE.columnSpacing,
  noteHeightScale: DEFAULT_REPLAY_SKIN_PROFILE.noteHeightScale,
  hitPosition: REPLAY_SKIN_DEFAULT_HIT_POSITION,
  scorePosition: osuManiaStagePositionToReplayPosition(OSU_MANIA_DEFAULT_SCORE_POSITION),
  comboPosition: osuManiaStagePositionToReplayPosition(OSU_MANIA_DEFAULT_COMBO_POSITION),
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

function normalizeColumnSpacing(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_REPLAY_SKIN_PROFILE.columnSpacing;
  return Math.max(REPLAY_SKIN_MIN_COLUMN_SPACING, Math.min(REPLAY_SKIN_MAX_COLUMN_SPACING, Math.round(parsed)));
}

function normalizeNumberList(value: unknown, min: number, max: number, limit = REPLAY_SKIN_MAX_COLUMNS): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((entry) => Math.round(Number(entry)))
    .filter((entry) => Number.isFinite(entry))
    .map((entry) => Math.max(min, Math.min(max, entry)));
}

function normalizeNoteHeightScale(value: unknown, fallback = DEFAULT_REPLAY_SKIN_PROFILE.noteHeightScale): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const source = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE, Math.min(REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE, Math.round(source)));
}

function normalizeHitPosition(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return REPLAY_SKIN_DEFAULT_HIT_POSITION;
  return Math.max(0, Math.min(768, Math.round(parsed)));
}

export function osuManiaStagePositionToReplayPosition(position: number): number {
  const normalized = Math.max(OSU_MANIA_MIN_HIT_POSITION, Math.min(OSU_MANIA_MAX_HIT_POSITION, Math.round(position)));
  return Math.round((OSU_MANIA_MAX_HIT_POSITION - normalized) * OSU_MANIA_COORDINATE_SCALE);
}

export function replayStagePositionToOsuManiaPosition(position: number): number {
  const normalized = normalizeHitPosition(position);
  return Math.round(OSU_MANIA_MAX_HIT_POSITION - (normalized / OSU_MANIA_COORDINATE_SCALE));
}

export const osuManiaHitPositionToReplayHitPosition = osuManiaStagePositionToReplayPosition;
export const replayHitPositionToOsuManiaHitPosition = replayStagePositionToOsuManiaPosition;

function normalizeImageAsset(value: unknown): ReplaySkinImageAsset | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<Record<keyof ReplaySkinImageAsset, unknown>>;
  const src = typeof raw.src === "string" && raw.src.startsWith("data:image/") ? raw.src : null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 160) : null;
  if (!src || !name) return undefined;
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  const scale = Number(raw.scale);
  return {
    name,
    src,
    path: typeof raw.path === "string" && raw.path.trim() ? raw.path.trim().slice(0, 320) : undefined,
    width: Number.isFinite(width) && width > 0 ? Math.min(4096, width) : undefined,
    height: Number.isFinite(height) && height > 0 ? Math.min(4096, height) : undefined,
    scale: Number.isFinite(scale) && scale > 0 ? Math.min(4, scale) : undefined,
  };
}

function normalizeColumnAsset(value: unknown): ReplaySkinColumnAssets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Partial<Record<keyof ReplaySkinColumnAssets, unknown>>;
  const normalized: ReplaySkinColumnAssets = {};
  const tap = normalizeImageAsset(raw.tap);
  const lnHead = normalizeImageAsset(raw.lnHead);
  const lnBody = normalizeImageAsset(raw.lnBody);
  const lnTail = normalizeImageAsset(raw.lnTail);
  const receptor = normalizeImageAsset(raw.receptor);
  const receptorPressed = normalizeImageAsset(raw.receptorPressed);
  if (tap) normalized.tap = tap;
  if (lnHead) normalized.lnHead = lnHead;
  if (lnBody) normalized.lnBody = lnBody;
  if (lnTail) normalized.lnTail = lnTail;
  if (receptor) normalized.receptor = receptor;
  if (receptorPressed) normalized.receptorPressed = receptorPressed;
  return normalized;
}

function normalizeJudgementAssets(value: unknown): ReplaySkinJudgementAssets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Partial<Record<keyof ReplaySkinJudgementAssets, unknown>>;
  const normalized: ReplaySkinJudgementAssets = {};
  for (const key of ["hit0", "hit50", "hit100", "hit200", "hit300", "hit300g"] as const) {
    const asset = normalizeImageAsset(raw[key]);
    if (asset) normalized[key] = asset;
  }
  return normalized;
}

function normalizeComboAssets(value: unknown): ReplaySkinComboAssets | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<Record<keyof ReplaySkinComboAssets, unknown>>;
  const prefix = typeof raw.prefix === "string" && raw.prefix.trim() ? raw.prefix.trim().slice(0, 160) : "combo";
  const overlap = Math.max(-80, Math.min(80, Math.round(Number(raw.overlap) || 0)));
  const digits = Array.isArray(raw.digits)
    ? raw.digits.slice(0, 10).map((asset) => normalizeImageAsset(asset) ?? null)
    : [];
  while (digits.length < 10) digits.push(null);
  const x = normalizeImageAsset(raw.x);
  if (!digits.some(Boolean) && !x) return null;
  return { prefix, overlap, digits, x };
}

function normalizeKeymodeAssets(value: unknown): ReplaySkinKeymodeAssets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_REPLAY_SKIN_ASSETS;
  const raw = value as Partial<Record<keyof ReplaySkinKeymodeAssets, unknown>>;
  return {
    columns: Array.isArray(raw.columns)
      ? raw.columns.slice(0, REPLAY_SKIN_MAX_COLUMNS).map(normalizeColumnAsset)
      : [],
    judgements: normalizeJudgementAssets(raw.judgements),
    combo: normalizeComboAssets(raw.combo),
  };
}

function normalizeKeymodeProfile(value: unknown, fallback?: Partial<ReplaySkinKeymodeProfile>, persistedVersion = 2): ReplaySkinKeymodeProfile {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof ReplaySkinKeymodeProfile, unknown>>
    : {};
  const columnWidth = normalizeColumnWidth(raw.columnWidth ?? fallback?.columnWidth, persistedVersion);
  const columnWidths = normalizeNumberList(raw.columnWidths, REPLAY_SKIN_MIN_COLUMN_WIDTH, REPLAY_SKIN_MAX_COLUMN_WIDTH);
  const smallestColumnWidth = columnWidths.length > 0 ? Math.min(...columnWidths) : columnWidth;
  return {
    tapColor: normalizeHexColor(raw.tapColor) ?? fallback?.tapColor ?? DEFAULT_REPLAY_SKIN_PROFILE.tapColor,
    tapColors: normalizeColumnColors(raw.tapColors),
    lnHeadColor: normalizeHexColor(raw.lnHeadColor) ?? fallback?.lnHeadColor ?? DEFAULT_REPLAY_SKIN_PROFILE.lnHeadColor,
    lnHeadColors: normalizeColumnColors(raw.lnHeadColors),
    columnWidth,
    columnSpacing: normalizeColumnSpacing(raw.columnSpacing ?? fallback?.columnSpacing),
    columnWidths,
    columnSpacings: normalizeNumberList(raw.columnSpacings, REPLAY_SKIN_MIN_COLUMN_SPACING, REPLAY_SKIN_MAX_COLUMN_SPACING),
    noteHeightScale: normalizeNoteHeightScale(raw.noteHeightScale ?? fallback?.noteHeightScale, smallestColumnWidth),
    assets: normalizeKeymodeAssets(raw.assets),
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
    columnSpacing: normalized.columnSpacing,
    columnWidths: [],
    columnSpacings: [],
    noteHeightScale: normalized.noteHeightScale,
    assets: EMPTY_REPLAY_SKIN_ASSETS,
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
    columnSpacing: raw.columnSpacing,
    noteHeightScale: raw.noteHeightScale,
  }, undefined, persistedVersion);
  return {
    version: 2,
    style: raw.style === "circles" || raw.style === "bars" || raw.style === "arrows"
      ? raw.style
      : DEFAULT_REPLAY_SKIN_SETTINGS.style,
    tapColor: fallbackProfile.tapColor,
    tapColors: fallbackProfile.tapColors,
    lnHeadColor: fallbackProfile.lnHeadColor,
    lnHeadColors: fallbackProfile.lnHeadColors,
    lnBodyColor: normalizeHexColor(raw.lnBodyColor) ?? DEFAULT_REPLAY_SKIN_SETTINGS.lnBodyColor,
    percy: typeof raw.percy === "boolean" ? raw.percy : DEFAULT_REPLAY_SKIN_SETTINGS.percy,
    upscroll: typeof raw.upscroll === "boolean" ? raw.upscroll : DEFAULT_REPLAY_SKIN_SETTINGS.upscroll,
    keysUnderNotes: typeof raw.keysUnderNotes === "boolean" ? raw.keysUnderNotes : DEFAULT_REPLAY_SKIN_SETTINGS.keysUnderNotes,
    columnWidth: fallbackProfile.columnWidth,
    columnSpacing: fallbackProfile.columnSpacing,
    noteHeightScale: fallbackProfile.noteHeightScale,
    hitPosition: normalizeHitPosition(raw.hitPosition),
    scorePosition: normalizeHitPosition(raw.scorePosition ?? DEFAULT_REPLAY_SKIN_SETTINGS.scorePosition),
    comboPosition: normalizeHitPosition(raw.comboPosition ?? DEFAULT_REPLAY_SKIN_SETTINGS.comboPosition),
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

function normalizePresetName(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, 80) : "Untitled preset";
}

function normalizePreset(value: unknown): ReplaySkinPreset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<Record<keyof ReplaySkinPreset, unknown>>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 80) : cryptoRandomId();
  const createdAt = Math.max(0, Math.round(Number(raw.createdAt) || Date.now()));
  const updatedAt = Math.max(createdAt, Math.round(Number(raw.updatedAt) || createdAt));
  return {
    id,
    name: normalizePresetName(raw.name),
    settings: normalizeReplaySkinSettings(raw.settings),
    createdAt,
    updatedAt,
  };
}

export function readReplaySkinPresets(): ReplaySkinPreset[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(REPLAY_SKIN_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizePreset)
      .filter((preset): preset is ReplaySkinPreset => preset != null)
      .slice(0, 24);
  } catch (error) {
    console.warn("[replay] failed to read replay skin presets", error);
    return [];
  }
}

export function writeReplaySkinPresets(presets: ReplaySkinPreset[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      REPLAY_SKIN_PRESETS_STORAGE_KEY,
      JSON.stringify(presets.map(normalizePreset).filter(Boolean).slice(0, 24)),
    );
  } catch (error) {
    console.warn("[replay] failed to write replay skin presets", error);
  }
}

export function createReplaySkinPreset(name: string, settings: ReplaySkinSettings): ReplaySkinPreset {
  const now = Date.now();
  return {
    id: cryptoRandomId(),
    name: normalizePresetName(name),
    settings: normalizeReplaySkinSettings(settings),
    createdAt: now,
    updatedAt: now,
  };
}

function compactKeymodeProfile(profile: ReplaySkinKeymodeProfile): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (profile.tapColor !== DEFAULT_REPLAY_SKIN_PROFILE.tapColor) out.tapColor = profile.tapColor;
  if (profile.tapColors.some((color) => color)) out.tapColors = profile.tapColors;
  if (profile.lnHeadColor !== DEFAULT_REPLAY_SKIN_PROFILE.lnHeadColor) out.lnHeadColor = profile.lnHeadColor;
  if (profile.lnHeadColors.some((color) => color)) out.lnHeadColors = profile.lnHeadColors;
  if (profile.columnWidth !== DEFAULT_REPLAY_SKIN_PROFILE.columnWidth) out.columnWidth = profile.columnWidth;
  if (profile.columnSpacing !== DEFAULT_REPLAY_SKIN_PROFILE.columnSpacing) out.columnSpacing = profile.columnSpacing;
  if (profile.columnWidths.length > 0) out.columnWidths = profile.columnWidths;
  if (profile.columnSpacings.length > 0) out.columnSpacings = profile.columnSpacings;
  if (profile.noteHeightScale !== DEFAULT_REPLAY_SKIN_PROFILE.noteHeightScale) out.noteHeightScale = profile.noteHeightScale;
  const hasAssets = profile.assets.columns.length > 0
    || profile.assets.combo !== null
    || Object.keys(profile.assets.judgements).length > 0;
  if (hasAssets) out.assets = profile.assets;
  return Object.keys(out).length > 0 ? out : null;
}

function compactReplaySkinSettings(settings: ReplaySkinSettings): Record<string, unknown> {
  const def = DEFAULT_REPLAY_SKIN_SETTINGS;
  const out: Record<string, unknown> = {};
  if (settings.style !== def.style) out.style = settings.style;
  if (settings.tapColor !== def.tapColor) out.tapColor = settings.tapColor;
  if (settings.tapColors.some((color) => color)) out.tapColors = settings.tapColors;
  if (settings.lnHeadColor !== def.lnHeadColor) out.lnHeadColor = settings.lnHeadColor;
  if (settings.lnHeadColors.some((color) => color)) out.lnHeadColors = settings.lnHeadColors;
  if (settings.lnBodyColor !== def.lnBodyColor) out.lnBodyColor = settings.lnBodyColor;
  if (settings.percy !== def.percy) out.percy = settings.percy;
  if (settings.upscroll !== def.upscroll) out.upscroll = settings.upscroll;
  if (settings.keysUnderNotes !== def.keysUnderNotes) out.keysUnderNotes = settings.keysUnderNotes;
  if (settings.columnWidth !== def.columnWidth) out.columnWidth = settings.columnWidth;
  if (settings.columnSpacing !== def.columnSpacing) out.columnSpacing = settings.columnSpacing;
  if (settings.noteHeightScale !== def.noteHeightScale) out.noteHeightScale = settings.noteHeightScale;
  if (settings.hitPosition !== def.hitPosition) out.hitPosition = settings.hitPosition;
  if (settings.scorePosition !== def.scorePosition) out.scorePosition = settings.scorePosition;
  if (settings.comboPosition !== def.comboPosition) out.comboPosition = settings.comboPosition;
  const profiles: Record<string, unknown> = {};
  for (const [key, profile] of Object.entries(settings.keymodeProfiles)) {
    const compact = compactKeymodeProfile(profile);
    if (compact) profiles[key] = compact;
  }
  if (Object.keys(profiles).length > 0) out.keymodeProfiles = profiles;
  return out;
}

export function createReplaySkinShareKey(name: string, settings: ReplaySkinSettings): string {
  const normalized = normalizeReplaySkinSettings(settings);
  const payload = {
    n: normalizePresetName(name),
    s: compactReplaySkinSettings(normalized),
  };
  return `mhreplay2.${encodeBase64Url(JSON.stringify(payload))}`;
}

export function parseReplaySkinShareKey(key: string): ReplaySkinSharePayload | null {
  const trimmed = key.trim();
  if (trimmed.startsWith("mhreplay2.")) {
    try {
      const parsed = JSON.parse(decodeBase64Url(trimmed.slice("mhreplay2.".length)));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const raw = parsed as { n?: unknown; s?: unknown };
      return {
        type: "mania-hub-replay-settings",
        version: 1,
        name: normalizePresetName(raw.n),
        settings: normalizeReplaySkinSettings(raw.s ?? {}),
      };
    } catch {
      return null;
    }
  }
  const legacy = trimmed.startsWith("mhreplay1.")
    ? trimmed.slice("mhreplay1.".length)
    : trimmed;
  try {
    const parsed = JSON.parse(decodeBase64Url(legacy));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const payload = parsed as Partial<ReplaySkinSharePayload>;
    if (payload.type !== "mania-hub-replay-settings") return null;
    return {
      type: "mania-hub-replay-settings",
      version: 1,
      name: normalizePresetName(payload.name),
      settings: normalizeReplaySkinSettings(payload.settings),
    };
  } catch {
    return null;
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
