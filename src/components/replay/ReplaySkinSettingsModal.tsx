import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Copy, GripHorizontal, Pencil, Plus, Settings, Trash2, Upload, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";

import { ReplaySkinColorPanel } from "./ReplaySkinColorPanel";
import { ReplayMasterOverlayControls } from "./ReplayMasterOverlayControls";
import { ensureReplayFontStylesheet } from "../../lib/replay-fonts";
import {
  DEFAULT_REPLAY_OVERLAY_SETTINGS,
  REPLAY_OVERLAY_IDS,
  REPLAY_OVERLAY_LABELS,
  normalizeReplayHandAccuracyStyle,
  normalizeReplayOverlaySettings,
} from "#/lib/replay-overlays";
import type { ReplayHandAccuracyStyle, ReplayOverlayId, ReplayOverlaySettings } from "#/lib/replay-overlays";
import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  OSU_MANIA_DEFAULT_COMBO_POSITION,
  OSU_MANIA_DEFAULT_SCORE_POSITION,
  REPLAY_COMBO_FONT_SETS,
  REPLAY_JUDGEMENT_SETS,
  getReplayComboFontStyle,
  getReplayJudgementScale,
  getReplayJudgementSetAssets,
  getReplaySkinProfile,
  getReplaySkinStagePosition,
  normalizeReplaySkinSettings,
  OSU_MANIA_MAX_HIT_POSITION,
  OSU_MANIA_MIN_HIT_POSITION,
  OSU_MANIA_SCREEN_WIDTH,
  osuManiaStagePositionToReplayPosition,
  createReplaySkinPreset,
  createReplaySkinShareKey,
  parseReplaySkinShareKey,
  readReplaySkinPresets,
  REPLAY_SKIN_MAX_COLUMN_WIDTH,
  REPLAY_SKIN_MAX_COLUMN_SPACING,
  REPLAY_SKIN_MAX_JUDGEMENT_SCALE,
  REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE,
  REPLAY_SKIN_MAX_OUTLINE_WIDTH,
  REPLAY_SKIN_MIN_COLUMN_WIDTH,
  REPLAY_SKIN_MIN_COLUMN_SPACING,
  REPLAY_SKIN_MIN_JUDGEMENT_SCALE,
  REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE,
  REPLAY_SKIN_MIN_OUTLINE_WIDTH,
  REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE,
  REPLAY_SKIN_DEFAULT_OUTLINE_WIDTH,
  replayStagePositionToOsuManiaPosition,
  writeReplaySkinPresets,
} from "#/lib/replay-skin";
import { extractSkinSoundsFromArchive, importReplaySkinFromOsk, listOskImageEntries, loadOskImageAssetByPath, openOskArchive } from "#/lib/replay-skin-import";
import type { OskArchive, OskImageEntry } from "#/lib/replay-skin-import";
import { readCachedReplaySkin, writeCachedReplaySkin } from "#/lib/replay-skin-cache";
import type { ReplaySkinColumnAssets, ReplaySkinImageAsset, ReplaySkinJudgementAssets, ReplaySkinKeymodeAssets, ReplaySkinKeymodeProfile, ReplaySkinPreset, ReplaySkinPresetCommunityLink, ReplaySkinSettings, ReplaySkinStageAssets, ReplaySkinStagePositionKey, ReplaySkinStyle } from "#/lib/replay-skin";
import { readReplayAudioSettings, writeReplayAudioSettings, type ReplayAudioSettings } from "#/lib/replay-preferences";
import { clearReplaySkinSounds, readReplaySkinSounds, writeReplaySkinSounds } from "#/lib/replay-skin-sounds";
import { useAuth } from "#/lib/auth-context";
import { getLiveBackendUrl } from "#/lib/live-backend";
import {
  communityPresetCacheKey,
  dehydrateReplaySkinSettings,
  fetchMyReplaySkinCached,
  loadOwnerReplaySkin,
  readAppliedCommunityReplaySkin,
  rehydrateOwnerReplaySkinSettings,
  replaySkinSettingsEmbedAssets,
  resolveCommunityPresetSave,
  setMyReplaySkin,
  writeMyReplaySkinMemory,
} from "#/lib/replay-owner-skin";
import type { AppliedCommunitySkinDraft, OwnerReplaySkinRecord } from "#/lib/replay-owner-skin";
import { fetchSkinsListDirect, formatKeymodes, skinOskFileUrl } from "#/lib/skins";
import type { SkinSummary } from "#/lib/skins";

const MANIA_ARROW_ICON_STYLE: CSSProperties = {
  WebkitMask: "url('/images/notes/mania-arrow-right.svg') center / contain no-repeat",
  mask: "url('/images/notes/mania-arrow-right.svg') center / contain no-repeat",
};
const MANIA_BAR_ICON_STYLE: CSSProperties = {
  WebkitMask: "url('/images/notes/mania-bar.svg') center / contain no-repeat",
  mask: "url('/images/notes/mania-bar.svg') center / contain no-repeat",
};
const MANIA_CIRCLE_ICON_STYLE: CSSProperties = {
  WebkitMask: "url('/images/notes/mania-circle.svg') center / contain no-repeat",
  mask: "url('/images/notes/mania-circle.svg') center / contain no-repeat",
};

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const DRAFT_PRESET_ID = "custom";
const DEFAULT_DRAFT_PRESET_NAME = "Default";
const PREVIEW_BAR_NOTE_HEIGHT_RATIO = 0.22;
const PREVIEW_MANIA_SKIN_STAGE_HEIGHT = 480;
const PREVIEW_MIN_HEIGHT = 300;
const PREVIEW_MAX_HEIGHT = 430;
const PREVIEW_HEIGHT_RATIO = 0.9;
const REPLAY_JUDGEMENT_REFERENCE_ASPECT = 256 / 72;
const PREVIEW_BAR_COLUMN_COLORS: Record<number, string[]> = {
  1: ["#fff"],
  2: ["#5a8fff", "#5a8fff"],
  3: ["#5a8fff", "#fff", "#5a8fff"],
  4: ["#fff", "#5a8fff", "#5a8fff", "#fff"],
  5: ["#5a8fff", "#de31ae", "#fff", "#de31ae", "#5a8fff"],
  6: ["#5a8fff", "#de31ae", "#fff", "#fff", "#de31ae", "#5a8fff"],
  7: ["#fff", "#5a8fff", "#fff", "#ffcc22", "#fff", "#5a8fff", "#fff"],
  8: ["#5a8fff", "#de31ae", "#fff", "#ffcc22", "#ffcc22", "#fff", "#de31ae", "#5a8fff"],
  9: ["#5a8fff", "#de31ae", "#fff", "#ffcc22", "#88da20", "#ffcc22", "#fff", "#de31ae", "#5a8fff"],
  10: ["#5a8fff", "#de31ae", "#fff", "#ffcc22", "#88da20", "#88da20", "#ffcc22", "#fff", "#de31ae", "#5a8fff"],
};

type ColorTarget = "tap" | "lnHead" | "lnBody" | "outline";
type OverrideKind = "tap" | "lnHead";
type PreviewMode = "tap" | "ln";
type ReplaySkinSettingsTab = "style" | "layout" | "hud" | "overlays" | "audio" | "assets";
type ArrowDirection = "left" | "right" | "up" | "down";

interface HydratedCommunityPreset {
  settings: ReplaySkinSettings;
  archive: OskArchive | null;
  // Null means the visuals are cached but this preset's sounds have not been
  // recovered yet. An empty object is a known skin with no gameplay samples.
  sounds: Record<string, ArrayBuffer> | null;
}

// Assets tab (only mounted when an .osk archive rides along, i.e. the
// owner-replay-skin customize flow): which draft slot a picked image lands in.
type AssetStageKey = "left" | "right" | "bottom" | "hint" | "light" | "scorebarBg" | "scorebarColour" | "scorebarMarker";
type AssetPickerTarget =
  | { kind: "column"; column: number; assetKey: keyof ReplaySkinColumnAssets; label: string }
  | { kind: "judgement"; assetKey: keyof ReplaySkinJudgementAssets; label: string }
  | { kind: "stage"; assetKey: AssetStageKey; label: string };

const ASSET_COLUMN_ROWS: ReadonlyArray<{ key: keyof ReplaySkinColumnAssets; label: MessageDescriptor }> = [
  { key: "tap", label: msg`Note` },
  { key: "lnHead", label: msg`LN head` },
  { key: "lnBody", label: msg`LN body` },
  { key: "lnTail", label: msg`LN tail` },
  { key: "receptor", label: msg`Key` },
  { key: "receptorPressed", label: msg`Key pressed` },
];
const ASSET_JUDGEMENT_ROWS: ReadonlyArray<{ key: keyof ReplaySkinJudgementAssets; label: MessageDescriptor }> = [
  { key: "hit0", label: msg`MISS` },
  { key: "hit50", label: msg`50` },
  { key: "hit100", label: msg`100` },
  { key: "hit200", label: msg`200` },
  { key: "hit300", label: msg`300` },
  { key: "hit300g", label: msg`300g` },
];
const ASSET_STAGE_ROWS: ReadonlyArray<{ key: AssetStageKey; label: MessageDescriptor }> = [
  { key: "left", label: msg`Left` },
  { key: "right", label: msg`Right` },
  { key: "bottom", label: msg`Bottom` },
  { key: "hint", label: msg`Hint` },
  { key: "light", label: msg`Light` },
  { key: "scorebarBg", label: msg`HP bar bg` },
  { key: "scorebarColour", label: msg`HP bar fill` },
  { key: "scorebarMarker", label: msg`HP bar marker` },
];
// A skin can hold hundreds of images; the picker renders at most this many
// rows and asks for a narrower search beyond it, so thumbnails only ever
// decode for the visible slice.
const ASSET_PICKER_MAX_ENTRIES = 60;

function loadCachedOskAsset(
  archive: OskArchive,
  path: string,
  cache: Map<string, Promise<ReplaySkinImageAsset | undefined>>,
): Promise<ReplaySkinImageAsset | undefined> {
  let promise = cache.get(path);
  if (!promise) {
    promise = loadOskImageAssetByPath(archive, path).catch(() => undefined);
    cache.set(path, promise);
  }
  return promise;
}

type SelectionMode = "replace" | "toggle" | "range";

function getComboFontPreviewStyle(value: ReplaySkinSettings["comboFontSet"]): CSSProperties {
  const font = getReplayComboFontStyle(value);
  return {
    fontFamily: font.family,
    fontWeight: font.weight,
    fontStyle: font.style ?? "normal",
  };
}

function getJudgementSetLabel(set: ReplaySkinSettings["judgementSet"], i18n: I18n): string {
  if (set === "skin") return i18n._(msg`Skin`);
  const index = Number(set.slice(3));
  return i18n._(msg`Set ${index}`);
}

function getJudgementPreviewAsset(settings: ReplaySkinSettings): ReplaySkinImageAsset | undefined {
  return getReplayJudgementSetAssets(settings.judgementSet)?.hit300g;
}

// The MAX judgement exactly as the skin defines it, like the catalog preview:
// a skin that ships a transparent 300g hides perfect hits in game, so the
// preview stays empty there too. hit300 only stands in when there is no 300g.
function getSkinJudgementPreviewAsset(
  settings: ReplaySkinSettings,
  profile: ReplaySkinKeymodeProfile,
): ReplaySkinImageAsset | undefined {
  if (getReplayJudgementSetAssets(settings.judgementSet)) return undefined;
  return profile.assets.judgements.hit300g ?? profile.assets.judgements.hit300;
}

// Native pixels in the game's 768-unit space, the rule every piece of
// imported art follows on the stage.
function getSkinAssetPreviewSize(
  asset: ReplaySkinImageAsset,
  layoutScale: number,
  extraScale = 1,
): { width: number; height: number } | null {
  const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
  const width = asset.width && asset.width > 0 ? asset.width / scale : 0;
  const height = asset.height && asset.height > 0 ? asset.height / scale : 0;
  if (!(width > 0) || !(height > 0)) return null;
  const unit = (480 / 768) * layoutScale * extraScale;
  return { width: Math.max(1, width * unit), height: Math.max(1, height * unit) };
}

// "1234x" in the skin's own digits, at the size and overlap the stage uses
// (including the lazer HUD scale the importer picked up).
function getSkinComboPreviewGlyphs(
  profile: ReplaySkinKeymodeProfile,
  layoutScale: number,
): { glyphs: Array<{ asset: ReplaySkinImageAsset; width: number; height: number }>; overlap: number } | null {
  const combo = profile.assets.combo;
  if (!combo) return null;
  const digits = [1, 2, 3, 4].map((digit) => combo.digits[digit]);
  if (!digits.every((asset): asset is ReplaySkinImageAsset => Boolean(asset))) return null;
  // The "x" glyph is optional: plenty of skins point the mania combo at a
  // score font that ships digits only, and the stage draws the number alone
  // there rather than falling back to a different font entirely.
  const assets = combo.x ? [...digits, combo.x] : digits;
  const glyphs: Array<{ asset: ReplaySkinImageAsset; width: number; height: number }> = [];
  for (const asset of assets) {
    const size = getSkinAssetPreviewSize(asset, layoutScale, profile.comboScale);
    if (!size) return null;
    glyphs.push({ asset, ...size });
  }
  return { glyphs, overlap: combo.overlap * (480 / 768) * layoutScale * profile.comboScale };
}

function getPreviewKeyAreaHeight(asset: ReplaySkinImageAsset, layoutScale: number, fallbackHeight: number): number {
  const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
  const height = asset.height && asset.height > 0 ? asset.height / scale : 0;
  return height > 0 ? Math.max(1, height * (480 / 768) * layoutScale) : fallbackHeight;
}

// One repeat of a cascading LN body, in preview pixels. Stable runs the body
// art at its natural aspect from the tail end and repeats it (its default
// NoteBodyStyle) instead of squashing one copy over the hold, which is what
// keeps a Percy body's rounded cap and its transparent lead-in visible.
function getPreviewLnBodyTileHeight(asset: ReplaySkinImageAsset, laneWidth: number, span: number): number {
  const width = asset.width && asset.width > 0 ? asset.width : 0;
  const height = asset.height && asset.height > 0 ? asset.height : 0;
  if (!(width > 0) || !(height > 0)) return Math.max(1, span);
  return Math.max(1, height * (laneWidth / width));
}

// Total stage width in skin units, which both the centred ColumnStart and the
// preview's placement measure against.
function getStageUnitWidth(profile: ReplaySkinKeymodeProfile, keyCount: number): number {
  const keys = Math.max(1, keyCount);
  let total = 0;
  for (let col = 0; col < keys; col += 1) {
    total += profile.columnWidths[col] ?? profile.columnWidth;
    if (col < keys - 1) total += profile.columnSpacings[col] ?? profile.columnSpacing;
  }
  return total;
}

// The ColumnStart that leaves the stage centred, which is where the viewer
// puts it when skin.ini names no value.
function getCenteredColumnStart(profile: ReplaySkinKeymodeProfile, keyCount: number): number {
  return Math.max(0, Math.round((OSU_MANIA_SCREEN_WIDTH - getStageUnitWidth(profile, keyCount)) / 2));
}

function applySelection(current: number[], column: number, mode: SelectionMode): number[] {
  if (mode === "toggle") {
    if (current.includes(column)) {
      const next = current.filter((c) => c !== column);
      return next.length > 0 ? next : current;
    }
    return [...current, column].sort((a, b) => a - b);
  }
  if (mode === "range") {
    const anchor = current[current.length - 1] ?? column;
    const lo = Math.min(anchor, column);
    const hi = Math.max(anchor, column);
    const range: number[] = [];
    for (let i = lo; i <= hi; i += 1) range.push(i);
    return range;
  }
  return [column];
}

// Keymodes whose profile carries any column art (notes or receptors). With
// the importer synthesizing undeclared keymodes from stable's default
// filenames, an empty list here means the skin genuinely has nothing to show
// for that keymode.
function keymodesWithSkinArt(settings: ReplaySkinSettings): number[] {
  return Object.entries(settings.keymodeProfiles)
    .filter(([, profile]) => profile.assets.columns.some((column) => Object.values(column).some(Boolean)))
    .map(([key]) => Number(key))
    .sort((a, b) => a - b);
}

function arraysEqualUnordered(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function fallbackPreviewBarColors(keyCount: number): string[] {
  return PREVIEW_BAR_COLUMN_COLORS[keyCount]
    ?? Array.from({ length: keyCount }, (_, i) => `#${Math.floor(0xffffff * (0.45 + 0.55 * Math.sin((i / keyCount) * Math.PI))).toString(16).padStart(6, "0")}`);
}

function HitsoundVolumeSlider({ value, onChange }: { value: number; onChange: (volume: number) => void }) {
  const percent = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-osu-pink"
        style={{
          background: `linear-gradient(90deg, var(--color-osu-pink, #e83c90) 0%, var(--color-osu-pink, #e83c90) ${percent}%, rgba(38, 38, 51, 0.9) ${percent}%, rgba(38, 38, 51, 0.9) 100%)`,
        }}
      />
      <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-osu-f1">{percent}%</span>
    </div>
  );
}

function getColumnArrowDirection(col: number, keyCount: number): ArrowDirection {
  if (keyCount <= 1) return "down";
  if (col === 0) return "left";
  if (col === keyCount - 1) return "right";
  return col % 2 === 1 ? "up" : "down";
}

interface ReplaySkinSettingsModalProps {
  settings: ReplaySkinSettings;
  overlaySettings: ReplayOverlaySettings;
  keyCount: number;
  // `community` is set when the applied draft embeds community-skin art: the
  // replay page persists the asset-free copy plus this pointer instead of
  // multi-MB data URLs (which blow the localStorage quota and silently
  // revert the apply).
  onSave: (settings: ReplaySkinSettings, community?: AppliedCommunitySkinDraft | null) => void;
  onSaveOverlays: (settings: ReplayOverlaySettings) => void;
  // Audio settings apply immediately (not part of the draft/save flow).
  onAudioSettingsChange?: (settings: ReplayAudioSettings) => void;
  onClose: () => void;
  // The open .osk behind the settings being edited. Only the owner-replay-skin
  // customize flow passes it; when present, an Assets tab appears that swaps
  // individual draft assets for other images from the archive.
  assetArchive?: OskArchive | null;
  assetSourceName?: string | null;
  // The catalog skin that assetArchive came from, when the caller knows it.
  // Presets created inside that editor then carry a rebuild pointer instead
  // of raw art (which localStorage may refuse, and stripped art without a
  // pointer is gone for good).
  assetSourceSkin?: SkinSummary | null;
  // The regular editor changes how this browser watches replays. The owner
  // customize flow publishes its primary save for everyone instead.
  saveScope?: "viewer" | "owner";
}

export function ReplaySkinSettingsModal({
  settings,
  overlaySettings,
  keyCount,
  onSave,
  onSaveOverlays,
  onAudioSettingsChange,
  onClose,
  assetArchive = null,
  assetSourceName = null,
  assetSourceSkin = null,
  saveScope = "viewer",
}: ReplaySkinSettingsModalProps) {
  useEffect(() => { void ensureReplayFontStylesheet().catch(() => {}); }, []);
  const { t, i18n } = useLingui();
  const modalRef = useRef<HTMLDivElement | null>(null);
  const matchedInitialPresetRef = useRef(false);
  const [windowRect, setWindowRect] = useState<WindowRect | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = readStoredWindowRect();
    const initial = stored ?? defaultWindowRect(window.innerWidth, window.innerHeight);
    return clampWindowRect(initial, window.innerWidth, window.innerHeight);
  });
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; startRect: WindowRect } | null>(null);
  const resizeStateRef = useRef<{ pointerId: number; dir: ResizeDirection; startX: number; startY: number; startRect: WindowRect } | null>(null);
  const [draft, setDraft] = useState(() => normalizeReplaySkinSettings(settings));
  const [overlayDraft, setOverlayDraft] = useState(() => normalizeReplayOverlaySettings(overlaySettings));
  const [presets, setPresets] = useState<ReplaySkinPreset[]>(() => readReplaySkinPresets());
  const [selectedPresetId, setSelectedPresetId] = useState(DRAFT_PRESET_ID);
  const [draftPresetName, setDraftPresetName] = useState(DEFAULT_DRAFT_PRESET_NAME);
  const [toast, setToast] = useState<{ id: number; message: string; tone: "info" | "error" } | null>(null);
  const toastIdRef = useRef(0);
  const pushStatus = useCallback((message: string, tone: "info" | "error" = "info") => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, message, tone });
  }, []);
  const [promptDialog, setPromptDialog] = useState<{
    title: string;
    label?: string;
    initial: string;
    placeholder?: string;
    confirmLabel?: string;
    multiline?: boolean;
    onSubmit: (value: string) => void;
  } | null>(null);
  const [keyDialog, setKeyDialog] = useState<{ title: string; value: string } | null>(null);
  const [selectedKeyCount, setSelectedKeyCount] = useState(() => Math.max(1, Math.min(10, keyCount)));
  const [activeColor, setActiveColor] = useState<ColorTarget | null>(null);
  const [activeTab, setActiveTab] = useState<ReplaySkinSettingsTab>(() => readWindowTab());
  const [audioSettings, setAudioSettings] = useState<ReplayAudioSettings>(readReplayAudioSettings);
  const [skinSoundsInfo, setSkinSoundsInfo] = useState<{ name: string | null; keys: string[] } | null>(null);
  const soundPreviewContextRef = useRef<AudioContext | null>(null);
  const [columnEditorOpen, setColumnEditorOpen] = useState(false);
  const [overrideKind, setOverrideKind] = useState<OverrideKind>("tap");
  const [barColorOverrideBackup, setBarColorOverrideBackup] = useState<string[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<number[]>([]);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("tap");
  const [assetPicker, setAssetPicker] = useState<AssetPickerTarget | null>(null);
  // Set by a click in the preview: the Assets tab opens on that row, scrolls it
  // into view and rings it for a moment. A skin's stage art is unrecognisable
  // by filename, so "the black bar across the top" had no way back to its row.
  const [highlightedAssetId, setHighlightedAssetId] = useState<string | null>(null);
  const identifyAsset = (target: AssetPickerTarget) => {
    setActiveTab("assets");
    setHighlightedAssetId(target.kind === "column"
      ? `column:${target.column}:${target.assetKey}`
      : `${target.kind}:${target.assetKey}`);
  };

  // ---- community skin (Style tab) -------------------------------------------
  const auth = useAuth();
  const viewerId = auth.viewer?.id ?? null;
  // The whole block needs the catalog backend; without it there is nothing to
  // browse, download or save against.
  const liveBackendAvailable = getLiveBackendUrl() != null;
  // A catalog skin imported during this editing session. Its archive powers
  // the Assets tab exactly like the assetArchive prop does; the prop (the
  // settings-page customize flow) acts as the seed until a session load
  // replaces it.
  //
  // Invariant: this is where the draft's embedded art came FROM, not merely
  // an archive that happens to be open. Every path that replaces the draft
  // wholesale keeps the two in step (or clears this), because it is what
  // pairs a rebuild pointer with saved settings - a stale value here pairs
  // skin B's settings with skin A's pointer, and the preset rebuilds wrong.
  const [loadedCatalogSkin, setLoadedCatalogSkin] = useState<{ skin: SkinSummary; archive: OskArchive } | null>(
    () => (assetSourceSkin && assetArchive ? { skin: assetSourceSkin, archive: assetArchive } : null),
  );
  const [skinBrowserOpen, setSkinBrowserOpen] = useState(false);
  const [communityBusy, setCommunityBusy] = useState<null | "import" | "preset" | "load-mine" | "save-mine">(null);
  // Open archives by skin id, so re-selecting a community preset in the same
  // session never re-downloads or re-parses the .osk.
  const archiveCacheRef = useRef(new Map<string, Promise<OskArchive | null>>());
  // Keep decoded preset settings too. The archive cache alone avoids the
  // download, but rebuilding data URLs from it still decodes every referenced
  // image and is the visible hitch when switching Default -> custom.
  const hydratedPresetCacheRef = useRef(new Map<string, HydratedCommunityPreset>());
  const [importProgress, setImportProgress] = useState<number | null>(null);
  // Gameplay samples pulled out of the last imported .osk. They only persist
  // (IndexedDB) when the user hits Apply; Cancel drops them with the draft.
  const pendingSkinSoundsRef = useRef<{ name: string; sounds: Record<string, ArrayBuffer> } | null>(null);
  const persistedSkinSoundsRef = useRef<{ skinName: string | null; samples: Record<string, ArrayBuffer> } | null>(null);
  // The exact draft object that came from (or was published as) the viewer's
  // replay skin; any edit replaces the object, which is what tells "Load"
  // whether it would do anything.
  const myReplaySkinDraftRef = useRef<ReplaySkinSettings | null>(null);
  const [myReplaySkinRecord, setMyReplaySkinRecord] = useState<OwnerReplaySkinRecord | null>(null);

  // Null until an .osk is open, which also hides the Assets tab: there is
  // nothing to swap individual assets from until then.
  const activeAssetArchive = loadedCatalogSkin?.archive ?? assetArchive ?? null;
  const activeAssetSourceName = loadedCatalogSkin?.skin.name ?? assetSourceName ?? null;
  // Decoded picker thumbnails, keyed by zip path. Loading is deduped through
  // the promise so a re-search never decodes the same image twice; a fresh map
  // per archive keeps same-named paths from colliding across skins.
  const assetThumbCache = useMemo(
    () => new Map<string, Promise<ReplaySkinImageAsset | undefined>>(),
    [activeAssetArchive],
  );
  const assetEntries = useMemo(() => (activeAssetArchive ? listOskImageEntries(activeAssetArchive) : []), [activeAssetArchive]);
  const profile = getReplaySkinProfile(draft, selectedKeyCount);
  const stagePositionValue = (key: ReplaySkinStagePositionKey) => getReplaySkinStagePosition(profile, draft, key);
  const keymodeHasSkinArt = profile.assets.columns.some((column) => Object.values(column).some(Boolean));
  const keymodeHasComboArt = Boolean(profile.assets.combo?.digits.some(Boolean));
  const keymodeHasJudgementArt = Object.values(profile.assets.judgements).some(Boolean);
  // Both of the HUD tab's blocks pick art the stage would ignore once the skin
  // ships its own, leaving nothing on the tab that changes what plays. The
  // judgement size still does, so it moves to Layout next to its position.
  const showHudTab = !keymodeHasComboArt || !keymodeHasJudgementArt;
  const isCompactWindow = (windowRect?.w ?? WINDOW_DEFAULT_WIDTH) < WINDOW_COMPACT_WIDTH;
  // Tabs without a note preview span the full window width.
  const isFullWidthTab = activeTab === "overlays" || activeTab === "audio";
  const previewPaneWidth = Math.round(Math.max(WINDOW_PREVIEW_MIN_WIDTH, Math.min(WINDOW_PREVIEW_MAX_WIDTH, (windowRect?.w ?? WINDOW_DEFAULT_WIDTH) * WINDOW_PREVIEW_WIDTH_RATIO)));
  const previewContentWidth = isCompactWindow || isFullWidthTab ? undefined : previewPaneWidth - WINDOW_PREVIEW_HORIZONTAL_PADDING;
  const contentGridStyle: CSSProperties | undefined = !isCompactWindow && !isFullWidthTab
    ? { gridTemplateColumns: `minmax(0, 1fr) ${previewPaneWidth}px` }
    : undefined;
  const [columnWidthInput, setColumnWidthInput] = useState(() => String(profile.columnWidth));
  const [columnSpacingInput, setColumnSpacingInput] = useState(() => String(profile.columnSpacing));
  // ColumnStart is stored null while the stage stays centred, so the control
  // shows the centred value as its number and resets back to it.
  const centeredColumnStart = getCenteredColumnStart(profile, selectedKeyCount);
  const columnStartValue = profile.columnStart ?? centeredColumnStart;
  const [columnStartInput, setColumnStartInput] = useState(() => String(columnStartValue));
  const [noteHeightScaleInput, setNoteHeightScaleInput] = useState(() => String(profile.noteHeightScale));
  const [outlineWidthInput, setOutlineWidthInput] = useState(() => String(draft.outlineWidth));
  const hitPositionValue = replayStagePositionToOsuManiaPosition(stagePositionValue("hitPosition"));
  const [hitPositionInput, setHitPositionInput] = useState(() => String(hitPositionValue));
  const scorePositionValue = replayStagePositionToOsuManiaPosition(stagePositionValue("scorePosition"));
  const [scorePositionInput, setScorePositionInput] = useState(() => String(scorePositionValue));
  const comboPositionValue = replayStagePositionToOsuManiaPosition(stagePositionValue("comboPosition"));
  const [comboPositionInput, setComboPositionInput] = useState(() => String(comboPositionValue));
  const currentJudgementScale = getReplayJudgementScale(draft);
  const [judgementScaleInput, setJudgementScaleInput] = useState(() => String(currentJudgementScale));

  useEffect(() => {
    setColumnWidthInput(String(profile.columnWidth));
  }, [profile.columnWidth]);

  useEffect(() => {
    setColumnSpacingInput(String(profile.columnSpacing));
  }, [profile.columnSpacing]);

  useEffect(() => {
    setColumnStartInput(String(columnStartValue));
  }, [columnStartValue]);

  useEffect(() => {
    setNoteHeightScaleInput(String(profile.noteHeightScale));
  }, [profile.noteHeightScale]);

  useEffect(() => {
    setOutlineWidthInput(String(draft.outlineWidth));
  }, [draft.outlineWidth]);

  useEffect(() => {
    setHitPositionInput(String(hitPositionValue));
  }, [hitPositionValue]);

  useEffect(() => {
    setScorePositionInput(String(scorePositionValue));
  }, [scorePositionValue]);

  useEffect(() => {
    setComboPositionInput(String(comboPositionValue));
  }, [comboPositionValue]);

  useEffect(() => {
    setJudgementScaleInput(String(currentJudgementScale));
  }, [currentJudgementScale]);

  useEffect(() => {
    writeWindowTab(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!highlightedAssetId) return;
    const row = modalRef.current?.querySelector(`[data-asset-row="${highlightedAssetId}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = window.setTimeout(() => setHighlightedAssetId(null), 2600);
    return () => window.clearTimeout(timer);
  }, [highlightedAssetId, activeTab]);

  useEffect(() => {
    let cancelled = false;
    void readReplaySkinSounds().then((record) => {
      if (cancelled) return;
      persistedSkinSoundsRef.current = record;
      setSkinSoundsInfo(record ? { name: record.skinName, keys: Object.keys(record.samples) } : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    const context = soundPreviewContextRef.current;
    soundPreviewContextRef.current = null;
    if (context) void context.close().catch(() => {});
  }, []);

  const previewSkinSound = async (key: string) => {
    const record = await readReplaySkinSounds();
    const data = record?.samples[key];
    if (!data) return;
    let context = soundPreviewContextRef.current;
    if (!context) {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      context = new Ctor();
      soundPreviewContextRef.current = context;
    }
    if (context.state === "suspended") void context.resume().catch(() => {});
    try {
      // decodeAudioData detaches the buffer, so decode a copy.
      const buffer = await context.decodeAudioData(data.slice(0));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start();
    } catch {
      // Zero-byte "silence" overrides and unreadable samples preview as nothing.
    }
  };

  const updateAudioSettings = (patch: Partial<ReplayAudioSettings>) => {
    setAudioSettings((current) => {
      const next = { ...current, ...patch };
      writeReplayAudioSettings(next);
      onAudioSettingsChange?.(next);
      return next;
    });
  };

  const clearImportedSkinSounds = () => {
    void clearReplaySkinSounds();
    setSkinSoundsInfo(null);
    pushStatus(t`Removed imported skin hitsounds`);
  };

  useEffect(() => {
    setSelectedColumns((current) => {
      const filtered = current.filter((col) => col < selectedKeyCount);
      return filtered.length === current.length ? current : filtered;
    });
  }, [selectedKeyCount]);

  useEffect(() => {
    if (selectedColumns.length === 0) return;
    const handler = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-replay-selectable-area]")) return;
      setSelectedColumns([]);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [selectedColumns.length]);

  useEffect(() => {
    if (windowRect != null) return;
    if (typeof window === "undefined") return;
    const stored = readStoredWindowRect();
    const initial = stored ?? defaultWindowRect(window.innerWidth, window.innerHeight);
    setWindowRect(clampWindowRect(initial, window.innerWidth, window.innerHeight));
  }, [windowRect]);

  useEffect(() => {
    if (!windowRect) return;
    writeStoredWindowRect(windowRect);
  }, [windowRect]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => {
      setWindowRect((current) => (current ? clampWindowRect(current, window.innerWidth, window.innerHeight) : current));
    };
    window.addEventListener("resize", handle);
    return () => window.removeEventListener("resize", handle);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (matchedInitialPresetRef.current) return;
    matchedInitialPresetRef.current = true;
    // An applied community skin re-selects its preset on open. The settings
    // comparison below cannot see it: the draft carries the rebuilt data-URL
    // art while the preset stores the asset-free copy. Viewer scope only: the
    // owner editor's draft is the record being customized, not the viewer's
    // applied skin, and selecting that preset here let Apply overwrite it
    // with the record's settings.
    const applied = saveScope === "viewer" ? readAppliedCommunityReplaySkin() : null;
    if (applied) {
      const communityMatch = presets.find((preset) => preset.community?.skin.id === applied.skin.id);
      if (communityMatch) {
        setSelectedPresetId(communityMatch.id);
        return;
      }
    }
    // Stringify the draft once, not once per preset: after a community skin
    // was applied the draft carries data-URL assets and re-serializing it 24
    // times stalls the modal open.
    const draftKey = JSON.stringify(normalizeReplaySkinSettings(draft));
    const match = presets.find((preset) => JSON.stringify(normalizeReplaySkinSettings(preset.settings)) === draftKey);
    if (match) setSelectedPresetId(match.id);
  }, [draft, presets]);

  useEffect(() => {
    if (draft.style !== "bars") return;
    setActiveColor(null);
    setOverrideKind((current) => (current === "lnHead" ? "tap" : current));
  }, [draft.style]);

  // The active tab persists across sessions; a stored "assets" must not strand
  // a modal opened without an archive on an empty tab, and neither must "hud"
  // once the loaded skin draws its own judgements and combo.
  useEffect(() => {
    if (activeTab === "assets" && !activeAssetArchive) setActiveTab("style");
    if (activeTab === "hud" && !showHudTab) setActiveTab("style");
  }, [activeTab, activeAssetArchive, showHudTab]);

  // The signed-in user's stored replay skin, for the community-skin block's
  // "Your replay skin" row. Fetched once after mount; never blocks the modal.
  useEffect(() => {
    if (!viewerId || !liveBackendAvailable) return;
    let cancelled = false;
    void fetchMyReplaySkinCached(viewerId)
      .then((record) => {
        if (cancelled) return;
        setMyReplaySkinRecord(record);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [viewerId, liveBackendAvailable]);

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!windowRect) return;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-window-no-drag]")) return;
    event.preventDefault();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: windowRect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    setWindowRect(clampWindowRect(
      { ...state.startRect, x: state.startRect.x + dx, y: state.startRect.y + dy },
      window.innerWidth,
      window.innerHeight,
    ));
  };

  const handleHeaderPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizePointerDown = (dir: ResizeDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!windowRect) return;
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      pointerId: event.pointerId,
      dir,
      startX: event.clientX,
      startY: event.clientY,
      startRect: windowRect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    let { x, y, w, h } = state.startRect;
    if (state.dir.includes("e")) {
      w = state.startRect.w + dx;
    }
    if (state.dir.includes("s")) {
      h = state.startRect.h + dy;
    }
    if (state.dir.includes("w")) {
      const requested = state.startRect.w - dx;
      const newW = Math.max(WINDOW_MIN_WIDTH, requested);
      x = state.startRect.x + (state.startRect.w - newW);
      w = newW;
    }
    if (state.dir.includes("n")) {
      const requested = state.startRect.h - dy;
      const newH = Math.max(WINDOW_MIN_HEIGHT, requested);
      y = state.startRect.y + (state.startRect.h - newH);
      h = newH;
    }
    setWindowRect(clampWindowRect({ x, y, w, h }, window.innerWidth, window.innerHeight));
  };

  const handleResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const update = (patch: Partial<ReplaySkinSettings>) => {
    setDraft((current) => normalizeReplaySkinSettings({ ...current, ...patch, version: 2 }));
  };

  const updateJudgementScale = (scale: number) => {
    setDraft((current) => {
      const normalizedScale = Math.max(REPLAY_SKIN_MIN_JUDGEMENT_SCALE, Math.min(REPLAY_SKIN_MAX_JUDGEMENT_SCALE, Math.round(scale)));
      const judgementScales = { ...current.judgementScales };
      if (normalizedScale === REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE) {
        delete judgementScales[current.judgementSet];
      } else {
        judgementScales[current.judgementSet] = normalizedScale;
      }
      return normalizeReplaySkinSettings({
        ...current,
        judgementScale: normalizedScale,
        judgementScales,
        version: 2,
      });
    });
  };

  const updateOverlay = (id: ReplayOverlayId, patch: Partial<ReplayOverlaySettings[ReplayOverlayId]>) => {
    setOverlayDraft((current) => normalizeReplayOverlaySettings({
      ...current,
      [id]: {
        ...current[id],
        ...patch,
      },
    }));
  };

  // Hit, score and combo positions are per keymode once a skin declares them,
  // the way ColumnWidth already is: a skin can hold its 4K hit line at 440 and
  // its 7K one at 393. Editing follows the same split, so a keymode carrying
  // the skin's own value keeps the edit to itself and every stage on the
  // settings-wide value (the built-in skins) keeps editing that one.
  const updateStagePosition = (key: ReplaySkinStagePositionKey, value: number) => {
    // Placing the counter by hand overrides the skin's "off the stage", or the
    // slider would move a number that draws nothing.
    if (key === "comboPosition" && profile.comboHidden) {
      updateProfile({ comboPosition: value, comboHidden: false });
      return;
    }
    if (profile[key] != null) updateProfile({ [key]: value } as Partial<ReplaySkinKeymodeProfile>);
    else update({ [key]: value } as Partial<ReplaySkinSettings>);
  };
  const resetStagePosition = (key: ReplaySkinStagePositionKey, osuDefault: number) => {
    if (profile[key] != null) updateProfile({ [key]: null } as Partial<ReplaySkinKeymodeProfile>);
    else update({ [key]: osuManiaStagePositionToReplayPosition(osuDefault) } as Partial<ReplaySkinSettings>);
  };

  const updateStyle = (style: ReplaySkinStyle) => update({ style });

  const updateProfile = (patch: Partial<ReplaySkinKeymodeProfile>) => {
    setDraft((current) => {
      const currentProfile = getReplaySkinProfile(current, selectedKeyCount);
      return normalizeReplaySkinSettings({
        ...current,
        keymodeProfiles: {
          ...current.keymodeProfiles,
          [selectedKeyCount]: {
            ...currentProfile,
            ...patch,
          },
        },
        version: 2,
      });
    });
  };

  // Clones the selected keymode's asset tree like updateProfile clones the
  // profile, so a picked image never mutates the saved settings in place.
  const updateProfileAssets = (mutate: (assets: ReplaySkinKeymodeAssets) => ReplaySkinKeymodeAssets) => {
    setDraft((current) => {
      const currentProfile = getReplaySkinProfile(current, selectedKeyCount);
      return normalizeReplaySkinSettings({
        ...current,
        keymodeProfiles: {
          ...current.keymodeProfiles,
          [selectedKeyCount]: {
            ...currentProfile,
            assets: mutate(currentProfile.assets),
          },
        },
        version: 2,
      });
    });
  };

  // asset undefined clears the slot; the renderer falls back to flat shapes.
  const applyAssetPick = (target: AssetPickerTarget, asset: ReplaySkinImageAsset | undefined, applyToAllColumns: boolean) => {
    if (target.kind === "column") {
      updateProfileAssets((assets) => {
        const columns = Array.from(
          { length: Math.max(selectedKeyCount, assets.columns.length) },
          (_, index) => ({ ...(assets.columns[index] ?? {}) }),
        );
        const targets = applyToAllColumns
          ? Array.from({ length: selectedKeyCount }, (_, index) => index)
          : [target.column];
        for (const column of targets) {
          if (column < 0 || column >= columns.length) continue;
          if (asset) columns[column][target.assetKey] = asset;
          else delete columns[column][target.assetKey];
        }
        return { ...assets, columns };
      });
      return;
    }
    if (target.kind === "judgement") {
      updateProfileAssets((assets) => {
        const judgements = { ...assets.judgements };
        if (asset) judgements[target.assetKey] = asset;
        else delete judgements[target.assetKey];
        return { ...assets, judgements };
      });
      // Imported judgement art only draws under the "skin" judgement set, so
      // picking some must not look like a no-op while a built-in set is active.
      if (asset) update({ judgementSet: "skin" });
      return;
    }
    updateProfileAssets((assets) => ({
      ...assets,
      stage: { ...assets.stage, [target.assetKey]: asset } as ReplaySkinStageAssets,
    }));
  };

  // A freshly imported skin replaces the draft the way a preset load does.
  // The caller follows up with upsertCommunityPreset, which re-attaches the
  // selection to the skin's preset entry.
  const adoptImportedSettings = (
    settings: ReplaySkinSettings,
    skin: SkinSummary,
    archive: OskArchive,
    keymodes: number[],
    preferredKeyCount: number | null,
  ) => {
    const adopted = normalizeReplaySkinSettings(settings);
    setDraft(adopted);
    setLoadedCatalogSkin({ skin, archive });
    setSelectedPresetId(DRAFT_PRESET_ID);
    setDraftPresetName(DEFAULT_DRAFT_PRESET_NAME);
    setActiveColor(null);
    if (!keymodes.includes(selectedKeyCount)) {
      const next = preferredKeyCount ?? keymodes[0];
      if (next) setSelectedKeyCount(Math.max(1, Math.min(10, next)));
    }
    return adopted;
  };

  const rememberHydratedPreset = (
    preset: ReplaySkinPreset,
    settings: ReplaySkinSettings,
    archive: OskArchive | null,
    sounds: Record<string, ArrayBuffer> | null = null,
  ) => {
    const existing = hydratedPresetCacheRef.current.get(preset.id);
    const persistedSounds = persistedSkinSoundsRef.current;
    const matchingPersistedSounds = persistedSounds
      && persistedSounds.skinName === preset.community?.skin.name
      ? persistedSounds.samples
      : null;
    const knownSounds = sounds
      ?? existing?.sounds
      ?? matchingPersistedSounds;
    const entry: HydratedCommunityPreset = {
      settings,
      archive: archive ?? existing?.archive ?? null,
      sounds: knownSounds,
    };
    hydratedPresetCacheRef.current.set(preset.id, entry);
    // IndexedDB makes non-active presets fast after the modal (or page) is
    // reopened. Only persist when sounds are known so an unfinished preload
    // cannot masquerade as a skin that intentionally ships no samples.
    if (knownSounds) {
      void writeCachedReplaySkin(
        communityPresetCacheKey(preset),
        { settings, sounds: knownSounds },
        Date.now(),
      ).catch(() => {});
    }
    return entry;
  };

  // Every loaded community skin also lives in Skin preset under the skin's
  // name, storing the dehydrated payload (asset paths, no pixels), so the
  // localStorage entry stays a few KB. Re-importing the same skin refreshes
  // its preset instead of stacking duplicates.
  const upsertCommunityPreset = (skin: SkinSummary, settings: ReplaySkinSettings) => {
    const payload = dehydrateReplaySkinSettings(settings);
    const community: ReplaySkinPresetCommunityLink = { skin, payload };
    const assetFree = normalizeReplaySkinSettings(payload.settings);
    const existing = presets.find((preset) => preset.community?.skin.id === skin.id);
    const preset = existing
      ? { ...existing, settings: assetFree, community, updatedAt: Date.now() }
      : createReplaySkinPreset(skin.name, assetFree, community);
    persistPresets(existing
      ? presets.map((candidate) => (candidate.id === preset.id ? preset : candidate))
      : [preset, ...presets].slice(0, 24));
    setSelectedPresetId(preset.id);
    return preset;
  };

  const getArchiveForSkin = (skin: SkinSummary): Promise<OskArchive | null> => {
    const cache = archiveCacheRef.current;
    const cached = cache.get(skin.id);
    if (cached) return cached;
    const promise = (async () => {
      const url = skinOskFileUrl(skin);
      if (!url) return null;
      // The streaming endpoint is CORS-safe and does not count as a download.
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) return null;
      return openOskArchive(await response.arrayBuffer());
    })().catch(() => null);
    cache.set(skin.id, promise);
    // A failed download must not poison the cache for the next attempt.
    void promise.then((archive) => {
      if (!archive) cache.delete(skin.id);
    });
    return promise;
  };

  // Selecting a community preset re-downloads the catalog .osk (session and
  // HTTP cached) and rehydrates the stored asset paths. If the download
  // fails, the preset's asset-free settings still apply so colors and layout
  // survive without the art.
  const applyCommunityPreset = async (preset: ReplaySkinPreset, community: ReplaySkinPresetCommunityLink) => {
    if (communityBusy) return;
    setSelectedPresetId(preset.id);
    setDraftPresetName(DEFAULT_DRAFT_PRESET_NAME);
    setActiveColor(null);
    const applyCached = (cached: HydratedCommunityPreset) => {
      setDraft(cached.settings);
      // No archive yet -> null, never a leftover from the previous skin; the
      // reopened-editor effect restores it for the Assets tab.
      setLoadedCatalogSkin(cached.archive ? { skin: community.skin, archive: cached.archive } : null);
      if (cached.sounds) {
        pendingSkinSoundsRef.current = Object.keys(cached.sounds).length > 0
          ? { name: community.skin.name, sounds: cached.sounds }
          : null;
      }
    };

    // The common Default -> custom switch never needs to touch the archive:
    // selecting Default remembers this decoded object before clearing it.
    let cached = hydratedPresetCacheRef.current.get(preset.id) ?? null;
    if (cached?.sounds) {
      applyCached(cached);
      pushStatus(`Loaded ${preset.name}`);
      return;
    }

    setCommunityBusy("preset");
    try {
      if (!cached) {
        const stored = await readCachedReplaySkin(communityPresetCacheKey(preset)).catch(() => null);
        if (stored) {
          cached = rememberHydratedPreset(preset, normalizeReplaySkinSettings(stored.settings), null, stored.sounds);
          applyCached(cached);
          pushStatus(`Loaded ${preset.name}`);
          // The existing effect restores the archive quietly for the Assets
          // tab; gameplay art can switch immediately from the decoded cache.
          return;
        }
      } else {
        applyCached(cached);
      }

      const archive = cached?.archive ?? await getArchiveForSkin(community.skin);
      const settings = cached?.settings
        ?? (archive ? await rehydrateOwnerReplaySkinSettings(community.payload, archive) : null);
      if (!settings) {
        setDraft(preset.settings);
        setLoadedCatalogSkin(null);
        pushStatus(t`${community.skin.name} could not be downloaded, applied colors only`, "error");
        return;
      }
      setDraft(settings);
      if (!archive) {
        setLoadedCatalogSkin(null);
        rememberHydratedPreset(preset, settings, null, cached?.sounds ?? null);
        pushStatus(t`Loaded ${preset.name}; archive tools are unavailable`, "error");
        return;
      }
      setLoadedCatalogSkin({ skin: community.skin, archive });
      const sounds = cached?.sounds ?? await extractSkinSoundsFromArchive(archive);
      pendingSkinSoundsRef.current = Object.keys(sounds).length > 0
        ? { name: community.skin.name, sounds }
        : null;
      rememberHydratedPreset(preset, settings, archive, sounds);
      pushStatus(`Loaded ${preset.name}`);
    } finally {
      setCommunityBusy(null);
    }
  };

  const importCatalogSkin = async (skin: SkinSummary) => {
    if (communityBusy) return;
    const oskFileUrl = skinOskFileUrl(skin);
    if (!oskFileUrl) {
      pushStatus(t`That skin has no downloadable file`, "error");
      return;
    }
    setSkinBrowserOpen(false);
    setCommunityBusy("import");
    setImportProgress(0);
    try {
      // The streaming endpoint is CORS-safe and does not count as a download.
      const response = await fetch(oskFileUrl, { credentials: "omit" });
      if (!response.ok) throw new Error("osk_fetch_failed");
      const file = new File([await response.blob()], `${skin.name}.osk`);
      // Open once and let the importer populate this archive's decoded-asset
      // cache. Reopening it after import used to unzip the same .osk twice and
      // leave the retained archive with an empty image cache.
      const archive = await openOskArchive(await file.arrayBuffer());
      const result = await importReplaySkinFromOsk(file, {
        targetKeyCount: selectedKeyCount,
        baseSettings: draft,
        extractSounds: true,
        archive,
        onProgress: (done, total) => {
          const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
          setImportProgress((current) => (current === percent ? current : percent));
        },
      });
      archiveCacheRef.current.set(skin.id, Promise.resolve(archive));
      // Prefer the keymodes that actually resolved art (synthesized ones
      // included) so the editor stays on the replay's keymode whenever the
      // skin can dress it.
      const artKeymodes = result.summary.assetKeymodes.length > 0
        ? result.summary.assetKeymodes
        : result.summary.keymodes;
      const adopted = adoptImportedSettings(result.settings, skin, archive, artKeymodes, result.summary.selectedKeyCount);
      const preset = upsertCommunityPreset(skin, result.settings);
      pendingSkinSoundsRef.current = Object.keys(result.sounds).length > 0
        ? { name: result.summary.name, sounds: result.sounds }
        : null;
      rememberHydratedPreset(preset, adopted, archive, result.sounds);
      pushStatus(t`Loaded ${skin.name}`);
    } catch (error) {
      pushStatus(error instanceof Error && error.message.includes("skin.ini")
        ? error.message
        : t`Loading ${skin.name} failed`, "error");
    } finally {
      setCommunityBusy(null);
      setImportProgress(null);
    }
  };

  const loadMyReplaySkinIntoDraft = async () => {
    const record = myReplaySkinRecord;
    if (!record || communityBusy) return;
    setCommunityBusy("load-mine");
    try {
      const loaded = await loadOwnerReplaySkin(record);
      if (!loaded) {
        pushStatus(t`Your replay skin could not be loaded`, "error");
        return;
      }
      archiveCacheRef.current.set(record.skin.id, Promise.resolve(loaded.archive));
      const artKeymodes = keymodesWithSkinArt(loaded.settings);
      const adopted = myReplaySkinDraftRef.current = adoptImportedSettings(
        loaded.settings,
        record.skin,
        loaded.archive,
        artKeymodes.length > 0 ? artKeymodes : record.skin.keymodes,
        record.skin.keymodes[0] ?? null,
      );
      const preset = upsertCommunityPreset(record.skin, loaded.settings);
      pendingSkinSoundsRef.current = Object.keys(loaded.sounds).length > 0
        ? { name: record.skin.name, sounds: loaded.sounds }
        : null;
      rememberHydratedPreset(preset, adopted, loaded.archive, loaded.sounds);
      pushStatus(t`Loaded ${record.skin.name}`);
    } finally {
      setCommunityBusy(null);
    }
  };

  const saveDraftAsMyReplaySkin = async () => {
    const targetSkin = loadedCatalogSkin?.skin
      ?? presets.find((preset) => preset.id === selectedPresetId)?.community?.skin
      ?? null;
    if (!targetSkin || !viewerId || communityBusy) return;
    setCommunityBusy("save-mine");
    try {
      const payload = dehydrateReplaySkinSettings(draft);
      const result = await setMyReplaySkin({
        data: { skinId: targetSkin.id, settingsJson: JSON.stringify(payload) },
      });
      if (result.ok) {
        const record = { skin: targetSkin, settings: payload, updatedAt: new Date().toISOString() };
        // The draft is now what is published, so "Load" has nothing to fetch.
        myReplaySkinDraftRef.current = draft;
        setMyReplaySkinRecord(record);
        writeMyReplaySkinMemory(viewerId, record);
        pushStatus(t`Saved as your replay skin`);
      } else {
        pushStatus(result.error === "payload_too_large"
          ? t`The customized settings are too large to store`
          : t`Saving your replay skin failed`, "error");
      }
    } catch {
      pushStatus(t`Saving your replay skin failed`, "error");
    } finally {
      setCommunityBusy(null);
    }
  };

  const updateBaseColor = (kind: "tap" | "lnHead", value: string) => {
    if (kind === "tap") updateProfile({ tapColor: value });
    else updateProfile({ lnHeadColor: value });
  };

  const updateOverrideColors = (kind: "tap" | "lnHead", targetColumns: number[], value: string) => {
    if (targetColumns.length === 0) return;
    setDraft((current) => {
      const currentProfile = getReplaySkinProfile(current, selectedKeyCount);
      const key = kind === "tap" ? "tapColors" : "lnHeadColors";
      const colors = [...currentProfile[key]];
      for (const column of targetColumns) {
        if (column >= 0 && column < selectedKeyCount) colors[column] = value;
      }
      return normalizeReplaySkinSettings({
        ...current,
        keymodeProfiles: {
          ...current.keymodeProfiles,
          [selectedKeyCount]: {
            ...currentProfile,
            [key]: colors,
          },
        },
        version: 2,
      });
    });
  };

  const disableBarColorOverrides = () => {
    setBarColorOverrideBackup(profile.tapColors);
    updateProfile({ tapColors: [] });
    setColumnEditorOpen(false);
  };

  const enableBarColorOverrides = () => {
    if (barColorOverrideBackup.some((color) => color)) {
      updateProfile({ tapColors: barColorOverrideBackup });
    }
    setOverrideKind("tap");
    setPreviewMode("tap");
    setColumnEditorOpen(true);
  };

  const updateLnBodyColor = (value: string) => {
    update({ lnBodyColor: value });
  };

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null;
  // The community skin currently in play: the session-loaded archive wins,
  // otherwise the selected community preset (a reopened modal has the preset
  // selected but no archive until something reloads it).
  const communitySkinContext = loadedCatalogSkin?.skin ?? selectedPreset?.community?.skin ?? null;
  const noteHeightDefault = Math.max(
    REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE,
    Math.min(
      REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE,
      profile.columnWidths.length > 0 ? Math.min(...profile.columnWidths) : profile.columnWidth,
    ),
  );
  const hasNoteAssets = profile.assets.columns.some((col) => col?.tap || col?.lnHead || col?.lnBody || col?.lnTail);
  const showNoteHeightScale = draft.style === "bars" || hasNoteAssets;
  // "Load" pulls the published copy of your replay skin back down, which is
  // the only route to it in a browser that has never loaded it and the way
  // back after local edits. Once the draft IS that copy it has nothing to do,
  // so it says so instead of looking broken. Identity, not a deep compare:
  // every edit rebuilds the draft object, while comparing the stored payloads
  // called a skin "changed" the moment the format gained a field.

  const draftMatchesMyReplaySkin = Boolean(myReplaySkinRecord)
    && loadedCatalogSkin?.skin.id === myReplaySkinRecord?.skin.id
    && myReplaySkinDraftRef.current === draft;

  const persistPresets = (nextPresets: ReplaySkinPreset[]) => {
    setPresets(nextPresets);
    writeReplaySkinPresets(nextPresets);
  };

  const applyPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    // The draft slot reads as "Default" in the dropdown, so picking it with a
    // skin loaded has to mean the built-in one. It used to only relabel the
    // slot: the art stayed in the draft, the preview kept drawing it, and
    // Apply wrote the same skin straight back through the pointer. A draft
    // that carries no skin art is still the user's own work, so leave it be.
    if (presetId === DRAFT_PRESET_ID) {
      if (!loadedCatalogSkin && !replaySkinSettingsEmbedAssets(draft)) return;
      if (selectedPreset?.community && replaySkinSettingsEmbedAssets(draft)) {
        rememberHydratedPreset(
          selectedPreset,
          draft,
          loadedCatalogSkin?.archive ?? null,
          pendingSkinSoundsRef.current?.sounds ?? null,
        );
      }
      pendingSkinSoundsRef.current = null;
      setLoadedCatalogSkin(null);
      setDraft(DEFAULT_REPLAY_SKIN_SETTINGS);
      setDraftPresetName(DEFAULT_DRAFT_PRESET_NAME);
      setActiveColor(null);
      pushStatus(t`Loaded the built-in skin`);
      return;
    }
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    if (preset.community) {
      void applyCommunityPreset(preset, preset.community);
      return;
    }
    // A plain preset replaces the draft wholesale, so whatever archive was
    // open is no longer where the draft's art came from. Keeping it paired a
    // later "New preset" or publish with the wrong skin.
    setLoadedCatalogSkin(null);
    setDraft(preset.settings);
    setDraftPresetName(DEFAULT_DRAFT_PRESET_NAME);
    setActiveColor(null);
    pushStatus(`Loaded ${preset.name}`);
  };

  // A reopened editor lands on the applied skin's preset with its art already
  // in the draft but no .osk open, which is what hid the Assets tab and left
  // "Set as my replay skin" dead. Pull the archive back quietly (session and
  // HTTP cached, so it is the same file the page already fetched).
  //
  // The draft can also arrive WITHOUT the art: the page that owns the settings
  // rebuilds it asynchronously from the pointer, so an editor opened first, or
  // opened after a failed rebuild, holds the asset-free copy while the preset
  // name still says the skin is loaded. Rebuild it here from the same archive
  // rather than letting the editor edit (and Apply save) a stripped skin.
  const communityPresetSkin = selectedPreset?.community?.skin ?? null;
  const communityPresetPayload = selectedPreset?.community?.payload ?? null;
  const draftMissingSkinArt = Boolean(communityPresetSkin) && !replaySkinSettingsEmbedAssets(draft);
  useEffect(() => {
    if (!communityPresetSkin) return;
    if (communityBusy) return;
    // Id-compared, not presence-checked: an archive from a different skin
    // being open must not satisfy this preset's need for its own.
    if (loadedCatalogSkin?.skin.id === communityPresetSkin.id && !draftMissingSkinArt) return;
    let cancelled = false;
    void getArchiveForSkin(communityPresetSkin).then(async (archive) => {
      if (cancelled || !archive) return;
      setLoadedCatalogSkin((current) => (
        current?.skin.id === communityPresetSkin.id ? current : { skin: communityPresetSkin, archive }
      ));
      if (!draftMissingSkinArt || !communityPresetPayload) {
        if (selectedPreset) rememberHydratedPreset(selectedPreset, draft, archive);
        return;
      }
      const rebuilt = await rehydrateOwnerReplaySkinSettings(communityPresetPayload, archive);
      if (cancelled || !rebuilt || !replaySkinSettingsEmbedAssets(rebuilt)) return;
      setDraft(rebuilt);
      if (selectedPreset) rememberHydratedPreset(selectedPreset, rebuilt, archive);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityPresetSkin?.id, selectedPreset?.id, loadedCatalogSkin, communityBusy, draftMissingSkinArt]);

  const createPresetFromDraft = () => {
    setPromptDialog({
      title: t`New preset`,
      label: t`Preset name`,
      initial: selectedPreset?.name
        ? t`${selectedPreset.name} copy`
        : draftPresetName === DEFAULT_DRAFT_PRESET_NAME ? t`My mania skin` : draftPresetName,
      placeholder: t`My mania skin`,
      confirmLabel: t`Create`,
      onSubmit: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        // With the draft's art coming from a community skin, the new preset
        // keeps the skin link and stores the dehydrated payload; embedded
        // data URLs must never land in the localStorage preset store. An
        // art-free draft stays plain even with an archive open - a pointer
        // would resurrect art the user does not have in front of them.
        let preset: ReplaySkinPreset;
        if (loadedCatalogSkin && replaySkinSettingsEmbedAssets(draft)) {
          const payload = dehydrateReplaySkinSettings(draft);
          preset = createReplaySkinPreset(trimmed, normalizeReplaySkinSettings(payload.settings), {
            skin: loadedCatalogSkin.skin,
            payload,
          });
        } else {
          preset = createReplaySkinPreset(trimmed, draft);
        }
        if (preset.community && loadedCatalogSkin) {
          rememberHydratedPreset(
            preset,
            draft,
            loadedCatalogSkin.archive,
            pendingSkinSoundsRef.current?.sounds ?? null,
          );
        }
        persistPresets([preset, ...presets].slice(0, 24));
        setSelectedPresetId(preset.id);
        setDraftPresetName(DEFAULT_DRAFT_PRESET_NAME);
        pushStatus(t`Created ${preset.name}`);
      },
    });
  };

  const renameSelectedPreset = () => {
    const target = selectedPreset;
    setPromptDialog({
      title: target ? t`Rename preset` : t`Name preset`,
      label: t`Preset name`,
      initial: target?.name ?? draftPresetName,
      placeholder: target?.name ?? t`My mania skin`,
      confirmLabel: t`Rename`,
      onSubmit: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        if (!target) {
          setDraftPresetName(trimmed.slice(0, 80));
          pushStatus(t`Named ${trimmed.slice(0, 80)}`);
          return;
        }
        const nextPreset = {
          ...target,
          name: trimmed.slice(0, 80),
          updatedAt: Date.now(),
        };
        persistPresets(presets.map((preset) => preset.id === target.id ? nextPreset : preset));
        pushStatus(t`Renamed to ${nextPreset.name}`);
      },
    });
  };

  const deleteSelectedPreset = () => {
    if (!selectedPreset) return;
    hydratedPresetCacheRef.current.delete(selectedPreset.id);
    persistPresets(presets.filter((preset) => preset.id !== selectedPreset.id));
    setSelectedPresetId(DRAFT_PRESET_ID);
    setDraftPresetName(DEFAULT_DRAFT_PRESET_NAME);
    pushStatus(t`Deleted ${selectedPreset.name}`);
  };

  const exportDraft = () => {
    const name = selectedPreset?.name ?? draftPresetName;
    // Art from a community skin travels as its rebuild pointer: the code
    // stays a pasteable size and the importer re-downloads the .osk instead
    // of trusting megabytes of base64. Only public skins qualify (a private
    // summary's URLs carry the owner's capability token); art with no known
    // source still embeds, as the code is its only carrier.
    const sourceSkin = loadedCatalogSkin?.skin ?? selectedPreset?.community?.skin ?? null;
    let key: string;
    if (sourceSkin && sourceSkin.visibility === "public" && replaySkinSettingsEmbedAssets(draft)) {
      const payload = dehydrateReplaySkinSettings(draft);
      key = createReplaySkinShareKey(name, normalizeReplaySkinSettings(payload.settings), {
        skin: sourceSkin,
        payload,
      });
    } else {
      key = createReplaySkinShareKey(name, draft);
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(key).then(
        () => pushStatus(t`Share code copied`),
        () => setKeyDialog({ title: t`Share code`, value: key }),
      );
    } else {
      setKeyDialog({ title: t`Share code`, value: key });
    }
  };

  const importShareKey = () => {
    setPromptDialog({
      title: t`Import share code`,
      label: t`Paste share code`,
      initial: "",
      placeholder: "mhreplay2.…",
      confirmLabel: t`Import`,
      multiline: true,
      onSubmit: (key) => {
        const trimmed = key.trim();
        if (!trimmed) return;
        const payload = parseReplaySkinShareKey(trimmed);
        if (!payload) {
          pushStatus(t`That share code could not be imported`, "error");
          return;
        }
        // A code carrying a community pointer imports as the same kind of
        // preset the exporter had: asset-free settings in localStorage, art
        // re-downloaded from the catalog.
        if (payload.community) {
          const preset = createReplaySkinPreset(payload.name, payload.settings, payload.community);
          persistPresets([preset, ...presets].slice(0, 24));
          setActiveColor(null);
          void applyCommunityPreset(preset, payload.community);
          return;
        }
        // The imported settings replace the draft wholesale; an archive left
        // open from before is not where this art came from.
        setLoadedCatalogSkin(null);
        const preset = createReplaySkinPreset(payload.name, payload.settings);
        persistPresets([preset, ...presets].slice(0, 24));
        setDraft(payload.settings);
        setSelectedPresetId(preset.id);
        setActiveColor(null);
        pushStatus(t`Imported ${preset.name}`);
      },
    });
  };

  const save = () => {
    const normalized = normalizeReplaySkinSettings(draft);
    const normalizedOverlays = normalizeReplayOverlaySettings(overlayDraft);
    // Hitsounds staged by a community-skin import persist only on Apply;
    // writeReplaySkinSounds dispatches the change event itself, same as the
    // Audio tab's import flow.
    const pendingSounds = pendingSkinSoundsRef.current;
    if (pendingSounds) {
      pendingSkinSoundsRef.current = null;
      void writeReplaySkinSounds({
        skinName: pendingSounds.name,
        updatedAt: Date.now(),
        samples: pendingSounds.sounds,
      });
    }
    const namedDraft = draftPresetName.trim();
    let appliedCommunity: AppliedCommunitySkinDraft | null = null;
    if (selectedPreset) {
      // Community presets persist dehydrated (asset paths, no pixels);
      // regular presets keep the full normalized settings as before.
      let nextPreset: ReplaySkinPreset;
      if (selectedPreset.community) {
        const { payload, assetFree } = resolveCommunityPresetSave(normalized, selectedPreset.community.payload);
        nextPreset = {
          ...selectedPreset,
          settings: assetFree,
          community: { skin: selectedPreset.community.skin, payload },
          updatedAt: Date.now(),
        };
        appliedCommunity = { skin: selectedPreset.community.skin, payload, assetFree };
      } else if (loadedCatalogSkin && replaySkinSettingsEmbedAssets(normalized)) {
        // A plain preset whose art traces back to a loaded skin becomes a
        // community preset on save, same as "New preset" and the named draft.
        // Without this the art went into localStorage as data URLs, blew the
        // quota, and got stripped with nothing to rebuild it from.
        const payload = dehydrateReplaySkinSettings(normalized);
        const assetFree = normalizeReplaySkinSettings(payload.settings);
        nextPreset = {
          ...selectedPreset,
          settings: assetFree,
          community: { skin: loadedCatalogSkin.skin, payload },
          updatedAt: Date.now(),
        };
        rememberHydratedPreset(nextPreset, normalized, loadedCatalogSkin.archive, pendingSounds?.sounds ?? null);
        appliedCommunity = { skin: loadedCatalogSkin.skin, payload, assetFree };
      } else {
        nextPreset = { ...selectedPreset, settings: normalized, updatedAt: Date.now() };
      }
      persistPresets(presets.map((preset) => preset.id === selectedPreset.id ? nextPreset : preset));
    } else if (namedDraft && namedDraft !== DEFAULT_DRAFT_PRESET_NAME) {
      // The named draft gets the same treatment as "New preset": art from a
      // loaded community skin persists as a pointer, never as data URLs in
      // the preset store (where a quota-stripped copy has nothing to rebuild
      // from).
      let preset: ReplaySkinPreset;
      if (loadedCatalogSkin && replaySkinSettingsEmbedAssets(normalized)) {
        const payload = dehydrateReplaySkinSettings(normalized);
        preset = createReplaySkinPreset(namedDraft, normalizeReplaySkinSettings(payload.settings), {
          skin: loadedCatalogSkin.skin,
          payload,
        });
        rememberHydratedPreset(preset, normalized, loadedCatalogSkin.archive, pendingSounds?.sounds ?? null);
        appliedCommunity = { skin: loadedCatalogSkin.skin, payload, assetFree: preset.settings };
      } else {
        preset = createReplaySkinPreset(namedDraft, normalized);
      }
      persistPresets([preset, ...presets].slice(0, 24));
    }
    // Draft slot with a community skin loaded: the applied settings still
    // embed its art, so they still need the pointer to persist.
    if (!appliedCommunity && loadedCatalogSkin && replaySkinSettingsEmbedAssets(normalized)) {
      const payload = dehydrateReplaySkinSettings(normalized);
      appliedCommunity = {
        skin: loadedCatalogSkin.skin,
        payload,
        assetFree: normalizeReplaySkinSettings(payload.settings),
      };
    }
    onSave(normalized, appliedCommunity);
    onSaveOverlays(normalizedOverlays);
    onClose();
  };

  const columns = Array.from({ length: selectedKeyCount }, (_, index) => index);
  const showBaseColorControls = draft.style !== "bars";
  const showLnHeadColorControls = draft.style !== "bars";
  const showOutlineControls = draft.style === "circles" || draft.style === "arrows";
  const columnColorKinds: OverrideKind[] = showLnHeadColorControls ? ["tap", "lnHead"] : ["tap"];
  const hasBarColorOverrides = draft.style === "bars" && profile.tapColors.some((color) => color);
  const barColorSwitchChecked = draft.style === "bars" ? hasBarColorOverrides || columnEditorOpen : columnEditorOpen;
  const overrideColors = overrideKind === "tap" ? profile.tapColors : profile.lnHeadColors;
  const overrideBaseColor = overrideKind === "tap" ? profile.tapColor : profile.lnHeadColor;
  const defaultBarColors = fallbackPreviewBarColors(selectedKeyCount);
  const overrideBaseColorForColumn = (col: number) => (
    draft.style === "bars" && overrideKind === "tap"
      ? defaultBarColors[col] ?? profile.tapColor
      : overrideBaseColor
  );
  const primarySelected = selectedColumns[0] ?? 0;
  const selectedValues = selectedColumns.map((col) => overrideColors[col] || overrideBaseColorForColumn(col));
  const allSelectedSameValue = selectedValues.every((value) => value === selectedValues[0]);
  const overrideValue = allSelectedSameValue
    ? selectedValues[0] ?? overrideBaseColorForColumn(primarySelected)
    : overrideColors[primarySelected] || overrideBaseColorForColumn(primarySelected);
  const anySelectedHasOverride = selectedColumns.some((col) => !!overrideColors[col]);

  const commitColumnWidthInput = () => {
    const parsed = Number(columnWidthInput);
    if (!Number.isFinite(parsed)) {
      setColumnWidthInput(String(profile.columnWidth));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_COLUMN_WIDTH, Math.min(REPLAY_SKIN_MAX_COLUMN_WIDTH, Math.round(parsed)));
    setColumnWidthInput(String(next));
    updateProfile({ columnWidth: next, columnWidths: [] });
  };

  const commitColumnSpacingInput = () => {
    const parsed = Number(columnSpacingInput);
    if (!Number.isFinite(parsed)) {
      setColumnSpacingInput(String(profile.columnSpacing));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_COLUMN_SPACING, Math.min(REPLAY_SKIN_MAX_COLUMN_SPACING, Math.round(parsed)));
    setColumnSpacingInput(String(next));
    updateProfile({ columnSpacing: next, columnSpacings: [] });
  };

  const commitColumnStartInput = () => {
    const parsed = Number(columnStartInput);
    if (!Number.isFinite(parsed)) {
      setColumnStartInput(String(columnStartValue));
      return;
    }
    const next = Math.max(0, Math.min(Math.round(OSU_MANIA_SCREEN_WIDTH), Math.round(parsed)));
    setColumnStartInput(String(next));
    updateProfile({ columnStart: next });
  };

  const commitNoteHeightScaleInput = () => {
    const parsed = Number(noteHeightScaleInput);
    if (!Number.isFinite(parsed)) {
      setNoteHeightScaleInput(String(profile.noteHeightScale));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE, Math.min(REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE, Math.round(parsed)));
    setNoteHeightScaleInput(String(next));
    updateProfile({ noteHeightScale: next });
  };

  const commitOutlineWidthInput = () => {
    const parsed = Number(outlineWidthInput);
    if (!Number.isFinite(parsed)) {
      setOutlineWidthInput(String(draft.outlineWidth));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_OUTLINE_WIDTH, Math.min(REPLAY_SKIN_MAX_OUTLINE_WIDTH, Math.round(parsed)));
    setOutlineWidthInput(String(next));
    update({ outlineWidth: next });
  };

  const commitHitPositionInput = () => {
    const parsed = Number(hitPositionInput);
    if (!Number.isFinite(parsed)) {
      setHitPositionInput(String(hitPositionValue));
      return;
    }
    const next = Math.max(OSU_MANIA_MIN_HIT_POSITION, Math.min(OSU_MANIA_MAX_HIT_POSITION, Math.round(parsed)));
    setHitPositionInput(String(next));
    updateStagePosition("hitPosition", osuManiaStagePositionToReplayPosition(next));
  };

  const commitScorePositionInput = () => {
    const parsed = Number(scorePositionInput);
    if (!Number.isFinite(parsed)) {
      setScorePositionInput(String(scorePositionValue));
      return;
    }
    const next = Math.max(OSU_MANIA_MIN_HIT_POSITION, Math.min(OSU_MANIA_MAX_HIT_POSITION, Math.round(parsed)));
    setScorePositionInput(String(next));
    updateStagePosition("scorePosition", osuManiaStagePositionToReplayPosition(next));
  };

  const commitComboPositionInput = () => {
    const parsed = Number(comboPositionInput);
    if (!Number.isFinite(parsed)) {
      setComboPositionInput(String(comboPositionValue));
      return;
    }
    const next = Math.max(OSU_MANIA_MIN_HIT_POSITION, Math.min(OSU_MANIA_MAX_HIT_POSITION, Math.round(parsed)));
    setComboPositionInput(String(next));
    updateStagePosition("comboPosition", osuManiaStagePositionToReplayPosition(next));
  };

  const commitJudgementScaleInput = () => {
    const parsed = Number(judgementScaleInput);
    if (!Number.isFinite(parsed)) {
      setJudgementScaleInput(String(currentJudgementScale));
      return;
    }
    const next = Math.max(REPLAY_SKIN_MIN_JUDGEMENT_SCALE, Math.min(REPLAY_SKIN_MAX_JUDGEMENT_SCALE, Math.round(parsed)));
    setJudgementScaleInput(String(next));
    updateJudgementScale(next);
  };

  const handleColumnWidthInputChange = (value: string) => {
    setColumnWidthInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_COLUMN_WIDTH || parsed > REPLAY_SKIN_MAX_COLUMN_WIDTH) return;
    updateProfile({ columnWidth: Math.round(parsed), columnWidths: [] });
  };

  const handleColumnSpacingInputChange = (value: string) => {
    setColumnSpacingInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_COLUMN_SPACING || parsed > REPLAY_SKIN_MAX_COLUMN_SPACING) return;
    updateProfile({ columnSpacing: Math.round(parsed), columnSpacings: [] });
  };

  const handleNoteHeightScaleInputChange = (value: string) => {
    setNoteHeightScaleInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE || parsed > REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE) return;
    updateProfile({ noteHeightScale: Math.round(parsed) });
  };

  const handleOutlineWidthInputChange = (value: string) => {
    setOutlineWidthInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_OUTLINE_WIDTH || parsed > REPLAY_SKIN_MAX_OUTLINE_WIDTH) return;
    update({ outlineWidth: Math.round(parsed) });
  };

  const handleHitPositionInputChange = (value: string) => {
    setHitPositionInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < OSU_MANIA_MIN_HIT_POSITION || parsed > OSU_MANIA_MAX_HIT_POSITION) return;
    updateStagePosition("hitPosition", osuManiaStagePositionToReplayPosition(Math.round(parsed)));
  };

  const handleScorePositionInputChange = (value: string) => {
    setScorePositionInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < OSU_MANIA_MIN_HIT_POSITION || parsed > OSU_MANIA_MAX_HIT_POSITION) return;
    updateStagePosition("scorePosition", osuManiaStagePositionToReplayPosition(Math.round(parsed)));
  };

  const handleComboPositionInputChange = (value: string) => {
    setComboPositionInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < OSU_MANIA_MIN_HIT_POSITION || parsed > OSU_MANIA_MAX_HIT_POSITION) return;
    updateStagePosition("comboPosition", osuManiaStagePositionToReplayPosition(Math.round(parsed)));
  };

  const handleJudgementScaleInputChange = (value: string) => {
    setJudgementScaleInput(value);
    if (value.trim() === "") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < REPLAY_SKIN_MIN_JUDGEMENT_SCALE || parsed > REPLAY_SKIN_MAX_JUDGEMENT_SCALE) return;
    updateJudgementScale(parsed);
  };

  if (typeof document === "undefined") return null;

  const colorTargetValue = (target: ColorTarget) =>
    target === "tap"
      ? profile.tapColor
      : target === "lnHead"
        ? profile.lnHeadColor
        : target === "outline"
          ? draft.outlineColor
          : draft.lnBodyColor;

  const colorTargetLabel: Record<ColorTarget, string> = {
    tap: t`Note color`,
    lnHead: t`LN head color`,
    lnBody: t`LN body color`,
    outline: t`Outline color`,
  };
  const showDevOverlayReset = activeTab === "overlays" && import.meta.env.DEV;
  const comboFontOptions = REPLAY_COMBO_FONT_SETS.map((set, index) => ({
    value: set,
    label: t`Set ${index + 1}`,
    style: getComboFontPreviewStyle(set),
  }));
  return createPortal(
    <>
      <motion.div
        className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onClick={onClose}
      />
      <motion.div
        ref={modalRef}
        className={`fixed z-[111] flex flex-col overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl ${
          windowRect ? "" : "pointer-events-none opacity-0"
        }`}
        style={{
          left: windowRect?.x ?? -9999,
          top: windowRect?.y ?? -9999,
          width: windowRect?.w ?? WINDOW_DEFAULT_WIDTH,
          height: windowRect?.h ?? WINDOW_DEFAULT_HEIGHT,
        }}
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="select-none border-b border-osu-b3/50 bg-osu-b4">
          <div
            onPointerDown={handleHeaderPointerDown}
            onPointerMove={handleHeaderPointerMove}
            onPointerUp={handleHeaderPointerEnd}
            onPointerCancel={handleHeaderPointerEnd}
            className="flex cursor-grab touch-none items-center gap-3 px-5 pb-3 pt-4 active:cursor-grabbing sm:pb-2.5"
          >
            <GripHorizontal className="h-4 w-4 shrink-0 text-osu-f1" />
            <h3 className="text-base font-bold text-white">
              {saveScope === "owner" ? t`Customize my replay skin` : t`Replay settings`}
            </h3>
            <button
              onClick={onClose}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={t`Close replay settings`}
              data-window-no-drag
              className="relative z-20 ml-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-osu-b3/50 text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
            >
              <X className="h-4 w-4" strokeWidth={2.4} />
            </button>
          </div>
          <div
            className="flex overflow-x-auto px-5 scrollbar-hide"
            data-window-no-drag
            onPointerDown={(e) => e.stopPropagation()}
          >
            {([
              ["style", t`Style`],
              ["layout", t`Layout`],
              ...(showHudTab ? ([["hud", t`HUD`]] as const) : []),
              ["overlays", t`Overlays`],
              ["audio", t`Audio`],
              // Only with an archive to pick from - the assetArchive prop or a
              // community skin loaded this session; otherwise five tabs.
              ...(activeAssetArchive ? ([["assets", t`Assets`]] as const) : []),
            ] as ReadonlyArray<readonly [ReplaySkinSettingsTab, string]>).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`relative cursor-pointer px-4 py-2.5 text-[12px] font-semibold transition-colors duration-[120ms] ${
                  activeTab === tab ? "text-osu-c1" : "text-osu-f1 hover:text-osu-l2"
                }`}
              >
                {label}
                {activeTab === tab ? (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-osu-h1"
                  />
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div
          className={`grid min-h-0 flex-1 ${isCompactWindow || isFullWidthTab ? "grid-cols-1 overflow-y-auto" : ""}`}
          style={contentGridStyle}
        >
          <div className={`space-y-4 ${isCompactWindow ? "overflow-visible p-4 sm:p-5" : "overflow-y-auto p-5"}`}>
            <div className={`grid gap-3 md:grid-cols-[minmax(0,1fr)_110px] ${activeTab === "audio" ? "hidden" : ""}`}>
              <div className="min-w-0 space-y-2">
                <FancySelect
                  label={t`Skin preset`}
                  value={selectedPresetId}
                  onChange={applyPreset}
                  options={[
                    { value: DRAFT_PRESET_ID, label: draftPresetName },
                    ...presets.map((preset) => ({ value: preset.id, label: preset.name })),
                  ]}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <PresetTextButton label={t`New preset`} onClick={createPresetFromDraft}>
                    <Plus className="h-3.5 w-3.5" />
                    {t`New`}
                  </PresetTextButton>
                  <PresetIconButton label={t`Rename preset`} onClick={renameSelectedPreset}>
                    <Pencil className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <PresetIconButton label={t`Delete preset`} onClick={deleteSelectedPreset} disabled={!selectedPreset}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <span className="h-5 w-px bg-osu-b3/50" />
                  <PresetIconButton label={t`Copy share code`} onClick={exportDraft}>
                    <Copy className="h-3.5 w-3.5" />
                  </PresetIconButton>
                  <PresetIconButton label={t`Import share code`} onClick={importShareKey}>
                    <Upload className="h-3.5 w-3.5" />
                  </PresetIconButton>
                </div>
              </div>
              <FancySelect
                label={t`Keymode`}
                value={String(selectedKeyCount)}
                onChange={(value) => setSelectedKeyCount(Number(value))}
                options={Array.from({ length: 10 }, (_, index) => ({
                  value: String(index + 1),
                  label: `${index + 1}K`,
                }))}
              />
            </div>

            {activeTab === "style" ? (
              <>
                {/* Two subjects, so two sections: the skin open in this
                    editor, and the one published on your profile. Sharing a
                    card made "Load into editor" read as acting on the skin
                    named above it rather than on your own. */}
                {saveScope === "viewer" && liveBackendAvailable ? (
                  <section>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1">{t`Custom skin`}</div>
                    <div className="space-y-2 rounded-lg border border-osu-b3/50 bg-osu-b5/35 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          {communitySkinContext?.previewUrl && communityBusy !== "import" && communityBusy !== "preset" ? (
                            <img
                              src={communitySkinContext.previewUrl}
                              alt=""
                              draggable={false}
                              className="h-6 w-10 shrink-0 rounded object-cover"
                            />
                          ) : null}
                          <span className="min-w-0 truncate text-xs font-semibold text-osu-l1">
                            {communityBusy === "import"
                              ? t`Importing… ${importProgress ?? 0}%`
                              : communityBusy === "preset"
                                ? t`Loading skin…`
                                : communitySkinContext
                                  ? t`${communitySkinContext.name} loaded`
                                  : t`No skin loaded in the editor`}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSkinBrowserOpen(true)}
                          disabled={communityBusy != null}
                          className="shrink-0 cursor-pointer rounded-lg bg-osu-b3/50 px-3 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white disabled:cursor-default disabled:opacity-50"
                        >
                          {t`Browse skins`}
                        </button>
                      </div>
                      <p className="text-[11px] leading-relaxed text-osu-f1/80">
                        {t`Picking a skin loads it into the editor and saves it as a preset under its name.`}
                      </p>
                      {communitySkinContext && communityBusy == null && !keymodeHasSkinArt ? (
                        <p className="text-[11px] leading-relaxed text-osu-yellow">
                          <Trans>This skin has no {selectedKeyCount}K art, so {selectedKeyCount}K plays render flat shapes with its colors instead.</Trans>
                        </p>
                      ) : null}
                    </div>
                  </section>
                ) : null}
                {saveScope === "viewer" && liveBackendAvailable ? (
                  <section>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1">{t`My replay skin`}</div>
                    <div className="space-y-2 rounded-lg border border-osu-b3/50 bg-osu-b5/35 p-3">
                      {viewerId ? (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              {myReplaySkinRecord?.skin.previewUrl ? (
                                <img
                                  src={myReplaySkinRecord.skin.previewUrl}
                                  alt=""
                                  draggable={false}
                                  className="h-6 w-10 shrink-0 rounded object-cover"
                                />
                              ) : null}
                              <span className="min-w-0 truncate text-xs font-semibold text-osu-l1">
                                {myReplaySkinRecord ? myReplaySkinRecord.skin.name : t`None set`}
                              </span>
                            </div>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {myReplaySkinRecord ? (
                                <button
                                  type="button"
                                  onClick={() => void loadMyReplaySkinIntoDraft()}
                                  disabled={communityBusy != null || draftMatchesMyReplaySkin}
                                  title={draftMatchesMyReplaySkin
                                    ? t`The editor already holds ${myReplaySkinRecord.skin.name}`
                                    : t`Replace the draft with ${myReplaySkinRecord.skin.name}`}
                                  className="cursor-pointer rounded-lg bg-osu-b3/50 px-3 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white disabled:cursor-default disabled:opacity-50"
                                >
                                  {communityBusy === "load-mine" ? t`Loading…` : t`Load into editor`}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void saveDraftAsMyReplaySkin()}
                                disabled={!communitySkinContext || communityBusy != null || draftMatchesMyReplaySkin}
                                title={draftMatchesMyReplaySkin
                                  ? t`This exact version is already your replay skin`
                                  : t`Saves the current draft as-is; everyone watching your replays sees it`}
                                className="cursor-pointer rounded-lg border border-osu-pink/40 bg-osu-pink/10 px-3 py-1.5 text-xs font-semibold text-osu-pink-light transition-colors hover:border-osu-pink hover:bg-osu-pink/20 hover:text-white disabled:cursor-default disabled:opacity-45 disabled:hover:border-osu-pink/40 disabled:hover:bg-osu-pink/10 disabled:hover:text-osu-pink-light"
                              >
                                {communityBusy === "save-mine"
                                  ? t`Saving…`
                                  : draftMatchesMyReplaySkin
                                    ? t`Already set`
                                    : myReplaySkinRecord?.skin.id === communitySkinContext?.id
                                      ? t`Save changes for everyone`
                                      : t`Set as my replay skin`}
                              </button>
                            </span>
                          </div>
                          <p className="text-[11px] leading-relaxed text-osu-f1/80">
                            {t`Everyone watching your replays sees this skin.`}
                          </p>
                        </>
                      ) : (
                        <p className="text-[11px] leading-relaxed text-osu-f1">
                          {t`Sign in to set a replay skin for your plays.`}
                        </p>
                      )}
                    </div>
                  </section>
                ) : null}
                {/* A loaded skin brings its own notes, colours and LN caps, so
                    the built-in shapes and the colour/trim switches have
                    nothing left to act on. */}
                {keymodeHasSkinArt ? null : (
                  <section>
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1">{t`Note shape`}</div>
                    <div className="grid grid-cols-3 gap-2">
                      <ReplaySkinShapeButton
                        active={draft.style === "circles"}
                        icon={<ReplaySkinShapeIcon style={MANIA_CIRCLE_ICON_STYLE} />}
                        label={t`Circles`}
                        onClick={() => updateStyle("circles")}
                      />
                      <ReplaySkinShapeButton
                        active={draft.style === "bars"}
                        icon={<ReplaySkinShapeIcon style={MANIA_BAR_ICON_STYLE} />}
                        label={t`Bars`}
                        onClick={() => updateStyle("bars")}
                      />
                      <ReplaySkinShapeButton
                        active={draft.style === "arrows"}
                        icon={<ReplaySkinShapeIcon style={MANIA_ARROW_ICON_STYLE} />}
                        label={t`Arrows`}
                        onClick={() => updateStyle("arrows")}
                      />
                    </div>
                  </section>
                )}

                {showBaseColorControls ? (
                  <section className="space-y-2 pt-2">
                    <ReplaySkinColorRow
                      label={t`Note color`}
                      title={t`Base tap color used for any column without a per-column override.`}
                      value={profile.tapColor}
                      selected={activeColor === "tap"}
                      onOpen={() => setActiveColor((current) => (current === "tap" ? null : "tap"))}
                    />
                    <ReplaySkinColorRow
                      label={t`LN Head color`}
                      title={t`Base LN head color used for any column without a per-column override.`}
                      value={profile.lnHeadColor}
                      selected={activeColor === "lnHead"}
                      onOpen={() => setActiveColor((current) => (current === "lnHead" ? null : "lnHead"))}
                    />
                    <ReplaySkinColorRow
                      label={t`LN Body color`}
                      title={t`Color of the LN body. Always global (no per-column override).`}
                      value={draft.lnBodyColor}
                      selected={activeColor === "lnBody"}
                      onOpen={() => setActiveColor((current) => (current === "lnBody" ? null : "lnBody"))}
                    />
                  </section>
                ) : null}

                {showOutlineControls ? (
                  <section className="space-y-3 pt-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-osu-l1">{t`Outline`}</span>
                      <ReplaySkinSwitch checked={draft.outlineEnabled} onChange={(checked) => update({ outlineEnabled: checked })} />
                    </div>
                    {draft.outlineEnabled ? (
                      <>
                        <ReplaySkinColorRow
                          label={t`Outline color`}
                          title={t`Stroke color for circle and arrow notes.`}
                          value={draft.outlineColor}
                          selected={activeColor === "outline"}
                          onOpen={() => setActiveColor((current) => (current === "outline" ? null : "outline"))}
                        />
                        <LayoutNumberControl
                          label={t`Outline width`}
                          inputValue={outlineWidthInput}
                          numericValue={draft.outlineWidth}
                          min={REPLAY_SKIN_MIN_OUTLINE_WIDTH}
                          max={REPLAY_SKIN_MAX_OUTLINE_WIDTH}
                          defaultValue={REPLAY_SKIN_DEFAULT_OUTLINE_WIDTH}
                          onSliderChange={(value) => update({ outlineWidth: value })}
                          onInputChange={handleOutlineWidthInputChange}
                          onCommit={commitOutlineWidthInput}
                          onResetToDefault={() => update({ outlineWidth: REPLAY_SKIN_DEFAULT_OUTLINE_WIDTH })}
                        />
                      </>
                    ) : null}
                  </section>
                ) : null}

                <section className="space-y-3 pt-1">
                  {keymodeHasSkinArt ? null : (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-osu-l1">{draft.style === "bars" ? t`Bar colors` : t`Per-column colors`}</span>
                        <span className="flex items-center gap-2">
                          <ReplaySkinSwitch
                            checked={barColorSwitchChecked}
                            onChange={(checked) => {
                              if (draft.style !== "bars") {
                                setColumnEditorOpen(checked);
                                return;
                              }
                              if (checked) {
                                enableBarColorOverrides();
                              } else {
                                disableBarColorOverrides();
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setColumnEditorOpen((value) => !value)}
                            aria-label={t`Edit per-column colors`}
                            className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border border-osu-b3/60 bg-osu-b5/70 text-osu-f1 transition-colors hover:border-osu-b2 hover:text-white"
                          >
                            <Settings className="h-4 w-4" />
                          </button>
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-osu-l1">{t`Cut LN tail`}</span>
                        <ReplaySkinSwitch checked={draft.percy} onChange={(checked) => update({ percy: checked })} />
                      </div>
                    </>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-osu-l1">{t`Upscroll`}</span>
                    <ReplaySkinSwitch checked={draft.upscroll} onChange={(checked) => update({ upscroll: checked })} />
                  </div>
                </section>
              </>
            ) : activeTab === "layout" ? (
              <section className="space-y-5">
                <LayoutNumberControl
                  label={t`Column width`}
                  inputValue={columnWidthInput}
                  numericValue={profile.columnWidth}
                  min={REPLAY_SKIN_MIN_COLUMN_WIDTH}
                  max={REPLAY_SKIN_MAX_COLUMN_WIDTH}
                  defaultValue={30}
                  onSliderChange={(value) => updateProfile({ columnWidth: value, columnWidths: [] })}
                  onInputChange={handleColumnWidthInputChange}
                  onCommit={commitColumnWidthInput}
                  onResetToDefault={() => updateProfile({ columnWidth: 30, columnWidths: [] })}
                />
                <LayoutNumberControl
                  label={t`Column spacing`}
                  inputValue={columnSpacingInput}
                  numericValue={profile.columnSpacing}
                  min={REPLAY_SKIN_MIN_COLUMN_SPACING}
                  max={REPLAY_SKIN_MAX_COLUMN_SPACING}
                  defaultValue={0}
                  onSliderChange={(value) => updateProfile({ columnSpacing: value, columnSpacings: [] })}
                  onInputChange={handleColumnSpacingInputChange}
                  onCommit={commitColumnSpacingInput}
                  onResetToDefault={() => updateProfile({ columnSpacing: 0, columnSpacings: [] })}
                />
                <LayoutNumberControl
                  label={t`Column start`}
                  inputValue={columnStartInput}
                  numericValue={columnStartValue}
                  min={0}
                  max={Math.round(OSU_MANIA_SCREEN_WIDTH)}
                  defaultValue={centeredColumnStart}
                  onSliderChange={(value) => updateProfile({ columnStart: value })}
                  onInputChange={setColumnStartInput}
                  onCommit={commitColumnStartInput}
                  onResetToDefault={() => updateProfile({ columnStart: null })}
                  hint={t`Stage's left edge, skin.ini ColumnStart.`}
                />
                {showNoteHeightScale ? (
                  <LayoutNumberControl
                    label={t`Note height`}
                    inputValue={noteHeightScaleInput}
                    numericValue={profile.noteHeightScale}
                    min={REPLAY_SKIN_MIN_NOTE_HEIGHT_SCALE}
                    max={REPLAY_SKIN_MAX_NOTE_HEIGHT_SCALE}
                    defaultValue={noteHeightDefault}
                    onSliderChange={(value) => updateProfile({ noteHeightScale: value })}
                    onInputChange={handleNoteHeightScaleInputChange}
                    onCommit={commitNoteHeightScaleInput}
                    onResetToDefault={() => updateProfile({ noteHeightScale: noteHeightDefault })}
                    hint={draft.style === "bars" ? t`Bar note height.` : t`Imported note image height scaling.`}
                  />
                ) : null}
                <LayoutNumberControl
                  label={t`Hit position`}
                  inputValue={hitPositionInput}
                  numericValue={hitPositionValue}
                  min={OSU_MANIA_MIN_HIT_POSITION}
                  max={OSU_MANIA_MAX_HIT_POSITION}
                  defaultValue={402}
                  onSliderChange={(value) => updateStagePosition("hitPosition", osuManiaStagePositionToReplayPosition(value))}
                  onInputChange={handleHitPositionInputChange}
                  onCommit={commitHitPositionInput}
                  onResetToDefault={() => resetStagePosition("hitPosition", 402)}
                  hint={t`Higher values move receptors lower.`}
                />
                <LayoutNumberControl
                  label={t`ScorePosition`}
                  inputValue={scorePositionInput}
                  numericValue={scorePositionValue}
                  min={OSU_MANIA_MIN_HIT_POSITION}
                  max={OSU_MANIA_MAX_HIT_POSITION}
                  defaultValue={OSU_MANIA_DEFAULT_SCORE_POSITION}
                  onSliderChange={(value) => updateStagePosition("scorePosition", osuManiaStagePositionToReplayPosition(value))}
                  onInputChange={handleScorePositionInputChange}
                  onCommit={commitScorePositionInput}
                  onResetToDefault={() => resetStagePosition("scorePosition", OSU_MANIA_DEFAULT_SCORE_POSITION)}
                  hint={t`Hitburst and judgement height.`}
                />
                {showHudTab ? null : (
                  <LayoutNumberControl
                    label={t`Judgement size`}
                    inputValue={judgementScaleInput}
                    numericValue={currentJudgementScale}
                    min={REPLAY_SKIN_MIN_JUDGEMENT_SCALE}
                    max={REPLAY_SKIN_MAX_JUDGEMENT_SCALE}
                    defaultValue={REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE}
                    onSliderChange={updateJudgementScale}
                    onInputChange={handleJudgementScaleInputChange}
                    onCommit={commitJudgementScaleInput}
                    onResetToDefault={() => updateJudgementScale(REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE)}
                    hint={t`Scales the skin's hitburst art.`}
                  />
                )}
                <LayoutNumberControl
                  label={t`ComboPosition`}
                  inputValue={comboPositionInput}
                  numericValue={comboPositionValue}
                  min={OSU_MANIA_MIN_HIT_POSITION}
                  max={OSU_MANIA_MAX_HIT_POSITION}
                  defaultValue={OSU_MANIA_DEFAULT_COMBO_POSITION}
                  onSliderChange={(value) => updateStagePosition("comboPosition", osuManiaStagePositionToReplayPosition(value))}
                  onInputChange={handleComboPositionInputChange}
                  onCommit={commitComboPositionInput}
                  onResetToDefault={() => resetStagePosition("comboPosition", OSU_MANIA_DEFAULT_COMBO_POSITION)}
                  hint={t`Combo counter height.`}
                />
              </section>
            ) : activeTab === "hud" ? (
              <section className="space-y-4">
                {/* The built-in fonts are what the counter falls back to. A
                    skin that ships its own digits draws those instead, so the
                    picker and its sample would only misrepresent the stage. */}
                {keymodeHasComboArt ? null : (
                  <div className="rounded-lg border border-osu-b3/50 bg-osu-b5/35 p-3">
                    <FancySelect
                      label={t`Combo font`}
                      value={draft.comboFontSet}
                      onChange={(value) => update({ comboFontSet: value as ReplaySkinSettings["comboFontSet"] })}
                      options={comboFontOptions}
                    />
                    <div className="mt-3 flex h-20 items-center justify-center rounded-lg border border-osu-b3/40 bg-black/20">
                      <span
                        className="text-4xl text-white"
                        style={getComboFontPreviewStyle(draft.comboFontSet)}
                      >
                        123x
                      </span>
                    </div>
                  </div>
                )}
                <div className="rounded-lg border border-osu-b3/50 bg-osu-b5/35 p-3">
                  <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-osu-f1">{t`Judgement set`}</span>
                  <JudgementSetGallery
                    value={draft.judgementSet}
                    onChange={(value) => update({ judgementSet: value })}
                    scaleInputValue={judgementScaleInput}
                    numericScale={currentJudgementScale}
                    onScaleSliderChange={updateJudgementScale}
                    onScaleInputChange={handleJudgementScaleInputChange}
                    onScaleCommit={commitJudgementScaleInput}
                    onScaleReset={() => updateJudgementScale(REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE)}
                  />
                </div>
              </section>
            ) : activeTab === "overlays" ? (
              <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {REPLAY_OVERLAY_IDS.map((id) => (
                  <ReplayOverlaySettingsRow
                    key={id}
                    id={id}
                    placement={overlayDraft[id]}
                    onChange={(patch) => updateOverlay(id, patch)}
                  />
                ))}
              </section>
            ) : activeTab === "assets" && activeAssetArchive ? (
              <section className="space-y-4">
                <p className="text-[11px] leading-relaxed text-osu-f1">
                  <Trans>Swap any element for another image from {activeAssetSourceName ?? t`this skin`}, or click it in the
                  preview to find its row. Note and key art draws under the Bars style; cleared elements fall back to
                  flat shapes.</Trans>
                </p>
                {columns.map((column) => (
                  <div key={`asset-column-${column}`} className="rounded-lg border border-osu-b3/50 bg-osu-b5/35 p-3">
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1"><Trans>Column {column + 1}</Trans></div>
                    <div className="space-y-1.5">
                      {ASSET_COLUMN_ROWS.map(({ key, label }) => (
                        <ReplaySkinAssetRow
                          key={key}
                          rowId={`column:${column}:${key}`}
                          highlighted={highlightedAssetId === `column:${column}:${key}`}
                          label={i18n._(label)}
                          asset={profile.assets.columns[column]?.[key]}
                          onChange={() => setAssetPicker({ kind: "column", column, assetKey: key, label: i18n._(label) })}
                          onClear={() => applyAssetPick({ kind: "column", column, assetKey: key, label: i18n._(label) }, undefined, false)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div className="rounded-lg border border-osu-b3/50 bg-osu-b5/35 p-3">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1">{t`Judgements`}</div>
                  <div className="space-y-1.5">
                    {ASSET_JUDGEMENT_ROWS.map(({ key, label }) => (
                      <ReplaySkinAssetRow
                        key={key}
                        rowId={`judgement:${key}`}
                        highlighted={highlightedAssetId === `judgement:${key}`}
                        label={i18n._(label)}
                        asset={profile.assets.judgements[key]}
                        onChange={() => setAssetPicker({ kind: "judgement", assetKey: key, label: i18n._(label) })}
                        onClear={() => applyAssetPick({ kind: "judgement", assetKey: key, label: i18n._(label) }, undefined, false)}
                      />
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border border-osu-b3/50 bg-osu-b5/35 p-3">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-osu-f1">{t`Stage`}</div>
                  <div className="space-y-1.5">
                    {ASSET_STAGE_ROWS.map(({ key, label }) => (
                      <ReplaySkinAssetRow
                        key={key}
                        rowId={`stage:${key}`}
                        highlighted={highlightedAssetId === `stage:${key}`}
                        label={i18n._(label)}
                        asset={profile.assets.stage[key]}
                        onChange={() => setAssetPicker({ kind: "stage", assetKey: key, label: i18n._(label) })}
                        onClear={() => applyAssetPick({ kind: "stage", assetKey: key, label: i18n._(label) }, undefined, false)}
                      />
                    ))}
                  </div>
                </div>
              </section>
            ) : (
              <section className="max-w-xl space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="text-sm font-semibold text-osu-l1">{t`Hitsounds`}</span>
                    <div className="text-[10px] text-osu-f1">{t`Key presses play the note's hitsound, like in game. Misses trigger the combo break sound.`}</div>
                  </div>
                  <ReplaySkinSwitch
                    checked={audioSettings.hitsoundsEnabled}
                    onChange={(checked) => updateAudioSettings({ hitsoundsEnabled: checked })}
                  />
                </div>

                <div className={`space-y-4 ${audioSettings.hitsoundsEnabled ? "" : "pointer-events-none opacity-40"}`}>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <span className="text-sm font-semibold text-osu-l1">{t`Beatmap hitsounds`}</span>
                        <div className="text-[10px] text-osu-f1">{t`The map's own samples and keysounds, when it has them.`}</div>
                      </div>
                      <ReplaySkinSwitch
                        checked={audioSettings.beatmapHitsounds}
                        onChange={(checked) => updateAudioSettings({ beatmapHitsounds: checked })}
                      />
                    </div>
                    <div className={audioSettings.beatmapHitsounds ? "" : "pointer-events-none opacity-40"}>
                      <HitsoundVolumeSlider
                        value={audioSettings.beatmapHitsoundVolume}
                        onChange={(volume) => updateAudioSettings({ beatmapHitsoundVolume: volume })}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <span className="text-sm font-semibold text-osu-l1">{t`Key press hitsounds`}</span>
                        <div className="text-[10px] text-osu-f1">{t`Press feedback from your skin or the default samples. Turn off to hear only the map's own hitsounds.`}</div>
                      </div>
                      <ReplaySkinSwitch
                        checked={audioSettings.keypressHitsounds}
                        onChange={(checked) => updateAudioSettings({ keypressHitsounds: checked })}
                      />
                    </div>
                    <div className={audioSettings.keypressHitsounds ? "" : "pointer-events-none opacity-40"}>
                      <HitsoundVolumeSlider
                        value={audioSettings.keypressHitsoundVolume}
                        onChange={(volume) => updateAudioSettings({ keypressHitsoundVolume: volume })}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="text-sm font-semibold text-osu-l1">{t`Combo break sound`}</span>
                      <div className="text-[10px] text-osu-f1">{t`Plays when a combo above 20 is lost.`}</div>
                    </div>
                    <ReplaySkinSwitch
                      checked={audioSettings.comboBreakSound}
                      onChange={(checked) => updateAudioSettings({ comboBreakSound: checked })}
                    />
                  </div>

                  <div className="rounded-lg border border-osu-b3/50 bg-osu-b5/35 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="text-sm font-semibold text-osu-l1">{t`Skin hitsounds`}</span>
                        <div className="truncate text-[10px] text-osu-f1">
                          {skinSoundsInfo
                            ? (skinSoundsInfo.keys.length === 1
                              ? t`${skinSoundsInfo.keys.length} sound from ${skinSoundsInfo.name ?? t`an imported skin`}`
                              : t`${skinSoundsInfo.keys.length} sounds from ${skinSoundsInfo.name ?? t`an imported skin`}`)
                            : t`Load a custom skin in the Style tab to use its hitsounds. Without them, the default osu! samples play.`}
                        </div>
                      </div>
                      {skinSoundsInfo ? (
                        <button
                          type="button"
                          onClick={clearImportedSkinSounds}
                          className="shrink-0 cursor-pointer rounded-lg bg-osu-b3/50 px-3 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
                        >
                          {t`Remove`}
                        </button>
                      ) : null}
                    </div>
                    {skinSoundsInfo && skinSoundsInfo.keys.length > 0 ? (
                      <div className="mt-2.5 space-y-1.5">
                        <div className="flex flex-wrap gap-1">
                          {skinSoundsInfo.keys.map((key) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => void previewSkinSound(key)}
                              className="cursor-pointer rounded-md bg-osu-b3/40 px-2 py-1 font-mono text-[10px] text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
                            >
                              {key}
                            </button>
                          ))}
                        </div>
                        <div className="text-[10px] text-osu-f1/70">{t`Click a sound to preview it. Each note plays the sample its map assigns, so all of these can be heard in a replay.`}</div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="text-[10px] text-osu-f1">{t`Audio settings apply immediately.`}</div>
              </section>
            )}
          </div>

          <div
            className={`${isCompactWindow ? "border-t border-osu-b3/50 p-4 sm:p-5" : "overflow-y-auto border-l border-osu-b3/50 p-5"} ${isFullWidthTab ? "hidden" : ""}`}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-white">{t`Preview`}</span>
              <div className="grid grid-cols-2 rounded-md bg-osu-b5/70 p-0.5 text-[10px] font-bold uppercase tracking-wider">
                {(["tap", "ln"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setPreviewMode(mode)}
                    className={`cursor-pointer rounded px-2 py-1 transition-colors ${
                      previewMode === mode ? "bg-osu-pink/20 text-white" : "text-osu-f1 hover:text-white"
                    }`}
                  >
                    {mode === "tap" ? t`Notes` : t`LN`}
                  </button>
                ))}
              </div>
            </div>
            <ReplaySkinPreview
              settings={draft}
              profile={profile}
              keyCount={selectedKeyCount}
              previewMode={previewMode}
              selectedColumns={selectedColumns}
              expectedWidth={previewContentWidth}
              onIdentifyAsset={activeAssetArchive ? identifyAsset : undefined}
              onSelectionChange={(next) => {
                // Column selection exists to open the per-column colour
                // editor, and colours do nothing to a skin that ships its own
                // note art, so the click stays inert there.
                if (keymodeHasSkinArt) return;
                setSelectedColumns((current) => (arraysEqualUnordered(current, next) ? current : next));
                if (next.length > 0) {
                  setOverrideKind(previewMode === "ln" && showLnHeadColorControls ? "lnHead" : "tap");
                  setColumnEditorOpen(true);
                }
              }}
            />
            {keymodeHasSkinArt ? null : (
              <div className="mt-2 text-[10px] text-osu-f1">
                Click a column to select. Drag a box for multi-select. Hold Shift for range, Ctrl/Cmd to toggle.
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-osu-b3/50 px-5 py-4">
          {activeTab !== "overlays" && activeTab !== "audio" ? (
            <button
              onClick={() => {
                setDraft(DEFAULT_REPLAY_SKIN_SETTINGS);
                setActiveColor(null);
                setSelectedColumns([]);
                setSelectedPresetId(DRAFT_PRESET_ID);
                setDraftPresetName(DEFAULT_DRAFT_PRESET_NAME);
              }}
              className="relative z-20 mr-auto cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
            >
              {t`Reset`}
            </button>
          ) : showDevOverlayReset ? (
            <button
              onClick={() => setOverlayDraft(DEFAULT_REPLAY_OVERLAY_SETTINGS)}
              className="relative z-20 mr-auto cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
            >
              {t`Reset defaults`}
            </button>
          ) : (
            <div className="mr-auto" />
          )}
          <button
            onClick={onClose}
            className="relative z-20 cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            {t`Cancel`}
          </button>
          {saveScope === "viewer" && viewerId && communitySkinContext ? (
            <button
              type="button"
              onClick={() => void saveDraftAsMyReplaySkin()}
              disabled={communityBusy != null || draftMatchesMyReplaySkin}
              title={draftMatchesMyReplaySkin
                ? t`This exact version is already shown to everyone watching your replays`
                : t`Save this editor version as the skin everyone sees on your replays`}
              className="relative z-20 cursor-pointer rounded-lg border border-osu-pink/40 bg-osu-pink/10 px-4 py-2 text-xs font-semibold text-osu-pink-light transition-colors hover:border-osu-pink hover:bg-osu-pink/20 hover:text-white disabled:cursor-default disabled:opacity-45 disabled:hover:border-osu-pink/40 disabled:hover:bg-osu-pink/10 disabled:hover:text-osu-pink-light"
            >
              {communityBusy === "save-mine"
                ? t`Saving…`
                : draftMatchesMyReplaySkin
                  ? t`Saved for everyone`
                  : t`Save for everyone`}
            </button>
          ) : null}
          <button
            onClick={save}
            className="relative z-20 cursor-pointer rounded-lg bg-osu-pink px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-osu-pink-light"
          >
            {saveScope === "owner" ? t`Save for everyone` : t`Apply for me`}
          </button>
        </div>

        {RESIZE_HANDLES.map(({ dir, className, cursor }) => (
          <div
            key={dir}
            onPointerDown={handleResizePointerDown(dir)}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
            className={`absolute z-10 touch-none ${className}`}
            style={{ cursor }}
          >
            {dir === "se" ? (
              <span className="pointer-events-none absolute bottom-1.5 right-1.5 h-4 w-4 rounded-br-md border-b-2 border-r-2 border-osu-f1/45 sm:hidden" />
            ) : null}
          </div>
        ))}
      </motion.div>

      {activeColor ? (
        <DraggableColorPopover
          key={`base-${activeColor}`}
          title={colorTargetLabel[activeColor]}
          anchorRef={modalRef}
          storageKey={`base-color`}
          onClose={() => setActiveColor(null)}
        >
          <ReplaySkinColorPanel
            value={colorTargetValue(activeColor)}
            onChange={(value) => {
              if (activeColor === "tap") updateBaseColor("tap", value);
              else if (activeColor === "lnHead") updateBaseColor("lnHead", value);
              else if (activeColor === "outline") update({ outlineColor: value });
              else updateLnBodyColor(value);
            }}
          />
        </DraggableColorPopover>
      ) : null}

      {columnEditorOpen ? (
        <DraggableColorPopover
          key="per-column"
          title={draft.style === "bars" ? t`Bar colors` : t`Per-column colors`}
          width={296}
          anchorRef={modalRef}
          storageKey="per-column"
          onClose={() => setColumnEditorOpen(false)}
        >
          <div className="mb-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(selectedKeyCount, 10)}, minmax(0, 1fr))` }}>
            {columns.map((column) => {
              const overridden = !!overrideColors[column];
              const swatch = overrideColors[column] || overrideBaseColorForColumn(column);
              const isSelected = selectedColumns.includes(column);
              return (
                <button
                  key={column}
                  type="button"
                  onClick={(event) => {
                    const mode: SelectionMode = event.shiftKey
                      ? "range"
                      : event.metaKey || event.ctrlKey
                        ? "toggle"
                        : "replace";
                    setSelectedColumns((current) => applySelection(current, column, mode));
                  }}
                  className={`relative flex h-9 cursor-pointer flex-col items-center justify-center rounded-md border text-[10px] font-bold transition-colors ${
                    isSelected
                      ? "border-osu-pink text-white"
                      : "border-osu-b3/50 text-osu-f1 hover:border-osu-b2 hover:text-white"
                  }`}
                  style={{ backgroundColor: isSelected ? "rgba(232, 60, 144, 0.1)" : "rgba(15, 15, 24, 0.5)" }}
                >
                  <span>{column + 1}</span>
                  <span
                    className="mt-0.5 h-1.5 w-5 rounded-sm"
                    style={{
                      backgroundColor: swatch,
                      opacity: overridden ? 1 : 0.45,
                    }}
                  />
                </button>
              );
            })}
          </div>
          <div className="mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
            <span>
              {selectedColumns.length === 0
                ? t`Select columns to edit`
                : selectedColumns.length === 1
                  ? t`Column ${primarySelected + 1}`
                  : t`${selectedColumns.length} columns selected`}
            </span>
            {selectedColumns.length < selectedKeyCount ? (
              <button
                type="button"
                onClick={() => setSelectedColumns(columns)}
                className="cursor-pointer text-osu-f1 transition-colors hover:text-white"
              >
                {t`Select all`}
              </button>
            ) : null}
          </div>
          <div className={`mb-3 grid rounded-lg bg-osu-b5/70 p-1 ${columnColorKinds.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
            {columnColorKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  setOverrideKind(kind);
                  setPreviewMode(kind === "lnHead" ? "ln" : "tap");
                }}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
                  overrideKind === kind ? "bg-osu-pink/20 text-white" : "text-osu-f1 hover:text-white"
                }`}
              >
                {kind === "tap" ? t`Note` : t`LN Head`}
              </button>
            ))}
          </div>
          <ReplaySkinColorPanel
            value={overrideValue}
            onChange={(value) => updateOverrideColors(overrideKind, selectedColumns, value)}
          />
          {anySelectedHasOverride ? (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateOverrideColors(overrideKind, selectedColumns, "")}
                className="cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:text-white"
              >
                {t`Use base`}
              </button>
            </div>
          ) : null}
        </DraggableColorPopover>
      ) : null}

      <AnimatePresence>
        {toast ? (
          <ReplaySkinToast
            key={toast.id}
            message={toast.message}
            tone={toast.tone}
            onDismiss={() => setToast((current) => (current && current.id === toast.id ? null : current))}
          />
        ) : null}
      </AnimatePresence>

      {skinBrowserOpen ? (
        <ReplaySkinCatalogBrowserDialog
          onPick={(skin) => void importCatalogSkin(skin)}
          onClose={() => setSkinBrowserOpen(false)}
        />
      ) : null}

      {assetPicker && activeAssetArchive ? (
        <ReplaySkinAssetPickerDialog
          target={assetPicker}
          archive={activeAssetArchive}
          entries={assetEntries}
          sourceName={activeAssetSourceName}
          thumbCache={assetThumbCache}
          onPick={(asset, applyToAllColumns) => {
            applyAssetPick(assetPicker, asset, applyToAllColumns);
            setAssetPicker(null);
          }}
          onClose={() => setAssetPicker(null)}
        />
      ) : null}

      {promptDialog ? (
        <ReplaySkinPromptDialog
          title={promptDialog.title}
          label={promptDialog.label}
          initial={promptDialog.initial}
          placeholder={promptDialog.placeholder}
          confirmLabel={promptDialog.confirmLabel}
          multiline={promptDialog.multiline}
          onCancel={() => setPromptDialog(null)}
          onConfirm={(value) => {
            const submit = promptDialog.onSubmit;
            setPromptDialog(null);
            submit(value);
          }}
        />
      ) : null}

      {keyDialog ? (
        <ReplaySkinKeyDialog
          title={keyDialog.title}
          value={keyDialog.value}
          onClose={() => setKeyDialog(null)}
          onCopy={() => {
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(keyDialog.value).then(
                () => pushStatus(t`Share code copied`),
                () => pushStatus(t`Could not copy to clipboard`, "error"),
              );
            }
          }}
        />
      ) : null}
    </>,
    document.body,
  );
}

const PREVIEW_TAP_Y_OFFSETS_DOWN: ReadonlyArray<number> = [60, 95, 130, 165, 200];
const PREVIEW_LN_LENGTHS: ReadonlyArray<number> = [120, 95, 75];
// Holds drawn with the skin's own body art get a share of the card instead of
// a fixed length: a cascading body spends its first stretch on the art's cap
// (and on the transparent lead-in a Percy body uses to read shorter), which
// leaves a bars-sized stand-in with no body left to show.
const PREVIEW_SKIN_LN_LENGTH_RATIOS: ReadonlyArray<number> = [0.62, 0.5, 0.4];
const PREVIEW_ARROW_PATH = "M5.8 17.5H20l-2.6-2.6c-2.6-2.6-2.6-6.8 0-9.4l2.4-2.4c2.4-2.4 6.2-2.4 8.6 0l16.9 16.9c2.2 2.2 2.2 5.8 0 8L28.4 44.9c-2.4 2.4-6.2 2.4-8.6 0l-2.4-2.4c-2.6-2.6-2.6-6.8 0-9.4l2.6-2.6H5.8C2.6 30.5 0 27.6 0 24s2.6-6.5 5.8-6.5Z";

function getPreviewAssetHeight(asset: ReplaySkinImageAsset, targetWidth: number, heightScaleWidth: number, fallbackHeight: number): number {
  const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
  const width = asset.width && asset.width > 0 ? asset.width / scale : 0;
  const height = asset.height && asset.height > 0 ? asset.height / scale : 0;
  if (width > 0 && height > 0) return Math.max(1, height * (heightScaleWidth / width));
  return Math.max(1, fallbackHeight || targetWidth);
}

function getJudgementPreviewHeight(asset: ReplaySkinImageAsset, previewHeight: number, scalePercent: number): number {
  const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
  const width = asset.width && asset.width > 0 ? asset.width / scale : 0;
  const intrinsic = asset.height && asset.height > 0 ? asset.height / scale : 0;
  const fallback = previewHeight * 0.055;
  const canvasEquivalent = intrinsic > 0 ? intrinsic * (previewHeight / 480) : fallback;
  const clamped = Math.min(previewHeight * 0.085, Math.max(previewHeight * 0.04, canvasEquivalent));
  const aspect = width > 0 && intrinsic > 0 ? width / intrinsic : 1;
  const aspectScale = aspect > REPLAY_JUDGEMENT_REFERENCE_ASPECT
    ? REPLAY_JUDGEMENT_REFERENCE_ASPECT / aspect
    : 1;
  return clamped * aspectScale * (scalePercent / 100);
}

const JUDGEMENT_PREVIEW_ITEMS: Array<{ assetKey: keyof ReplaySkinJudgementAssets; label: string; color: string }> = [
  { assetKey: "hit300g", label: "MAX", color: "#b3f5ff" },
  { assetKey: "hit300", label: "300", color: "#ffcc22" },
  { assetKey: "hit200", label: "200", color: "#88da20" },
  { assetKey: "hit100", label: "100", color: "#5a8fff" },
  { assetKey: "hit50", label: "50", color: "#cc8800" },
  { assetKey: "hit0", label: "MISS", color: "#ff4444" },
];

const JUDGEMENT_TILE_PREVIEW_KEYS: Array<keyof ReplaySkinJudgementAssets> = ["hit300g", "hit300", "hit100", "hit0"];

function JudgementSetGallery({
  value,
  onChange,
  scaleInputValue,
  numericScale,
  onScaleSliderChange,
  onScaleInputChange,
  onScaleCommit,
  onScaleReset,
}: {
  value: ReplaySkinSettings["judgementSet"];
  onChange: (next: ReplaySkinSettings["judgementSet"]) => void;
  scaleInputValue: string;
  numericScale: number;
  onScaleSliderChange: (next: number) => void;
  onScaleInputChange: (next: string) => void;
  onScaleCommit: () => void;
  onScaleReset: () => void;
}) {
  const { t, i18n } = useLingui();
  const tiles: Array<ReplaySkinSettings["judgementSet"]> = ["skin", ...REPLAY_JUDGEMENT_SETS];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {tiles.map((set) => {
        const isSelected = set === value;
        const assets = getReplayJudgementSetAssets(set);
        return (
          <div
            key={set}
            className={`rounded-lg border p-2.5 transition-colors ${
              isSelected
                ? "border-osu-pink/60 bg-osu-pink/10"
                : "border-osu-b3/50 bg-black/20 hover:border-osu-pink/30 hover:bg-osu-b4/60"
            }`}
          >
            <button
              type="button"
              onClick={() => onChange(set)}
              aria-pressed={isSelected}
              className="mb-2 flex w-full cursor-pointer items-center gap-2 text-left"
            >
              <span className={`shrink-0 text-[11px] font-bold uppercase tracking-wider ${isSelected ? "text-osu-pink-light" : "text-osu-f1"}`}>
                {getJudgementSetLabel(set, i18n)}
              </span>
            </button>
            {isSelected ? (
              <JudgementScaleTileControl
                inputValue={scaleInputValue}
                numericValue={numericScale}
                onSliderChange={onScaleSliderChange}
                onInputChange={onScaleInputChange}
                onCommit={onScaleCommit}
                onResetToDefault={onScaleReset}
              />
            ) : null}
            <div className="relative h-16 overflow-hidden rounded-md bg-black/30">
              <button
                type="button"
                onClick={() => onChange(set)}
                aria-label={t`Select ${getJudgementSetLabel(set, i18n)} judgement set`}
                className="flex h-full w-full cursor-pointer items-center justify-around gap-2 px-2"
              >
                {JUDGEMENT_TILE_PREVIEW_KEYS.map((assetKey) => {
                  const item = JUDGEMENT_PREVIEW_ITEMS.find((entry) => entry.assetKey === assetKey)!;
                  const asset = assets?.[assetKey];
                  if (asset) {
                    return (
                      <img
                        key={assetKey}
                        src={asset.src}
                        alt=""
                        draggable={false}
                        className="min-w-0 flex-1 max-h-12 object-contain"
                      />
                    );
                  }
                  if (set === "skin") {
                    return (
                      <span
                        key={assetKey}
                        className="text-xs font-bold leading-none"
                        style={{ color: item.color }}
                      >
                        {item.label}
                      </span>
                    );
                  }
                  return <span key={assetKey} aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-white/10" />;
                })}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function JudgementScaleTileControl({
  inputValue,
  numericValue,
  onSliderChange,
  onInputChange,
  onCommit,
  onResetToDefault,
}: {
  inputValue: string;
  numericValue: number;
  onSliderChange: (value: number) => void;
  onInputChange: (value: string) => void;
  onCommit: () => void;
  onResetToDefault: () => void;
}) {
  const { t } = useLingui();
  const safeValue = Math.max(REPLAY_SKIN_MIN_JUDGEMENT_SCALE, Math.min(REPLAY_SKIN_MAX_JUDGEMENT_SCALE, Number.isFinite(numericValue) ? numericValue : REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE));
  const fillRatio = (safeValue - REPLAY_SKIN_MIN_JUDGEMENT_SCALE) / (REPLAY_SKIN_MAX_JUDGEMENT_SCALE - REPLAY_SKIN_MIN_JUDGEMENT_SCALE);
  const isDefault = safeValue === REPLAY_SKIN_DEFAULT_JUDGEMENT_SCALE;
  return (
    <div className="mb-2 grid grid-cols-[auto_minmax(0,1fr)_44px] items-center gap-2 rounded-md border border-osu-b3/50 bg-osu-b5/80 px-2 py-1.5">
      <button
        type="button"
        onClick={onResetToDefault}
        disabled={isDefault}
        className="cursor-pointer text-[9px] font-bold uppercase tracking-wide text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-45 disabled:hover:text-osu-f1"
      >
        {t`Size`}
      </button>
      <input
        type="range"
        min={REPLAY_SKIN_MIN_JUDGEMENT_SCALE}
        max={REPLAY_SKIN_MAX_JUDGEMENT_SCALE}
        step={1}
        value={safeValue}
        onChange={(event) => onSliderChange(Number(event.target.value))}
        className="h-1.5 min-w-0 cursor-pointer appearance-none rounded-full accent-osu-pink"
        style={{
          background: `linear-gradient(90deg, var(--color-osu-pink, #e83c90) 0%, var(--color-osu-pink, #e83c90) ${fillRatio * 100}%, rgba(38, 38, 51, 0.9) ${fillRatio * 100}%, rgba(38, 38, 51, 0.9) 100%)`,
        }}
      />
      <input
        type="number"
        min={REPLAY_SKIN_MIN_JUDGEMENT_SCALE}
        max={REPLAY_SKIN_MAX_JUDGEMENT_SCALE}
        step={1}
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="h-7 w-11 rounded-md border border-osu-b3/60 bg-osu-b5 px-1 text-center text-xs font-bold text-white outline-none transition-colors focus:border-osu-pink/70 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  );
}
function ReplaySkinPreview({
  settings,
  profile,
  keyCount,
  previewMode,
  selectedColumns,
  expectedWidth,
  onSelectionChange,
  onIdentifyAsset,
}: {
  settings: ReplaySkinSettings;
  profile: ReplaySkinKeymodeProfile;
  keyCount: number;
  previewMode: PreviewMode;
  selectedColumns: number[];
  expectedWidth?: number;
  onSelectionChange: (next: number[]) => void;
  onIdentifyAsset?: (target: AssetPickerTarget) => void;
}) {
  const { t, i18n } = useLingui();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [previewWidth, setPreviewWidth] = useState(() => expectedWidth ?? 260);
  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      const measured = expectedWidth ?? containerRef.current?.clientWidth ?? 260;
      const nextWidth = Math.max(180, Math.round(measured));
      setPreviewWidth((current) => (current === nextWidth ? current : nextWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !containerRef.current) {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [expectedWidth]);

  const width = previewWidth;
  const height = Math.round(Math.max(PREVIEW_MIN_HEIGHT, Math.min(PREVIEW_MAX_HEIGHT, width * PREVIEW_HEIGHT_RATIO)));
  const columnWidths = Array.from({ length: keyCount }, (_, col) => profile.columnWidths[col] ?? profile.columnWidth);
  const columnSpacings = Array.from({ length: Math.max(0, keyCount - 1) }, (_, col) => profile.columnSpacings[col] ?? profile.columnSpacing);
  const desiredPlayfieldWidth = columnWidths.reduce((sum, value) => sum + value, 0) + columnSpacings.reduce((sum, value) => sum + value, 0);
  const targetLayoutScale = height / PREVIEW_MANIA_SKIN_STAGE_HEIGHT;
  const playfieldWidth = Math.min(width * 0.82, desiredPlayfieldWidth * targetLayoutScale);
  const layoutScale = desiredPlayfieldWidth > 0 ? playfieldWidth / desiredPlayfieldWidth : 1;
  const averageLaneWidth = columnWidths.reduce((sum, value) => sum + value, 0) / Math.max(1, columnWidths.length) * layoutScale;
  // ColumnStart mapped across the card rather than measured in skin units: the
  // card keeps the notes at a readable size, so a faithful 16:9 screen would
  // be several times its width and any off-centre stage would drift out of
  // view or pin itself to an edge. Proportional placement keeps the whole
  // stage on the card and still reads as left, centre or right.
  const columnStartRange = Math.max(1, OSU_MANIA_SCREEN_WIDTH - getStageUnitWidth(profile, keyCount));
  const playfieldX = profile.columnStart == null
    ? (width - playfieldWidth) / 2
    : Math.max(0, Math.min(1, profile.columnStart / columnStartRange)) * Math.max(0, width - playfieldWidth);
  // Per keymode where the skin declared one, like the stage itself.
  const hitPosition = getReplaySkinStagePosition(profile, settings, "hitPosition");
  const scorePosition = getReplaySkinStagePosition(profile, settings, "scorePosition");
  const comboPosition = getReplaySkinStagePosition(profile, settings, "comboPosition");
  const receptorY = height * (settings.upscroll ? hitPosition : 768 - hitPosition) / 768;
  const scoreY = height * (settings.upscroll ? scorePosition : 768 - scorePosition) / 768;
  const comboY = height * (settings.upscroll ? comboPosition : 768 - comboPosition) / 768;
  const previewJudgementAsset = getJudgementPreviewAsset(settings);
  const judgementScale = getReplayJudgementScale(settings);
  // Imported judgement art and combo digits draw at the same native size the
  // stage gives them, so the card reads like the skin does in play.
  const hasSkinArt = profile.assets.columns.some((column) => Object.values(column).some(Boolean));
  const skinJudgementAsset = getSkinJudgementPreviewAsset(settings, profile);
  const skinJudgementSize = skinJudgementAsset
    ? getSkinAssetPreviewSize(skinJudgementAsset, layoutScale, judgementScale / 100)
    : null;
  // A skin that pushed ComboPosition off the stage wants no counter, so the
  // card shows none either rather than pinning one to its bottom edge.
  const comboGlyphs = profile.comboHidden ? null : getSkinComboPreviewGlyphs(profile, layoutScale);
  const noteSize = settings.style === "circles" || settings.style === "arrows"
    ? Math.max(18, Math.min(averageLaneWidth - 4, Math.max(28, averageLaneWidth * 0.9)))
    : Math.max(8, Math.min(18, averageLaneWidth - 6));
  const visualCenterY = (anchorY: number, halfSize: number) => settings.upscroll ? anchorY + halfSize : anchorY - halfSize;
  const noteTopFromAnchor = (anchorY: number, size: number) => settings.upscroll ? anchorY : anchorY - size;
  const colorFor = (colors: string[], fallback: string, col: number) => colors[col] || fallback;
  const previewBarColors = fallbackPreviewBarColors(keyCount);
  const barColorFor = (col: number) => profile.tapColors[col] || previewBarColors[col] || profile.tapColor;
  const barNoteHeight = Math.max(6, profile.noteHeightScale * layoutScale * PREVIEW_BAR_NOTE_HEIGHT_RATIO);
  const barInsetFor = (laneWidth: number) => Math.min(3, Math.max(1, laneWidth * 0.14));

  const dragStateRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startLocalX: number;
    startLocalY: number;
    initialSelection: number[];
    additive: boolean;
    moved: boolean;
    pendingColumn: number | null;
    pendingMode: SelectionMode;
  } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  let cursorX = playfieldX;
  const lanePositions = Array.from({ length: keyCount }, (_, col) => {
    const laneWidth = columnWidths[col] * layoutScale;
    const startX = cursorX;
    cursorX += laneWidth + (columnSpacings[col] ?? 0) * layoutScale;
    return { col, startX, endX: startX + laneWidth, cx: startX + laneWidth / 2, width: laneWidth };
  });

  // Click-to-find: with an .osk open, every drawn element points back at the
  // Assets row it came from, so "what is this black bar across the top?" is a
  // click rather than a hunt through the list. Elements swallow the pointer so
  // the drag-select below still owns the empty lane space.
  const identify = (target: AssetPickerTarget | null) => {
    if (!onIdentifyAsset || !target) return { className: "pointer-events-none", handlers: {} };
    return {
      className: "pointer-events-auto cursor-pointer",
      handlers: {
        title: t`Find ${target.label} in the Assets tab`,
        onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),
        onClick: (event: ReactMouseEvent) => {
          event.stopPropagation();
          onIdentifyAsset(target);
        },
      },
    };
  };
  const identifyColumn = (column: number, assetKey: keyof ReplaySkinColumnAssets) => {
    const found = ASSET_COLUMN_ROWS.find((row) => row.key === assetKey)?.label;
    const label = found ? i18n._(found) : assetKey;
    return identify({ kind: "column", column, assetKey, label });
  };
  const identifyStage = (assetKey: AssetStageKey) => {
    const found = ASSET_STAGE_ROWS.find((row) => row.key === assetKey)?.label;
    const label = found ? i18n._(found) : assetKey;
    return identify({ kind: "stage", assetKey, label });
  };
  // Whichever judgement the card is showing, so its row is the one that opens.
  const skinJudgementKey: keyof ReplaySkinJudgementAssets | null = profile.assets.judgements.hit300g
    ? "hit300g"
    : profile.assets.judgements.hit300
      ? "hit300"
      : null;
  const skinJudgementPick = identify(skinJudgementKey
    ? {
        kind: "judgement",
        assetKey: skinJudgementKey,
        label: (() => {
          const found = ASSET_JUDGEMENT_ROWS.find((row) => row.key === skinJudgementKey)?.label;
          return found ? i18n._(found) : skinJudgementKey;
        })(),
      }
    : null);

  // Stage furniture sizing, the stage's own rules: everything but the deck is
  // native pixels in the game's 768-space, and mania-stage-bottom is one
  // texture pixel per playfield unit on both axes (so a tall deck hangs off
  // the far edge and clips, exactly as in game).
  const stageArt = (() => {
    const stage = settings.style === "bars" ? profile.assets.stage : null;
    const hintSize = stage?.hint ? getSkinAssetPreviewSize(stage.hint, layoutScale) : null;
    const bottomNativeWidth = stage?.bottom
      ? (stage.bottom.width ?? 0) / (stage.bottom.scale && stage.bottom.scale > 0 ? stage.bottom.scale : 1)
      : 0;
    const bottomNativeHeight = stage?.bottom
      ? (stage.bottom.height ?? 0) / (stage.bottom.scale && stage.bottom.scale > 0 ? stage.bottom.scale : 1)
      : 0;
    const sides: Array<{ side: AssetStageKey & ("left" | "right"); asset: ReplaySkinImageAsset; width: number; pick: ReturnType<typeof identify> }> = [];
    for (const side of ["left", "right"] as const) {
      const asset = stage?.[side];
      const size = asset ? getSkinAssetPreviewSize(asset, layoutScale) : null;
      if (asset && size) sides.push({ side, asset, width: size.width, pick: identifyStage(side) });
    }
    return {
      hint: stage?.hint && hintSize
        ? { asset: stage.hint, height: hintSize.height, pick: identifyStage("hint") }
        : null,
      bottom: stage?.bottom && bottomNativeWidth > 0 && bottomNativeHeight > 0
        ? {
            asset: stage.bottom,
            width: Math.max(1, bottomNativeWidth * layoutScale),
            height: Math.max(1, bottomNativeHeight * layoutScale),
            pick: identifyStage("bottom"),
          }
        : null,
      sides,
    };
  })();

  const tapYForColumn = (col: number) => {
    const offset = PREVIEW_TAP_Y_OFFSETS_DOWN[col % PREVIEW_TAP_Y_OFFSETS_DOWN.length];
    const downscrollY = receptorY - offset;
    if (settings.upscroll) return receptorY + offset;
    return downscrollY;
  };

  const lnLengthForColumn = (col: number) => {
    const base = PREVIEW_LN_LENGTHS[col % PREVIEW_LN_LENGTHS.length];
    const hasBodyArt = settings.style === "bars" && Boolean(profile.assets.columns[col]?.lnBody);
    const length = hasBodyArt
      ? Math.max(base, height * PREVIEW_SKIN_LN_LENGTH_RATIOS[col % PREVIEW_SKIN_LN_LENGTH_RATIOS.length])
      : base;
    return settings.percy ? Math.max(50, length - 30) : length;
  };

  const findColumnAtX = (localX: number): number | null => {
    for (const lane of lanePositions) {
      if (localX >= lane.startX && localX <= lane.endX) return lane.col;
    }
    if (lanePositions.length === 0) return null;
    const first = lanePositions[0];
    const last = lanePositions[lanePositions.length - 1];
    const gapHalf = Math.max(2, profile.columnSpacing * layoutScale / 2 + 2);
    for (const lane of lanePositions) {
      if (localX >= lane.startX - gapHalf && localX <= lane.endX + gapHalf) return lane.col;
    }
    if (localX < first.startX - gapHalf || localX > last.endX + gapHalf) return null;
    return null;
  };

  const columnsInRange = (loX: number, hiX: number): number[] => {
    const cols: number[] = [];
    for (const lane of lanePositions) {
      if (lane.endX >= loX && lane.startX <= hiX) cols.push(lane.col);
    }
    return cols;
  };

  const mergeMarqueeSelection = (initial: number[], hit: number[], additive: boolean): number[] => {
    if (additive) {
      const merged = new Set(initial);
      for (const col of hit) merged.add(col);
      return Array.from(merged).sort((a, b) => a - b);
    }
    return hit.slice().sort((a, b) => a - b);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    if (event.button !== 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const pendingColumn = findColumnAtX(localX);
    const pendingMode: SelectionMode = event.shiftKey
      ? "range"
      : event.metaKey || event.ctrlKey
        ? "toggle"
        : "replace";
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLocalX: localX,
      startLocalY: localY,
      initialSelection: selectedColumns,
      additive,
      moved: false,
      pendingColumn,
      pendingMode,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!containerRef.current) return;
    const dx = event.clientX - state.startClientX;
    const dy = event.clientY - state.startClientY;
    if (!state.moved && Math.hypot(dx, dy) < 4) return;
    state.moved = true;
    const rect = containerRef.current.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const left = Math.max(0, Math.min(state.startLocalX, localX));
    const right = Math.min(rect.width, Math.max(state.startLocalX, localX));
    const top = Math.max(0, Math.min(state.startLocalY, localY));
    const bottom = Math.min(rect.height, Math.max(state.startLocalY, localY));
    setMarqueeRect({ left, top, width: right - left, height: bottom - top });
    const hit = columnsInRange(left, right);
    onSelectionChange(mergeMarqueeSelection(state.initialSelection, hit, state.additive));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setMarqueeRect(null);
    if (!state.moved && state.pendingColumn != null) {
      onSelectionChange(applySelection(state.initialSelection, state.pendingColumn, state.pendingMode));
    }
  };

  return (
    <div
      ref={containerRef}
      data-replay-selectable-area="preview"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      className="relative overflow-hidden rounded-lg border border-osu-b3/60 bg-[#07070c] select-none touch-none"
      style={{ height }}
    >
      {/* The lane dividers are part of the built-in bars look, like the stage
          mutes them under imported column art. */}
      {settings.style === "bars" && !hasSkinArt ? (
        <div className="pointer-events-none absolute inset-y-0" style={{ left: playfieldX, width: playfieldWidth }}>
          {[...lanePositions.map((lane) => lane.startX - playfieldX), playfieldWidth].map((left, index) => (
            <div
              key={index}
              className="absolute inset-y-0 w-px bg-white/10"
              style={{ left }}
            />
          ))}
        </div>
      ) : null}
      {lanePositions.map(({ col, startX, width: laneWidth }) => {
        const isSelected = selectedColumns.includes(col);
        return (
          <div
            key={`lane-bg-${col}`}
            className={`pointer-events-none absolute inset-y-0 transition-colors ${
              isSelected ? "bg-osu-pink/15" : ""
            }`}
            style={{ left: startX, width: laneWidth }}
          />
        );
      })}
      {/* skin.ini JudgementLine, same as the stage: skins that draw their own
          hit line turn it off. */}
      {settings.style === "bars" && profile.judgementLine ? (
        <div className="pointer-events-none absolute h-0.5 bg-white/70" style={{ left: playfieldX, width: playfieldWidth, top: receptorY }} />
      ) : null}
      {/* The stage's own furniture, drawn in the game's layering: the hint
          strip under the notes, the frame and deck over them. The card showed
          none of it, which left a skin's stage art impossible to recognise
          (let alone find in the Assets tab) without loading a replay. */}
      {stageArt.hint ? (
        <img
          src={stageArt.hint.asset.src}
          alt=""
          draggable={false}
          className={`${stageArt.hint.pick.className} absolute object-fill`}
          {...stageArt.hint.pick.handlers}
          style={{
            left: playfieldX,
            width: playfieldWidth,
            top: settings.upscroll ? receptorY : receptorY - stageArt.hint.height / 2,
            height: stageArt.hint.height,
            transform: settings.upscroll ? "scaleY(-1)" : undefined,
          }}
        />
      ) : null}
      {lanePositions.map(({ col, cx, width: laneWidth }) => {
        const isSelected = selectedColumns.includes(col);
        const receptorAsset = settings.style === "bars" ? profile.assets.columns[col]?.receptor : undefined;
        if (receptorAsset) {
          // Key area at the game's scale: native height in 768-space,
          // stretched to the lane, sitting on the bottom edge of the stage
          // (hanging from the top on upscroll). Hanging it off the hit line
          // instead pushed all but a sliver below the card.
          const receptorHeight = getPreviewKeyAreaHeight(receptorAsset, layoutScale, noteSize);
          const pick = identifyColumn(col, "receptor");
          return (
            <img
              key={`receptor-${col}`}
              src={receptorAsset.src}
              alt=""
              draggable={false}
              className={`${pick.className} absolute object-fill`}
              {...pick.handlers}
              style={{
                left: cx - laneWidth / 2,
                top: settings.upscroll ? 0 : height - receptorHeight,
                width: laneWidth,
                height: receptorHeight,
                transform: settings.upscroll ? "scaleY(-1)" : undefined,
                opacity: isSelected ? 1 : 0.62,
              }}
            />
          );
        }
        if (settings.style === "circles") {
          const receptorCenterY = visualCenterY(receptorY, noteSize / 2);
          return (
            <div
              key={`receptor-${col}`}
              className="pointer-events-none absolute rounded-full border-2"
              style={{
                left: cx - noteSize / 2,
                top: receptorCenterY - noteSize / 2,
                width: noteSize,
                height: noteSize,
                borderColor: isSelected ? "#e83c90" : "#ffffff",
                borderWidth: 2,
                opacity: isSelected ? 1 : 0.5,
              }}
            />
          );
        }
        if (settings.style === "arrows") {
          return (
            <ArrowShape
              key={`receptor-${col}`}
              cx={cx}
              cy={visualCenterY(receptorY, noteSize / 2)}
              size={noteSize}
              direction={getColumnArrowDirection(col, keyCount)}
              fill="transparent"
              fillOpacity={0}
              stroke={isSelected ? "#e83c90" : "#ffffff"}
              strokeOpacity={isSelected ? 1 : 0.5}
              strokeWidth={2.75}
            />
          );
        }
        return (
          <div
            key={`receptor-${col}`}
            className="pointer-events-none absolute rounded-sm"
            style={{
              left: cx - noteSize / 2,
              top: settings.upscroll ? receptorY - 11 : receptorY + 4,
              width: noteSize,
              height: 7,
              backgroundColor: "#ffffff",
              opacity: isSelected ? 0.45 : 0.16,
            }}
          />
        );
      })}
      {previewMode === "tap"
        ? lanePositions.map(({ col, startX, cx, width: laneWidth }) => {
            const y = tapYForColumn(col);
            const color = settings.style === "bars" ? barColorFor(col) : colorFor(profile.tapColors, profile.tapColor, col);
            const tapAsset = settings.style === "bars" ? profile.assets.columns[col]?.tap : undefined;
            if (tapAsset) {
              const assetHeight = getPreviewAssetHeight(tapAsset, laneWidth, profile.noteHeightScale * layoutScale, noteSize);
              const pick = identifyColumn(col, "tap");
              return (
                <img
                  key={`tap-${col}`}
                  src={tapAsset.src}
                  alt=""
                  draggable={false}
                  className={`${pick.className} absolute object-fill`}
                  {...pick.handlers}
                  style={{ left: cx - laneWidth / 2, top: settings.upscroll ? y : y + noteSize - assetHeight, width: laneWidth, height: assetHeight }}
                />
              );
            }
            if (settings.style === "circles") {
              return (
                <div
                  key={`tap-${col}`}
                  className="pointer-events-none absolute rounded-full"
                  style={{
                    left: cx - noteSize / 2,
                    top: noteTopFromAnchor(y, noteSize),
                    width: noteSize,
                    height: noteSize,
                    backgroundColor: color,
                    border: settings.outlineEnabled ? `${settings.outlineWidth}px solid ${settings.outlineColor}` : undefined,
                  }}
                />
              );
            }
            if (settings.style === "arrows") {
              return (
                <ArrowShape
                  key={`tap-${col}`}
                  cx={cx}
                  cy={visualCenterY(y, noteSize / 2)}
                  size={noteSize}
                  direction={getColumnArrowDirection(col, keyCount)}
                  fill={color}
                  fillOpacity={1}
                  stroke={settings.outlineColor}
                  strokeOpacity={settings.outlineEnabled ? 1 : 0}
                  strokeWidth={settings.outlineWidth}
                />
              );
            }
            return (
              <div
                key={`tap-${col}`}
                className="pointer-events-none absolute rounded"
                style={{
                  left: startX + barInsetFor(laneWidth),
                  top: y,
                  width: Math.max(2, laneWidth - barInsetFor(laneWidth) * 2),
                  height: barNoteHeight,
                  backgroundColor: color,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
                }}
              />
            );
          })
        : lanePositions.map(({ col, startX, cx, width: laneWidth }) => {
            const headColor = settings.style === "bars" ? barColorFor(col) : colorFor(profile.lnHeadColors, profile.lnHeadColor, col);
            const length = lnLengthForColumn(col);
            const lnHeadY = receptorY;
            const lnTailEnd = settings.upscroll ? lnHeadY + length : lnHeadY - length;
            const lnTop = Math.min(lnHeadY, lnTailEnd);
            const lnBottom = Math.max(lnHeadY, lnTailEnd);
            const lnHeadCenterY = visualCenterY(lnHeadY, noteSize / 2);
            const columnAssets = settings.style === "bars" ? profile.assets.columns[col] : undefined;
            if (columnAssets?.lnHead || columnAssets?.lnBody || columnAssets?.lnTail) {
              const headAsset = columnAssets.lnHead ?? columnAssets.tap;
              const bodyAsset = columnAssets.lnBody;
              const tailAsset = columnAssets.lnTail;
              const headHeight = headAsset ? getPreviewAssetHeight(headAsset, laneWidth, profile.noteHeightScale * layoutScale, noteSize) : noteSize;
              const tailHeight = tailAsset ? getPreviewAssetHeight(tailAsset, laneWidth, profile.noteHeightScale * layoutScale, noteSize) : noteSize;
              // Stable runs the body to the MIDDLE of the head cap, not to its
              // far edge (the stage shares this rule). Round cap art is widest
              // at its centre, so a body carried past that pokes out below the
              // head as a nub of body colour, which is exactly what a skin's
              // rectangular body did under its round note.
              const bodyHeadY = settings.upscroll ? lnHeadY + headHeight / 2 : lnHeadY - headHeight / 2;
              // Directional, like the stage: art whose head is taller than the
              // sample hold is long has no body to show, and an absolute span
              // would flip it into a nub on the far side of the head.
              const bodyTop = settings.upscroll ? bodyHeadY : lnTailEnd;
              const bodyBottom = settings.upscroll ? lnTailEnd : bodyHeadY;
              const hasBody = bodyBottom > bodyTop;
              const bodyPick = identifyColumn(col, "lnBody");
              const tailPick = identifyColumn(col, "lnTail");
              const headPick = identifyColumn(col, columnAssets.lnHead ? "lnHead" : "tap");
              return (
                <div key={`ln-${col}`}>
                  {!hasBody ? null : bodyAsset ? (
                    // Cascaded from the tail end at natural aspect, like the
                    // stage: a stretched copy flattens the art's cap into the
                    // body and loses the shorter-looking lead-in. On upscroll
                    // the tail sits at the bottom, so the whole band mirrors.
                    <div
                      className={`${bodyPick.className} absolute`}
                      {...bodyPick.handlers}
                      style={{
                        left: cx - laneWidth / 2,
                        top: bodyTop,
                        width: laneWidth,
                        height: bodyBottom - bodyTop,
                        backgroundImage: `url("${bodyAsset.src}")`,
                        backgroundRepeat: "repeat-y",
                        backgroundSize: `100% ${getPreviewLnBodyTileHeight(bodyAsset, laneWidth, bodyBottom - bodyTop)}px`,
                        backgroundPosition: "top center",
                        transform: settings.upscroll ? "scaleY(-1)" : undefined,
                      }}
                    />
                  ) : (
                    <div
                      className="pointer-events-none absolute"
                      style={{ left: cx - Math.max(10, noteSize * 0.5) / 2, top: bodyTop, width: Math.max(10, noteSize * 0.5), height: bodyBottom - bodyTop, backgroundColor: settings.lnBodyColor }}
                    />
                  )}
                  {tailAsset ? (
                    <img
                      src={tailAsset.src}
                      alt=""
                      draggable={false}
                      className={`${tailPick.className} absolute object-fill`}
                      {...tailPick.handlers}
                      style={{ left: cx - laneWidth / 2, top: settings.upscroll ? lnTailEnd - tailHeight : lnTailEnd, width: laneWidth, height: tailHeight }}
                    />
                  ) : null}
                  {headAsset ? (
                    <img
                      src={headAsset.src}
                      alt=""
                      draggable={false}
                      className={`${headPick.className} absolute object-fill`}
                      {...headPick.handlers}
                      style={{ left: cx - laneWidth / 2, top: settings.upscroll ? lnHeadY : lnHeadY - headHeight, width: laneWidth, height: headHeight }}
                    />
                  ) : null}
                </div>
              );
            }
            if (settings.style === "circles") {
              const bodyWidth = Math.max(10, noteSize * 0.72);
              // To the head's CENTRE, the rule the stage holds every style to
              // (and the arrows branch below): run it to the head's anchor
              // instead and the body's rounded cap clears the bottom of the
              // head circle, which reads as the hold spilling past its note.
              const bodyTop = Math.min(lnHeadCenterY, lnTailEnd);
              const bodyBottom = Math.max(lnHeadCenterY, lnTailEnd);
              return (
                <div key={`ln-${col}`} className="pointer-events-none">
                  <div
                    className="absolute"
                    style={{
                      left: cx - bodyWidth / 2,
                      top: bodyTop,
                      width: bodyWidth,
                      height: bodyBottom - bodyTop,
                      backgroundColor: settings.lnBodyColor,
                      borderRadius: bodyWidth / 2,
                    }}
                  />
                  <div
                    className="absolute rounded-full"
                    style={{
                      left: cx - noteSize / 2,
                      top: lnHeadCenterY - noteSize / 2,
                      width: noteSize,
                      height: noteSize,
                      backgroundColor: headColor,
                      border: settings.outlineEnabled ? `${settings.outlineWidth}px solid ${settings.outlineColor}` : undefined,
                    }}
                  />
                </div>
              );
            }
            if (settings.style === "arrows") {
              const bodyWidth = Math.max(14, noteSize * 0.68);
              const bodyTop = Math.min(lnHeadCenterY, lnTailEnd);
              const bodyBottom = Math.max(lnHeadCenterY, lnTailEnd);
              return (
                <div key={`ln-${col}`} className="pointer-events-none">
                  <div
                    className="absolute"
                    style={{
                      left: cx - bodyWidth / 2,
                      top: bodyTop,
                      width: bodyWidth,
                      height: bodyBottom - bodyTop,
                      backgroundColor: settings.lnBodyColor,
                      borderRadius: `${bodyWidth / 2}px ${bodyWidth / 2}px 0 0`,
                    }}
                  />
                  <ArrowShape
                    cx={cx}
                    cy={lnHeadCenterY}
                    size={noteSize}
                    direction={getColumnArrowDirection(col, keyCount)}
                    fill={headColor}
                    fillOpacity={1}
                    stroke={settings.outlineColor}
                    strokeOpacity={settings.outlineEnabled ? 1 : 0}
                    strokeWidth={settings.outlineWidth}
                  />
                </div>
              );
            }
            const barInset = barInsetFor(laneWidth);
            const barWidth = Math.max(2, laneWidth - barInset * 2);
            const headTop = settings.upscroll ? lnHeadY : lnHeadY - barNoteHeight;
            return (
              <div key={`ln-${col}`} className="pointer-events-none">
                <div
                  className="absolute"
                  style={{
                    left: startX + barInset,
                    top: lnTop,
                    width: barWidth,
                    height: lnBottom - lnTop,
                    backgroundColor: headColor,
                  }}
                />
                <div
                  className="absolute rounded"
                  style={{
                    left: startX + barInset,
                    top: headTop,
                    width: barWidth,
                    height: barNoteHeight,
                    backgroundColor: headColor,
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
                  }}
                />
              </div>
            );
          })}
      {comboGlyphs ? (
        <div
          className="pointer-events-none absolute flex -translate-y-1/2 items-center justify-center"
          style={{ left: playfieldX, width: playfieldWidth, top: comboY }}
        >
          {comboGlyphs.glyphs.map((glyph, index) => (
            <img
              key={`combo-${index}`}
              src={glyph.asset.src}
              alt=""
              draggable={false}
              className="object-fill"
              style={{
                width: glyph.width,
                height: glyph.height,
                marginLeft: index === 0 ? 0 : -comboGlyphs.overlap,
              }}
            />
          ))}
        </div>
      ) : profile.comboHidden ? null : (
        <div
          className="pointer-events-none absolute flex -translate-y-1/2 items-center justify-center text-[15px] font-bold leading-none"
          style={{
            left: playfieldX,
            width: playfieldWidth,
            top: comboY,
            color: "rgba(255,255,255,0.85)",
            ...getComboFontPreviewStyle(settings.comboFontSet),
          }}
        >
          1234x
        </div>
      )}
      {skinJudgementSize && skinJudgementAsset ? (
        <img
          src={skinJudgementAsset.src}
          alt=""
          draggable={false}
          className={`${skinJudgementPick.className} absolute -translate-x-1/2 -translate-y-1/2 object-fill`}
          {...skinJudgementPick.handlers}
          style={{
            left: playfieldX + playfieldWidth / 2,
            top: scoreY,
            width: skinJudgementSize.width,
            height: skinJudgementSize.height,
            maxWidth: "none",
          }}
        />
      ) : previewJudgementAsset ? (
        <img
          src={previewJudgementAsset.src}
          alt=""
          draggable={false}
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 object-contain"
          style={{
            left: playfieldX + playfieldWidth / 2,
            top: scoreY,
            height: getJudgementPreviewHeight(previewJudgementAsset, height, judgementScale),
            maxWidth: "none",
          }}
        />
      ) : settings.judgementSet === "skin" && !skinJudgementAsset ? (
        // Judgement set "skin" with no art for this keymode: the stage falls
        // back to the built-in labels, so the preview shows one too.
        <div
          className="pointer-events-none absolute flex -translate-y-1/2 items-center justify-center text-[11px] font-bold leading-none"
          style={{
            left: playfieldX,
            width: playfieldWidth,
            top: scoreY,
            color: "#b3f5ff",
            fontSize: 11 * (judgementScale / 100),
          }}
        >
          MAX
        </div>
      ) : null}
      {stageArt.sides.map(({ side, asset, width: artWidth, pick }) => (
        <img
          key={`stage-${side}`}
          src={asset.src}
          alt=""
          draggable={false}
          className={`${pick.className} absolute object-fill`}
          {...pick.handlers}
          style={{
            left: side === "left" ? playfieldX - artWidth : playfieldX + playfieldWidth,
            top: 0,
            width: artWidth,
            height,
          }}
        />
      ))}
      {stageArt.bottom ? (
        <img
          src={stageArt.bottom.asset.src}
          alt=""
          draggable={false}
          className={`${stageArt.bottom.pick.className} absolute object-fill`}
          {...stageArt.bottom.pick.handlers}
          style={{
            left: playfieldX + playfieldWidth / 2 - stageArt.bottom.width / 2,
            top: settings.upscroll ? 0 : height - stageArt.bottom.height,
            width: stageArt.bottom.width,
            height: stageArt.bottom.height,
            transform: settings.upscroll ? "scaleY(-1)" : undefined,
          }}
        />
      ) : null}
      {marqueeRect ? (
        <div
          className="pointer-events-none absolute"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
            border: "1px solid #4ea3ff",
            backgroundColor: "rgba(78, 163, 255, 0.22)",
          }}
        />
      ) : null}
    </div>
  );
}

function ArrowShape({
  cx,
  cy,
  size,
  direction,
  fill,
  fillOpacity,
  stroke,
  strokeOpacity,
  strokeWidth,
}: {
  cx: number;
  cy: number;
  size: number;
  direction: ArrowDirection;
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
}) {
  const transform = {
    right: undefined,
    left: "translate(48 0) scale(-1 1)",
    up: "rotate(-90 24 24)",
    down: "rotate(90 24 24)",
  }[direction];
  const fillColor = fillOpacity > 0 ? fill : "#07070c";
  const visibleFillOpacity = fillOpacity > 0 ? fillOpacity : 1;
  const outlineRadius = Math.max(0, strokeWidth * (48 / Math.max(1, size)));
  const pad = Math.max(4, outlineRadius * 2 + 2);
  const viewBoxSize = 48 + pad * 2;
  const outerSize = size * (viewBoxSize / 48);
  const showOutline = strokeOpacity > 0 && strokeWidth > 0;
  const showFilledOutline = showOutline && fillOpacity > 0;
  const showHollowOutline = showOutline && fillOpacity <= 0;
  if (fillOpacity <= 0 && !showOutline) return null;
  const strokeProps = {
    fill: "none",
    stroke,
    strokeOpacity,
    strokeWidth: outlineRadius * 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg
      className="pointer-events-none absolute"
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      aria-hidden="true"
      style={{
        left: cx - outerSize / 2,
        top: cy - outerSize / 2,
        width: outerSize,
        height: outerSize,
        overflow: "visible",
      }}
    >
      {showHollowOutline ? (
        <g transform={`translate(${pad} ${pad})`}>
          <g transform={transform}>
            <path d={PREVIEW_ARROW_PATH} {...strokeProps} />
          </g>
        </g>
      ) : null}
      {showFilledOutline ? (
        <g transform={`translate(${pad} ${pad})`}>
          <g transform={transform}>
            <path d={PREVIEW_ARROW_PATH} {...strokeProps} />
          </g>
        </g>
      ) : null}
      <g transform={`translate(${pad} ${pad})`} opacity={visibleFillOpacity}>
        <g transform={transform}>
          <path d={PREVIEW_ARROW_PATH} fill={fillColor} />
        </g>
      </g>
    </svg>
  );
}

function ReplaySkinShapeIcon({ style }: { style: CSSProperties }) {
  return <span aria-hidden="true" className="h-4 w-4 bg-current" style={style} />;
}

function ReplaySkinShapeButton({
  active,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? "border-osu-pink bg-osu-pink/15 text-white"
          : "border-osu-b3/60 bg-osu-b5/55 text-osu-f1 hover:border-osu-b2 hover:text-white"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ReplaySkinColorRow({
  label,
  title,
  value,
  selected,
  onOpen,
}: {
  label: string;
  title?: string;
  value: string;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title}
      className={`grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-3 rounded-lg text-left transition-colors ${
        selected ? "text-white" : "text-osu-f1 hover:text-white"
      }`}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span
        className={`flex h-9 min-w-36 items-center gap-2 rounded-md border px-2 transition-colors ${
          selected ? "border-osu-pink/70 bg-osu-pink/10" : "border-osu-b3/60 bg-osu-b5/60"
        }`}
      >
        <span className="h-5 w-7 rounded-sm border border-white/35" style={{ backgroundColor: value }} />
        <span className="font-mono text-xs font-semibold text-osu-c1">{value}</span>
      </span>
    </button>
  );
}

function ReplaySkinSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border p-0.5 transition-colors ${
        checked ? "border-osu-pink bg-osu-pink" : "border-osu-b3/60 bg-osu-b5/80"
      }`}
    >
      <span
        className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function PresetIconButton({
  label,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 cursor-pointer place-items-center rounded-md border border-osu-b3/60 bg-osu-b5/70 text-osu-f1 transition-colors hover:border-osu-b2 hover:text-white disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-osu-b3/60 disabled:hover:text-osu-f1"
    >
      {children}
    </button>
  );
}

function PresetTextButton({
  label,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-osu-b3/60 bg-osu-b5/70 px-2 text-[11px] font-bold text-osu-f1 transition-colors hover:border-osu-b2 hover:text-white disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-osu-b3/60 disabled:hover:text-osu-f1"
    >
      {children}
    </button>
  );
}


const REPLAY_OVERLAY_DESCRIPTIONS: Record<ReplayOverlayId, MessageDescriptor> = {
  keypresses: msg`Per-column press count.`,
  kps: msg`Keys pressed per second.`,
  misses: msg`Left vs right hand miss totals.`,
  accuracy: msg`Current accuracy percentage.`,
  handAccuracy: msg`Current accuracy percentage for each hand.`,
  pp: msg`Live performance points.`,
  judgements: msg`Hit counts and unstable rate.`,
  progress: msg`Map completion percentage.`,
  leaderboard: msg`Ingame scoreboard with live rank climbing. Tab toggles it.`,
  replayMaster: msg`Scrolling judgement-colored notes with actual hit offsets and long-note releases.`,
};

const REPLAY_OVERLAY_PREVIEWS: Partial<Record<ReplayOverlayId, string>> = {
  keypresses: "/images/replay-overlays/keypresses.webp",
  kps: "/images/replay-overlays/kps-v2.webp",
  misses: "/images/replay-overlays/misses.webp",
  accuracy: "/images/replay-overlays/accuracy.webp",
  pp: "/images/replay-overlays/pp.webp",
  judgements: "/images/replay-overlays/judgements.webp",
  progress: "/images/replay-overlays/progress.webp",
  replayMaster: "/images/replay-overlays/replay-master.svg",
};

// The same four shapes the canvas draws, so the card matches what enabling
// the overlay puts on screen. Fill lengths use the canvas' own curve.
function HandAccuracyOverlayPreview({ style }: { style: ReplayHandAccuracyStyle }) {
  const hands = [
    { label: "L", value: "99.42", color: "#5a8fff", fill: (99.42 / 100) ** 12 },
    { label: "R", value: "98.76", color: "#de31ae", fill: (98.76 / 100) ** 12 },
  ];

  if (style === "rings") {
    const radius = 15;
    const circumference = 2 * Math.PI * radius;
    return (
      <div className="relative flex h-full w-full items-center justify-center gap-6" aria-hidden="true">
        {hands.map((hand) => (
          <div key={hand.label} className="flex flex-col items-center gap-1">
            <div className="relative h-9 w-9">
              <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
                <circle cx="18" cy="18" r={radius} fill="none" stroke="#ffffff" strokeOpacity={0.14} strokeWidth={3} />
                <circle
                  cx="18"
                  cy="18"
                  r={radius}
                  fill="none"
                  stroke={hand.color}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray={`${circumference * hand.fill} ${circumference}`}
                />
              </svg>
              <span
                className="absolute inset-0 grid place-items-center text-[10px] font-bold"
                style={{ color: hand.color }}
              >
                {hand.label}
              </span>
            </div>
            <div className="text-xs font-bold leading-none text-white/95 tabular-nums">
              {hand.value}
              <span className="text-[8px] text-white/50">%</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (style === "balance") {
    return (
      <div className="relative flex h-full w-full flex-col justify-center px-[16%]" aria-hidden="true">
        <div className="flex items-baseline justify-between text-[9px] font-bold leading-none">
          <span style={{ color: hands[0].color }}>L</span>
          <span style={{ color: hands[1].color }}>R</span>
        </div>
        <div className="mt-1.5 flex items-baseline justify-between text-lg font-bold leading-none text-white/95 tabular-nums">
          {hands.map((hand) => (
            <span key={hand.label}>
              {hand.value}<span className="ml-px text-[11px] text-white/50">%</span>
            </span>
          ))}
        </div>
        {/* Each hand fills outward from the centre, so the weaker one is the
            shorter arm. */}
        <div className="relative mt-2 h-1 w-full rounded-full bg-white/10">
          <div className="absolute inset-y-0 right-1/2 mr-px w-[46.6%] rounded-full bg-[#5a8fff]" />
          <div className="absolute inset-y-0 left-1/2 ml-px w-[43.1%] rounded-full bg-[#de31ae]" />
          <div className="absolute -bottom-0.5 -top-0.5 left-1/2 w-px -translate-x-1/2 bg-white/30" />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col justify-center px-[26%]" aria-hidden="true">
      {hands.map((hand, index) => (
        <div key={hand.label} className={index === 0 ? "" : style === "meters" ? "mt-2.5" : "mt-1.5"}>
          <div className="flex items-baseline gap-1.5 leading-none">
            <span className="text-[9px] font-bold" style={{ color: hand.color }}>{hand.label}</span>
            <span className="text-base font-bold text-white/95 tabular-nums">
              {hand.value}<span className="ml-px text-[9px] text-white/50">%</span>
            </span>
            {style === "plain" && index === 1 && (
              <span className="text-[9px] font-bold tabular-nums" style={{ color: hand.color }}>-0.66</span>
            )}
          </div>
          {style === "meters" && (
            <div className="mt-1 h-[3px] w-full rounded-full bg-white/10">
              <div
                className="h-full rounded-full"
                style={{ width: `${hand.fill * 100}%`, backgroundColor: hand.color }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ReplayOverlaySettingsRow({
  id,
  placement,
  onChange,
}: {
  id: ReplayOverlayId;
  placement: ReplayOverlaySettings[ReplayOverlayId];
  onChange: (patch: Partial<ReplayOverlaySettings[ReplayOverlayId]>) => void;
}) {
  const { i18n } = useLingui();
  const enabled = placement.enabled;
  const toggle = () => onChange({ enabled: !enabled });
  return (
    <div
      className={`group relative flex w-full cursor-pointer flex-col overflow-hidden rounded-lg border text-left transition-all ${
        enabled
          ? "border-osu-pink/70 bg-osu-b5/55 shadow-[0_0_0_1px_rgba(232,60,144,0.18)]"
          : "border-osu-b3/50 bg-osu-b5/25 hover:border-osu-b2 hover:bg-osu-b5/45"
      }`}
    >
      <button type="button" aria-pressed={enabled} onClick={toggle} className="flex w-full cursor-pointer flex-col text-left">
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-black" style={{ backgroundColor: "#000" }}>
          <div className="absolute inset-0 bg-black" aria-hidden="true" />
          {REPLAY_OVERLAY_PREVIEWS[id] ? (
            <img
              src={REPLAY_OVERLAY_PREVIEWS[id]}
              alt=""
              loading="lazy"
              draggable={false}
              className="relative h-full w-full object-contain"
              style={{ backgroundColor: "#000" }}
            />
          ) : id === "handAccuracy" ? (
            <HandAccuracyOverlayPreview style={normalizeReplayHandAccuracyStyle(placement.style)} />
          ) : id === "leaderboard" ? (
            <div className="relative flex h-full w-full items-center px-6" aria-hidden="true">
              <div className="w-3/5 space-y-1">
                {[["#101018", "1"], ["#1f4a6e", "2"], ["#101018", "3"]].map(([color, rankNumber]) => (
                  <div
                    key={rankNumber}
                    className="relative h-7 rounded-r px-1.5 py-0.5"
                    style={{ background: `linear-gradient(90deg, ${color}ee, ${color}22)` }}
                  >
                    <div className="h-1.5 w-12 rounded-sm bg-white/80" />
                    <div className="mt-1 h-1 w-8 rounded-sm bg-white/50" />
                    <span className="absolute right-1 top-0 text-[18px] font-bold leading-7 text-white/20">{rankNumber}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div
            className={`absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full transition-colors ${
              enabled
                ? "bg-osu-pink text-white"
                : "border border-osu-b3/70 bg-osu-b5/70 text-transparent group-hover:border-osu-b2"
            }`}
            aria-hidden="true"
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </div>
        </div>
        <div className="border-t border-osu-b3/40 px-3 py-2">
          <div className={`text-sm font-semibold ${enabled ? "text-white" : "text-osu-l1"}`}>
            {i18n._(REPLAY_OVERLAY_LABELS[id])}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-osu-f1">
            {i18n._(REPLAY_OVERLAY_DESCRIPTIONS[id])}
          </div>
        </div>
      </button>
      {id === "replayMaster" && (
        <div className="px-3 pb-3 text-osu-l1">
          <ReplayMasterOverlayControls placement={placement} onChange={onChange} />
        </div>
      )}
      {id === "replayMaster" && (
        <p className="px-3 pb-2 text-[11px] leading-snug text-osu-f1">
          <Trans>
            Adapted from <a
              href="https://github.com/Mania-Visualization-Project/Mania-Replay-Master"
              target="_blank"
              rel="noopener noreferrer"
              className="text-osu-pink underline underline-offset-2 hover:text-osu-pink-light"
            >Mania Replay Master</a>.
          </Trans>
        </p>
      )}
    </div>
  );
}

function LayoutNumberControl({
  label,
  inputValue,
  numericValue,
  min,
  max,
  defaultValue,
  hint,
  onSliderChange,
  onInputChange,
  onCommit,
  onResetToDefault,
}: {
  label: string;
  inputValue: string;
  numericValue: number;
  min: number;
  max: number;
  defaultValue: number;
  hint?: string;
  onSliderChange: (value: number) => void;
  onInputChange: (value: string) => void;
  onCommit: () => void;
  onResetToDefault: () => void;
}) {
  const safeValue = Math.max(min, Math.min(max, Number.isFinite(numericValue) ? numericValue : defaultValue));
  const fillRatio = max > min ? (safeValue - min) / (max - min) : 0;
  const isDefault = safeValue === defaultValue;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm font-semibold text-osu-l1">
        <span>{label}</span>
        <button
          type="button"
          onClick={onResetToDefault}
          disabled={isDefault}
          className="text-[10px] uppercase tracking-wide text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-50 disabled:hover:text-osu-f1"
        >
          Reset to {defaultValue}
        </button>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={safeValue}
          onChange={(event) => onSliderChange(Number(event.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full accent-osu-pink"
          style={{
            background: `linear-gradient(90deg, var(--color-osu-pink, #e83c90) 0%, var(--color-osu-pink, #e83c90) ${fillRatio * 100}%, rgba(38, 38, 51, 0.9) ${fillRatio * 100}%, rgba(38, 38, 51, 0.9) 100%)`,
          }}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-9 w-20 shrink-0 rounded-lg border border-osu-b3/60 bg-osu-b5/70 px-2 text-center text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-osu-f1">
        <span>{min}</span>
        {hint ? <span>{hint}</span> : <span className="opacity-0">.</span>}
        <span>{max}</span>
      </div>
    </div>
  );
}

function FancySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; style?: CSSProperties }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="block">
      <span className="mb-2 block text-[10px] font-bold uppercase tracking-wider text-osu-f1">{label}</span>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={`flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 text-sm font-semibold outline-none transition-all ${
            open
              ? "border-osu-pink/50 bg-osu-pink/10 text-white"
              : "border-osu-b3/60 bg-osu-b5/70 text-white hover:border-osu-pink/40 hover:bg-osu-b4"
          }`}
        >
          <span className="truncate" style={selected?.style}>{selected?.label ?? ""}</span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? "rotate-180 text-osu-pink-light" : "text-osu-f1"}`}
            strokeWidth={2.4}
          />
        </button>
        <div
          className={`absolute left-0 right-0 top-full z-[115] mt-1.5 overflow-hidden rounded-lg border border-osu-pink/20 bg-osu-b4/95 shadow-xl shadow-black/40 backdrop-blur-md transition-all duration-150 origin-top ${
            open ? "opacity-100 scale-y-100 translate-y-0 pointer-events-auto" : "opacity-0 scale-y-95 -translate-y-1 pointer-events-none"
          }`}
          role="listbox"
        >
          <div className="max-h-[240px] overflow-y-auto p-1">
            {options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition-colors cursor-pointer ${
                    isSelected
                      ? "bg-osu-pink/15 text-osu-pink-light"
                      : "text-osu-l2 hover:bg-osu-b3 hover:text-white"
                  }`}
                >
                  <span className={`flex h-3 w-3 shrink-0 items-center justify-center transition-opacity ${isSelected ? "opacity-100" : "opacity-0"}`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-osu-pink">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span className="truncate" style={option.style}>{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const POPOVER_POSITION_STORAGE_PREFIX = "mania-hub-replay-popover-pos:";

const WINDOW_RECT_STORAGE_KEY = "mania-hub-replay-settings-window-v1";
const WINDOW_TAB_STORAGE_KEY = "mania-hub-replay-settings-tab-v1";
const WINDOW_DEFAULT_WIDTH = 720;
const WINDOW_DEFAULT_HEIGHT = 640;
const WINDOW_MIN_WIDTH = 320;
const WINDOW_MIN_HEIGHT = 380;
const WINDOW_VIEWPORT_MARGIN = 8;
const WINDOW_COMPACT_WIDTH = 640;
const WINDOW_PREVIEW_MIN_WIDTH = 300;
const WINDOW_PREVIEW_MAX_WIDTH = 520;
const WINDOW_PREVIEW_WIDTH_RATIO = 0.38;
const WINDOW_PREVIEW_HORIZONTAL_PADDING = 40;

type WindowRect = { x: number; y: number; w: number; h: number };
type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function isReplaySkinSettingsTab(value: unknown): value is ReplaySkinSettingsTab {
  return value === "style" || value === "layout" || value === "hud" || value === "overlays" || value === "audio" || value === "assets";
}

function readWindowTab(): ReplaySkinSettingsTab {
  if (typeof window === "undefined") return "style";
  try {
    const value = window.localStorage.getItem(WINDOW_TAB_STORAGE_KEY);
    return isReplaySkinSettingsTab(value) ? value : "style";
  } catch {
    return "style";
  }
}

function writeWindowTab(tab: ReplaySkinSettingsTab): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WINDOW_TAB_STORAGE_KEY, tab);
  } catch {
    // ignore quota errors
  }
}

function readStoredWindowRect(): WindowRect | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WINDOW_RECT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.x !== "number" || typeof parsed.y !== "number" || typeof parsed.w !== "number" || typeof parsed.h !== "number") {
      return null;
    }
    return { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h };
  } catch {
    return null;
  }
}

function writeStoredWindowRect(rect: WindowRect): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WINDOW_RECT_STORAGE_KEY, JSON.stringify(rect));
  } catch {
    // ignore quota errors
  }
}

function clampWindowRect(rect: WindowRect, viewportW: number, viewportH: number): WindowRect {
  const margin = WINDOW_VIEWPORT_MARGIN;
  const maxW = Math.max(1, viewportW - margin * 2);
  const maxH = Math.max(1, viewportH - margin * 2);
  const minW = Math.min(WINDOW_MIN_WIDTH, maxW);
  const minH = Math.min(WINDOW_MIN_HEIGHT, maxH);
  const w = Math.max(minW, Math.min(rect.w, maxW));
  const h = Math.max(minH, Math.min(rect.h, maxH));
  const x = Math.max(margin, Math.min(rect.x, Math.max(margin, viewportW - w - margin)));
  const y = Math.max(margin, Math.min(rect.y, Math.max(margin, viewportH - h - margin)));
  return { x, y, w, h };
}

function defaultWindowRect(viewportW: number, viewportH: number): WindowRect {
  const maxW = Math.max(1, viewportW - WINDOW_VIEWPORT_MARGIN * 2);
  const maxH = Math.max(1, viewportH - WINDOW_VIEWPORT_MARGIN * 2);
  const w = Math.min(WINDOW_DEFAULT_WIDTH, maxW);
  const h = Math.min(WINDOW_DEFAULT_HEIGHT, maxH);
  const x = Math.max(WINDOW_VIEWPORT_MARGIN, Math.round((viewportW - w) / 2));
  const y = Math.max(WINDOW_VIEWPORT_MARGIN, Math.round((viewportH - h) / 2));
  return { x, y, w, h };
}

const RESIZE_HANDLES: ReadonlyArray<{ dir: ResizeDirection; className: string; cursor: string }> = [
  { dir: "n",  className: "left-8 right-8 top-0 h-3 sm:left-2 sm:right-2 sm:h-1.5",       cursor: "ns-resize" },
  { dir: "s",  className: "left-8 right-8 bottom-0 h-6 sm:left-2 sm:right-2 sm:h-1.5",    cursor: "ns-resize" },
  { dir: "w",  className: "top-14 bottom-8 left-0 w-4 sm:top-2 sm:bottom-2 sm:w-1.5",     cursor: "ew-resize" },
  { dir: "e",  className: "top-14 bottom-8 right-0 w-6 sm:top-2 sm:bottom-2 sm:w-1.5",    cursor: "ew-resize" },
  { dir: "nw", className: "top-0 left-0 h-7 w-7 sm:h-3 sm:w-3",                           cursor: "nwse-resize" },
  { dir: "ne", className: "top-0 right-0 h-7 w-7 sm:h-3 sm:w-3",                          cursor: "nesw-resize" },
  { dir: "sw", className: "bottom-0 left-0 h-10 w-10 sm:h-3 sm:w-3",                      cursor: "nesw-resize" },
  { dir: "se", className: "bottom-0 right-0 h-12 w-12 sm:h-3 sm:w-3",                     cursor: "nwse-resize" },
];

function readStoredPopoverPosition(storageKey: string | undefined): { x: number; y: number } | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(POPOVER_POSITION_STORAGE_PREFIX + storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

function writeStoredPopoverPosition(storageKey: string | undefined, position: { x: number; y: number }): void {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(POPOVER_POSITION_STORAGE_PREFIX + storageKey, JSON.stringify(position));
  } catch {
    // ignore quota errors
  }
}

function DraggableColorPopover({
  title,
  children,
  width = 264,
  anchorRef,
  onClose,
  storageKey,
}: {
  title: string;
  children: ReactNode;
  width?: number;
  anchorRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  storageKey?: string;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragState = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    if (position != null) return;
    if (typeof window === "undefined") return;
    const margin = 12;
    const w = width;
    const h = ref.current?.offsetHeight ?? 360;
    const stored = readStoredPopoverPosition(storageKey);
    if (stored) {
      const clampedX = Math.min(Math.max(margin, stored.x), Math.max(margin, window.innerWidth - w - margin));
      const clampedY = Math.min(Math.max(margin, stored.y), Math.max(margin, window.innerHeight - h - margin));
      setPosition({ x: clampedX, y: clampedY });
      return;
    }
    const anchor = anchorRef?.current?.getBoundingClientRect();
    let x: number;
    let y: number;
    if (anchor) {
      const rightRoom = window.innerWidth - anchor.right - margin;
      const leftRoom = anchor.left - margin;
      if (rightRoom >= w + margin) {
        x = Math.round(anchor.right + margin);
      } else if (leftRoom >= w + margin) {
        x = Math.round(anchor.left - margin - w);
      } else {
        x = Math.round(anchor.left + margin);
      }
      y = Math.round(anchor.top + 64);
      x = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - w - margin));
      y = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - h - margin));
    } else {
      x = Math.max(margin, window.innerWidth - w - margin - 24);
      y = Math.max(margin, Math.round((window.innerHeight - h) / 2));
    }
    setPosition({ x, y });
  }, [position, width, anchorRef, storageKey]);

  useEffect(() => {
    if (!position) return;
    writeStoredPopoverPosition(storageKey, position);
  }, [position, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => {
      setPosition((current) => {
        if (!current) return current;
        const w = width;
        const h = ref.current?.offsetHeight ?? 360;
        return {
          x: Math.min(Math.max(8, current.x), Math.max(8, window.innerWidth - w - 8)),
          y: Math.min(Math.max(8, current.y), Math.max(8, window.innerHeight - h - 8)),
        };
      });
    };
    window.addEventListener("resize", handle);
    return () => window.removeEventListener("resize", handle);
  }, [width]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!ref.current || !position) return;
    event.preventDefault();
    const rect = ref.current.getBoundingClientRect();
    dragState.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const w = width;
    const h = ref.current?.offsetHeight ?? 360;
    const nextX = Math.min(Math.max(8, event.clientX - state.offsetX), Math.max(8, window.innerWidth - w - 8));
    const nextY = Math.min(Math.max(8, event.clientY - state.offsetY), Math.max(8, window.innerHeight - h - 8));
    setPosition({ x: nextX, y: nextY });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={ref}
      data-replay-selectable-area="popover"
      className={`fixed z-[120] rounded-xl border border-osu-b2/70 bg-osu-b4/95 shadow-2xl backdrop-blur transition-opacity duration-100 ${
        position ? "opacity-100" : "opacity-0"
      }`}
      style={{ width, left: position?.x ?? -9999, top: position?.y ?? -9999 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex cursor-grab touch-none items-center gap-2 rounded-t-xl border-b border-osu-b3/50 px-3 py-3 select-none active:cursor-grabbing sm:py-2"
      >
        <GripHorizontal className="h-4 w-4 text-osu-f1" />
        <span className="text-xs font-bold uppercase tracking-wider text-osu-l1">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t`Close picker`}
          className="ml-auto grid h-6 w-6 cursor-pointer place-items-center rounded-md text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2.4} />
        </button>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function ReplaySkinToast({
  message,
  tone,
  onDismiss,
}: {
  message: string;
  tone: "info" | "error";
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 2400);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);
  const toneClasses = tone === "error"
    ? "border-red-400/60 bg-red-500/15 text-red-100"
    : "border-osu-pink/50 bg-osu-b4/95 text-white";
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.16 }}
      className={`fixed left-1/2 top-6 z-[140] -translate-x-1/2 rounded-lg border px-3.5 py-2 text-xs font-semibold shadow-lg backdrop-blur ${toneClasses}`}
    >
      {message}
    </motion.div>
  );
}

function ReplaySkinPromptDialog({
  title,
  label,
  initial,
  placeholder,
  confirmLabel = "Confirm",
  multiline = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  label?: string;
  initial: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const { t } = useLingui();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const target = multiline ? textareaRef.current : inputRef.current;
    if (!target) return;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
  }, [multiline]);
  const submit = () => {
    if (!value.trim()) return;
    onConfirm(value);
  };
  return (
    <>
      <motion.div
        className="fixed inset-0 z-[130] bg-black/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1 }}
        onClick={onCancel}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        className="fixed left-1/2 top-1/2 z-[131] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-osu-b3/50 px-5 py-3 text-sm font-bold text-white">{title}</div>
        <div className="space-y-2 px-5 py-4">
          {label ? <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">{label}</div> : null}
          {multiline ? (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              rows={4}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
                if (event.key === "Escape") onCancel();
              }}
              className="w-full resize-none rounded-md border border-osu-b3/60 bg-osu-b5/70 px-3 py-2 font-mono text-xs text-white outline-none transition-colors focus:border-osu-pink/70"
            />
          ) : (
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
                if (event.key === "Escape") onCancel();
              }}
              className="h-10 w-full rounded-md border border-osu-b3/60 bg-osu-b5/70 px-3 text-sm font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-osu-b3/50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            {t`Cancel`}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className="cursor-pointer rounded-lg bg-osu-pink px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-osu-pink-light disabled:cursor-not-allowed disabled:bg-osu-pink/40"
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </>
  );
}

function ReplaySkinKeyDialog({
  title,
  value,
  onClose,
  onCopy,
}: {
  title: string;
  value: string;
  onClose: () => void;
  onCopy: () => void;
}) {
  const { t } = useLingui();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const target = textareaRef.current;
    if (!target) return;
    target.focus();
    target.select();
  }, []);
  return (
    <>
      <motion.div
        className="fixed inset-0 z-[130] bg-black/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1 }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        className="fixed left-1/2 top-1/2 z-[131] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-osu-b3/50 px-5 py-3 text-sm font-bold text-white">{title}</div>
        <div className="space-y-2 px-5 py-4">
          <textarea
            ref={textareaRef}
            value={value}
            readOnly
            rows={5}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            className="w-full resize-none rounded-md border border-osu-b3/60 bg-osu-b5/70 px-3 py-2 font-mono text-[11px] text-osu-c1 outline-none focus:border-osu-pink/70"
          />
          <div className="text-[10px] text-osu-f1">{t`Select all and copy, or use the button below.`}</div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-osu-b3/50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            {t`Close`}
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-osu-pink px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-osu-pink-light"
          >
            <Copy className="h-3.5 w-3.5" />
            {t`Copy`}
          </button>
        </div>
      </motion.div>
    </>
  );
}

// 0 is "any"; the rest mirrors the /skins catalog's keys filter.
const CATALOG_KEYMODE_FILTERS = [0, 4, 5, 6, 7, 8, 9, 10];

// The "Browse skins" picker: the published /skins catalog inside the modal,
// searched against the live backend's public list endpoint. Picking a card
// hands the SkinSummary back; the modal downloads and imports from there.
function ReplaySkinCatalogBrowserDialog({
  onPick,
  onClose,
}: {
  onPick: (skin: SkinSummary) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  // 0 is no filter, matching the /skins catalog's own keys row.
  const [keymode, setKeymode] = useState(0);
  const [results, setResults] = useState<SkinSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "idle" | "error">("loading");
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setStatus("loading");
    // The first page loads immediately; typing debounces ~300ms.
    const timer = window.setTimeout(async () => {
      try {
        const result = await fetchSkinsListDirect({ q: query.trim(), page: 0, k: keymode });
        if (requestRef.current !== requestId) return;
        setResults(result.skins);
        setStatus("idle");
      } catch {
        if (requestRef.current !== requestId) return;
        setResults([]);
        setStatus("error");
      }
    }, query.trim() ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [query, keymode]);

  return (
    <>
      <motion.div
        className="fixed inset-0 z-[130] bg-black/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1 }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        className="fixed left-1/2 top-1/2 z-[131] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-osu-b3/50 px-5 py-3">
          <div className="text-sm font-bold text-white">{t`Browse skins`}</div>
          <div className="mt-0.5 text-[10px] text-osu-f1">{t`Pick one to load it into the editor.`}</div>
        </div>
        <div className="space-y-2 px-5 py-4">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search skins by name`}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            className="h-9 w-full rounded-md border border-osu-b3/60 bg-osu-b5/70 px-3 text-xs font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
          />
          <div className="flex flex-wrap items-center gap-1">
            {CATALOG_KEYMODE_FILTERS.map((keys) => (
              <button
                key={keys}
                type="button"
                onClick={() => setKeymode(keymode === keys ? 0 : keys)}
                aria-pressed={keymode === keys}
                className={`cursor-pointer rounded-md px-2 py-1 text-[11px] font-bold transition-colors ${
                  keymode === keys
                    ? "bg-osu-pink/20 text-osu-pink-light"
                    : "bg-osu-b5/70 text-osu-f1 hover:bg-osu-b3/60 hover:text-white"
                }`}
              >
                {keys === 0 ? t`any` : `${keys}K`}
              </button>
            ))}
          </div>
          <div className="max-h-[340px] overflow-y-auto rounded-md border border-osu-b3/50 bg-osu-b5/40">
            {status === "error" ? (
              <div className="px-3 py-4 text-[11px] text-osu-f1">{t`The skin list could not be loaded. Try again.`}</div>
            ) : status === "loading" && results.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-osu-f1">{t`Loading skins…`}</div>
            ) : results.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-osu-f1">{t`No skins match that search.`}</div>
            ) : (
              results.map((skin) => (
                <button
                  key={skin.id}
                  type="button"
                  onClick={() => onPick(skin)}
                  className="flex w-full cursor-pointer items-center gap-2.5 border-b border-osu-b3/30 px-2.5 py-1.5 text-left transition-colors last:border-b-0 hover:bg-osu-b3/40"
                >
                  <span className="grid h-9 w-16 shrink-0 place-items-center overflow-hidden rounded bg-black/40">
                    {skin.previewUrl ? (
                      <img src={skin.previewUrl} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
                    ) : (
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-white/10" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-osu-l1">{skin.name}</span>
                    <span className="block truncate text-[10px] text-osu-f1">
                      {/* No author on file means no credit line, not the
                          uploader standing in for one. */}
                      {[skin.author, formatKeymodes(skin.keymodes)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-osu-b3/50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            {t`Cancel`}
          </button>
        </div>
      </motion.div>
    </>
  );
}

function ReplaySkinAssetRow({
  label,
  asset,
  rowId,
  highlighted = false,
  onChange,
  onClear,
}: {
  label: string;
  asset: ReplaySkinImageAsset | undefined;
  rowId?: string;
  highlighted?: boolean;
  onChange: () => void;
  onClear: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      data-asset-row={rowId}
      className={`flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 transition-colors ${
        highlighted ? "border-osu-pink/70 bg-osu-pink/10" : "border-osu-b3/40 bg-osu-b5/40"
      }`}
    >
      <span className="w-20 shrink-0 text-[11px] font-semibold text-osu-l1">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {asset ? (
          <>
            <span className="grid h-7 w-10 shrink-0 place-items-center overflow-hidden rounded bg-black/40">
              <img src={asset.src} alt="" draggable={false} className="max-h-7 max-w-10 object-contain" />
            </span>
            <span className="truncate font-mono text-[10px] text-osu-c1" title={asset.path ?? asset.name}>
              {asset.name}
            </span>
          </>
        ) : (
          <span className="text-[11px] text-osu-f1">{t`default`}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onChange}
          className="cursor-pointer rounded-md bg-osu-b3/50 px-2.5 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
        >
          {t`Change`}
        </button>
        {asset ? (
          <button
            type="button"
            onClick={onClear}
            className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-white"
          >
            {t`Clear`}
          </button>
        ) : null}
      </span>
    </div>
  );
}

// Lazy picker thumbnail: decodes the image the first time it scrolls into the
// rendered slice and keeps riding the shared promise cache afterwards.
function OskEntryThumbnail({
  archive,
  path,
  cache,
}: {
  archive: OskArchive;
  path: string;
  cache: Map<string, Promise<ReplaySkinImageAsset | undefined>>;
}) {
  const [asset, setAsset] = useState<ReplaySkinImageAsset | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadCachedOskAsset(archive, path, cache).then((loaded) => {
      if (!cancelled) setAsset(loaded ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [archive, path, cache]);
  return (
    <span className="grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded bg-black/40">
      {asset ? (
        <img src={asset.src} alt="" draggable={false} className="max-h-9 max-w-14 object-contain" />
      ) : (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-white/10" />
      )}
    </span>
  );
}

function ReplaySkinAssetPickerDialog({
  target,
  archive,
  entries,
  sourceName,
  thumbCache,
  onPick,
  onClose,
}: {
  target: AssetPickerTarget;
  archive: OskArchive;
  entries: OskImageEntry[];
  sourceName?: string | null;
  thumbCache: Map<string, Promise<ReplaySkinImageAsset | undefined>>;
  onPick: (asset: ReplaySkinImageAsset, applyToAllColumns: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [applyToAll, setApplyToAll] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const trimmed = query.trim().toLowerCase();
  const matches = trimmed ? entries.filter((entry) => entry.path.toLowerCase().includes(trimmed)) : entries;
  const visible = matches.slice(0, ASSET_PICKER_MAX_ENTRIES);

  const pick = async (entry: OskImageEntry) => {
    if (picking) return;
    setPicking(entry.path);
    const asset = await loadCachedOskAsset(archive, entry.path, thumbCache);
    setPicking(null);
    if (!asset) return;
    onPick(asset, applyToAll);
  };

  return (
    <>
      <motion.div
        className="fixed inset-0 z-[130] bg-black/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1 }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        className="fixed left-1/2 top-1/2 z-[131] w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-osu-b3/50 px-5 py-3">
          <div className="text-sm font-bold text-white">
            <Trans>Change {target.label}</Trans>
            {target.kind === "column" ? ` · ${t`Column ${target.column + 1}`}` : ""}
          </div>
          {sourceName ? <div className="mt-0.5 text-[10px] text-osu-f1"><Trans>Images from {sourceName}</Trans></div> : null}
        </div>
        <div className="space-y-2 px-5 py-4">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search images by file name`}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            className="h-9 w-full rounded-md border border-osu-b3/60 bg-osu-b5/70 px-3 text-xs font-semibold text-white outline-none transition-colors focus:border-osu-pink/70"
          />
          <div className="max-h-[320px] overflow-y-auto rounded-md border border-osu-b3/50 bg-osu-b5/40">
            {visible.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-osu-f1">{t`No images match that search.`}</div>
            ) : (
              visible.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => void pick(entry)}
                  disabled={picking != null}
                  className="flex w-full cursor-pointer items-center gap-2.5 border-b border-osu-b3/30 px-2.5 py-1.5 text-left transition-colors last:border-b-0 hover:bg-osu-b3/40 disabled:cursor-default"
                >
                  <OskEntryThumbnail archive={archive} path={entry.path} cache={thumbCache} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-osu-l1">{entry.name}</span>
                    <span className="block truncate font-mono text-[10px] text-osu-f1">{entry.path}</span>
                  </span>
                  {picking === entry.path ? (
                    <span className="shrink-0 text-[10px] font-semibold text-osu-f1">{t`Loading…`}</span>
                  ) : null}
                </button>
              ))
            )}
          </div>
          {matches.length > visible.length ? (
            <div className="text-[10px] text-osu-f1">
              <Trans>Showing {visible.length} of {matches.length} images. Refine your search to see the rest.</Trans>
            </div>
          ) : null}
          {target.kind === "column" ? (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-[11px] font-semibold text-osu-l1">
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(event) => setApplyToAll(event.target.checked)}
                className="h-3.5 w-3.5 cursor-pointer accent-osu-pink"
              />
              {t`Apply to all columns`}
            </label>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-osu-b3/50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </>
  );
}
