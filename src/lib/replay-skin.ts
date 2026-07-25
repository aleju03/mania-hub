export const REPLAY_SKIN_STORAGE_KEY = "mania-hub-replay-skin-v1";
export const REPLAY_SKIN_PRESETS_STORAGE_KEY = "mania-hub-replay-skin-presets-v1";

export type ReplaySkinStyle = "bars" | "circles" | "arrows";
export type ReplayJudgementSet =
  | "skin"
  | "set01"
  | "set02"
  | "set03"
  | "set06"
  | "set07"
  | "set08"
  | "set09"
  | "set10"
  | "set12"
  | "set14"
  | "set18"
  | "set19"
  | "set20"
  | "set23"
  | "set24"
  | "set25"
  | "set26"
  | "set27"
  | "set28"
  | "set29"
  | "set30"
  | "set31"
  | "set32"
  | "set34";
export type ReplayComboFontSet =
  | "set1"
  | "set2"
  | "set3"
  | "set4"
  | "set5"
  | "set6"
  | "set7"
  | "set8"
  | "set9"
  | "set10"
  | "set11"
  | "set12"
  | "set13"
  | "set14"
  | "set15"
  | "set16"
  | "set17"
  | "set18"
  | "set19"
  | "set20"
  | "set21"
  | "set22"
  | "set23";

export interface ReplayComboFontStyle {
  family: string;
  weight: "300" | "400" | "500" | "600" | "700" | "800" | "900";
  style?: "normal" | "italic";
}

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

// The stage furniture skin.ini declares per keymode: the frame either side of
// the columns, the deck under them, the hit-position hint, the column light
// that flashes under a pressed key, and the hit glow. Skins like RESIDENT are
// mostly this art, so a playfield drawn without it barely resembles them.
export interface ReplaySkinStageAssets {
  left?: ReplaySkinImageAsset;
  right?: ReplaySkinImageAsset;
  bottom?: ReplaySkinImageAsset;
  hint?: ReplaySkinImageAsset;
  light?: ReplaySkinImageAsset;
  lighting?: ReplaySkinImageAsset;
  // skin.ini LightingNWidth, per column, in 480-space units. Empty means the
  // key was absent and the glow keeps the art's own width.
  lightingWidths: number[];
  // skin.ini ColourLight{n} as #rrggbb, the tint for the column light.
  lightColors: string[];
}

export interface ReplaySkinKeymodeAssets {
  columns: ReplaySkinColumnAssets[];
  judgements: ReplaySkinJudgementAssets;
  combo: ReplaySkinComboAssets | null;
  stage: ReplaySkinStageAssets;
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
  // skin.ini ColumnLineWidth: keys+1 boundary line widths in 480-space units
  // (outer edges included). Empty means the key was absent, which in stable
  // falls back to 2-unit lines at every boundary.
  columnLineWidths: number[];
  // skin.ini ColourColumnLine as #rrggbb or #rrggbbaa; "" means skin default
  // (opaque white).
  columnLineColor: string;
  // skin.ini Colour{n}: the column BACKGROUND, as #rrggbb or #rrggbbaa. Kept
  // apart from the note palette on purpose - skins routinely set these black,
  // and feeding them to the flat-fallback notes made those invisible. "" means
  // the skin said nothing, so the playfield default applies.
  columnBackgrounds: string[];
  // skin.ini JudgementLine: the white line at HitPosition. Circle/arrow skins
  // almost always turn it off; stable defaults it on.
  judgementLine: boolean;
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
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidth: number;
  percy: boolean;
  upscroll: boolean;
  columnWidth: number;
  columnSpacing: number;
  noteHeightScale: number;
  hitPosition: number;
  scorePosition: number;
  comboPosition: number;
  comboFontSet: ReplayComboFontSet;
  judgementSet: ReplayJudgementSet;
  judgementScale: number;
  judgementScales: Partial<Record<ReplayJudgementSet, number>>;
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
export const REPLAY_SKIN_MIN_OUTLINE_WIDTH = 1;
export const REPLAY_SKIN_MAX_OUTLINE_WIDTH = 8;
export const REPLAY_SKIN_DEFAULT_OUTLINE_WIDTH = 2;
export const REPLAY_SKIN_DEFAULT_HIT_POSITION = 110;
export const OSU_MANIA_DEFAULT_SCORE_POSITION = 206;
export const OSU_MANIA_DEFAULT_COMBO_POSITION = 177;
export const REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE = 100;
export const REPLAY_SKIN_MIN_JUDGEMENT_SCALE = 50;
export const REPLAY_SKIN_MAX_JUDGEMENT_SCALE = 250;
export const OSU_MANIA_MIN_HIT_POSITION = 0;
export const OSU_MANIA_MAX_HIT_POSITION = 480;
const OSU_MANIA_COORDINATE_SCALE = 768 / 480;

export const REPLAY_COMBO_FONT_SETS: ReplayComboFontSet[] = [
  "set1",
  "set2",
  "set3",
  "set4",
  "set6",
  "set7",
  "set8",
  "set9",
  "set10",
  "set11",
  "set13",
  "set14",
  "set15",
  "set16",
  "set17",
  "set18",
  "set22",
];

export const DEFAULT_REPLAY_COMBO_FONT_SET: ReplayComboFontSet = "set1";
export const DEFAULT_REPLAY_JUDGEMENT_SET: ReplayJudgementSet = "skin";

const REPLAY_COMBO_FONT_STYLES: Record<ReplayComboFontSet, ReplayComboFontStyle> = {
  set1: { family: "Torus, sans-serif", weight: "700" },
  set2: { family: "\"Fredoka One\", Fredoka, \"Baloo 2\", \"Arial Rounded MT Bold\", sans-serif", weight: "800" },
  set3: { family: "Roboto, Arial, sans-serif", weight: "700" },
  set4: { family: "Knewave, \"Comic Sans MS\", cursive", weight: "700" },
  set5: { family: "Torus, sans-serif", weight: "700" },
  set6: { family: "\"DSEG7 Classic\", \"Digital-7\", \"Courier New\", monospace", weight: "700" },
  set7: { family: "\"PT Sans\", \"Source Sans 3\", sans-serif", weight: "400" },
  set8: { family: "\"Courier New\", monospace", weight: "700" },
  set9: { family: "Lato, sans-serif", weight: "600" },
  set10: { family: "\"Nimbus Sans Narrow\", \"Arial Narrow\", Arial, sans-serif", weight: "700" },
  set11: { family: "Nunito, \"Fredoka One\", Fredoka, \"Arial Rounded MT Bold\", sans-serif", weight: "800" },
  set12: { family: "Torus, sans-serif", weight: "700" },
  set13: { family: "\"Roboto Condensed\", Roboto, Arial, sans-serif", weight: "300" },
  set14: { family: "GeosansLight, \"Century Gothic\", sans-serif", weight: "400" },
  set15: { family: "\"Open Sans\", \"Noto Sans\", sans-serif", weight: "800", style: "italic" },
  set16: { family: "Lato, \"DejaVu Sans Condensed\", sans-serif", weight: "700" },
  set17: { family: "\"Comic Sans MS\", \"Comic Neue\", cursive", weight: "700", style: "italic" },
  set18: { family: "Roboto, \"Helvetica Neue\", Arial, sans-serif", weight: "300" },
  set19: { family: "\"Fredoka One\", Fredoka, \"Arial Rounded MT Bold\", sans-serif", weight: "700" },
  set20: { family: "Roboto, \"Helvetica Neue\", Arial, sans-serif", weight: "300" },
  set21: { family: "\"PT Sans\", sans-serif", weight: "400" },
  set22: { family: "\"Noto Sans\", Lato, sans-serif", weight: "600" },
  set23: { family: "\"Noto Sans\", \"Open Sans\", sans-serif", weight: "600" },
};

export const REPLAY_JUDGEMENT_SETS: ReplayJudgementSet[] = [
  "set01",
  "set02",
  "set03",
  "set06",
  "set07",
  "set08",
  "set09",
  "set10",
  "set12",
  "set14",
  "set18",
  "set19",
  "set20",
  "set23",
  "set24",
  "set25",
  "set26",
  "set27",
  "set28",
  "set29",
  "set30",
  "set31",
  "set32",
  "set34",
];

const REPLAY_JUDGEMENT_SET_ASSETS: Record<Exclude<ReplayJudgementSet, "skin">, ReplaySkinJudgementAssets> = {
  set01: judgementSetAssets("01", ["hit0", "hit100", "hit200", "hit300", "hit50"]),
  set02: judgementSetAssets("02", ["hit0", "hit100", "hit200", "hit300", "hit50"]),
  set03: judgementSetAssets("03", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set06: judgementSetAssets("06", ["hit0", "hit100", "hit200", "hit300", "hit50"]),
  set07: judgementSetAssets("07", ["hit0", "hit100", "hit200", "hit300", "hit50"]),
  set08: judgementSetAssets("08", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set09: judgementSetAssets("09", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set10: judgementSetAssets("10", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set12: judgementSetAssets("12", ["hit0", "hit100", "hit200", "hit300", "hit50"]),
  set14: judgementSetAssets("14", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set18: judgementSetAssets("18", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set19: judgementSetAssets("19", ["hit0", "hit100", "hit200", "hit300", "hit50"]),
  set20: judgementSetAssets("20", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set23: judgementSetAssets("23", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set24: judgementSetAssets("24", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set25: judgementSetAssets("25", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set26: judgementSetAssets("26", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set27: judgementSetAssets("27", ["hit0", "hit100", "hit200", "hit300", "hit50"]),
  set28: judgementSetAssets("28", ["hit0", "hit100", "hit200", "hit300", "hit50"]),
  set29: judgementSetAssets("29", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set30: judgementSetAssets("30", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set31: judgementSetAssets("31", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set32: judgementSetAssets("32", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
  set34: judgementSetAssets("34", ["hit0", "hit100", "hit200", "hit300", "hit300g", "hit50"]),
};

export const EMPTY_REPLAY_SKIN_STAGE_ASSETS: ReplaySkinStageAssets = {
  lightingWidths: [],
  lightColors: [],
};

export const EMPTY_REPLAY_SKIN_ASSETS: ReplaySkinKeymodeAssets = {
  columns: [],
  judgements: {},
  combo: null,
  stage: EMPTY_REPLAY_SKIN_STAGE_ASSETS,
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
  columnLineWidths: [],
  columnLineColor: "",
  columnBackgrounds: [],
  judgementLine: true,
  noteHeightScale: REPLAY_SKIN_DEFAULT_COLUMN_WIDTH,
  assets: EMPTY_REPLAY_SKIN_ASSETS,
};

export const REPLAY_SKIN_MAX_COLUMN_LINE_WIDTH = 20;
// osu!stable draws 2-unit column lines at every boundary when a skin does not
// set ColumnLineWidth at all.
export const OSU_MANIA_DEFAULT_COLUMN_LINE_WIDTH = 2;

export const DEFAULT_REPLAY_SKIN_SETTINGS: ReplaySkinSettings = {
  version: 2,
  style: "circles",
  tapColor: DEFAULT_REPLAY_SKIN_PROFILE.tapColor,
  tapColors: [],
  lnHeadColor: DEFAULT_REPLAY_SKIN_PROFILE.lnHeadColor,
  lnHeadColors: [],
  lnBodyColor: "#8b8b93",
  outlineEnabled: false,
  outlineColor: "#ffffff",
  outlineWidth: REPLAY_SKIN_DEFAULT_OUTLINE_WIDTH,
  percy: true,
  upscroll: false,
  columnWidth: DEFAULT_REPLAY_SKIN_PROFILE.columnWidth,
  columnSpacing: DEFAULT_REPLAY_SKIN_PROFILE.columnSpacing,
  noteHeightScale: DEFAULT_REPLAY_SKIN_PROFILE.noteHeightScale,
  hitPosition: 48,
  scorePosition: osuManiaStagePositionToReplayPosition(OSU_MANIA_DEFAULT_SCORE_POSITION),
  comboPosition: osuManiaStagePositionToReplayPosition(OSU_MANIA_DEFAULT_COMBO_POSITION),
  comboFontSet: "set11",
  judgementSet: "set18",
  judgementScale: 102,
  judgementScales: {
    set09: 102,
    set10: 102,
    set08: 181,
    set12: 102,
    set06: 102,
    set18: 102,
    set02: 102,
    set26: 199,
    set30: 199,
  },
  keymodeProfiles: {
    4: {
      ...DEFAULT_REPLAY_SKIN_PROFILE,
      lnHeadColors: ["#e3a5de", "#e3a5de", "#e3a5de", "#e3a5de", "#e3a5de"],
      columnWidth: 75,
      columnSpacing: 2,
    },
  },
};

function judgementSetAssets(set: string, keys: Array<keyof ReplaySkinJudgementAssets>): ReplaySkinJudgementAssets {
  return keys.reduce<ReplaySkinJudgementAssets>((assets, key) => {
    assets[key] = {
      name: key,
      src: `/images/replay-judgements/set-${set}/${key}.webp`,
    };
    return assets;
  }, {});
}

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

// Column lines keep their skin.ini alpha, so #rrggbbaa is allowed here on top
// of the #rrggbb the other colour fields use.
function normalizeLineColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(trimmed) ? trimmed : "";
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

function normalizeOutlineWidth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const source = Number.isFinite(parsed) ? parsed : REPLAY_SKIN_DEFAULT_OUTLINE_WIDTH;
  return Math.max(REPLAY_SKIN_MIN_OUTLINE_WIDTH, Math.min(REPLAY_SKIN_MAX_OUTLINE_WIDTH, Math.round(source)));
}

function normalizeJudgementScale(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const source = Number.isFinite(parsed) ? parsed : REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE;
  return Math.max(REPLAY_SKIN_MIN_JUDGEMENT_SCALE, Math.min(REPLAY_SKIN_MAX_JUDGEMENT_SCALE, Math.round(source)));
}

function normalizeJudgementScales(value: unknown): Partial<Record<ReplayJudgementSet, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<ReplayJudgementSet, number>> = {};
  for (const [set, scale] of Object.entries(value)) {
    const normalizedSet = normalizeReplayJudgementSet(set);
    if (normalizedSet !== set) continue;
    const normalizedScale = normalizeJudgementScale(scale);
    if (normalizedScale !== REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE) {
      out[normalizedSet] = normalizedScale;
    }
  }
  return out;
}

function normalizeHitPosition(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return REPLAY_SKIN_DEFAULT_HIT_POSITION;
  return Math.max(0, Math.min(768, Math.round(parsed)));
}

function normalizeReplayComboFontSet(value: unknown): ReplayComboFontSet {
  return typeof value === "string" && REPLAY_COMBO_FONT_SETS.includes(value as ReplayComboFontSet)
    ? value as ReplayComboFontSet
    : DEFAULT_REPLAY_COMBO_FONT_SET;
}

function normalizeReplayJudgementSet(value: unknown): ReplayJudgementSet {
  return typeof value === "string" && (value === "skin" || REPLAY_JUDGEMENT_SETS.includes(value as ReplayJudgementSet))
    ? value as ReplayJudgementSet
    : DEFAULT_REPLAY_JUDGEMENT_SET;
}

export function getReplayComboFontStyle(value: unknown): ReplayComboFontStyle {
  return REPLAY_COMBO_FONT_STYLES[normalizeReplayComboFontSet(value)];
}

export function getReplayJudgementSetAssets(value: unknown): ReplaySkinJudgementAssets | null {
  const set = normalizeReplayJudgementSet(value);
  return set === "skin" ? null : REPLAY_JUDGEMENT_SET_ASSETS[set];
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
    stage: normalizeStageAssets(raw.stage),
  };
}

function normalizeStageAssets(value: unknown): ReplaySkinStageAssets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_REPLAY_SKIN_STAGE_ASSETS;
  const raw = value as Partial<Record<keyof ReplaySkinStageAssets, unknown>>;
  return {
    left: normalizeImageAsset(raw.left),
    right: normalizeImageAsset(raw.right),
    bottom: normalizeImageAsset(raw.bottom),
    hint: normalizeImageAsset(raw.hint),
    light: normalizeImageAsset(raw.light),
    lighting: normalizeImageAsset(raw.lighting),
    lightingWidths: normalizeNumberList(raw.lightingWidths, 1, 400, REPLAY_SKIN_MAX_COLUMNS),
    lightColors: normalizeColumnColors(raw.lightColors),
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
    columnLineWidths: normalizeNumberList(raw.columnLineWidths, 0, REPLAY_SKIN_MAX_COLUMN_LINE_WIDTH, REPLAY_SKIN_MAX_COLUMNS + 1),
    columnLineColor: normalizeLineColor(raw.columnLineColor),
    columnBackgrounds: normalizeColumnColors(raw.columnBackgrounds),
    judgementLine: typeof raw.judgementLine === "boolean" ? raw.judgementLine : true,
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
  const judgementSet = normalizeReplayJudgementSet(raw.judgementSet ?? DEFAULT_REPLAY_SKIN_SETTINGS.judgementSet);
  const judgementScale = normalizeJudgementScale(raw.judgementScale);
  const judgementScales = normalizeJudgementScales(raw.judgementScales);
  if (
    judgementScale !== REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE &&
    judgementScales[judgementSet] == null
  ) {
    judgementScales[judgementSet] = judgementScale;
  }
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
    outlineEnabled: typeof raw.outlineEnabled === "boolean" ? raw.outlineEnabled : DEFAULT_REPLAY_SKIN_SETTINGS.outlineEnabled,
    outlineColor: normalizeHexColor(raw.outlineColor) ?? DEFAULT_REPLAY_SKIN_SETTINGS.outlineColor,
    outlineWidth: normalizeOutlineWidth(raw.outlineWidth),
    percy: typeof raw.percy === "boolean" ? raw.percy : DEFAULT_REPLAY_SKIN_SETTINGS.percy,
    upscroll: typeof raw.upscroll === "boolean" ? raw.upscroll : DEFAULT_REPLAY_SKIN_SETTINGS.upscroll,
    columnWidth: fallbackProfile.columnWidth,
    columnSpacing: fallbackProfile.columnSpacing,
    noteHeightScale: fallbackProfile.noteHeightScale,
    hitPosition: normalizeHitPosition(raw.hitPosition ?? DEFAULT_REPLAY_SKIN_SETTINGS.hitPosition),
    scorePosition: normalizeHitPosition(raw.scorePosition ?? DEFAULT_REPLAY_SKIN_SETTINGS.scorePosition),
    comboPosition: normalizeHitPosition(raw.comboPosition ?? DEFAULT_REPLAY_SKIN_SETTINGS.comboPosition),
    comboFontSet: normalizeReplayComboFontSet(raw.comboFontSet ?? DEFAULT_REPLAY_SKIN_SETTINGS.comboFontSet),
    judgementSet,
    judgementScale: getReplayJudgementScale({ judgementSet, judgementScales } as ReplaySkinSettings),
    judgementScales,
    keymodeProfiles: normalizeKeymodeProfiles(raw.keymodeProfiles, fallbackProfile, persistedVersion),
  };
}

export function getReplayJudgementScale(
  settings: Pick<ReplaySkinSettings, "judgementSet" | "judgementScales">,
  set: ReplayJudgementSet = settings.judgementSet,
): number {
  return settings.judgementScales[set] ?? REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE;
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

export const REPLAY_SKIN_SETTINGS_CHANGE_EVENT = "mania-hub:replay-skin-settings-change";

export function writeReplaySkinSettings(settings: ReplaySkinSettings): void {
  if (typeof window === "undefined") return;

  try {
    const normalized = normalizeReplaySkinSettings(settings);
    window.localStorage.setItem(
      REPLAY_SKIN_STORAGE_KEY,
      JSON.stringify(normalized),
    );
    if (typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, { detail: normalized }));
    }
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

function compactColor(value: string): string {
  return value.startsWith("#") ? value.slice(1) : value;
}

function expandColor(value: unknown): unknown {
  if (typeof value === "string" && /^[0-9a-f]{6}$/i.test(value)) return `#${value}`;
  return value;
}

function compactColorList(colors: string[]): unknown {
  const compacted = colors.map((color) => color ? compactColor(color) : "");
  return compacted.every(Boolean) ? compacted.join("") : compacted;
}

function expandColorList(value: unknown): unknown {
  if (typeof value === "string" && value.length > 0 && value.length % 6 === 0 && /^[0-9a-f]+$/i.test(value)) {
    const colors: string[] = [];
    for (let i = 0; i < value.length; i += 6) colors.push(`#${value.slice(i, i + 6)}`);
    return colors;
  }
  if (Array.isArray(value)) return value.map((entry) => entry === "" ? "" : expandColor(entry));
  return value;
}

function compactBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function expandBoolean(value: unknown): unknown {
  if (value === 1) return true;
  if (value === 0) return false;
  return value;
}

function compactReplaySkinStyle(style: ReplaySkinStyle): number | ReplaySkinStyle {
  if (style === "bars") return 0;
  if (style === "circles") return 1;
  if (style === "arrows") return 2;
  return style;
}

function expandReplaySkinStyle(value: unknown): unknown {
  if (value === 0) return "bars";
  if (value === 1) return "circles";
  if (value === 2) return "arrows";
  return value;
}

function compactKeymodeProfileV3(profile: ReplaySkinKeymodeProfile): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (profile.tapColor !== DEFAULT_REPLAY_SKIN_PROFILE.tapColor) out.b = compactColor(profile.tapColor);
  if (profile.tapColors.some((color) => color)) out.c = compactColorList(profile.tapColors);
  if (profile.lnHeadColor !== DEFAULT_REPLAY_SKIN_PROFILE.lnHeadColor) out.d = compactColor(profile.lnHeadColor);
  if (profile.lnHeadColors.some((color) => color)) out.e = compactColorList(profile.lnHeadColors);
  if (profile.columnWidth !== DEFAULT_REPLAY_SKIN_PROFILE.columnWidth) out.h = profile.columnWidth;
  if (profile.columnSpacing !== DEFAULT_REPLAY_SKIN_PROFILE.columnSpacing) out.i = profile.columnSpacing;
  if (profile.columnWidths.length > 0) out.j = profile.columnWidths;
  if (profile.columnSpacings.length > 0) out.k = profile.columnSpacings;
  if (profile.columnLineWidths.length > 0) out.n = profile.columnLineWidths;
  if (profile.columnLineColor) out.o = compactColor(profile.columnLineColor);
  if (!profile.judgementLine) out.p = 0;
  if (profile.noteHeightScale !== DEFAULT_REPLAY_SKIN_PROFILE.noteHeightScale) out.l = profile.noteHeightScale;
  const hasAssets = profile.assets.columns.length > 0
    || profile.assets.combo !== null
    || Object.keys(profile.assets.judgements).length > 0;
  if (hasAssets) out.m = profile.assets;
  return Object.keys(out).length > 0 ? out : null;
}

function expandKeymodeProfileV3(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return {
    tapColor: expandColor(raw.b),
    tapColors: expandColorList(raw.c),
    lnHeadColor: expandColor(raw.d),
    lnHeadColors: expandColorList(raw.e),
    columnWidth: raw.h,
    columnSpacing: raw.i,
    columnWidths: raw.j,
    columnSpacings: raw.k,
    columnLineWidths: raw.n,
    columnLineColor: expandLineColor(raw.o),
    judgementLine: expandBoolean(raw.p),
    noteHeightScale: raw.l,
    assets: raw.m,
  };
}

function expandLineColor(value: unknown): unknown {
  if (typeof value === "string" && /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return `#${value}`;
  return value;
}

function compactReplaySkinSettingsV3(settings: ReplaySkinSettings): Record<string, unknown> {
  const def = DEFAULT_REPLAY_SKIN_SETTINGS;
  const out: Record<string, unknown> = {};
  if (settings.style !== def.style) out.a = compactReplaySkinStyle(settings.style);
  if (settings.tapColor !== def.tapColor) out.b = compactColor(settings.tapColor);
  if (settings.tapColors.some((color) => color)) out.c = compactColorList(settings.tapColors);
  if (settings.lnHeadColor !== def.lnHeadColor) out.d = compactColor(settings.lnHeadColor);
  if (settings.lnHeadColors.some((color) => color)) out.e = compactColorList(settings.lnHeadColors);
  if (settings.lnBodyColor !== def.lnBodyColor) out.f = compactColor(settings.lnBodyColor);
  if (settings.outlineEnabled !== def.outlineEnabled) out.g = compactBoolean(settings.outlineEnabled);
  if (settings.outlineColor !== def.outlineColor) out.h = compactColor(settings.outlineColor);
  if (settings.outlineWidth !== def.outlineWidth) out.i = settings.outlineWidth;
  if (settings.percy !== def.percy) out.j = compactBoolean(settings.percy);
  if (settings.upscroll !== def.upscroll) out.k = compactBoolean(settings.upscroll);
  if (settings.columnWidth !== def.columnWidth) out.m = settings.columnWidth;
  if (settings.hitPosition !== def.hitPosition) out.n = settings.hitPosition;
  if (settings.scorePosition !== def.scorePosition) out.o = settings.scorePosition;
  if (settings.comboPosition !== def.comboPosition) out.p = settings.comboPosition;
  if (settings.comboFontSet !== def.comboFontSet) out.t = settings.comboFontSet;
  if (settings.judgementSet !== def.judgementSet) out.u = settings.judgementSet;
  if (Object.keys(settings.judgementScales).length > 0) out.w = settings.judgementScales;
  const profiles: Record<string, unknown> = {};
  for (const [key, profile] of Object.entries(settings.keymodeProfiles)) {
    const compact = compactKeymodeProfileV3(profile);
    if (compact) profiles[key] = compact;
  }
  if (Object.keys(profiles).length > 0) out.q = profiles;
  if (settings.columnSpacing !== def.columnSpacing) out.r = settings.columnSpacing;
  if (settings.noteHeightScale !== def.noteHeightScale) out.s = settings.noteHeightScale;
  return out;
}

function expandReplaySkinSettingsV3(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const profiles: Record<string, unknown> = {};
  if (raw.q && typeof raw.q === "object" && !Array.isArray(raw.q)) {
    for (const [key, profile] of Object.entries(raw.q)) {
      profiles[key] = expandKeymodeProfileV3(profile);
    }
  }
  return {
    style: expandReplaySkinStyle(raw.a),
    tapColor: expandColor(raw.b),
    tapColors: expandColorList(raw.c),
    lnHeadColor: expandColor(raw.d),
    lnHeadColors: expandColorList(raw.e),
    lnBodyColor: expandColor(raw.f),
    outlineEnabled: expandBoolean(raw.g),
    outlineColor: expandColor(raw.h),
    outlineWidth: raw.i,
    percy: expandBoolean(raw.j),
    upscroll: expandBoolean(raw.k),
    columnWidth: raw.m,
    columnSpacing: raw.r,
    noteHeightScale: raw.s,
    hitPosition: raw.n,
    scorePosition: raw.o,
    comboPosition: raw.p,
    comboFontSet: raw.t,
    judgementSet: raw.u,
    judgementScale: raw.v,
    judgementScales: raw.w,
    keymodeProfiles: profiles,
  };
}

export function createReplaySkinShareKey(name: string, settings: ReplaySkinSettings): string {
  const normalized = normalizeReplaySkinSettings(settings);
  const payload = [
    normalizePresetName(name),
    compactReplaySkinSettingsV3(normalized),
  ];
  return `mhreplay3.${encodeBase64Url(JSON.stringify(payload))}`;
}

export function parseReplaySkinShareKey(key: string): ReplaySkinSharePayload | null {
  const trimmed = key.trim();
  if (trimmed.startsWith("mhreplay3.")) {
    try {
      const parsed = JSON.parse(decodeBase64Url(trimmed.slice("mhreplay3.".length)));
      if (!Array.isArray(parsed)) return null;
      return {
        type: "mania-hub-replay-settings",
        version: 1,
        name: normalizePresetName(parsed[0]),
        settings: normalizeReplaySkinSettings(expandReplaySkinSettingsV3(parsed[1])),
      };
    } catch {
      return null;
    }
  }
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
