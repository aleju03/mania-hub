import { Application, Assets, CanvasRenderer, Container, FillGradient, Graphics, GraphicsPath, Matrix, Rectangle, Sprite, Text, Texture, WebGLRenderer } from "pixi.js";
import type { ReplayFrame, ReplayLifeBarFrame } from "../../lib/types";
import type { ManiaNote, ManiaScrollVelocity, ManiaTimingPoint } from "../../lib/beatmap-parser";
import type { Judgment, ManiaReplayHitWindows, ManiaReplayRuleset, ReplayJudgementEvent, ReplayNoteState } from "../../lib/mania-replay-judgement";
import { applyManiaReplayModsToNotes, buildReplaySegments, calculateReplayAccuracy, getManiaReplayHitWindows, getManiaReplayRuleset, simulateManiaReplayJudgements } from "../../lib/mania-replay-judgement";
import { calculateManiaPp, getManiaPpModMultiplier } from "../../lib/mania-pp";
import { createManiaScoreSimulator, formatLazerScore, formatStableScore, getScoreScaleToReal } from "../../lib/mania-score-simulation";
import type { ManiaScoreSimulator } from "../../lib/mania-score-simulation";
import { calculateManiaStarRatingTimeline } from "../../lib/mania-star-rating";
import { buildReplayPeakKps, replayPeakKpsAt } from "../../lib/replay-kps";
import { ensureReplayFontStyle } from "../../lib/replay-fonts";
import { withTimeout } from "../../lib/promise-timeout";
import type { ManiaStarRatingTimelinePoint } from "../../lib/mania-star-rating";
import { getReplayHandForColumn } from "../../lib/replay-hand-stats";
import { DEFAULT_REPLAY_MISS_THUMB_HAND, DEFAULT_REPLAY_OVERLAY_SETTINGS, REPLAY_OVERLAY_MAX_SCALE, REPLAY_OVERLAY_MIN_SCALE, normalizeReplayHandAccuracyStyle, normalizeReplayMissThumbHand, normalizeReplayOverlaySettings } from "../../lib/replay-overlays";
import type { ReplayOverlayId, ReplayOverlaySettings, ReplayThumbHand } from "../../lib/replay-overlays";
import { buildReplayMasterTimeline, drawReplayMasterTimeline } from "../../lib/replay-master-overlay";
import type { ReplayMasterTimeline } from "../../lib/replay-master-overlay";
import { DEFAULT_REPLAY_SCROLL_SPEED } from "../../lib/replay-scroll-speed";
import { DEFAULT_REPLAY_COMBO_FONT_SET, DEFAULT_REPLAY_JUDGEMENT_SET, DEFAULT_REPLAY_SKIN_SETTINGS, OSU_MANIA_DEFAULT_LIGHT_POSITION, OSU_MANIA_SCREEN_WIDTH, REPLAY_SKIN_DEFAULT_HIT_POSITION, getReplayComboFontStyle, getReplayJudgementScale, getReplayJudgementSetAssets, getReplaySkinProfile, getReplaySkinStagePosition, normalizeReplaySkinSettings } from "../../lib/replay-skin";
import type { ReplayComboFontStyle, ReplaySkinColumnAssets, ReplaySkinImageAsset, ReplaySkinKeymodeProfile, ReplaySkinSettings, ReplaySkinStagePositionKey } from "../../lib/replay-skin";
import type { ReplayLiveStats } from "../../lib/replay-types";
import type { ReplayHitCounts } from "../../lib/replay-validation";
import { buildStableReplayComboEvents, resolveReplayJudgementEvents } from "../../lib/replay-validation";
import type { HitsoundAnchor, ReplayHitsoundTrigger } from "../../lib/replay-hitsounds";
import { buildComboBreakSoundTimes, buildHitsoundAnchorsByColumn, selectHitsoundAnchor } from "../../lib/replay-hitsounds";
import { MANIA_FLASHLIGHT_DIM_ALPHA, dampManiaHiddenCoverageReference, getManiaFlashlightBand, getManiaHiddenAlphaAtY, getManiaHiddenCoverageReference, getManiaHiddenCoverageReferencePx, getManiaHiddenFadePx } from "../../lib/replay-visibility-mods";
import { opaqueStoryboardSpriteCoversRect, type StoryboardRect } from "../../lib/storyboard/occlusion";
import { StoryboardActiveSet, createStoryboardSpriteState, evaluateStoryboardSprite } from "../../lib/storyboard/timeline";
import { SB_LAYER_COUNT, SB_LAYER_FAIL, SB_LAYER_OVERLAY, STORYBOARD_HEIGHT, STORYBOARD_WIDTH } from "../../lib/storyboard/types";
import type { CompiledStoryboardSprite, ReplayStoryboardData } from "../../lib/storyboard/types";
import { peekStoryboardTexture, releaseStoryboardTexture, retainStoryboardTexture } from "./replay-storyboard-textures";
import { formatPixiRendererType } from "./renderer-debug";
import { MOD_BADGE_FILE_NAMES, MOD_BADGE_TYPE_COLORS } from "../ui/ModBadge";

type ReplaySegment = {
  start: number;
  end: number;
};

export interface ReplayLeaderboardEntry {
  name: string;
  score: number;
  combo: number;
  /** Real board position; the display never renumbers rows live. */
  rank?: number;
}

type ReplayLeaderboardRowKind = "other" | "target" | "player";

const COLUMN_COLORS: Record<number, string[]> = {
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

const JUDGMENT_COLORS: Record<number, string> = {
  1: "#b3f5ff",
  2: "#ffcc22",
  3: "#88da20",
  4: "#5a8fff",
  5: "#cc8800",
  6: "#ff4444",
};

// Both hand overlays (L/R misses, per-hand accuracy) draw from one colour
// pair so the same hand reads the same way across them.
const HAND_COLORS = { left: "#5a8fff", right: "#de31ae" } as const;

const JUDGMENT_LABELS: Record<number, string> = {
  1: "MAX", 2: "300", 3: "200", 4: "100", 5: "50", 6: "MISS",
};

// The classic selection-mod sprites extracted from the stable default skin,
// keyed by acronym; the rarer entries only exist as @1x art. ScoreV2 comes
// through as either "SV2" or "V2" depending on the source.
const STABLE_MOD_ICON_FILES: Record<string, string> = {
  EZ: "EZ", NF: "NF", HT: "HT", HR: "HR", SD: "SD", PF: "PF",
  DT: "DT", NC: "NC", HD: "HD", FI: "FI", FL: "FL", RD: "RD",
  MR: "MR", AT: "AT", CN: "CN", SV2: "SV2", V2: "SV2",
  "1K": "1K", "2K": "2K", "3K": "3K", "4K": "4K", "5K": "5K",
  "6K": "6K", "7K": "7K", "8K": "8K", "9K": "9K", "10K": "10K",
};

const stableModIconAssets = new Map<string, ReplaySkinImageAsset>();

function getStableModIconAsset(acronym: string): ReplaySkinImageAsset | null {
  const file = STABLE_MOD_ICON_FILES[acronym];
  if (!file) return null;
  let asset = stableModIconAssets.get(file);
  if (!asset) {
    asset = { name: `mod-${file}`, src: `/images/badges/mods/stable/${file}.png` };
    stableModIconAssets.set(file, asset);
  }
  return asset;
}

// Lazer badges reuse the site's ModBadge art: the white shield SVG tinted by
// mod type with the white glyph SVG tinted dark on top.
const LAZER_MOD_BADGE_SHAPE_ASSET: ReplaySkinImageAsset = { name: "mod-badge-shape", src: "/images/badges/mods/mod-icon.svg" };
// The shield SVG viewBox; the glyph sheets share its aspect with their own
// built-in padding, so both draw into the same rect.
const LAZER_MOD_BADGE_ASPECT = 100 / 70;

const lazerModGlyphAssets = new Map<string, ReplaySkinImageAsset>();

function getLazerModGlyphAsset(file: string): ReplaySkinImageAsset {
  let asset = lazerModGlyphAssets.get(file);
  if (!asset) {
    asset = { name: `mod-glyph-${file}`, src: `/images/badges/mods/mod-${file}.svg` };
    lazerModGlyphAssets.set(file, asset);
  }
  return asset;
}

// color-mix(in srgb-linear, black, color 10%), matching the glyph color the
// ModBadge component computes in CSS; the canvas needs it as a concrete hex.
const darkenedModColorCache = new Map<string, string>();

function darkenModBadgeColor(hex: string): string {
  let darkened = darkenedModColorCache.get(hex);
  if (!darkened) {
    const channel = (offset: number) => {
      const raw = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      const linear = raw <= 0.04045 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
      const mixed = linear * 0.1;
      const srgb = mixed <= 0.0031308 ? mixed * 12.92 : 1.055 * mixed ** (1 / 2.4) - 0.055;
      return Math.round(srgb * 255).toString(16).padStart(2, "0");
    };
    darkened = `#${channel(1)}${channel(3)}${channel(5)}`;
    darkenedModColorCache.set(hex, darkened);
  }
  return darkened;
}

// Mania accuracies bunch up in the top few percent, so a linear meter would
// pin both hands at the far end of the track. This curve spends most of the
// track between 95% and 100% and still moves once a play falls apart.
function handAccuracyMeterFill(accuracy: number): number {
  const normalized = Math.max(0, Math.min(1, accuracy / 100));
  return normalized ** 12;
}

const HOLD_VISUAL_GRACE_MS = 60;
// A busy replay stays a number: however much room the stage has, never more
// than this many named watchers get a line, and the rest become "+N more".
const MAX_SPECTATOR_NAMES_DRAWN = 8;
// What the backend is willing to name at all, so "+N more" counts from the
// same list the room sent rather than from a trimmed copy.
const MAX_SPECTATOR_NAMES_KNOWN = 20;
const BACKGROUND_FADE_DURATION_MS = 180;
const KEY_KPS_WINDOW_MS = 1000;
const REPLAY_JUDGEMENT_ASSET_HEIGHT_RATIO = 0.055;
const REPLAY_JUDGEMENT_POP_DURATION_MS = 280;
const REPLAY_JUDGEMENT_HOLD_DURATION_MS = 80;
const REPLAY_JUDGEMENT_FADE_DURATION_MS = 80;
const REPLAY_JUDGEMENT_REFERENCE_ASPECT = 256 / 72;
const REPLAY_COMBO_POP_DURATION_MS = 300;
const REPLAY_COMBO_POP_SCALE_Y = 1.4;
const REPLAY_COMBO_FADE_IN_DURATION_MS = 120;
const REPLAY_COMBO_BREAK_DURATION_MS = 200;
const REPLAY_COMBO_BREAK_SCALE = 4;
const MANIA_MAX_TIME_RANGE = 11485;
const MANIA_REFERENCE_HEIGHT = 768;
const MANIA_SKIN_STAGE_HEIGHT = 480;
const MANIA_DEFAULT_HIT_POSITION = (480 - 402) * 1.6;
const MANIA_HIT_TARGET_POSITION = REPLAY_SKIN_DEFAULT_HIT_POSITION;
const MANIA_BAR_NOTE_HEIGHT_RATIO = 0.22;
// How many times a cascading LN body may repeat before it is stretched
// instead. Art short enough to need more tiles than this is the uniform kind,
// where a stretch is the same picture for one draw call rather than dozens.
const MAX_LN_BODY_TILES = 8;
// Body art at least this much taller than it is wide is a cover-the-whole-hold
// strip (the importer's own cutoff for the ones it crops), so it runs once and
// then holds its end rather than repeating.
const LN_BODY_STRIP_ASPECT = 8;
// How much of a strip's far end is stretched over a hold that outruns it. Far
// from the cap these bodies are uniform, so a few rows carry any distance.
const LN_BODY_FILLER_ROWS = 8;
// What the inline mobile canvas used to be (~390-430px tall). Inline portrait
// layouts anchor skin scale and scroll speed to this instead of the real
// height, so the taller redesigned stage adds lookahead rather than speed.
const MOBILE_PORTRAIT_REFERENCE_HEIGHT = 430;
const BACKGROUND_OVERSCAN_SCALE = 1.02;
// A phone's replay stage is already physically small. Rendering it at the old
// 1.5x backing resolution while also asking WebGL for MSAA spent substantially
// more tile/VRAM memory for very little visible gain, which makes the renderer
// an easier target for Android's GPU-process killer.
const MOBILE_REPLAY_DPR_CAP = 1.25;
const DESKTOP_REPLAY_DPR_CAP = 2;
// Events crossed more than this far behind the playback clock (lag spikes,
// tab switches) stay silent instead of firing as a burst.
const HITSOUND_MAX_LATENESS_MS = 200;

function destroyReplayPixiApplication(app: Application<WebGLRenderer | CanvasRenderer>) {
  if (app.renderer instanceof WebGLRenderer) {
    // Pixi normally calls WEBGL_lose_context during destroy. A replay opened
    // immediately afterwards can then hit the same ANGLE create-loss-create
    // driver hang as the auto-detection probe. Pixi still deletes its GPU
    // resources below; let the browser retire the detached canvas context
    // naturally instead of forcing a context-loss event during navigation.
    app.renderer.context.extensions.loseContext = undefined;
  }
  app.destroy({ removeView: false }, { children: true });
}

type ArrowDirection = "left" | "right" | "up" | "down";

const ARROW_PATH = new GraphicsPath(
  "M5.8 17.5H20l-2.6-2.6c-2.6-2.6-2.6-6.8 0-9.4l2.4-2.4c2.4-2.4 6.2-2.4 8.6 0l16.9 16.9c2.2 2.2 2.2 5.8 0 8L28.4 44.9c-2.4 2.4-6.2 2.4-8.6 0l-2.4-2.4c-2.6-2.6-2.6-6.8 0-9.4l2.6-2.6H5.8C2.6 30.5 0 27.6 0 24s2.6-6.5 5.8-6.5Z",
);

function arrowTransform(cx: number, cy: number, size: number, direction: ArrowDirection): Matrix {
  const scale = size / 48;
  const x = cx - size / 2;
  const y = cy - size / 2;
  switch (direction) {
    case "left":
      return new Matrix(-scale, 0, 0, scale, x + size, y);
    case "up":
      return new Matrix(0, -scale, scale, 0, x, y + size);
    case "down":
      return new Matrix(0, scale, -scale, 0, x + size, y);
    case "right":
      return new Matrix(scale, 0, 0, scale, x, y);
  }
}

function buildArrowPath(cx: number, cy: number, size: number, direction: ArrowDirection): GraphicsPath {
  return new GraphicsPath().addPath(ARROW_PATH, arrowTransform(cx, cy, size, direction));
}

export function getColumnArrowDirection(col: number, keyCount: number): ArrowDirection {
  if (keyCount <= 1) return "down";
  if (col === 0) return "left";
  if (col === keyCount - 1) return "right";
  return col % 2 === 1 ? "up" : "down";
}

// Not Math.max(...notes.map(...)): spreading a marathon chart's note list can
// exceed the engine argument limit and throw a RangeError.
function maxNoteEndTime(notes: ReadonlyArray<{ endTime: number }>): number {
  let max = 0;
  for (const note of notes) max = Math.max(max, note.endTime);
  return max;
}

// A stage position (the settings' hit position, kept in the game's 768-space
// as a distance up from the stage's bottom edge) in the 480-unit stage space
// that column widths and skin art are measured in.
function getSkinStagePositionUnits(position: number): number {
  return Math.max(0, Math.min(768, position)) * (480 / 768);
}

const HEX_NUMBER_CACHE = new Map<string, number>();

function hexToNumber(color: string): number {
  const cached = HEX_NUMBER_CACHE.get(color);
  if (cached != null) return cached;
  let out = 0xffffff;
  if (color.startsWith("#")) {
    const raw = color.slice(1);
    const expanded = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    out = Number.parseInt(expanded, 16);
  }
  HEX_NUMBER_CACHE.set(color, out);
  return out;
}

function colorWithAlpha(color: string, alpha: number): string {
  const value = hexToNumber(color);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function easeOutElastic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped === 0 || clamped === 1) return clamped;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * clamped) * Math.sin((clamped * 10 - 0.75) * c4) + 1;
}

function easeOutQuad(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) * (1 - clamped);
}

function getModAcronym(mod: ReplayRendererMod): string {
  return (typeof mod === "string" ? mod : mod.acronym ?? "").toUpperCase();
}

function getModSetting(mod: ReplayRendererMod | undefined, names: string[]): unknown {
  if (!mod || typeof mod === "string") return undefined;
  const settings = mod.settings;
  if (!settings) return undefined;
  for (const name of names) {
    if (name in settings) return settings[name];
  }
  return undefined;
}

function parseModBooleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function parseModNumberSetting(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Cover's direction setting is lazer's CoverExpandDirection enum:
// 0 = AlongScroll (over the spawn edge, the serialization default),
// 1 = AgainstScroll (over the receptors, Hidden-style).
function parseCoverDirectionAlongScroll(value: unknown): boolean {
  if (typeof value === "number") return value !== 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "againstscroll" || normalized === "1") return false;
  }
  return true;
}

interface RendererOptions {
  backgroundImage?: HTMLImageElement;
  backgroundDim?: number;
  isConvert?: boolean;
  isLazer?: boolean;
  // Frame-time rounding is a property of the source replay file, not the
  // judging ruleset; pass it explicitly when re-judging a replay on the
  // other client (the "what if" toggle). Defaults to the judging mode.
  legacyReplayFrameRounding?: boolean;
  od?: number;
  showInputOverlay?: boolean;
  inputOverlayOnly?: boolean;
  inputOverlayColor?: string;
  inputOverlayKeyHistory?: boolean;
  mods?: ReplayRendererMod[];
  speedMultiplier?: number;
  timingPoints?: ManiaTimingPoint[];
  transparentBackground?: boolean;
  blackPlayfield?: boolean;
  hideHud?: boolean;
  hidePerformanceStats?: boolean;
  // Keeps the score/pp machinery running for getLiveStats() even with the HUD
  // hidden, so chrome outside the canvas can draw the same numbers.
  liveStats?: boolean;
  showCombo?: boolean;
  // Keeps the judgement pop over the notes with the rest of the HUD hidden.
  // It reads as part of the play, not as chrome, so a bare stage still shows
  // what every hit was judged as.
  showJudgements?: boolean;
  initialCombo?: number;
  barePlayfield?: boolean;
  // Comparison panels can be portrait-shaped on a landscape screen. Scale
  // their skins to the full panel height instead of the phone portrait cap.
  fullHeightLayout?: boolean;
  // Draws the storyboard (with its backdrop, background and dim) and nothing
  // else: no notes, no stage, no HUD. Side by side runs one of these full
  // bleed behind both playfields, so the storyboard is drawn once for the
  // screen instead of once per stage, centred on neither playfield.
  storyboardOnly?: boolean;
  // Where the playfield sits across the canvas: 0 flush left, 1 flush right,
  // 0.5 centred. Side by side pulls each stage toward the middle so the two
  // runs read as a pair instead of sitting a screen apart.
  playfieldAlign?: number;
  scrollVelocities?: ManiaScrollVelocity[];
  expectedCounts?: ReplayHitCounts;
  // Score the play actually earned; pins the simulated HUD score counter's
  // end state to the real total (absorbs mod-multiplier edge cases).
  realTotalScore?: number | null;
  lifeBarFrames?: ReplayLifeBarFrame[];
  showHealthBar?: boolean;
  skinSettings?: ReplaySkinSettings;
  overlaySettings?: ReplayOverlaySettings;
  // Which hand owns the middle lane of an odd keymode in per-hand stats.
  missThumbHand?: ReplayThumbHand;
  onOverlaySettingsChange?: (settings: ReplayOverlaySettings) => void;
  // Fired when the "+ thumb" tag on the L/R miss counter is clicked.
  onMissThumbHandChange?: (hand: ReplayThumbHand) => void;
  onContextLost?: (wasPlaying: boolean) => void;
  onContextRestored?: (resumed: boolean) => void;
}

interface Layout {
  w: number;
  h: number;
  playfieldWidth: number;
  playfieldX: number;
  laneWidth: number;
  layoutScale: number;
  judgmentY: number;
  noteHeight: number;
  receptorHeight: number;
  pixelsPerMs: number;
}

// One repeat of a cascading LN body: a destination band plus the slice of the
// source it shows. flipY marks the upscroll case, where the art runs from the
// band's bottom edge upward.
interface LnBodyTile {
  top: number;
  bottom: number;
  fracTop: number;
  fracBottom: number;
  flipY: boolean;
}

// Trims a cascade tile to a visible span without moving where its source is
// anchored, which is what lets the body stop at the tail cap's art while the
// cascade still counts from the box edge. Null when nothing of it survives.
function clipLnBodyTile(tile: LnBodyTile, clipTop: number, clipBottom: number): LnBodyTile | null {
  const top = Math.max(tile.top, clipTop);
  const bottom = Math.min(tile.bottom, clipBottom);
  if (!(bottom > top)) return null;
  if (top <= tile.top && bottom >= tile.bottom) return tile;
  const span = tile.bottom - tile.top;
  if (!(span > 0)) return null;
  const fracSpan = tile.fracBottom - tile.fracTop;
  // A tail-anchored tile runs its source the other way, so a trim at the top
  // of the span is a trim at the end of the source slice.
  const nearTrim = tile.flipY ? tile.bottom - bottom : top - tile.top;
  const farTrim = tile.flipY ? tile.bottom - top : bottom - tile.top;
  return {
    top,
    bottom,
    fracTop: tile.fracTop + fracSpan * (nearTrim / span),
    fracBottom: tile.fracTop + fracSpan * (farTrim / span),
    flipY: tile.flipY,
  };
}

// Fraction of a texture's height at which its visible pixels begin, measured
// from the top edge. Read once per source off a scratch canvas and cached.
// "pending" while the read is in flight (or if it failed - tainted canvas,
// zero-size image), which the caller treats as "stop at the cap's centre";
// null once a completed scan found no visible pixels at all, which means the
// cap covers nothing and the body should not be clipped for it. The tail cap
// is the only thing that needs this.
const LN_TAIL_ART_THRESHOLD = 25;
const lnTailArtTopCache = new Map<string, number | null | "pending">();

function readLnTailArtTop(src: string): void {
  if (lnTailArtTopCache.has(src)) return;
  lnTailArtTopCache.set(src, "pending");
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    try {
      const width = image.naturalWidth || 0;
      const height = image.naturalHeight || 0;
      if (!(width > 0) || !(height > 0)) return;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0);
      const alpha = ctx.getImageData(0, 0, width, height).data;
      for (let row = 0; row < height; row += 1) {
        const start = row * width * 4;
        for (let index = start + 3; index < start + width * 4; index += 4) {
          if (alpha[index] >= LN_TAIL_ART_THRESHOLD) {
            lnTailArtTopCache.set(src, row / height);
            return;
          }
        }
      }
      // Scanned clean: the cap is fully transparent.
      lnTailArtTopCache.set(src, null);
    } catch {
      // Tainted or unreadable: stays "pending", the centre stop applies.
    }
  };
  image.src = src;
}

type ReplayComboEvent = { kind: "break" | "hit"; time: number };
type ReplayOverlayHitbox = { id: ReplayOverlayId; x: number; y: number; width: number; height: number };
type ReplayOverlayResizeDirection = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
type ReplayOverlayFrame = { x: number; y: number; width: number; height: number };
type KeypressOverlayMetrics = {
  scale: number;
  keyGap: number;
  keyBoxWidth: number;
  keyBoxHeight: number;
  width: number;
  height: number;
};
type ReplayOverlayPlacementSnapshot = {
  id: ReplayOverlayId;
  x: number;
  y: number;
  scale: number;
  width: number;
  height: number;
};
type SkinSpriteFramePool = {
  layer: Container;
  sprites: Sprite[];
  stripTextures: (Texture | null)[];
  cursor: number;
};
type ReplayRendererMod = string | {
  acronym?: string;
  settings?: Record<string, string | number | boolean>;
};

export class ManiaReplayRenderer {
  private canvas: HTMLCanvasElement;
  // Typed to the renderers initPixi actually builds, so the destroy helper
  // (which reaches into the WebGL context) still type-checks against it.
  private app: Application<WebGLRenderer | CanvasRenderer> | null = null;
  private gameplayGraphics = new Graphics();
  private inputOverlayGraphics = new Graphics();
  private hudGraphics = new Graphics();
  private graphics = this.gameplayGraphics;
  private textLayer = new Container();
  private textPool: Text[] = [];
  private textPoolCursor = 0;
  private textMeasureContext: CanvasRenderingContext2D | null = null;
  private textWidthCache = new Map<string, number>();
  private textFontRevision = 0;
  private comboTextLayer = new Container();
  private comboTextPool: Text[] = [];
  private comboTextPoolCursor = 0;
  private gameplaySkinSprites: SkinSpriteFramePool = {
    layer: new Container(),
    sprites: [],
    stripTextures: [],
    cursor: 0,
  };
  private hudSkinSprites: SkinSpriteFramePool = {
    layer: new Container(),
    sprites: [],
    stripTextures: [],
    cursor: 0,
  };
  private activeSkinSprites = this.gameplaySkinSprites;
  private skinTextureCache = new Map<string, Texture>();
  private skinTextureLoadPromises = new Map<string, Promise<Texture | null>>();
  private skinTextureFailedSources = new Set<string>();
  private backgroundLayer = new Container();
  private backgroundSprite: Sprite | null = null;
  private previousBackgroundSprite: Sprite | null = null;
  private storyboardData: ReplayStoryboardData | null = null;
  private storyboardActiveSet: StoryboardActiveSet | null = null;
  // Opaque base under the storyboard (osu! renders storyboards on black).
  private storyboardBackdrop = new Graphics();
  // Background/Fail/Pass/Foreground layers + the map background, under the
  // playfield; the dim rect sits between them and the playfield.
  private storyboardBackRoot = new Container();
  private storyboardDim = new Graphics();
  // Overlay layer, above the playfield but below every part of the HUD.
  private storyboardOverlayRoot = new Container();
  private storyboardLayerContainers: Container[] = [];
  private storyboardBackgroundSprite: Sprite | null = null;
  private storyboardMaskBack: Graphics | null = null;
  private storyboardMaskOverlay: Graphics | null = null;
  private storyboardPixiBySprite = new Map<CompiledStoryboardSprite, Sprite>();
  private storyboardSpritePool: Sprite[] = [];
  private storyboardRetainedUrls: string[] = [];
  private storyboardScratchState = createStoryboardSpriteState();
  private storyboardShapesW = 0;
  private storyboardShapesH = 0;
  private storyboardShapesDim = -1;
  private storyboardReadyPromise: Promise<void> = Promise.resolve();
  // The storyboard only draws once every texture is resident; until then the
  // stage stays transparent so the page's normal background keeps showing
  // instead of a half-loaded flash.
  private storyboardTexturesReady = false;
  private storyboardOccludesPlayfield = false;
  private receptorBeamGradients = new Map<string, FillGradient>();
  private inputHistoryTopFadeGradient: FillGradient | null = null;
  private flashlightFadeToClearGradient: FillGradient | null = null;
  private flashlightFadeToDimGradient: FillGradient | null = null;
  private initPromise: Promise<void>;
  private destroyed = false;

  private frames: ReplayFrame[];
  private notes: ManiaNote[];
  private lifeBarFrames: ReplayLifeBarFrame[];
  private keypressTimesByColumn: number[][];
  private keypressTimes: number[] = [];
  private peakKps: Uint32Array = new Uint32Array();
  private removeTextFontListener: (() => void) | null = null;
  private keyCount: number;
  private currentTime = 0;
  private playbackSpeed = 1;
  private modRate = 1;
  private _isPlaying = false;
  private scrollSpeed = DEFAULT_REPLAY_SCROLL_SPEED;
  private animFrameId = 0;
  private lastRenderTime = 0;
  private audioClockAnchorTime: number | null = null;
  private audioClockAnchorNow = 0;
  private fpsSampleStartedAt = 0;
  private fpsMaxObserved = 0;
  private fpsFrameCount = 0;
  private measuredFps = 0;
  private colors: string[];
  private totalDuration: number;
  private segments: ReturnType<typeof buildReplaySegments>;
  private maxHoldDuration: number;
  private scrollVelocities: ManiaScrollVelocity[];
  private scrollVelocityMinMultiplier = 1;
  private scrollVelocityTimes: number[] = [0];
  private scrollVelocityMultipliers: number[] = [1];
  private scrollVelocityCumulative: number[] = [0];
  private ruleset: ManiaReplayRuleset;
  private hitWindows: ManiaReplayHitWindows;

  private backgroundImage: HTMLImageElement | null = null;
  private previousBackgroundImage: HTMLImageElement | null = null;
  private backgroundDim = 80;
  private backgroundTransitionStartedAt = 0;
  private od = 8;
  private showInputOverlay = false;
  private inputOverlayOnly = false;
  private inputOverlayColor = "#a855f7";
  private inputOverlayKeyHistory = false;
  private hasHiddenMod = false;
  private hasFadeInMod = false;
  private coverMod: { coverage: number; alongScroll: boolean } | null = null;
  private hasVisibilityMod = false;
  private hasFlashlightMod = false;
  private flashlightComboBasedSize = false;
  private flashlightSizeMultiplier = 1;
  private transparentBackground = false;
  private blackPlayfield = false;
  private hideHud = false;
  private hidePerformanceStats = false;
  private liveStats = false;
  private showCombo = false;
  private showJudgements = false;
  private playfieldAlign: number | null = null;
  private initialCombo = 0;
  private hiddenCoverageReference = getManiaHiddenCoverageReference(0);
  private hiddenCoverageUpdatedAt = 0;
  private barePlayfield = false;
  private storyboardOnly = false;
  private showHealthBar = true;
  private skinSettings: ReplaySkinSettings = DEFAULT_REPLAY_SKIN_SETTINGS;
  private overlaySettings: ReplayOverlaySettings = DEFAULT_REPLAY_OVERLAY_SETTINGS;
  private onOverlaySettingsChange: ((settings: ReplayOverlaySettings) => void) | null = null;
  private onMissThumbHandChange: ((hand: ReplayThumbHand) => void) | null = null;
  private onContextLost: ((wasPlaying: boolean) => void) | null = null;
  private onContextRestored: ((resumed: boolean) => void) | null = null;
  private handleContextLost: ((event: Event) => void) | null = null;
  private handleContextRestored: (() => void) | null = null;
  // Pixi restores its buffers/textures when the browser restores WebGL, but
  // this wrapper pauses its own RAF on loss. Remember whether that RAF must be
  // restarted; otherwise a successfully restored replay stays frozen forever.
  private resumeAfterContextRestore = false;
  // Wall-clock cost of the synchronous judgement simulation done in the
  // constructor; surfaced to crash diagnostics to catch main-thread hangs.
  private judgementBuildMs: number | null = null;
  private overlayHitboxes: ReplayOverlayHitbox[] = [];
  private overlayCloseButtons: Array<{ id: ReplayOverlayId; x: number; y: number; radius: number }> = [];
  // The "+ thumb" tag on the L/R miss counter of an odd keymode: it names the
  // side that owns the middle lane and a click on it moves the thumb over.
  private missThumbTagHitbox: { x: number; y: number; width: number; height: number } | null = null;
  private missThumbTagHovered = false;
  private missThumbTagPress: { pointerId: number; x: number; y: number } | null = null;
  // Set when a close button eats a press: the release then lands on bare
  // playfield (the overlay is gone) and must not read as click-to-pause.
  private suppressPlayfieldClickAt = -Infinity;
  private selectedOverlayIds = new Set<ReplayOverlayId>();
  private activeOverlayPointers = new Map<number, { id: ReplayOverlayId; x: number; y: number }>();
  private previousCanvasTouchAction = "";
  private draggingOverlay: {
    id: ReplayOverlayId;
    pointerId: number;
    startX: number;
    startY: number;
    startPlacementX: number;
    startPlacementY: number;
    width: number;
    height: number;
    selected: ReplayOverlayPlacementSnapshot[];
  } | null = null;
  private resizingOverlay: {
    id: ReplayOverlayId;
    direction: ReplayOverlayResizeDirection;
    pointerId: number;
    startX: number;
    startY: number;
    startPlacementX: number;
    startPlacementY: number;
    startScale: number;
    startWidth: number;
    startHeight: number;
    selected: ReplayOverlayPlacementSnapshot[];
  } | null = null;
  private pinchingOverlay: {
    id: ReplayOverlayId;
    pointerIds: [number, number];
    startDistance: number;
    startScale: number;
    startWidth: number;
    startHeight: number;
  } | null = null;
  private selectingOverlays: {
    pointerId: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    initialSelection: ReplayOverlayId[];
    additive: boolean;
  } | null = null;
  private skinProfile: ReplaySkinKeymodeProfile = getReplaySkinProfile(DEFAULT_REPLAY_SKIN_SETTINGS, 4);
  private barTapColors: string[] = [];
  private circleTapColors: string[] = [];
  private circleLnHeadColors: string[] = [];
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private antialias = true;
  private fullscreenLayout = false;
  private fullHeightLayout = false;

  private externalClock: (() => { time: number; stalled: boolean } | null) | null = null;
  private receptorFlashTimestamps: number[];
  private judgmentEvents: ReplayJudgementEvent[];
  private missTimesCache: number[] | null = null;
  private noteStates: ReplayNoteState[];
  private replayMasterTimeline: ReplayMasterTimeline | null = null;
  private comboEvents: ReplayComboEvent[];

  private combo = 0;
  private maxComboSoFar = 0;
  private comboAnimationValue = 0;
  private comboAnimationTime = -Infinity;
  private comboAnimationKind: "hit" | "break" | null = null;
  private statsScanIndex = 0;
  private comboScanIndex = 0;
  private hitsoundTrigger: ReplayHitsoundTrigger | null = null;
  private hitsoundAnchorsByColumn: HitsoundAnchor[][] = [];
  private comboBreakSoundTimes: number[] = [];
  private hitsoundPressCursors: number[] = [];
  private comboBreakSoundCursor = 0;
  private judgmentCounts: number[] = [0, 0, 0, 0, 0, 0, 0];
  private scoreSimulator: ManiaScoreSimulator | null = null;
  private modAcronyms: string[] = [];
  private failTime: number | null = null;
  private leaderboardEntries: ReplayLeaderboardEntry[] = [];
  private leaderboardHidden = false;
  private leaderboardPlayerName = "";
  private leaderboardSlotYs = new Map<string, number>();
  private leaderboardSlotGradients = new Map<string, FillGradient>();
  private leaderboardPrevRank: number | null = null;
  private leaderboardFlashAt = -Infinity;
  private leaderboardAnimTs = 0;
  private leaderboardGlowAsset: ReplaySkinImageAsset | null = null;
  private suppressOvertakeFlash = false;
  private spectatorCount = 0;
  private spectatorNames: string[] = [];
  private starRatingTimeline: ManiaStarRatingTimelinePoint[] = [];
  private ppModMultiplier = 1;
  private leftHandMisses = 0;
  private rightHandMisses = 0;
  private leftHandJudgmentCounts: number[] = [0, 0, 0, 0, 0, 0, 0];
  private rightHandJudgmentCounts: number[] = [0, 0, 0, 0, 0, 0, 0];
  private missThumbHand: ReplayThumbHand = DEFAULT_REPLAY_MISS_THUMB_HAND;
  private recentHitOffsets: number[] = [];
  private recentHitTimes: number[] = [];
  // Wall-clock eased position of the hit-error average marker; both clients
  // glide it toward each new value instead of snapping per hit.
  private hitErrorAvgDisplayed: number | null = null;
  private hitErrorAvgTs = 0;
  private lastJudgment: Judgment = 0;
  private lastJudgmentTime = 0;

  private cachedLayout: Layout | null = null;
  private cachedColumns: { x: number; width: number }[] = [];
  private keyStateCursor = 0;
  private currentKeyState = 0;
  private urSum = 0;
  private urSumSq = 0;
  // Whole-run counterparts of the rolling ur* sums above: the HUD's hit-error
  // bar wants the last few hits, getLiveStats wants the run so far.
  private totalHits = 0;
  private totalHitOffsetSum = 0;
  private totalHitOffsetSumSq = 0;
  private earlyHits = 0;
  private lateHits = 0;
  private maxPp = 0;

  private staticGraphics = new Graphics();
  private staticDirty = true;

  private hudSnapshotTime = -Infinity;
  private hudCachedScore = "00000000";
  private hudCachedAccuracy = "100.00%";
  private hudCachedPp = "0pp";
  private hudCachedUr = "0";
  private hudCachedTime = "0:00";
  private hudCachedJudgmentCounts: string[] = ["0", "0", "0", "0", "0", "0", "0"];
  private hudCachedLeftMisses = "0";
  private hudCachedRightMisses = "0";
  // Digits only: the per-hand overlay draws the "%" as its own smaller glyph,
  // and the meter needs the number rather than the formatted string.
  private hudCachedLeftHandAccuracy = "100.00";
  private hudCachedRightHandAccuracy = "100.00";
  private hudCachedLeftHandAccuracyValue = 100;
  private hudCachedRightHandAccuracyValue = 100;
  private hudCachedKeyKps: string[] = [];
  private hudCachedTotalKps = "0";
  private hudCachedTotalKpsValue = 0;
  private hudCachedMaxKps = "0";
  private hudCachedMaxKpsValue = 0;


  constructor(
    canvas: HTMLCanvasElement,
    frames: ReplayFrame[],
    keyCount: number,
    notes: ManiaNote[] = [],
    options?: RendererOptions,
  ) {
    this.canvas = canvas;
    this.canvas.style.visibility = "";
    this.frames = frames;
    this.lifeBarFrames = (options?.lifeBarFrames ?? [])
      .map((frame) => ({
        time: Math.round(frame.time),
        health: Math.max(0, Math.min(1, frame.health)),
      }))
      .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.health))
      .sort((a, b) => a.time - b.time);
    this.keyCount = keyCount;
    this.keypressTimesByColumn = this.buildKeypressTimesByColumn();
    this.keypressTimes = this.keypressTimesByColumn.flat().sort((a, b) => a - b);
    this.hudCachedKeyKps = new Array(keyCount).fill("0");
    this.colors = COLUMN_COLORS[keyCount] || this.generateColors(keyCount);
    for (const c of this.colors) hexToNumber(c);

    const inputMods = (options?.mods ?? []).filter(Boolean);
    const mods = new Set(inputMods.map((m) => getModAcronym(m)).filter(Boolean));
    this.modAcronyms = [...mods] as string[];
    const flashlightMod = inputMods.find((m) => getModAcronym(m) === "FL");
    const speedMultiplier = Number(options?.speedMultiplier);
    this.modRate = Number.isFinite(speedMultiplier) && speedMultiplier > 0
      ? speedMultiplier
      : mods.has("DT") || mods.has("NC")
        ? 1.5
        : mods.has("HT") || mods.has("DC")
          ? 0.75
          : 1;
    this.peakKps = buildReplayPeakKps(this.keypressTimes, KEY_KPS_WINDOW_MS, this.modRate);
    this.hasHiddenMod = mods.has("HD");
    this.hasFadeInMod = mods.has("FI");
    const coverInputMod = inputMods.find((m) => getModAcronym(m) === "CO");
    this.coverMod = coverInputMod != null
      ? {
          coverage: Math.min(0.8, Math.max(0.2, parseModNumberSetting(getModSetting(coverInputMod, ["coverage"]), 0.5))),
          alongScroll: parseCoverDirectionAlongScroll(getModSetting(coverInputMod, ["direction"])),
        }
      : null;
    this.hasVisibilityMod = this.hasHiddenMod || this.hasFadeInMod || this.coverMod != null;
    this.hasFlashlightMod = mods.has("FL");
    this.flashlightComboBasedSize = parseModBooleanSetting(
      getModSetting(flashlightMod, ["combo_based_size", "comboBasedSize", "combo_based", "comboBased"]),
      false,
    );
    this.flashlightSizeMultiplier = parseModNumberSetting(
      getModSetting(flashlightMod, ["size_multiplier", "sizeMultiplier", "flashlight_size", "flashlightSize"]),
      1,
    );
    this.notes = applyManiaReplayModsToNotes(notes, keyCount, inputMods, {
      timingPoints: options?.timingPoints,
    });
    this.ruleset = getManiaReplayRuleset(options?.isLazer ?? false, [...mods], options?.isConvert ?? false, this.modRate);

    this.backgroundImage = options?.backgroundImage ?? null;
    this.backgroundDim = options?.backgroundDim ?? 80;
    const difficultyAdjustMod = inputMods.find((m) => getModAcronym(m) === "DA");
    const overriddenOd = Number(getModSetting(difficultyAdjustMod, ["overall_difficulty", "overallDifficulty"]));
    // NaN-proof (`NaN ?? 8` stays NaN): a non-finite od poisons every hit
    // window, which disables the judgement simulation's loop guards.
    const suppliedOd = options?.od;
    this.od = Number.isFinite(overriddenOd)
      ? overriddenOd
      : suppliedOd != null && Number.isFinite(suppliedOd) ? suppliedOd : 8;
    this.showInputOverlay = options?.showInputOverlay ?? false;
    this.inputOverlayOnly = options?.inputOverlayOnly ?? false;
    this.inputOverlayColor = options?.inputOverlayColor ?? "#a855f7";
    this.inputOverlayKeyHistory = options?.inputOverlayKeyHistory ?? false;
    this.transparentBackground = options?.transparentBackground ?? false;
    this.blackPlayfield = options?.blackPlayfield ?? false;
    this.hideHud = options?.hideHud ?? false;
    this.hidePerformanceStats = options?.hidePerformanceStats ?? false;
    this.liveStats = options?.liveStats ?? false;
    this.showCombo = options?.showCombo ?? false;
    this.showJudgements = options?.showJudgements ?? false;
    this.playfieldAlign = options?.playfieldAlign != null
      ? Math.max(0, Math.min(1, options.playfieldAlign))
      : null;
    this.initialCombo = Math.max(0, Math.floor(options?.initialCombo ?? 0));
    this.combo = this.initialCombo;
    this.hiddenCoverageReference = getManiaHiddenCoverageReference(this.combo);
    this.maxComboSoFar = this.combo;
    this.barePlayfield = options?.barePlayfield ?? false;
    this.fullHeightLayout = options?.fullHeightLayout ?? false;
    this.storyboardOnly = options?.storyboardOnly ?? false;
    this.showHealthBar = options?.showHealthBar ?? true;
    this.skinSettings = normalizeReplaySkinSettings(options?.skinSettings);
    this.overlaySettings = normalizeReplayOverlaySettings(options?.overlaySettings);
    this.missThumbHand = normalizeReplayMissThumbHand(options?.missThumbHand);
    this.onOverlaySettingsChange = options?.onOverlaySettingsChange ?? null;
    this.onMissThumbHandChange = options?.onMissThumbHandChange ?? null;
    this.onContextLost = options?.onContextLost ?? null;
    this.onContextRestored = options?.onContextRestored ?? null;
    this.updateSkinCache();
    // Constant Speed removes every BPM/SV-driven scroll change; the renderer's
    // base scroll is already constant-time, so dropping the SVs is the mod.
    this.scrollVelocities = mods.has("CS") ? [] : options?.scrollVelocities ?? [];
    this.prepareScrollVelocities();
    this.receptorFlashTimestamps = new Array(keyCount).fill(0);
    this.hitWindows = getManiaReplayHitWindows(this.od, this.ruleset);

    const frameDuration = frames.length > 0 ? frames[frames.length - 1].time : 0;
    const noteDuration = maxNoteEndTime(this.notes);
    const replayTailGrace = this.hitWindows.miss * 1.5;
    this.totalDuration = Math.max(frameDuration, noteDuration + replayTailGrace);

    this.maxHoldDuration = 0;
    for (const n of this.notes) {
      if (n.isHold) this.maxHoldDuration = Math.max(this.maxHoldDuration, n.endTime - n.time);
    }

    const judgementBuildStart = typeof performance !== "undefined" ? performance.now() : 0;
    this.segments = buildReplaySegments(this.frames, this.keyCount, this.totalDuration);
    const simulated = simulateManiaReplayJudgements(
      this.notes,
      this.segments,
      this.keyCount,
      this.hitWindows,
      this.ruleset.accuracyMode,
      {
        lazerNoReleaseTails: mods.has("NR"),
        legacyReplayFrameRounding: options?.legacyReplayFrameRounding ?? this.ruleset.accuracyMode !== "lazer",
        speedMultiplier: this.ruleset.speedMultiplier,
      },
    );
    if (typeof performance !== "undefined") {
      this.judgementBuildMs = performance.now() - judgementBuildStart;
      // These loops run synchronously on the main thread; a multi-second run can
      // hang the tab into a "page unresponsive" kill. Flag it so we can catch
      // pathological charts and consider moving the work off-thread.
      if (this.judgementBuildMs > 1500) {
        console.warn(
          `[replay] slow judgement build: ${Math.round(this.judgementBuildMs)}ms ` +
            `(${this.notes.length} notes, ${this.frames.length} frames)`,
        );
      }
    }
    const rawStableComboEvents = this.ruleset.accuracyMode === "stable"
      ? buildStableReplayComboEvents(this.notes, simulated.noteStates)
      : null;
    this.judgmentEvents = this.ruleset.accuracyMode === "lazer" && options?.expectedCounts
      ? resolveReplayJudgementEvents(simulated.events, options.expectedCounts, {
          allowLegacyScoreReconciliation: false,
          comboBreakTimes: rawStableComboEvents
            ?.filter((event) => event.kind === "break")
            .map((event) => event.time),
          lifeBarFrames: this.lifeBarFrames,
        }).events
      : simulated.events;
    // Fail detection must read the .osr's real life bar, never the simulated
    // fallback below (whose HP can legitimately die under an all-miss tail).
    this.failTime = this.computeFailTime();
    if (this.lifeBarFrames.length === 0) {
      this.lifeBarFrames = this.buildFallbackLifeBarFrames(this.judgmentEvents);
    }
    this.noteStates = simulated.noteStates;
    this.replayMasterTimeline = null;
    this.comboEvents = this.ruleset.accuracyMode === "stable"
      ? rawStableComboEvents ?? buildStableReplayComboEvents(this.notes, this.noteStates)
      : this.judgmentEvents.map((event) => ({
          kind: event.judgment == null || event.judgment === 6 ? "break" : "hit",
          time: event.time,
        }));
    const lastJudgementTime = this.judgmentEvents.length > 0
      ? this.judgmentEvents[this.judgmentEvents.length - 1].time
      : 0;
    this.totalDuration = Math.max(this.totalDuration, lastJudgementTime);

    // Live PP counter inputs: lazer-style timed star ratings over the same
    // post-mod note list the judgements are simulated on. Skipped where the
    // HUD can never render (chart previews, bare playfields).
    this.ppModMultiplier = getManiaPpModMultiplier([...mods]);
    this.rebuildStarRatingTimeline();
    this.buildScoreSimulator(options?.realTotalScore ?? null);

    this.buildHitsoundTimeline();

    this.setupStoryboardContainers();
    this.measureCanvas();
    this.installTextFontInvalidation();
    this.initPromise = this.initPixi();
    this.installOverlayPointerHandlers();
  }

  private installTextFontInvalidation() {
    if (typeof document === "undefined" || !document.fonts?.ready) return;
    const invalidate = () => {
      if (this.destroyed) return;
      this.textFontRevision++;
      this.textWidthCache.clear();
      for (const label of this.textPool as Array<Text & { __sig?: string }>) {
        label.__sig = undefined;
        label.text = "";
      }
      for (const label of this.comboTextPool as Array<Text & { __sig?: string }>) {
        label.__sig = undefined;
        label.text = "";
      }
      if (!this._isPlaying) this.render();
    };
    void document.fonts.ready.then(invalidate);
    document.fonts.addEventListener?.("loadingdone", invalidate);
    this.removeTextFontListener = () => document.fonts.removeEventListener?.("loadingdone", invalidate);
  }

  private async initPixi() {
    // Font registration now belongs to the viewer. Explicitly load canvas-only
    // text before its first paint; a blocked font host falls back after a short
    // wait, with loadingdone invalidating cached text if it recovers later.
    await withTimeout(
      ensureReplayFontStyle(getReplayComboFontStyle(this.skinSettings.comboFontSet)),
      2500,
      "Timed out loading replay fonts.",
    ).catch(() => {});
    if (this.destroyed) return;
    const app = new Application<WebGLRenderer | CanvasRenderer>();
    const width = Math.max(1, this.cssWidth);
    const height = Math.max(1, this.cssHeight);
    const contextAttributes: WebGLContextAttributes = {
      alpha: true,
      antialias: this.antialias,
      premultipliedAlpha: true,
      stencil: true,
      powerPreference: "default",
    };
    // Pixi's autoDetectRenderer probes WebGL on a throwaway canvas and
    // immediately loses that context before requesting the real one. Some
    // ANGLE/driver combinations hang the whole renderer process during that
    // create-loss-create sequence. Request the actual replay context once and
    // pass it into the renderer so Pixi never runs the destructive probe.
    const gl = this.canvas.getContext("webgl2", contextAttributes);
    // Pixi 8 takes a WebGL2 context object and nothing else. On a canvas that
    // can only do WebGL1 we still create the context here and let Pixi ask for
    // it through preferWebGLVersion: getContext hands back the context already
    // on the canvas, so the destructive probe stays skipped either way.
    const gl1 = gl ? null : this.canvas.getContext("webgl", contextAttributes);
    let renderer: WebGLRenderer | CanvasRenderer;
    if (gl || gl1) {
      const webglRenderer = new WebGLRenderer();
      await webglRenderer.init({
        canvas: this.canvas,
        context: gl,
        preferWebGLVersion: gl ? 2 : 1,
        width,
        height,
        resolution: this.dpr,
        autoDensity: true,
        antialias: this.antialias,
        backgroundAlpha: 0,
      });
      renderer = webglRenderer;
    } else {
      const canvasRenderer = new CanvasRenderer();
      await canvasRenderer.init({
        canvas: this.canvas,
        width,
        height,
        resolution: this.dpr,
        autoDensity: true,
        antialias: this.antialias,
        backgroundAlpha: 0,
      });
      renderer = canvasRenderer;
    }
    app.renderer = renderer;
    const applicationOptions = {
      canvas: this.canvas,
      width,
      height,
      resolution: this.dpr,
      autoDensity: true,
      autoStart: false,
      antialias: this.antialias,
      backgroundAlpha: 0,
    };
    Application._plugins.forEach((plugin) => plugin.init.call(app, applicationOptions));

    if (this.destroyed) {
      destroyReplayPixiApplication(app);
      return;
    }

    this.app = app;
    // A GPU driver reset / VRAM pressure fires webglcontextlost; without
    // preventDefault the browser never restores the context (hard failure).
    // preventDefault opts into restoration and lets us record the event for
    // crash diagnostics.
    this.handleContextLost = (event: Event) => {
      event.preventDefault();
      const wasPlaying = this._isPlaying;
      this.resumeAfterContextRestore ||= wasPlaying;
      this.pause();
      console.error("[replay] WebGL context lost");
      this.onContextLost?.(wasPlaying);
    };
    this.handleContextRestored = () => {
      console.warn("[replay] WebGL context restored");
      if (this.destroyed) return;
      const shouldResume = this.resumeAfterContextRestore;
      this.resumeAfterContextRestore = false;
      // Pixi's listener was installed during renderer.init(), before ours, so
      // its contextChange pass has rebuilt GPU state by this point. Force the
      // first upload even for a paused replay, or restart the RAF/audio-driven
      // clock when the loss interrupted playback.
      if (shouldResume) this.play();
      else this.render(true);
      this.onContextRestored?.(shouldResume);
    };
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
    app.stage.addChild(this.backgroundLayer);
    app.stage.addChild(this.storyboardBackdrop);
    app.stage.addChild(this.storyboardBackRoot);
    app.stage.addChild(this.storyboardDim);
    app.stage.addChild(this.staticGraphics);
    app.stage.addChild(this.gameplayGraphics);
    app.stage.addChild(this.gameplaySkinSprites.layer);
    // Input holds must remain visible over opaque imported LN bodies.
    app.stage.addChild(this.inputOverlayGraphics);
    app.stage.addChild(this.storyboardOverlayRoot);
    app.stage.addChild(this.hudGraphics);
    app.stage.addChild(this.hudSkinSprites.layer);
    app.stage.addChild(this.textLayer);
    app.stage.addChild(this.comboTextLayer);
    this.rebuildBackgroundSprites();
    this.prewarmSkinTextures();
    this.resize();
  }

  private buildKeypressTimesByColumn(): number[][] {
    const out = Array.from({ length: this.keyCount }, () => [] as number[]);
    let previousState = 0;
    for (const frame of this.frames) {
      const rising = frame.keyState & ~previousState;
      if (rising !== 0) {
        for (let col = 0; col < this.keyCount; col++) {
          if ((rising & (1 << col)) !== 0) out[col].push(frame.time);
        }
      }
      previousState = frame.keyState;
    }
    return out;
  }

  // A failed replay's life bar graph ends at zero and its inputs stop well
  // before the chart does. Both must hold: a pass whose graph merely ends
  // low, or a file with a truncated graph, is not a fail.
  private computeFailTime(): number | null {
    const lifeFrames = this.lifeBarFrames;
    if (lifeFrames.length === 0) return null;
    if (lifeFrames[lifeFrames.length - 1].health > 0.001) return null;
    const lastInputTime = this.frames.length > 0 ? this.frames[this.frames.length - 1].time : 0;
    const lastNoteTime = maxNoteEndTime(this.notes);
    if (lastNoteTime > 0 && lastInputTime >= lastNoteTime - 1500) return null;
    // Walk back to where the terminal zero-health run starts.
    let failAt = lifeFrames[lifeFrames.length - 1].time;
    for (let i = lifeFrames.length - 1; i >= 0 && lifeFrames[i].health <= 0.001; i--) {
      failAt = lifeFrames[i].time;
    }
    return failAt > 0 ? failAt : null;
  }

  getFailTime(): number | null {
    return this.failTime;
  }

  // The ingame leaderboard's static rows: the map's top scores (already
  // scaled to the judging client's scoring), minus the watched play itself.
  setLeaderboard(entries: ReplayLeaderboardEntry[], playerName: string) {
    this.leaderboardEntries = entries
      .filter((entry) => entry && typeof entry.name === "string" && Number.isFinite(entry.score) && entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    this.leaderboardPlayerName = playerName;
    this.leaderboardSlotYs.clear();
    this.leaderboardPrevRank = null;
    this.suppressOvertakeFlash = true;
    if (!this._isPlaying) this.render();
  }

  // Tab toggles the scoreboard, like ingame. Rank tracking stays live while
  // hidden so re-showing it never fires a stale overtake flash.
  setLeaderboardVisible(visible: boolean) {
    if (this.leaderboardHidden === !visible) return;
    this.leaderboardHidden = !visible;
    if (!this._isPlaying) this.render();
  }

  // Live watcher count shown osu!-style above the scoreboard.
  setSpectatorCount(count: number) {
    if (this.spectatorCount === count) return;
    this.spectatorCount = count;
    if (!this._isPlaying) this.render();
  }

  // The watchers who asked to be named, in arrival order. Everyone else in the
  // room is only part of the count above. The whole list is kept, not just the
  // drawable part: the label needs the total to say how many it left out.
  setSpectatorNames(names: string[]) {
    const next = names.slice(0, MAX_SPECTATOR_NAMES_KNOWN);
    if (next.length === this.spectatorNames.length && next.every((name, i) => name === this.spectatorNames[i])) return;
    this.spectatorNames = next;
    if (!this._isPlaying) this.render();
  }

  private generateColors(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `#${Math.floor(0xffffff * (0.45 + 0.55 * Math.sin((i / n) * Math.PI))).toString(16).padStart(6, "0")}`);
  }

  private recomputeStatsUpTo(time: number) {
    this.statsScanIndex = 0;
    this.comboScanIndex = 0;
    this.combo = this.initialCombo;
    this.maxComboSoFar = this.combo;
    this.comboAnimationValue = 0;
    this.comboAnimationTime = -Infinity;
    this.comboAnimationKind = null;
    this.judgmentCounts = [0, 0, 0, 0, 0, 0, 0];
    this.scoreSimulator?.reset();
    // A seek re-derives the leaderboard rank from scratch; that jump is not
    // an overtake.
    this.suppressOvertakeFlash = true;
    this.leftHandMisses = 0;
    this.rightHandMisses = 0;
    this.leftHandJudgmentCounts = [0, 0, 0, 0, 0, 0, 0];
    this.rightHandJudgmentCounts = [0, 0, 0, 0, 0, 0, 0];
    this.recentHitOffsets = [];
    this.recentHitTimes = [];
    this.hitErrorAvgDisplayed = null;
    this.urSum = 0;
    this.urSumSq = 0;
    this.totalHits = 0;
    this.totalHitOffsetSum = 0;
    this.totalHitOffsetSumSq = 0;
    this.earlyHits = 0;
    this.lateHits = 0;
    this.lastJudgment = 0;
    this.lastJudgmentTime = 0;
    this.keyStateCursor = 0;
    this.resetHitsoundCursors(time);
    this.advanceStats(time);
  }

  setHitsoundTrigger(trigger: ReplayHitsoundTrigger | null) {
    this.hitsoundTrigger = trigger;
    // Skip everything up to the current position so attaching mid-playback
    // doesn't fire a backlog of sounds.
    this.resetHitsoundCursors(this.currentTime);
  }

  private buildHitsoundTimeline() {
    this.hitsoundAnchorsByColumn = buildHitsoundAnchorsByColumn(
      this.notes,
      this.noteStates,
      this.keyCount,
      this.hitWindows.miss,
      this.ruleset.isConvert,
    );
    this.comboBreakSoundTimes = buildComboBreakSoundTimes(this.comboEvents, this.initialCombo);
    this.resetHitsoundCursors(this.currentTime);
  }

  // Position the hitsound cursors just past `time` without firing anything.
  private resetHitsoundCursors(time: number) {
    this.hitsoundPressCursors = Array.from({ length: this.keyCount }, (_, col) => {
      const presses = this.keypressTimesByColumn[col] ?? [];
      let lo = 0;
      let hi = presses.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (presses[mid] <= time) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    });

    const breaks = this.comboBreakSoundTimes;
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] <= time) lo = mid + 1;
      else hi = mid;
    }
    this.comboBreakSoundCursor = lo;
  }

  // Fire key/combo-break sounds for events crossed since the last frame.
  private fireHitsounds() {
    const trigger = this.hitsoundTrigger;
    if (!trigger) return;
    const time = this.currentTime;

    for (let col = 0; col < this.keyCount; col++) {
      const presses = this.keypressTimesByColumn[col] ?? [];
      let cursor = this.hitsoundPressCursors[col] ?? presses.length;
      while (cursor < presses.length && presses[cursor] <= time) {
        const pressTime = presses[cursor];
        cursor++;
        if (time - pressTime > HITSOUND_MAX_LATENESS_MS * this.playbackSpeed * this.modRate) continue;
        const anchor = selectHitsoundAnchor(this.hitsoundAnchorsByColumn[col] ?? [], pressTime, this.hitWindows.miss);
        if (anchor && anchor.plays.length > 0) trigger.playSamples(anchor.plays);
      }
      this.hitsoundPressCursors[col] = cursor;
    }

    while (
      this.comboBreakSoundCursor < this.comboBreakSoundTimes.length &&
      this.comboBreakSoundTimes[this.comboBreakSoundCursor] <= time
    ) {
      const breakTime = this.comboBreakSoundTimes[this.comboBreakSoundCursor];
      this.comboBreakSoundCursor++;
      if (time - breakTime > HITSOUND_MAX_LATENESS_MS * this.playbackSpeed * this.modRate) continue;
      trigger.playComboBreak();
    }
  }

  private advanceStats(upToTime?: number) {
    const time = upToTime ?? this.currentTime;
    while (this.statsScanIndex < this.judgmentEvents.length) {
      const event = this.judgmentEvents[this.statsScanIndex];
      if (event.time > time) break;

      if (event.judgment == null) {
        this.statsScanIndex++;
        continue;
      }

      if (event.judgment > 0) {
        this.judgmentCounts[event.judgment]++;
        this.scoreSimulator?.applyJudgment(event.judgment);
        const hand = getReplayHandForColumn(event.column, this.keyCount, this.missThumbHand);
        if (hand === "left") this.leftHandJudgmentCounts[event.judgment]++;
        if (hand === "right") this.rightHandJudgmentCounts[event.judgment]++;
        if (event.judgment === 6 && hand === "left") this.leftHandMisses++;
        if (event.judgment === 6 && hand === "right") this.rightHandMisses++;
      }

      if (event.judgment <= 5) {
        const offset = event.offsetMs;
        this.recentHitOffsets.push(offset);
        this.recentHitTimes.push(event.time);
        this.urSum += offset;
        this.urSumSq += offset * offset;
        this.totalHits++;
        this.totalHitOffsetSum += offset;
        this.totalHitOffsetSumSq += offset * offset;
        if (offset < 0) this.earlyHits++;
        else if (offset > 0) this.lateHits++;
        if (this.recentHitOffsets.length > 40) {
          const removed = this.recentHitOffsets.shift()!;
          this.recentHitTimes.shift();
          this.urSum -= removed;
          this.urSumSq -= removed * removed;
        }
      }

      this.lastJudgment = event.judgment;
      this.lastJudgmentTime = event.time;
      this.statsScanIndex++;
    }

    while (this.comboScanIndex < this.comboEvents.length) {
      const event = this.comboEvents[this.comboScanIndex];
      if (event.time > time) break;

      if (event.kind === "break") {
        if (this.combo > 0) {
          this.comboAnimationValue = this.combo;
          this.comboAnimationTime = event.time;
          this.comboAnimationKind = "break";
        }
        this.combo = 0;
      } else {
        this.combo++;
        this.maxComboSoFar = Math.max(this.maxComboSoFar, this.combo);
        this.comboAnimationValue = this.combo;
        this.comboAnimationTime = event.time;
        this.comboAnimationKind = "hit";
      }

      this.comboScanIndex++;
    }
  }

  private getAccuracy(): number {
    return calculateReplayAccuracy(this.judgmentCounts, this.ruleset.accuracyMode);
  }

  private rebuildStarRatingTimeline() {
    this.starRatingTimeline = (this.hideHud || this.barePlayfield) && !this.liveStats
      ? []
      : calculateManiaStarRatingTimeline(this.notes, this.keyCount, this.modRate);
  }

  // The HUD score counter: replays the whole judgement stream once at build
  // time to learn the simulated final, pins that to the real score when one
  // is known, then rewinds so advanceStats can feed it incrementally.
  private buildScoreSimulator(realTotalScore: number | null) {
    if ((this.hideHud || this.barePlayfield) && !this.liveStats) {
      this.scoreSimulator = null;
      return;
    }
    let totalJudgements = 0;
    for (const event of this.judgmentEvents) {
      if (event.judgment != null && event.judgment > 0) totalJudgements++;
    }
    // The run's SS ceiling: every judgement a MAX against the finished chart's
    // stars. Constant for the run, so price it once here.
    this.maxPp = totalJudgements > 0 && this.starRatingTimeline.length > 0
      ? calculateManiaPp({
          starRating: this.starRatingTimeline[this.starRatingTimeline.length - 1].stars,
          counts: { perfect: totalJudgements, great: 0, good: 0, ok: 0, meh: 0, miss: 0 },
          modMultiplier: this.ppModMultiplier,
        })
      : 0;
    if (totalJudgements === 0) {
      this.scoreSimulator = null;
      return;
    }
    const simulator = createManiaScoreSimulator({
      mode: this.ruleset.accuracyMode,
      totalJudgements,
      mods: this.modAcronyms,
      rate: this.modRate,
    });
    for (const event of this.judgmentEvents) {
      if (event.judgment != null && event.judgment > 0) simulator.applyJudgment(event.judgment);
    }
    simulator.setScale(getScoreScaleToReal(simulator.value, realTotalScore));
    simulator.reset();
    this.scoreSimulator = simulator;
  }

  // PP as if the map ended at the playback clock: current judgement counts
  // against the star rating of the chart processed so far. Same recipe as
  // lazer's PerformancePointsCounter (timed difficulty attributes + the
  // score's live statistics), which keys its lookup by the judged object's
  // end time; the playback clock lands on the same timeline point.
  private getPp(): number {
    const timeline = this.starRatingTimeline;
    if (timeline.length === 0) return 0;
    const time = this.currentTime;
    let lo = 0;
    let hi = timeline.length - 1;
    let index = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].time <= time) {
        index = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const c = this.judgmentCounts;
    return calculateManiaPp({
      starRating: timeline[index].stars,
      counts: { perfect: c[1], great: c[2], good: c[3], ok: c[4], meh: c[5], miss: c[6] },
      modMultiplier: this.ppModMultiplier,
    });
  }

  private formatAccuracy(value: number): string {
    return `${value.toFixed(2)}%`;
  }

  private updateHudSnapshotIfNeeded(force = false) {
    if ((this.hideHud || this.barePlayfield) && !this.liveStats) return;
    const elapsed = performance.now() - this.hudSnapshotTime;
    if (!force && elapsed < 50 && Number.isFinite(this.hudSnapshotTime)) return;
    this.hudSnapshotTime = performance.now();

    const scoreValue = this.scoreSimulator?.value ?? 0;
    this.hudCachedScore = this.ruleset.accuracyMode !== "lazer"
      ? formatStableScore(scoreValue)
      : formatLazerScore(scoreValue);
    this.hudCachedAccuracy = this.formatAccuracy(this.getAccuracy());
    this.hudCachedPp = `${Math.round(this.getPp())}pp`;
    this.hudCachedUr = String(Math.round(this.getUr()));
    const wallTime = this.currentTime / this.modRate;
    const mins = Math.floor(wallTime / 60000);
    const secs = String(Math.floor((wallTime % 60000) / 1000)).padStart(2, "0");
    this.hudCachedTime = `${mins}:${secs}`;
    for (let i = 1; i < this.judgmentCounts.length; i++) {
      const v = String(this.judgmentCounts[i]);
      if (this.hudCachedJudgmentCounts[i] !== v) this.hudCachedJudgmentCounts[i] = v;
    }
    this.hudCachedLeftMisses = String(this.leftHandMisses);
    this.hudCachedRightMisses = String(this.rightHandMisses);
    this.hudCachedLeftHandAccuracyValue = calculateReplayAccuracy(
      this.leftHandJudgmentCounts,
      this.ruleset.accuracyMode,
    );
    this.hudCachedRightHandAccuracyValue = calculateReplayAccuracy(
      this.rightHandJudgmentCounts,
      this.ruleset.accuracyMode,
    );
    this.hudCachedLeftHandAccuracy = this.hudCachedLeftHandAccuracyValue.toFixed(2);
    this.hudCachedRightHandAccuracy = this.hudCachedRightHandAccuracyValue.toFixed(2);
    let totalKps = 0;
    for (let col = 0; col < this.keyCount; col++) {
      const keyKps = this.getKeyKps(col, this.currentTime);
      totalKps += keyKps;
      const v = this.formatKeyKps(keyKps);
      if (this.hudCachedKeyKps[col] !== v) this.hudCachedKeyKps[col] = v;
    }
    this.hudCachedTotalKpsValue = Math.round(totalKps);
    this.hudCachedTotalKps = this.formatKeyKps(totalKps);
    this.hudCachedMaxKpsValue = Math.round(this.getMaxKpsUpTo(this.currentTime));
    this.hudCachedMaxKps = this.formatKeyKps(this.hudCachedMaxKpsValue);
  }

  private updateSkinCache() {
    this.skinProfile = getReplaySkinProfile(this.skinSettings, this.keyCount);
    this.barTapColors = Array.from(
      { length: this.keyCount },
      (_, col) => this.skinProfile.tapColors[col] || this.colors[col],
    );
    this.circleTapColors = Array.from(
      { length: this.keyCount },
      (_, col) => this.skinProfile.tapColors[col] || this.skinProfile.tapColor,
    );
    this.circleLnHeadColors = Array.from(
      { length: this.keyCount },
      (_, col) => this.skinProfile.lnHeadColors[col] || this.skinProfile.lnHeadColor,
    );
    // Start the tail caps' alpha reads now rather than on the first frame that
    // draws a hold: whether a cap has any art at all decides the hold's whole
    // length, and a read landing mid-playback would visibly resize LNs.
    for (const column of this.skinProfile.assets.columns) {
      if (column?.lnTail) readLnTailArtTop(column.lnTail.src);
    }
  }

  // Which thumb plays the middle lane of an odd keymode. The L/R miss and
  // per-hand accuracy overlays read it, so switching only re-tallies the
  // hand-local stats seen so far instead of replaying the whole run's stats.
  setMissThumbHand(hand: ReplayThumbHand) {
    const normalized = normalizeReplayMissThumbHand(hand);
    if (this.missThumbHand === normalized) return;
    this.missThumbHand = normalized;
    this.recomputeHandStats();
    this.updateHudSnapshotIfNeeded(true);
    if (!this._isPlaying) this.render();
  }

  private recomputeHandStats() {
    this.leftHandMisses = 0;
    this.rightHandMisses = 0;
    this.leftHandJudgmentCounts = [0, 0, 0, 0, 0, 0, 0];
    this.rightHandJudgmentCounts = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < this.statsScanIndex; i++) {
      const event = this.judgmentEvents[i];
      if (event.judgment == null || event.judgment <= 0) continue;
      const hand = getReplayHandForColumn(event.column, this.keyCount, this.missThumbHand);
      if (hand === "left") this.leftHandJudgmentCounts[event.judgment]++;
      if (hand === "right") this.rightHandJudgmentCounts[event.judgment]++;
      if (event.judgment === 6 && hand === "left") this.leftHandMisses++;
      if (event.judgment === 6 && hand === "right") this.rightHandMisses++;
    }
  }

  private getUr(): number {
    const n = this.recentHitOffsets.length;
    if (n < 2) return 0;
    const mean = this.urSum / n;
    const variance = Math.max(0, this.urSumSq / n - mean * mean);
    return Math.sqrt(variance) * 10;
  }

  private getKeyKps(column: number, time: number): number {
    const presses = this.keypressTimesByColumn[column];
    if (!presses?.length) return 0;
    const windowStart = Math.max(0, time - this.getKpsWindowGameMs());
    const start = this.lowerBound(presses, windowStart);
    const end = this.upperBound(presses, time);
    return Math.max(0, end - start) * (1000 / KEY_KPS_WINDOW_MS);
  }

  private getMaxKpsUpTo(time: number): number {
    return replayPeakKpsAt(this.keypressTimes, this.peakKps, time, KEY_KPS_WINDOW_MS);
  }

  private getKpsWindowGameMs(): number {
    return KEY_KPS_WINDOW_MS * this.modRate;
  }

  private formatKeyKps(kps: number): string {
    return String(Math.round(kps));
  }

  private getKpsOverlayColor(kps: number): string {
    if (kps >= 20) return "#ff2f3e";
    if (kps >= 15) return "#ff8a22";
    if (kps >= 10) return "#ffd43b";
    if (kps >= 8) return "#40c8ff";
    return "#ffffff";
  }

  private prepareScrollVelocities() {
    const points = this.scrollVelocities
      .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.multiplier) && point.multiplier > 0)
      .map((point) => ({
        time: point.time,
        multiplier: Math.max(0.01, Math.min(20, point.multiplier)),
      }))
      .sort((a, b) => a.time - b.time);

    const collapsed: ManiaScrollVelocity[] = [];
    for (const point of points) {
      const previous = collapsed[collapsed.length - 1];
      if (previous && previous.time === point.time) {
        previous.multiplier = point.multiplier;
      } else {
        collapsed.push(point);
      }
    }

    if (collapsed.length === 0) {
      collapsed.unshift({ time: 0, multiplier: 1 });
    } else if (collapsed[0].time > 0) {
      const firstNoteTime = this.notes[0]?.time ?? Number.POSITIVE_INFINITY;
      const initialMultiplier = collapsed[0].time <= firstNoteTime ? collapsed[0].multiplier : 1;
      collapsed.unshift({ time: 0, multiplier: initialMultiplier });
    }

    this.scrollVelocityTimes = collapsed.map((point) => point.time);
    this.scrollVelocityMultipliers = collapsed.map((point) => point.multiplier);
    this.scrollVelocityCumulative = new Array(collapsed.length).fill(0);
    let minMultiplier = 1;
    for (const multiplier of this.scrollVelocityMultipliers) minMultiplier = Math.min(minMultiplier, multiplier);
    this.scrollVelocityMinMultiplier = minMultiplier;

    const zeroIndex = this.findScrollVelocityIndex(0);
    this.scrollVelocityCumulative[zeroIndex] = -this.integrateScrollDistance(this.scrollVelocityTimes[zeroIndex], 0, zeroIndex);

    for (let i = zeroIndex + 1; i < collapsed.length; i++) {
      this.scrollVelocityCumulative[i] = this.scrollVelocityCumulative[i - 1]
        + (this.scrollVelocityTimes[i] - this.scrollVelocityTimes[i - 1]) * this.scrollVelocityMultipliers[i - 1];
    }

    for (let i = zeroIndex - 1; i >= 0; i--) {
      this.scrollVelocityCumulative[i] = this.scrollVelocityCumulative[i + 1]
        - (this.scrollVelocityTimes[i + 1] - this.scrollVelocityTimes[i]) * this.scrollVelocityMultipliers[i];
    }
  }

  private findScrollVelocityIndex(time: number): number {
    const times = this.scrollVelocityTimes;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private integrateScrollDistance(start: number, end: number, startIndex = this.findScrollVelocityIndex(start)): number {
    if (end <= start) return 0;
    let distance = 0;
    let cursor = start;
    let index = startIndex;

    while (index + 1 < this.scrollVelocityTimes.length && this.scrollVelocityTimes[index + 1] < end) {
      const nextTime = Math.max(cursor, this.scrollVelocityTimes[index + 1]);
      distance += (nextTime - cursor) * this.scrollVelocityMultipliers[index];
      cursor = nextTime;
      index++;
    }

    distance += (end - cursor) * this.scrollVelocityMultipliers[index];
    return distance;
  }

  private getScrollPosition(time: number): number {
    const index = this.findScrollVelocityIndex(time);
    return this.scrollVelocityCumulative[index]
      + (time - this.scrollVelocityTimes[index]) * this.scrollVelocityMultipliers[index];
  }

  private measureCanvas() {
    const fullscreenParent = this.canvas.parentElement?.dataset.replayFullscreen === "true"
      ? this.canvas.parentElement
      : null;
    this.fullscreenLayout = fullscreenParent != null;
    if (!fullscreenParent) {
      this.canvas.style.width = "";
      this.canvas.style.height = "";
    }
    const rect = this.canvas.getBoundingClientRect();
    const parentRect = fullscreenParent?.getBoundingClientRect();
    const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const dprCap = coarsePointer ? MOBILE_REPLAY_DPR_CAP : DESKTOP_REPLAY_DPR_CAP;
    this.dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    // MSAA allocates extra multisample renderbuffers. At 1.25x on a phone the
    // backing canvas already smooths the playfield, so keep that VRAM instead.
    this.antialias = !coarsePointer;
    this.cssWidth = Math.max(1, parentRect?.width ?? rect.width);
    this.cssHeight = Math.max(1, parentRect?.height ?? rect.height);
    if (fullscreenParent) {
      this.canvas.style.width = `${this.cssWidth}px`;
      this.canvas.style.height = `${this.cssHeight}px`;
    }
  }

  private invalidateLayoutCache() {
    this.cachedLayout = null;
    this.cachedColumns = [];
    this.staticDirty = true;
  }

  private getLayout(): Layout {
    if (this.cachedLayout) return this.cachedLayout;

    const w = this.cssWidth;
    const h = this.cssHeight;
    const configuredColumnWidths = this.getConfiguredColumnWidths();
    const configuredColumnSpacings = this.getConfiguredColumnSpacings();
    const desiredPlayfieldWidth = configuredColumnWidths.reduce((sum, width) => sum + width, 0)
      + configuredColumnSpacings.reduce((sum, width) => sum + width, 0);
    // Inline portrait (phone) canvases: the mobile redesign made the stage
    // taller, and at a fixed scroll number a taller stage means notes cover
    // more pixels per ms. Anchor the skin scale and the scroll speed to the
    // height the mobile viewer always had, so the extra height buys lookahead
    // instead of bigger, faster notes. Fullscreen, comparisons and bare
    // (preview/card) renders keep native full-height scaling.
    const compactPortrait = !this.barePlayfield && !this.fullscreenLayout && !this.fullHeightLayout && h > w;
    const scaleHeight = compactPortrait ? Math.min(h, MOBILE_PORTRAIT_REFERENCE_HEIGHT) : h;
    const targetLayoutScale = scaleHeight / MANIA_SKIN_STAGE_HEIGHT;
    const widthCap = w * (this.barePlayfield ? 0.82 : 0.72);
    const maxPlayfieldWidth = this.barePlayfield
      ? widthCap
      : Math.min(widthCap, desiredPlayfieldWidth * targetLayoutScale);
    const layoutScale = desiredPlayfieldWidth > 0 ? maxPlayfieldWidth / desiredPlayfieldWidth : 1;
    const playfieldWidth = desiredPlayfieldWidth * layoutScale;
    const averageColumnWidth = configuredColumnWidths.reduce((sum, width) => sum + width, 0) / Math.max(1, configuredColumnWidths.length);
    const laneWidth = averageColumnWidth * layoutScale;
    const barePreviewBias = this.barePlayfield && this.keyCount >= 5 && w >= 380 ? 0.32 : 0.5;
    const playfieldX = this.getPlayfieldX(w, playfieldWidth, layoutScale, barePreviewBias);
    const hitPosition = this.stagePosition("hitPosition") ?? MANIA_HIT_TARGET_POSITION;
    const judgmentY = h * (this.skinSettings.upscroll ? hitPosition : MANIA_REFERENCE_HEIGHT - hitPosition) / MANIA_REFERENCE_HEIGHT;
    const noteHeight = Math.max(6, this.skinProfile.noteHeightScale * layoutScale * MANIA_BAR_NOTE_HEIGHT_RATIO);
    const receptorHeight = Math.max(6, h * 0.012);
    const scrollTimeRange = (MANIA_MAX_TIME_RANGE / Math.max(1, Math.min(40, this.scrollSpeed))) * this.modRate;
    // scaleHeight, not h: on inline portrait the scroll number keeps meaning
    // what it meant on the shorter stage; notes just stay visible longer.
    const scrollLength = scaleHeight * (MANIA_REFERENCE_HEIGHT - MANIA_DEFAULT_HIT_POSITION) / MANIA_REFERENCE_HEIGHT;
    const pixelsPerMs = scrollLength / scrollTimeRange;

    const layout: Layout = { w, h, playfieldWidth, playfieldX, laneWidth, layoutScale, judgmentY, noteHeight, receptorHeight, pixelsPerMs };
    this.cachedLayout = layout;
    let cursorX = playfieldX;
    this.cachedColumns = Array.from({ length: this.keyCount }, (_, i) => {
      const width = configuredColumnWidths[i] * layoutScale;
      const column = { x: cursorX, width };
      cursorX += width + (configuredColumnSpacings[i] ?? 0) * layoutScale;
      return column;
    });
    return layout;
  }

  // skin.ini ColumnStart puts the stage's left edge that many skin units from
  // the left of the screen, and the Layout tab exposes it. The canvas is
  // usually wider than the 16:9 the value was authored against, so measure
  // from a centred 16:9 box in the same units the columns are drawn in: the
  // stage lands where it does in game instead of drifting further left the
  // wider the window gets. No value keeps the viewer's centred stage, as do
  // the bare preview and card renders.
  // skin.ini HitPosition / ScorePosition / ComboPosition for the keymode being
  // played, falling back to the settings-wide value the Layout tab edits. A
  // skin can set a different hit line per keymode, and its key art is padded
  // to land on that one.
  private stagePosition(key: ReplaySkinStagePositionKey): number {
    return getReplaySkinStagePosition(this.skinProfile, this.skinSettings, key);
  }

  private getPlayfieldX(w: number, playfieldWidth: number, layoutScale: number, bias: number): number {
    const aligned = (w - playfieldWidth) * (this.playfieldAlign ?? bias);
    const columnStart = this.skinProfile.columnStart;
    if (columnStart == null || this.playfieldAlign != null || this.barePlayfield) return aligned;
    const boxWidth = OSU_MANIA_SCREEN_WIDTH * layoutScale;
    const x = (w - boxWidth) / 2 + columnStart * layoutScale;
    return Math.max(0, Math.min(Math.max(0, w - playfieldWidth), x));
  }

  private getColumnLayout(col: number, layout: Layout): { x: number; width: number } {
    return this.cachedColumns[col] ?? { x: layout.playfieldX + col * layout.laneWidth, width: layout.laneWidth };
  }

  private getConfiguredColumnWidths(): number[] {
    const widths = this.skinProfile.columnWidths.length > 0
      ? this.skinProfile.columnWidths
      : [];
    return Array.from(
      { length: this.keyCount },
      (_, index) => Math.max(1, widths[index] ?? this.skinProfile.columnWidth),
    );
  }

  private getConfiguredColumnSpacings(): number[] {
    const spacings = this.skinProfile.columnSpacings.length > 0
      ? this.skinProfile.columnSpacings
      : [];
    return Array.from(
      { length: Math.max(0, this.keyCount - 1) },
      (_, index) => Math.max(0, spacings[index] ?? this.skinProfile.columnSpacing),
    );
  }

  resize() {
    this.measureCanvas();
    this.invalidateLayoutCache();
    if (this.app) {
      this.app.renderer.resize(Math.max(1, this.cssWidth), Math.max(1, this.cssHeight), this.dpr);
      this.positionBackgroundSprites();
    }
    this.render();
  }

  play() {
    if (this._isPlaying) return;
    this._isPlaying = true;
    this.lastRenderTime = performance.now();
    // Paused wall time must never enter the external clock's prediction.
    this.resetAudioClockSmoothing();
    this.resetFpsCounter(this.lastRenderTime);
    // Let the transport resume audio and queue every comparison renderer
    // before drawing; a synchronous tick delays the other side and the song.
    this.animFrameId = requestAnimationFrame(() => this.tick());
  }

  pause() {
    this._isPlaying = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
  }

  get isPlaying() { return this._isPlaying; }

  ready() {
    return this.initPromise;
  }

  setPreviewData(
    frames: ReplayFrame[],
    keyCount: number,
    notes: ManiaNote[] = [],
    options?: { od?: number; scrollVelocities?: ManiaScrollVelocity[]; initialCombo?: number },
  ) {
    this.frames = frames;
    this.keyCount = Math.max(1, Math.floor(keyCount));
    this.notes = [...notes];
    this.colors = COLUMN_COLORS[this.keyCount] || this.generateColors(this.keyCount);
    for (const c of this.colors) hexToNumber(c);

    const previewOd = options?.od;
    this.od = previewOd != null && Number.isFinite(previewOd) ? previewOd : this.od;
    this.hitWindows = getManiaReplayHitWindows(this.od, this.ruleset);
    this.initialCombo = Math.max(0, Math.floor(options?.initialCombo ?? 0));
    this.combo = this.initialCombo;
    this.maxComboSoFar = this.combo;
    this.scrollVelocities = options?.scrollVelocities ?? [];
    this.receptorFlashTimestamps = new Array(this.keyCount).fill(0);
    this.hudCachedKeyKps = new Array(this.keyCount).fill("0");
    this.keypressTimesByColumn = this.buildKeypressTimesByColumn();
    this.keypressTimes = this.keypressTimesByColumn.flat().sort((a, b) => a - b);
    this.updateSkinCache();
    this.peakKps = buildReplayPeakKps(this.keypressTimes, KEY_KPS_WINDOW_MS, this.modRate);
    this.prepareScrollVelocities();

    const frameDuration = frames.length > 0 ? frames[frames.length - 1].time : 0;
    const noteDuration = maxNoteEndTime(this.notes);
    const replayTailGrace = this.hitWindows.miss * 1.5;
    this.totalDuration = Math.max(frameDuration, noteDuration + replayTailGrace);
    this.maxHoldDuration = 0;
    for (const n of this.notes) {
      if (n.isHold) this.maxHoldDuration = Math.max(this.maxHoldDuration, n.endTime - n.time);
    }

    this.segments = buildReplaySegments(this.frames, this.keyCount, this.totalDuration);
    const simulated = simulateManiaReplayJudgements(
      this.notes,
      this.segments,
      this.keyCount,
      this.hitWindows,
      this.ruleset.accuracyMode,
      {
        legacyReplayFrameRounding: this.ruleset.accuracyMode !== "lazer",
        speedMultiplier: this.ruleset.speedMultiplier,
      },
    );
    const rawStableComboEvents = this.ruleset.accuracyMode === "stable"
      ? buildStableReplayComboEvents(this.notes, simulated.noteStates)
      : null;
    this.judgmentEvents = simulated.events;
    this.missTimesCache = null;
    this.lifeBarFrames = this.buildFallbackLifeBarFrames(this.judgmentEvents);
    // Previews carry no real life bar, so they can never be fails.
    this.failTime = null;
    this.noteStates = simulated.noteStates;
    this.replayMasterTimeline = null;
    this.comboEvents = this.ruleset.accuracyMode === "stable"
      ? rawStableComboEvents ?? buildStableReplayComboEvents(this.notes, this.noteStates)
      : this.judgmentEvents.map((event) => ({
          kind: event.judgment == null || event.judgment === 6 ? "break" : "hit",
          time: event.time,
        }));
    const lastJudgementTime = this.judgmentEvents.length > 0
      ? this.judgmentEvents[this.judgmentEvents.length - 1].time
      : 0;
    this.totalDuration = Math.max(this.totalDuration, lastJudgementTime);
    this.rebuildStarRatingTimeline();
    this.buildScoreSimulator(null);
    this.buildHitsoundTimeline();

    this.currentTime = 0;
    this.hudSnapshotTime = -Infinity;
    this.measureCanvas();
    this.invalidateLayoutCache();
    if (this.app) {
      this.app.renderer.resize(Math.max(1, this.cssWidth), Math.max(1, this.cssHeight), this.dpr);
      this.positionBackgroundSprites();
    }
    this.recomputeStatsUpTo(0);
    this.resetHiddenCoverage();
    this.lastRenderTime = performance.now();
    this.resetAudioClockSmoothing();
    this.render(true);
  }

  seek(timeMs: number) {
    this.currentTime = Math.max(0, Math.min(timeMs, this.totalDuration));
    this.recomputeStatsUpTo(this.currentTime);
    this.resetHiddenCoverage();
    this.lastRenderTime = performance.now();
    this.resetAudioClockSmoothing();
    this.render();
  }

  renderFrameAt(timeMs: number) {
    this.currentTime = Math.max(0, Math.min(timeMs, this.totalDuration));
    this.recomputeStatsUpTo(this.currentTime);
    if (this.currentTime < this.hiddenCoverageUpdatedAt) this.resetHiddenCoverage();
    this.lastRenderTime = performance.now();
    this.resetAudioClockSmoothing();
    this.render(true);
  }

  getMissTimes(): number[] {
    // Cached: ReplayProgressBar polls this at 10Hz and the events only change
    // when a new replay/preview is loaded.
    this.missTimesCache ??= this.judgmentEvents
      .filter((event) => event.judgment === 6 && Number.isFinite(event.time))
      .map((event) => event.time);
    return this.missTimesCache;
  }

  setSpeed(speed: number) { this.playbackSpeed = speed; }

  setScrollSpeed(speed: number) {
    this.scrollSpeed = Math.max(1, Math.min(40, speed));
    this.invalidateLayoutCache();
    if (!this._isPlaying) this.render();
  }

  setBackgroundDim(dim: number) {
    if (this.backgroundDim === dim) return;
    this.backgroundDim = dim;
    this.staticDirty = true;
    if (!this._isPlaying) this.render();
  }

  setBlackPlayfield(on: boolean) {
    if (this.blackPlayfield === on) return;
    this.blackPlayfield = on;
    this.staticDirty = true;
    if (!this._isPlaying) this.render();
  }

  setBackgroundImage(img: HTMLImageElement | null) {
    if (img === this.backgroundImage) return;
    const shouldFade = this.backgroundImage && img;
    this.previousBackgroundImage = shouldFade ? this.backgroundImage : null;
    this.backgroundImage = img;
    this.backgroundTransitionStartedAt = shouldFade ? performance.now() : 0;
    this.rebuildBackgroundSprites();
    if (!this._isPlaying) this.render();
  }

  setStoryboard(data: ReplayStoryboardData | null) {
    if (data === this.storyboardData) return;
    this.clearStoryboardSprites();
    for (const url of this.storyboardRetainedUrls) releaseStoryboardTexture(url);
    this.storyboardRetainedUrls = [];
    this.storyboardData = data;
    this.storyboardActiveSet = data ? new StoryboardActiveSet(data.sprites) : null;
    this.storyboardTexturesReady = false;
    // Force the backdrop/dim/mask shapes to rebuild for the new storyboard.
    this.storyboardShapesDim = -1;

    if (data) {
      const pending: Promise<unknown>[] = [];
      for (const url of data.imageUrls.values()) {
        this.storyboardRetainedUrls.push(url);
        pending.push(retainStoryboardTexture(url));
      }
      if (data.backgroundImageUrl) {
        this.storyboardRetainedUrls.push(data.backgroundImageUrl);
        pending.push(retainStoryboardTexture(data.backgroundImageUrl));
      }
      const ready = Promise.all(pending).then(() => {});
      this.storyboardReadyPromise = ready;
      void ready.then(() => {
        if (this.destroyed || this.storyboardData !== data) return;
        this.storyboardTexturesReady = true;
        if (!this._isPlaying) this.render();
      });
    } else {
      this.storyboardReadyPromise = Promise.resolve();
    }

    this.rebuildStoryboardBackgroundSprite();
    if (!this._isPlaying) this.render();
  }

  // Resolves when every storyboard texture finished loading (or failed); the
  // video exporter awaits this so the first frames are not blank.
  storyboardReady(): Promise<void> {
    return this.storyboardReadyPromise;
  }

  private setupStoryboardContainers() {
    for (let layer = 0; layer < SB_LAYER_COUNT; layer++) {
      const container = new Container();
      container.sortableChildren = true;
      this.storyboardLayerContainers.push(container);
      if (layer === SB_LAYER_OVERLAY) this.storyboardOverlayRoot.addChild(container);
      else this.storyboardBackRoot.addChild(container);
    }
    // Replays show the passing state; the fail layer stays hidden.
    this.storyboardLayerContainers[SB_LAYER_FAIL].visible = false;
  }

  private rebuildStoryboardBackgroundSprite() {
    if (this.storyboardBackgroundSprite) {
      this.storyboardBackgroundSprite.parent?.removeChild(this.storyboardBackgroundSprite);
      this.storyboardBackgroundSprite.destroy({ texture: false, textureSource: false });
      this.storyboardBackgroundSprite = null;
    }
    const url = this.storyboardData?.backgroundImageUrl;
    if (!url) return;
    const sprite = new Sprite(Texture.EMPTY);
    this.storyboardBackgroundSprite = sprite;
    this.storyboardBackRoot.addChildAt(sprite, 0);
  }

  private clearStoryboardSprites() {
    for (const sprite of this.storyboardPixiBySprite.values()) this.releaseStoryboardSprite(sprite);
    this.storyboardPixiBySprite.clear();
  }

  private releaseStoryboardSprite(sprite: Sprite) {
    sprite.parent?.removeChild(sprite);
    sprite.visible = false;
    sprite.texture = Texture.EMPTY;
    this.storyboardSpritePool.push(sprite);
  }

  private getStoryboardTexture(path: string): Texture {
    const url = this.storyboardData?.imageUrls.get(path);
    if (!url) return Texture.EMPTY;
    return peekStoryboardTexture(url) ?? Texture.EMPTY;
  }

  // Backdrop, dim, and 4:3 mask only depend on canvas size and dim level;
  // rebuilt when those change instead of every frame.
  private updateStoryboardShapes(layout: Layout) {
    if (
      this.storyboardShapesW === layout.w &&
      this.storyboardShapesH === layout.h &&
      this.storyboardShapesDim === this.backgroundDim
    ) {
      return;
    }
    this.storyboardShapesW = layout.w;
    this.storyboardShapesH = layout.h;
    this.storyboardShapesDim = this.backgroundDim;

    this.storyboardBackdrop.clear();
    this.storyboardBackdrop.rect(0, 0, layout.w, layout.h).fill({ color: 0x000000, alpha: 1 });

    this.storyboardDim.clear();
    const dimAlpha = this.backgroundDim / 100;
    if (dimAlpha > 0) {
      this.storyboardDim.rect(0, 0, layout.w, layout.h).fill({ color: 0x000000, alpha: dimAlpha });
    }

    // Non-widescreen storyboards are clipped to the 4:3 storyboard area.
    const widescreen = this.storyboardData?.widescreen ?? true;
    if (!widescreen) {
      const scale = layout.h / STORYBOARD_HEIGHT;
      const maskWidth = STORYBOARD_WIDTH * scale;
      const maskX = (layout.w - maskWidth) / 2;
      if (!this.storyboardMaskBack) {
        this.storyboardMaskBack = new Graphics();
        this.storyboardBackRoot.addChild(this.storyboardMaskBack);
        this.storyboardBackRoot.mask = this.storyboardMaskBack;
      }
      if (!this.storyboardMaskOverlay) {
        this.storyboardMaskOverlay = new Graphics();
        this.storyboardOverlayRoot.addChild(this.storyboardMaskOverlay);
        this.storyboardOverlayRoot.mask = this.storyboardMaskOverlay;
      }
      for (const mask of [this.storyboardMaskBack, this.storyboardMaskOverlay]) {
        mask.clear();
        mask.rect(maskX, 0, maskWidth, layout.h).fill({ color: 0xffffff, alpha: 1 });
      }
    } else {
      if (this.storyboardMaskBack) {
        this.storyboardBackRoot.mask = null;
        this.storyboardBackRoot.removeChild(this.storyboardMaskBack);
        this.storyboardMaskBack.destroy();
        this.storyboardMaskBack = null;
      }
      if (this.storyboardMaskOverlay) {
        this.storyboardOverlayRoot.mask = null;
        this.storyboardOverlayRoot.removeChild(this.storyboardMaskOverlay);
        this.storyboardMaskOverlay.destroy();
        this.storyboardMaskOverlay = null;
      }
    }
  }

  private positionStoryboardBackgroundSprite(layout: Layout) {
    const sprite = this.storyboardBackgroundSprite;
    if (!sprite) return;
    const url = this.storyboardData?.backgroundImageUrl;
    const texture = url ? peekStoryboardTexture(url) : null;
    if (!texture || texture.width <= 0 || texture.height <= 0) {
      sprite.visible = false;
      return;
    }
    if (sprite.texture !== texture) sprite.texture = texture;
    sprite.visible = true;
    const imgAspect = texture.width / texture.height;
    const canvasAspect = layout.w / layout.h;
    if (imgAspect > canvasAspect) {
      sprite.height = layout.h;
      sprite.width = layout.h * imgAspect;
    } else {
      sprite.width = layout.w;
      sprite.height = layout.w / imgAspect;
    }
    sprite.x = (layout.w - sprite.width) / 2;
    sprite.y = (layout.h - sprite.height) / 2;
  }

  private renderStoryboard(layout: Layout) {
    const data = this.storyboardData;
    const activeSet = this.storyboardActiveSet;
    const hasStoryboard = data != null && activeSet != null && this.storyboardTexturesReady;
    this.storyboardBackdrop.visible = hasStoryboard;
    this.storyboardBackRoot.visible = hasStoryboard;
    this.storyboardDim.visible = hasStoryboard;
    this.storyboardOverlayRoot.visible = hasStoryboard;
    if (!hasStoryboard) return;

    this.updateStoryboardShapes(layout);
    this.positionStoryboardBackgroundSprite(layout);

    // Storyboard space is 640x480 scaled to the canvas height and centered;
    // widescreen sprites simply extend beyond the 640-wide band.
    const scale = layout.h / STORYBOARD_HEIGHT;
    const offsetX = (layout.w - STORYBOARD_WIDTH * scale) / 2;
    const storyboardMask: StoryboardRect | null = data.widescreen
      ? null
      : { left: offsetX, top: 0, right: offsetX + STORYBOARD_WIDTH * scale, bottom: layout.h };
    // One extra pixel on either side covers antialiasing at the playfield
    // boundary. Vertical edges coincide with the canvas clip and need no pad.
    const playfieldCoverageTarget: StoryboardRect = {
      left: layout.playfieldX - 1,
      top: 0,
      right: layout.playfieldX + layout.playfieldWidth + 1,
      bottom: layout.h,
    };
    for (const container of this.storyboardLayerContainers) {
      container.position.set(offsetX, 0);
      container.scale.set(scale);
    }

    const t = this.currentTime;
    const update = activeSet.update(t);
    for (const sprite of update.exited) {
      const pixi = this.storyboardPixiBySprite.get(sprite);
      if (pixi) {
        this.storyboardPixiBySprite.delete(sprite);
        this.releaseStoryboardSprite(pixi);
      }
    }
    for (const sprite of update.entered) {
      const pixi = this.storyboardSpritePool.pop() ?? new Sprite();
      pixi.visible = true;
      this.storyboardLayerContainers[sprite.layer].addChild(pixi);
      // Declaration order decides stacking within a layer.
      pixi.zIndex = sprite.order;
      this.storyboardPixiBySprite.set(sprite, pixi);
    }

    const state = this.storyboardScratchState;
    for (const sprite of update.active) {
      const pixi = this.storyboardPixiBySprite.get(sprite);
      if (!pixi) continue;
      evaluateStoryboardSprite(sprite, t, state);
      const path = sprite.framePaths ? sprite.framePaths[state.frameIndex] : sprite.filePath;
      const texture = this.getStoryboardTexture(path);
      if (pixi.texture !== texture) pixi.texture = texture;
      pixi.anchor.set(sprite.originX, sprite.originY);
      pixi.position.set(state.x, state.y);
      pixi.scale.set(state.flipH ? -state.scaleX : state.scaleX, state.flipV ? -state.scaleY : state.scaleY);
      pixi.rotation = state.rotation;
      pixi.alpha = state.alpha;
      pixi.tint = state.tint;
      pixi.blendMode = state.additive ? "add" : "normal";

      if (
        !this.storyboardOccludesPlayfield
        && sprite.layer === SB_LAYER_OVERLAY
        && data.opaqueImagePaths.has(path)
        && texture !== Texture.EMPTY
        && opaqueStoryboardSpriteCoversRect({
          sprite,
          state,
          textureWidth: texture.width,
          textureHeight: texture.height,
          viewportScale: scale,
          viewportOffsetX: offsetX,
          mask: storyboardMask,
        }, playfieldCoverageTarget)
      ) {
        this.storyboardOccludesPlayfield = true;
      }
    }
  }

  setShowInputOverlay(show: boolean) {
    this.showInputOverlay = show;
    if (!this._isPlaying) this.render();
  }

  setInputOverlayOptions(options: { only?: boolean; color?: string; keyHistory?: boolean }) {
    if (typeof options.only === "boolean") this.inputOverlayOnly = options.only;
    if (options.color) this.inputOverlayColor = options.color;
    if (typeof options.keyHistory === "boolean") this.inputOverlayKeyHistory = options.keyHistory;
    if (!this._isPlaying) this.render();
  }

  setOverlaySettings(settings: ReplayOverlaySettings) {
    this.overlaySettings = normalizeReplayOverlaySettings(settings);
    this.pruneSelectedOverlays();
    if (!this._isPlaying) this.render();
  }

  setSkinSettings(settings: ReplaySkinSettings) {
    this.skinSettings = normalizeReplaySkinSettings(settings);
    void ensureReplayFontStyle(getReplayComboFontStyle(this.skinSettings.comboFontSet)).catch(() => {});
    this.updateSkinCache();
    this.invalidateLayoutCache();
    this.prewarmSkinTextures();
    if (!this._isPlaying) this.render();
  }

  setExternalClock(cb: (() => { time: number; stalled: boolean } | null) | null) {
    this.externalClock = cb;
    this.lastRenderTime = performance.now();
    this.resetAudioClockSmoothing();
  }

  get time() { return this.currentTime; }
  get duration() { return this.totalDuration; }
  get displayDuration() { return this.totalDuration / this.modRate; }

  // True when the given client point lands on the bare playfield: inside the
  // lanes and clear of every draggable overlay. Lets the page treat a click
  // there as play/pause without stealing overlay drags.
  isPlayfieldClickPoint(clientX: number, clientY: number): boolean {
    if (performance.now() - this.suppressPlayfieldClickAt < 700) {
      this.suppressPlayfieldClickAt = -Infinity;
      return false;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = (clientX - rect.left) * (this.cssWidth / rect.width);
    const y = (clientY - rect.top) * (this.cssHeight / rect.height);
    const layout = this.cachedLayout ?? this.getLayout();
    if (x < layout.playfieldX || x > layout.playfieldX + layout.playfieldWidth) return false;
    if (y < 0 || y > layout.h) return false;
    return this.getOverlayAtPoint(x, y) == null;
  }

  // Support for the stage's right-click overlay menu: which overlay (if any)
  // sits under a client point, and whether overlays are editable here at all
  // (they are not on phones or with the HUD hidden).
  getOverlayIdAtClientPoint(clientX: number, clientY: number): ReplayOverlayId | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (clientX - rect.left) * (this.cssWidth / rect.width);
    const y = (clientY - rect.top) * (this.cssHeight / rect.height);
    return this.getOverlayAtPoint(x, y)?.id ?? null;
  }

  canEditOverlays(): boolean {
    const layout = this.cachedLayout ?? this.getLayout();
    return !this.hideHud && this.shouldRenderCustomOverlays(layout);
  }

  // The bottom chrome (Visual Settings drawer, fullscreen playbar) must not
  // slide up over an overlay parked near the bottom edge: it would cover the
  // overlay, its handles and its close button. True while a
  // drag/resize/pinch/marquee runs, while the pointer rests on an overlay or
  // its close button, and - with chromeBandPx set to how far up the chrome
  // reaches - while an overlay sits in the straight-down approach path, so
  // reaching for one never summons the thing that would bury it.
  isOverlayEditPoint(clientX: number, clientY: number, chromeBandPx = 0): boolean {
    if (this.draggingOverlay || this.resizingOverlay || this.pinchingOverlay || this.selectingOverlays) return true;
    if (!this.canEditOverlays()) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const scaleY = this.cssHeight / rect.height;
    const x = (clientX - rect.left) * (this.cssWidth / rect.width);
    const y = (clientY - rect.top) * scaleY;
    if (this.getOverlayCloseButtonAtPoint(x, y) != null || this.getOverlayAtPoint(x, y) != null) return true;
    if (chromeBandPx <= 0) return false;
    const bandTop = this.cssHeight - chromeBandPx * scaleY;
    for (const box of this.overlayHitboxes) {
      const frame = this.getOverlayInteractionFrame(box);
      const bottom = frame.y + frame.height;
      // Only overlays below the pointer, in the column it is descending, and
      // low enough for the chrome to reach them.
      if (bottom < y || bottom < bandTop) continue;
      if (x >= frame.x && x <= frame.x + frame.width) return true;
    }
    return false;
  }

  private installOverlayPointerHandlers() {
    this.previousCanvasTouchAction = this.canvas.style.touchAction;
    this.canvas.style.touchAction = "none";
    this.canvas.addEventListener("pointerdown", this.handleOverlayPointerDown);
    this.canvas.addEventListener("pointermove", this.handleOverlayPointerMove);
    this.canvas.addEventListener("pointerup", this.handleOverlayPointerEnd);
    this.canvas.addEventListener("pointercancel", this.handleOverlayPointerEnd);
    this.canvas.addEventListener("pointerleave", this.handleOverlayPointerLeave);
  }

  private removeOverlayPointerHandlers() {
    this.canvas.style.touchAction = this.previousCanvasTouchAction;
    this.canvas.removeEventListener("pointerdown", this.handleOverlayPointerDown);
    this.canvas.removeEventListener("pointermove", this.handleOverlayPointerMove);
    this.canvas.removeEventListener("pointerup", this.handleOverlayPointerEnd);
    this.canvas.removeEventListener("pointercancel", this.handleOverlayPointerEnd);
    this.canvas.removeEventListener("pointerleave", this.handleOverlayPointerLeave);
  }

  private getCanvasPointerPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? this.cssWidth / rect.width : 1;
    const scaleY = rect.height > 0 ? this.cssHeight / rect.height : 1;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  private getOverlayAtPoint(x: number, y: number): ReplayOverlayHitbox | null {
    for (let index = this.overlayHitboxes.length - 1; index >= 0; index -= 1) {
      const box = this.overlayHitboxes[index];
      const frame = this.getOverlayInteractionFrame(box);
      if (x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height) {
        return box;
      }
    }
    return null;
  }

  private getOverlaySelectionPad(): number {
    return Math.max(2, Math.min(5, this.cssWidth * 0.004));
  }

  private getOverlayCloseButtonAtPoint(x: number, y: number): { id: ReplayOverlayId; x: number; y: number; radius: number } | null {
    for (const button of this.overlayCloseButtons) {
      if (Math.hypot(x - button.x, y - button.y) <= button.radius) return button;
    }
    return null;
  }

  private getOverlayInteractionFrame(box: ReplayOverlayHitbox): ReplayOverlayHitbox {
    if (!this.selectedOverlayIds.has(box.id)) return box;
    const pad = this.getOverlaySelectionPad();
    return {
      id: box.id,
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    };
  }

  private canUseDesktopOverlaySelection(event?: PointerEvent): boolean {
    const layout = this.cachedLayout ?? this.getLayout();
    return !this.hideHud && this.shouldRenderCustomOverlays(layout) && (!event || event.pointerType === "mouse");
  }

  private getSelectedOverlaySnapshots(fallbackId: ReplayOverlayId): ReplayOverlayPlacementSnapshot[] {
    const ids = this.selectedOverlayIds.has(fallbackId)
      ? Array.from(this.selectedOverlayIds)
      : [fallbackId];
    return ids
      .map((id) => {
        const box = this.overlayHitboxes.find((hitbox) => hitbox.id === id);
        if (!box) return null;
        const placement = this.overlaySettings[id];
        return {
          id,
          x: placement.x,
          y: placement.y,
          scale: placement.scale,
          width: box.width,
          height: box.height,
        };
      })
      .filter((value): value is ReplayOverlayPlacementSnapshot => value != null);
  }

  private pruneSelectedOverlays() {
    const visibleIds = new Set(this.overlayHitboxes.map((hitbox) => hitbox.id));
    for (const id of this.selectedOverlayIds) {
      if (!this.overlaySettings[id]?.enabled || (visibleIds.size > 0 && !visibleIds.has(id))) {
        this.selectedOverlayIds.delete(id);
      }
    }
  }

  private getSelectionRect() {
    if (!this.selectingOverlays) return null;
    const left = Math.max(0, Math.min(this.selectingOverlays.startX, this.selectingOverlays.currentX));
    const top = Math.max(0, Math.min(this.selectingOverlays.startY, this.selectingOverlays.currentY));
    const right = Math.min(this.cssWidth, Math.max(this.selectingOverlays.startX, this.selectingOverlays.currentX));
    const bottom = Math.min(this.cssHeight, Math.max(this.selectingOverlays.startY, this.selectingOverlays.currentY));
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  private getOverlaysInRect(rect: { x: number; y: number; width: number; height: number }): ReplayOverlayId[] {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    return this.overlayHitboxes
      .filter((box) => box.x + box.width >= rect.x && box.x <= right && box.y + box.height >= rect.y && box.y <= bottom)
      .map((box) => box.id);
  }

  private applyOverlaySelection(ids: ReplayOverlayId[], additive: boolean) {
    const next = additive ? new Set(this.selectedOverlayIds) : new Set<ReplayOverlayId>();
    for (const id of ids) {
      if (this.overlaySettings[id]?.enabled) next.add(id);
    }
    this.selectedOverlayIds = next;
    if (!this._isPlaying) this.render();
  }

  private toggleOverlaySelection(id: ReplayOverlayId) {
    if (this.selectedOverlayIds.has(id)) {
      this.selectedOverlayIds.delete(id);
    } else if (this.overlaySettings[id]?.enabled) {
      this.selectedOverlayIds.add(id);
    }
    if (!this._isPlaying) this.render();
  }

  private getOverlayResizeZoneSize(box: ReplayOverlayHitbox): number {
    return Math.max(6, Math.min(12, Math.min(box.width, box.height) * 0.25));
  }

  private getOverlayResizeDirection(box: ReplayOverlayHitbox, x: number, y: number): ReplayOverlayResizeDirection | null {
    const frame = this.getOverlayInteractionFrame(box);
    const size = this.getOverlayResizeZoneSize(frame);
    const nearTop = y >= frame.y && y <= frame.y + size;
    const nearRight = x >= frame.x + frame.width - size && x <= frame.x + frame.width;
    const nearBottom = y >= frame.y + frame.height - size && y <= frame.y + frame.height;
    const nearLeft = x >= frame.x && x <= frame.x + size;
    if (nearTop && nearRight) return "ne";
    if (nearTop && nearLeft) return "nw";
    if (nearBottom && nearRight) return "se";
    if (nearBottom && nearLeft) return "sw";
    if (nearTop) return "n";
    if (nearRight) return "e";
    if (nearBottom) return "s";
    if (nearLeft) return "w";
    return null;
  }

  private getOverlayPointerCursor(x: number, y: number): string {
    if (this.getOverlayCloseButtonAtPoint(x, y)) return "pointer";
    if (this.isMissThumbTagPoint(x, y)) return "pointer";
    const hitbox = this.getOverlayAtPoint(x, y);
    if (!hitbox) return "";
    const direction = this.getOverlayResizeDirection(hitbox, x, y);
    switch (direction) {
      case "n":
      case "s":
        return "ns-resize";
      case "e":
      case "w":
        return "ew-resize";
      case "ne":
      case "sw":
        return "nesw-resize";
      case "nw":
      case "se":
        return "nwse-resize";
      default:
        return "grab";
    }
  }

  private getPointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private clampOverlayScale(scale: number): number {
    if (!Number.isFinite(scale)) return 1;
    return Math.max(REPLAY_OVERLAY_MIN_SCALE, Math.min(REPLAY_OVERLAY_MAX_SCALE, scale));
  }

  private clampOverlayPosition(x: number, y: number, width: number, height: number, layout: Layout): { x: number; y: number } {
    const maxX = Math.max(0, 1 - width / Math.max(1, layout.w));
    const maxY = Math.max(0, 1 - height / Math.max(1, layout.h));
    return {
      x: Math.max(0, Math.min(maxX, x)),
      y: Math.max(0, Math.min(maxY, y)),
    };
  }

  private handleOverlayPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.hideHud) return;
    const point = this.getCanvasPointerPoint(event);
    if (this.canUseDesktopOverlaySelection(event)) {
      const closeButton = this.getOverlayCloseButtonAtPoint(point.x, point.y);
      if (closeButton) {
        this.selectedOverlayIds.delete(closeButton.id);
        this.suppressPlayfieldClickAt = performance.now();
        this.updateOverlayPlacement(closeButton.id, { enabled: false });
        this.canvas.style.cursor = "";
        event.preventDefault();
        return;
      }
    }
    const hitbox = this.getOverlayAtPoint(point.x, point.y);
    const desktopSelection = this.canUseDesktopOverlaySelection(event);
    // A press on the thumb tag still arms the drag; the release decides
    // between a click (toggle the hand) and a move.
    this.missThumbTagPress = hitbox?.id === "misses" && this.isMissThumbTagPoint(point.x, point.y)
      ? { pointerId: event.pointerId, ...point }
      : null;
    if (!hitbox) {
      if (!desktopSelection) return;
      this.selectingOverlays = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
        initialSelection: Array.from(this.selectedOverlayIds),
        additive: event.shiftKey || event.metaKey || event.ctrlKey,
      };
      this.canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (desktopSelection) {
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        this.toggleOverlaySelection(hitbox.id);
      } else if (!this.selectedOverlayIds.has(hitbox.id)) {
        this.applyOverlaySelection([hitbox.id], false);
      }
    }

    this.activeOverlayPointers.set(event.pointerId, { id: hitbox.id, ...point });
    this.canvas.setPointerCapture(event.pointerId);
    const placement = this.overlaySettings[hitbox.id];
    const otherPointer = Array.from(this.activeOverlayPointers.entries())
      .find(([pointerId, pointer]) => pointerId !== event.pointerId && pointer.id === hitbox.id);

    if (otherPointer) {
      this.draggingOverlay = null;
      this.resizingOverlay = null;
      this.pinchingOverlay = {
        id: hitbox.id,
        pointerIds: [otherPointer[0], event.pointerId],
        startDistance: Math.max(1, this.getPointerDistance(otherPointer[1], point)),
        startScale: placement.scale,
        startWidth: hitbox.width,
        startHeight: hitbox.height,
      };
      this.canvas.style.cursor = "nwse-resize";
      event.preventDefault();
      return;
    }

    const resizeDirection = this.getOverlayResizeDirection(hitbox, point.x, point.y);
    if (resizeDirection) {
      this.resizingOverlay = {
        id: hitbox.id,
        direction: resizeDirection,
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        startPlacementX: placement.x,
        startPlacementY: placement.y,
        startScale: placement.scale,
        startWidth: hitbox.width,
        startHeight: hitbox.height,
        selected: this.getSelectedOverlaySnapshots(hitbox.id),
      };
      this.canvas.style.cursor = this.getOverlayPointerCursor(point.x, point.y);
      event.preventDefault();
      return;
    }

    this.draggingOverlay = {
      id: hitbox.id,
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      startPlacementX: placement.x,
      startPlacementY: placement.y,
      width: hitbox.width,
      height: hitbox.height,
      selected: this.getSelectedOverlaySnapshots(hitbox.id),
    };
    this.canvas.style.cursor = "grabbing";
    event.preventDefault();
  };

  private handleOverlayPointerMove = (event: PointerEvent) => {
    const layout = this.cachedLayout ?? this.getLayout();
    const point = this.getCanvasPointerPoint(event);
    const activePointer = this.activeOverlayPointers.get(event.pointerId);
    if (activePointer) {
      this.activeOverlayPointers.set(event.pointerId, { ...activePointer, ...point });
    }

    if (this.selectingOverlays) {
      if (event.pointerId !== this.selectingOverlays.pointerId) return;
      this.selectingOverlays.currentX = point.x;
      this.selectingOverlays.currentY = point.y;
      const rect = this.getSelectionRect();
      if (rect) {
        const selectedIds = this.selectingOverlays.additive
          ? Array.from(new Set([...this.selectingOverlays.initialSelection, ...this.getOverlaysInRect(rect)]))
          : this.getOverlaysInRect(rect);
        this.selectedOverlayIds = new Set(selectedIds);
      }
      if (!this._isPlaying) this.render();
      event.preventDefault();
      return;
    }

    if (this.pinchingOverlay && this.pinchingOverlay.pointerIds.includes(event.pointerId)) {
      const [firstId, secondId] = this.pinchingOverlay.pointerIds;
      const first = this.activeOverlayPointers.get(firstId);
      const second = this.activeOverlayPointers.get(secondId);
      if (!first || !second) return;
      const nextScale = this.clampOverlayScale(
        this.pinchingOverlay.startScale * (this.getPointerDistance(first, second) / this.pinchingOverlay.startDistance),
      );
      const scaleRatio = nextScale / Math.max(0.001, this.pinchingOverlay.startScale);
      const placement = this.overlaySettings[this.pinchingOverlay.id];
      const nextPosition = this.clampOverlayPosition(
        placement.x,
        placement.y,
        this.pinchingOverlay.startWidth * scaleRatio,
        this.pinchingOverlay.startHeight * scaleRatio,
        layout,
      );
      this.updateOverlayPlacement(this.pinchingOverlay.id, { ...nextPosition, scale: nextScale });
      event.preventDefault();
      return;
    }

    if (this.resizingOverlay) {
      if (event.pointerId !== this.resizingOverlay.pointerId) return;
      const resize = this.resizingOverlay;
      const dx = point.x - resize.startX;
      const dy = point.y - resize.startY;
      const deltas = [
        resize.direction.includes("e") ? dx / Math.max(1, resize.startWidth) : null,
        resize.direction.includes("w") ? -dx / Math.max(1, resize.startWidth) : null,
        resize.direction.includes("s") ? dy / Math.max(1, resize.startHeight) : null,
        resize.direction.includes("n") ? -dy / Math.max(1, resize.startHeight) : null,
      ].filter((value): value is number => value != null);
      const dominantDelta = deltas.reduce(
        (selected, value) => Math.abs(value) > Math.abs(selected) ? value : selected,
        0,
      );
      const nextScale = this.clampOverlayScale(resize.startScale * Math.max(0.1, 1 + dominantDelta));
      const scaleRatio = nextScale / Math.max(0.001, resize.startScale);
      const nextWidth = resize.startWidth * scaleRatio;
      const nextHeight = resize.startHeight * scaleRatio;
      const nextPosition = this.clampOverlayPosition(
        resize.startPlacementX + (resize.direction.includes("w") ? (resize.startWidth - nextWidth) / Math.max(1, layout.w) : 0),
        resize.startPlacementY + (resize.direction.includes("n") ? (resize.startHeight - nextHeight) / Math.max(1, layout.h) : 0),
        nextWidth,
        nextHeight,
        layout,
      );
      if (resize.selected.length > 1) {
        const nextPlacements = resize.selected.map((item) => {
          const itemScale = this.clampOverlayScale(item.scale * scaleRatio);
          const itemRatio = itemScale / Math.max(0.001, item.scale);
          const itemPosition = this.clampOverlayPosition(
            item.x + (resize.direction.includes("w") ? (item.width - item.width * itemRatio) / Math.max(1, layout.w) : 0),
            item.y + (resize.direction.includes("n") ? (item.height - item.height * itemRatio) / Math.max(1, layout.h) : 0),
            item.width * itemRatio,
            item.height * itemRatio,
            layout,
          );
          return [item.id, { ...itemPosition, scale: itemScale }] as const;
        });
        this.updateOverlayPlacements(nextPlacements);
      } else {
        this.updateOverlayPlacement(resize.id, { ...nextPosition, scale: nextScale });
      }
      event.preventDefault();
      return;
    }

    if (this.draggingOverlay) {
      if (event.pointerId !== this.draggingOverlay.pointerId) return;
      const drag = this.draggingOverlay;
      const dx = (point.x - drag.startX) / Math.max(1, layout.w);
      const dy = (point.y - drag.startY) / Math.max(1, layout.h);
      const next = this.clampOverlayPosition(
        drag.startPlacementX + dx,
        drag.startPlacementY + dy,
        drag.width,
        drag.height,
        layout,
      );
      if (drag.selected.length > 1) {
        this.updateOverlayPlacements(drag.selected.map((item) => [
          item.id,
          this.clampOverlayPosition(item.x + dx, item.y + dy, item.width, item.height, layout),
        ] as const));
      } else {
        this.updateOverlayPlacement(drag.id, next);
      }
      event.preventDefault();
      return;
    }

    this.setMissThumbTagHovered(this.isMissThumbTagPoint(point.x, point.y));
    this.canvas.style.cursor = this.getOverlayPointerCursor(point.x, point.y);
  };

  private handleOverlayPointerEnd = (event: PointerEvent) => {
    this.activeOverlayPointers.delete(event.pointerId);
    const point = this.getCanvasPointerPoint(event);
    if (this.missThumbTagPress?.pointerId === event.pointerId) {
      const press = this.missThumbTagPress;
      this.missThumbTagPress = null;
      if (Math.hypot(point.x - press.x, point.y - press.y) < 4 && this.isMissThumbTagPoint(point.x, point.y)) {
        const next: ReplayThumbHand = this.missThumbHand === "left" ? "right" : "left";
        this.setMissThumbHand(next);
        this.onMissThumbHandChange?.(next);
      }
    }
    if (this.selectingOverlays?.pointerId === event.pointerId) {
      const marquee = this.getSelectionRect();
      if (marquee && marquee.width < 4 && marquee.height < 4 && !this.selectingOverlays.additive) {
        this.selectedOverlayIds.clear();
      }
      this.selectingOverlays = null;
      if (!this._isPlaying) this.render();
    }
    if (this.pinchingOverlay?.pointerIds.includes(event.pointerId)) {
      this.pinchingOverlay = null;
    }
    if (this.resizingOverlay?.pointerId === event.pointerId) {
      this.resizingOverlay = null;
    }
    if (this.draggingOverlay?.pointerId === event.pointerId) {
      this.draggingOverlay = null;
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.canvas.style.cursor = this.getOverlayPointerCursor(point.x, point.y);
  };

  private handleOverlayPointerLeave = () => {
    this.setMissThumbTagHovered(false);
    if (!this.draggingOverlay && !this.resizingOverlay && !this.pinchingOverlay && !this.selectingOverlays) this.canvas.style.cursor = "";
  };

  private updateOverlayPlacement(id: ReplayOverlayId, placement: Partial<ReplayOverlaySettings[ReplayOverlayId]>) {
    const nextSettings = normalizeReplayOverlaySettings({
      ...this.overlaySettings,
      [id]: {
        ...this.overlaySettings[id],
        ...placement,
      },
    });
    this.overlaySettings = nextSettings;
    this.onOverlaySettingsChange?.(nextSettings);
    if (!this._isPlaying) this.render();
  }

  private updateOverlayPlacements(placements: Array<readonly [ReplayOverlayId, Partial<ReplayOverlaySettings[ReplayOverlayId]>]>) {
    const draft: ReplayOverlaySettings = { ...this.overlaySettings };
    for (const [id, placement] of placements) {
      draft[id] = {
        ...draft[id],
        ...placement,
      };
    }
    const nextSettings = normalizeReplayOverlaySettings(draft);
    this.overlaySettings = nextSettings;
    this.onOverlaySettingsChange?.(nextSettings);
    if (!this._isPlaying) this.render();
  }

  private tick() {
    if (!this._isPlaying) return;
    const now = performance.now();
    const external = this.externalClock?.() ?? null;

    if (external) {
      if (!external.stalled) {
        const audioTime = Math.max(0, Math.min(external.time, this.totalDuration));
        const newTime = this.getSmoothedExternalTime(audioTime, now);
        if (newTime >= this.currentTime || newTime > this.currentTime - 6) {
          this.currentTime = newTime;
        } else if (newTime < this.currentTime - 50) {
          this.currentTime = audioTime;
          this.recomputeStatsUpTo(this.currentTime);
          this.resetAudioClockSmoothing(audioTime, now);
        }
      } else {
        this.resetAudioClockSmoothing();
      }
    } else {
      this.resetAudioClockSmoothing();
      const dt = (now - this.lastRenderTime) * this.playbackSpeed * this.modRate;
      this.currentTime += dt;
    }

    this.lastRenderTime = now;
    if (this.currentTime >= this.totalDuration) {
      this.currentTime = this.totalDuration;
      this._isPlaying = false;
    }
    this.advanceStats();
    this.fireHitsounds();
    this.updateFpsCounter(now);
    this.render();
    if (this._isPlaying) this.animFrameId = requestAnimationFrame(() => this.tick());
  }

  private getSmoothedExternalTime(audioTime: number, now: number): number {
    if (this.audioClockAnchorTime == null) {
      this.resetAudioClockSmoothing(audioTime, now);
      return audioTime;
    }

    const predicted = this.audioClockAnchorTime + (now - this.audioClockAnchorNow) * this.playbackSpeed * this.modRate;
    const drift = audioTime - predicted;

    if (Math.abs(drift) > 80) {
      this.resetAudioClockSmoothing(audioTime, now);
      return audioTime;
    }

    if (Math.abs(drift) > 8) {
      const corrected = predicted + drift * 0.18;
      this.audioClockAnchorTime = corrected;
      this.audioClockAnchorNow = now;
      return corrected;
    }

    return predicted;
  }

  private resetAudioClockSmoothing(time: number | null = null, now = performance.now()) {
    this.audioClockAnchorTime = time;
    this.audioClockAnchorNow = now;
  }

  private resetFpsCounter(now = performance.now()) {
    // Restart the sampling window but keep the last reading on screen:
    // zeroing it made the corner counter blink out for the first half-second
    // after every resume.
    this.fpsSampleStartedAt = now;
    this.fpsFrameCount = 0;
  }

  private updateFpsCounter(now: number) {
    if (this.fpsSampleStartedAt <= 0) this.resetFpsCounter(now);
    this.fpsFrameCount++;
    const elapsed = now - this.fpsSampleStartedAt;
    if (elapsed >= 500) {
      this.measuredFps = Math.round((this.fpsFrameCount * 1000) / elapsed);
      this.fpsMaxObserved = Math.max(this.fpsMaxObserved, this.measuredFps);
      this.fpsSampleStartedAt = now;
      this.fpsFrameCount = 0;
    }
  }

  // The display refresh rate the renderer is realistically chasing: rAF locks
  // to the monitor, so the highest fps ever observed snapped to a common
  // refresh rate is the "960" in stable's "935/960fps" readout.
  private getFpsTarget(): number {
    const candidates = [60, 75, 90, 120, 144, 165, 240, 360, 480];
    for (const candidate of candidates) {
      if (this.fpsMaxObserved <= candidate + 2) return candidate;
    }
    return candidates[candidates.length - 1];
  }

  private render(forceHudSnapshot = false) {
    if (!this.app) return;

    const layout = this.getLayout();
    this.currentKeyState = this.getCurrentKeyState();
    this.updateHiddenCoverage();
    this.updateHudSnapshotIfNeeded(forceHudSnapshot);

    if (this.staticDirty) {
      this.staticGraphics.clear();
      this.renderStaticPlayfield(layout);
      this.staticDirty = false;
    }

    this.gameplayGraphics.clear();
    this.inputOverlayGraphics.clear();
    this.hudGraphics.clear();
    this.graphics = this.gameplayGraphics;
    this.beginSkinSpriteFrame();
    this.beginTextFrame();

    this.storyboardOccludesPlayfield = false;
    this.renderBackground(layout);
    this.renderStoryboard(layout);
    // A storyboard-only canvas is the whole render: everything below draws a
    // playfield this instance does not have.
    if (this.storyboardOnly) {
      this.finishSkinSpriteFrame();
      this.finishTextFrame();
      this.app.render();
      return;
    }
    if (!this.storyboardOccludesPlayfield) {
      this.graphics = this.inputOverlayGraphics;
      this.renderSegmentOverlays(layout);
      this.graphics = this.gameplayGraphics;
      this.renderStageFurnitureUnder(layout);
      // skin.ini KeysUnderNotes: the key area belongs below the notes, which
      // is how arrow and deck skins keep their receptors from covering the
      // hit. Sprite order is draw order, so this is the whole implementation.
      const keysUnderNotes = this.skinSettings.style === "bars" && this.skinProfile.keysUnderNotes;
      if (keysUnderNotes) this.renderReceptors(layout);
      if (this.showInputOverlay && this.inputOverlayOnly) {
        this.renderInputOverlayNotes(layout);
      } else {
        this.renderNotes(layout);
      }
      this.renderJudgmentLine(layout);
      if (!keysUnderNotes) this.renderReceptors(layout);
    }
    this.renderStageFurnitureOver(layout);
    if (this.hasFlashlightMod) this.renderFlashlightOverlay(layout);

    // Storyboard Overlay sprites cover the playfield, not the interface. Keep
    // both HUD geometry and imported HUD skin sprites above that layer; text
    // already has its own later stage containers.
    this.graphics = this.hudGraphics;
    this.activeSkinSprites = this.hudSkinSprites;
    if (this.showHealthBar) this.renderHealthBar(layout);
    this.overlayHitboxes = [];
    this.missThumbTagHitbox = null;
    if (!this.hideHud) {
      this.renderHUD(layout);
    } else {
      if (this.showJudgements) this.renderJudgementPop(layout);
      if (this.showCombo) this.renderCombo(layout);
    }
    this.renderOverlaySelectionAffordances(layout);
    this.finishSkinSpriteFrame();
    this.finishTextFrame();
    this.graphics = this.gameplayGraphics;
    this.activeSkinSprites = this.gameplaySkinSprites;
    this.app.render();
  }

  private renderBackground(_layout: Layout) {
    const transitionProgress = this.backgroundTransitionStartedAt > 0
      ? Math.min(1, (performance.now() - this.backgroundTransitionStartedAt) / BACKGROUND_FADE_DURATION_MS)
      : 1;
    if (this.previousBackgroundSprite) this.previousBackgroundSprite.alpha = 1 - transitionProgress;
    if (this.backgroundSprite) this.backgroundSprite.alpha = transitionProgress;

    if (transitionProgress >= 1) {
      if (this.previousBackgroundSprite) {
        this.backgroundLayer.removeChild(this.previousBackgroundSprite);
        this.previousBackgroundSprite.destroy({ texture: false, textureSource: false });
      }
      this.previousBackgroundSprite = null;
      this.previousBackgroundImage = null;
      this.backgroundTransitionStartedAt = 0;
    } else if (!this._isPlaying) {
      requestAnimationFrame(() => {
        if (!this._isPlaying) this.render();
      });
    }
  }

  private renderStaticBackgroundBands(layout: Layout) {
    if (this.transparentBackground) return;
    const g = this.staticGraphics;
    const { w, h } = layout;
    this.fillRectInto(g, 0, 0, w, h, "#0a0a18", 1);
    this.fillRectInto(g, 0, h * 0.34, w, h * 0.33, "#1a1016", 0.8);
    this.fillRectInto(g, 0, h * 0.66, w, h * 0.34, "#0c0c14", 1);
    g.rect(0, 0, w, h).fill({ color: 0x000000, alpha: this.backgroundDim / 100 });
  }

  private renderStaticPlayfield(layout: Layout) {
    this.renderStaticBackgroundBands(layout);
    const { w, h, playfieldX, playfieldWidth } = layout;
    // The alternating column tints, boundary lines and border rect are the
    // built-in "bars" look. A skin with real column art drives its own stage
    // (Colour{n} backgrounds, ColumnLineWidth lines, stage frame), and the
    // extra cosmetics read as lines the skin never had.
    const hasImportedColumnArt = this.skinProfile.assets.columns.some(
      (column) => column && Object.values(column).some(Boolean),
    );
    const showColumnDividers = this.skinSettings.style === "bars" && !hasImportedColumnArt;
    const g = this.staticGraphics;

    if (!this.barePlayfield) {
      this.fillRectInto(g, 0, 0, playfieldX, h, "#000000", 0.24);
      this.fillRectInto(g, playfieldX + playfieldWidth, 0, w - playfieldX - playfieldWidth, h, "#000000", 0.24);
      this.fillRectInto(g, playfieldX, 0, playfieldWidth, h, "#000000", this.blackPlayfield ? 1 : hasImportedColumnArt ? 0 : 0.12);

      for (let col = 0; showColumnDividers && col < this.keyCount; col++) {
        const { x, width } = this.getColumnLayout(col, layout);
        this.fillRectInto(g, x, 0, width, h, "#ffffff", col % 2 === 0 ? 0.02 : 0.04);
      }
    }

    // skin.ini Colour{n}: the column background, alpha included - it decides
    // how much of the map art shows through each lane, so it paints over the
    // default playfield fill rather than replacing the note palette. Preview
    // stages skip it: they sit on the page's own art with no stage behind
    // them, and most skins declare an opaque black lane there.
    if (this.skinSettings.style === "bars" && !this.barePlayfield) {
      for (let col = 0; col < this.keyCount; col++) {
        const declared = this.skinProfile.columnBackgrounds[col];
        if (!declared) continue;
        const { x, width } = this.getColumnLayout(col, layout);
        const alpha = declared.length === 9 ? parseInt(declared.slice(7, 9), 16) / 255 : 1;
        this.fillRectInto(g, x, 0, width, h, declared.slice(0, 7), alpha);
      }
    }

    const topFadeHeight = this.barePlayfield ? Math.min(56, h * 0.14) : 0;
    if (showColumnDividers) {
      for (let i = 0; i <= this.keyCount; i++) {
        const x = i < this.keyCount ? this.getColumnLayout(i, layout).x : playfieldX + playfieldWidth;
        this.lineWithTopFadeInto(g, x, 0, x, h, "#ffffff", 0.08, 1, topFadeHeight);
      }
    }
    if (this.barePlayfield) {
      if (showColumnDividers) this.lineInto(g, playfieldX, h - 1, playfieldX + playfieldWidth, h - 1, "#ffffff", 0.1, 2);
    } else if (!hasImportedColumnArt) {
      this.rectInto(g, playfieldX, 0, playfieldWidth, h, "#ffffff", 0.15, 2);
    }

    this.renderSkinColumnLines(g, layout);
  }

  // skin.ini column lines (ColumnLineWidth + ColourColumnLine): keys+1
  // boundary lines including the outer stage edges, in skin 480-space units.
  // Only drawn when the imported skin set the key explicitly, so built-in
  // styles and older imports keep their current look.
  private renderSkinColumnLines(g: Graphics, layout: Layout) {
    const widths = this.skinProfile.columnLineWidths;
    if (widths.length === 0) return;
    const { h, playfieldX, playfieldWidth } = layout;
    const rawColor = this.skinProfile.columnLineColor || "#ffffff";
    const color = rawColor.slice(0, 7);
    const alpha = rawColor.length === 9 ? parseInt(rawColor.slice(7, 9), 16) / 255 : 1;
    for (let boundary = 0; boundary <= this.keyCount; boundary++) {
      const units = widths[boundary] ?? 0;
      if (units <= 0) continue;
      const lineWidth = Math.max(1, units * layout.layoutScale);
      let x: number;
      if (boundary === 0) {
        x = playfieldX;
      } else if (boundary === this.keyCount) {
        x = playfieldX + playfieldWidth - lineWidth;
      } else {
        const previous = this.getColumnLayout(boundary - 1, layout);
        const current = this.getColumnLayout(boundary, layout);
        x = (previous.x + previous.width + current.x) / 2 - lineWidth / 2;
      }
      this.fillRectInto(g, x, 0, lineWidth, h, color, alpha);
    }
  }

  // Native @1x dimensions for stage furniture: imported assets carry their
  // pixel size, and the texture stands in for older stored settings that do
  // not. Null while the texture is still decoding - callers skip that frame
  // and the load's re-render picks it up.
  private getStageAssetNativeSize(asset: ReplaySkinImageAsset): { width: number; height: number } | null {
    const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
    let rawWidth = asset.width && asset.width > 0 ? asset.width : 0;
    let rawHeight = asset.height && asset.height > 0 ? asset.height : 0;
    if (!rawWidth || !rawHeight) {
      const texture = this.getTexture(asset);
      if (texture === Texture.EMPTY) return null;
      rawWidth = rawWidth || texture.width;
      rawHeight = rawHeight || texture.height;
    }
    if (!(rawWidth > 0) || !(rawHeight > 0)) return null;
    return { width: rawWidth / scale, height: rawHeight / scale };
  }

  // Furniture height rule shared with the catalog preview renderer: @1x
  // pixels are 768-space units, converted into the 480-unit stage space and
  // then to canvas px via layoutScale.
  private getStageAssetHeight(asset: ReplaySkinImageAsset, layout: Layout): number {
    const native = this.getStageAssetNativeSize(asset);
    return Math.max(1, (native?.height ?? 0) * (480 / 768) * layout.layoutScale);
  }

  // Stage furniture under the notes: the column light beneath held keys and
  // the hit-position hint strip. Bars style only - it is the style every .osk
  // import forces, and the synthetic styles have no stage art to draw.
  private renderStageFurnitureUnder(layout: Layout) {
    if (this.skinSettings.style !== "bars") return;
    const stage = this.skinProfile.assets.stage;
    if (!stage.light && !stage.hint) return;
    const { judgmentY, playfieldX, playfieldWidth } = layout;
    const upscroll = this.skinSettings.upscroll;

    if (stage.light) {
      // Bottom edge at skin.ini LightPosition, not the hit position: the
      // shift between the two is what lets O2Jam-style decks overlap their
      // key tops (see skin-preview-render for the derivation).
      const height = this.getStageAssetHeight(stage.light, layout);
      const hitUnits = getSkinStagePositionUnits(this.stagePosition("hitPosition"));
      const lightUnits = 480 - (this.skinProfile.lightPosition ?? OSU_MANIA_DEFAULT_LIGHT_POSITION);
      const lightShift = (hitUnits - lightUnits) * layout.layoutScale;
      for (let col = 0; col < this.keyCount; col++) {
        if ((this.currentKeyState & (1 << col)) === 0) continue;
        const { x, width } = this.getColumnLayout(col, layout);
        const tintColor = stage.lightColors[col] || "";
        const tint = tintColor ? hexToNumber(tintColor) : 0xffffff;
        if (upscroll) {
          this.drawSkinImage(stage.light, x + width / 2, judgmentY - lightShift, width, height, 0.5, 0, 1, tint, true);
        } else {
          this.drawSkinImage(stage.light, x + width / 2, judgmentY + lightShift - height, width, height, 0.5, 0, 1, tint);
        }
      }
    }

    if (stage.hint) {
      // The hint marks the hit position across the whole stage, centred on
      // the judgement line (hung below it, flipped, on upscroll).
      const height = this.getStageAssetHeight(stage.hint, layout);
      const centerX = playfieldX + playfieldWidth / 2;
      if (upscroll) {
        this.drawSkinImage(stage.hint, centerX, judgmentY, playfieldWidth, height, 0.5, 0, 1, 0xffffff, true);
      } else {
        this.drawSkinImage(stage.hint, centerX, judgmentY - height / 2, playfieldWidth, height, 0.5, 0, 1);
      }
    }
  }

  // Stage furniture over the notes, the layering the game uses: the deck art
  // overlapping the bottom of the stage and the frame flanking it.
  private renderStageFurnitureOver(layout: Layout) {
    if (this.skinSettings.style !== "bars") return;
    const stage = this.skinProfile.assets.stage;
    if (!stage.bottom && !stage.left && !stage.right) return;
    const { h, playfieldX, playfieldWidth } = layout;
    const upscroll = this.skinSettings.upscroll;

    if (stage.bottom) {
      // Never stretched to the stage width. Both axes use the asset's native
      // size in the 480-unit playfield space: the wiki's 0.625 note describes
      // that space relative to osu!'s 768-unit screen, not an extra horizontal
      // shrink. Applying 480/768 to the width made authored lane covers span
      // only the middle columns. A too-tall canvas still hangs off the top
      // edge and clips, exactly as in game.
      const native = this.getStageAssetNativeSize(stage.bottom);
      if (native) {
        const width = Math.max(1, native.width * layout.layoutScale);
        const height = Math.max(1, native.height * layout.layoutScale);
        const centerX = playfieldX + playfieldWidth / 2;
        if (upscroll) this.drawSkinImage(stage.bottom, centerX, 0, width, height, 0.5, 0, 1, 0xffffff, true);
        else this.drawSkinImage(stage.bottom, centerX, h - height, width, height, 0.5, 0, 1);
      }
    }

    for (const [asset, side] of [[stage.left, "left"], [stage.right, "right"]] as const) {
      if (!asset) continue;
      // The frame hangs outside the columns at its own width, stretched down
      // the full stage the way stable scales it to the playfield height.
      const native = this.getStageAssetNativeSize(asset);
      if (!native) continue;
      const width = Math.max(1, native.width * (480 / 768) * layout.layoutScale);
      const x = side === "left" ? playfieldX - width / 2 : playfieldX + playfieldWidth + width / 2;
      this.drawSkinImage(asset, x, 0, width, h, 0.5, 0, 1);
    }
  }

  // scorebar-bg + scorebar-colour, mounted the way stable rotates them for
  // mania: vertical against the stage's right edge, the art's left edge at
  // the bottom, the fill cropping away from the top as health drains.
  private renderSkinHealthBar(layout: Layout, health: number): boolean {
    const stage = this.skinProfile.assets.stage;
    const colour = stage.scorebarColour;
    if (!colour) return false;
    const colourNative = this.getStageAssetNativeSize(colour);
    // Textures still decoding: hold the frame rather than flashing the
    // default bar; the finished load re-renders.
    if (!colourNative) return true;
    const { h, playfieldX, playfieldWidth } = layout;
    const bgNative = stage.scorebarBg ? this.getStageAssetNativeSize(stage.scorebarBg) : null;
    // One uniform scale for both pieces so the art keeps its proportions,
    // capped so a full-length bar stays within the stage height.
    const unitScale = (480 / 768) * layout.layoutScale;
    const referenceLength = Math.max(bgNative?.width ?? 0, colourNative.width) * unitScale;
    const maxLength = h * 0.62;
    const pieceScale = referenceLength > maxLength ? (maxLength / referenceLength) * unitScale : unitScale;
    const x = playfieldX + playfieldWidth + 8;
    const bgThickness = (bgNative?.height ?? colourNative.height) * pieceScale;

    if (stage.scorebarBg && bgNative) {
      this.drawSkinImageRotatedCcw(stage.scorebarBg, x, h, bgNative.width * pieceScale, bgThickness, 1);
    }
    const colourThickness = colourNative.height * pieceScale;
    const colourX = x + Math.max(0, (bgThickness - colourThickness) / 2);
    const colourLength = colourNative.width * pieceScale;
    if (health > 0) {
      this.drawSkinImageRotatedCcw(colour, colourX, h, colourLength, colourThickness, 0.98, health);
    }

    // No synthetic fallback marker: a Graphics circle would render under the
    // sprite layer anyway, and skins that want a marker ship one.
    if (stage.scorebarMarker && health > 0) {
      const markerNative = this.getStageAssetNativeSize(stage.scorebarMarker);
      if (markerNative) {
        const fillY = h - colourLength * health;
        const markerWidth = Math.max(1, markerNative.width * pieceScale);
        const markerHeight = Math.max(1, markerNative.height * pieceScale);
        this.drawSkinImage(stage.scorebarMarker, colourX + colourThickness / 2, fillY, markerWidth, markerHeight, 0.5, 0.5, 1);
      }
    }
    return true;
  }

  // Vertical health bar right of the stage, styled per client: stable gets
  // the chunky near-white bar with the marker riding the fill edge, lazer the
  // rounded glowy capsule. Both tint toward red as health drains.
  private renderHealthBar(layout: Layout) {
    if (this.lifeBarFrames.length === 0) return;

    const { h, playfieldX, playfieldWidth } = layout;
    const health = this.getHealthAtTime(this.currentTime);
    if (this.skinSettings.style === "bars" && this.renderSkinHealthBar(layout, health)) return;
    const isLazer = this.ruleset.accuracyMode === "lazer";
    const barWidth = Math.max(7, Math.min(10, layout.laneWidth * 0.17));
    const x = playfieldX + playfieldWidth + 13;
    const height = Math.max(136, h * 0.52);
    const y = h - height;
    const fillHeight = height * health;
    const fillY = y + height - fillHeight;

    if (isLazer) {
      const radius = barWidth / 2;
      const color = health <= 0.2 ? "#ff6666" : "#66ccff";
      this.graphics.roundRect(x, y, barWidth, height, radius).fill({ color: 0x000000, alpha: 0.55 });
      if (fillHeight > barWidth) {
        this.graphics.roundRect(x, fillY, barWidth, fillHeight, radius).fill({ color: hexToNumber(color), alpha: 0.9 });
        // Inner highlight strip for the glowy look.
        this.graphics.roundRect(x + barWidth * 0.28, fillY + radius, barWidth * 0.22, Math.max(0, fillHeight - barWidth), barWidth * 0.11)
          .fill({ color: 0xffffff, alpha: 0.35 });
      }
      if (health > 0) {
        this.circle(x + barWidth / 2, fillY + radius, radius * 1.35, color, 0.5);
        this.circle(x + barWidth / 2, fillY + radius, radius * 0.8, "#ffffff", 0.9);
      }
      return;
    }

    const color = health <= 0.2 ? "#ff4444" : health <= 0.45 ? "#ffcc22" : "#eef7ff";
    this.fillRect(x, y, barWidth, height, "#05050a", 0.62);
    if (fillHeight > 0) {
      this.fillRect(x, fillY, barWidth, fillHeight, color, 0.92);
      // Brighter cap where the fill ends, under the marker.
      this.fillRect(x, fillY, barWidth, Math.min(10, fillHeight), "#ffffff", 0.85);
    }
    this.rect(x - 0.5, y, barWidth + 1, height, "#ffffff", 0.26, 1);
    if (health > 0) {
      const markerRadius = barWidth * 0.85;
      this.circle(x + barWidth / 2, fillY, markerRadius, color, 0.45);
      this.circle(x + barWidth / 2, fillY, markerRadius * 0.62, "#ffffff", 0.95);
    }
  }

  private renderFlashlightOverlay(layout: Layout) {
    const { w, h } = layout;
    const band = getManiaFlashlightBand({
      combo: this.combo,
      comboBasedSize: this.flashlightComboBasedSize,
      playfieldHeight: h,
      referenceHeight: MANIA_REFERENCE_HEIGHT,
      sizeMultiplier: this.flashlightSizeMultiplier,
    });
    const topFadeStart = Math.max(0, band.top - band.edgeFade);
    const topFadeHeight = Math.max(0, band.top - topFadeStart);
    const bottomFadeEnd = Math.min(h, band.bottom + band.edgeFade);
    const bottomFadeHeight = Math.max(0, bottomFadeEnd - band.bottom);

    this.fillRect(0, 0, w, topFadeStart, "#000000", MANIA_FLASHLIGHT_DIM_ALPHA);
    if (topFadeHeight > 0) {
      this.graphics.rect(0, topFadeStart, w, topFadeHeight).fill({
        fill: this.getFlashlightFadeToClearGradient(),
        alpha: MANIA_FLASHLIGHT_DIM_ALPHA,
      });
    }

    if (bottomFadeHeight > 0) {
      this.graphics.rect(0, band.bottom, w, bottomFadeHeight).fill({
        fill: this.getFlashlightFadeToDimGradient(),
        alpha: MANIA_FLASHLIGHT_DIM_ALPHA,
      });
    }
    this.fillRect(0, bottomFadeEnd, w, h - bottomFadeEnd, "#000000", MANIA_FLASHLIGHT_DIM_ALPHA);
  }

  private renderNotes(layout: Layout) {
    const { judgmentY, noteHeight, pixelsPerMs, h } = layout;
    if (this.notes.length === 0) return;

    const currentScrollPosition = this.getScrollPosition(this.currentTime);
    const getVisualDelta = (targetTime: number) => this.getScrollPosition(targetTime) - currentScrollPosition;
    const noteFadeHeight = this.barePlayfield ? Math.min(46, h * 0.11) : 0;
    const timeWindow = (this.skinSettings.upscroll ? h - judgmentY : judgmentY) / pixelsPerMs;
    const velocityWindow = timeWindow / this.scrollVelocityMinMultiplier;
    const visibleMinTime = this.currentTime - velocityWindow * 0.2;
    const visibleMaxTime = this.currentTime + velocityWindow * 1.1;
    // 0.6 keeps late-hit and timed-out notes in the loop until they are fully
    // below the bottom edge, even with a raised (skin) hit position.
    const searchMinTime = Math.min(visibleMinTime, this.currentTime - velocityWindow * 0.6);
    const searchMaxTime = visibleMaxTime;
    const startIdx = this.binarySearchNoteIndex(searchMinTime - this.maxHoldDuration);

    for (let i = startIdx; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.time > searchMaxTime) break;
      const col = note.column;
      if (col >= this.keyCount) continue;

      // Notes the simulation dropped (out-of-range column) have no state.
      const noteState = this.noteStates[i];
      if (!noteState) continue;
      const headResolved = noteState.headTime <= this.currentTime;
      const tailResolved = noteState.tailTime != null && noteState.tailTime <= this.currentTime;
      // Timed-out tap misses (headTime past the note time means no press consumed
      // it) keep scrolling below the receptors until offscreen, like the client.
      const tapMissScrollsPast = !note.isHold && noteState.headJudgment === 6 && noteState.headTime > note.time;

      if (!note.isHold) {
        if (headResolved && !tapMissScrollsPast) continue;
      } else if (headResolved && tailResolved) {
        // Judged holds keep their unconsumed remainder (missed head, break,
        // early release) scrolling past the line like the client; only holds
        // consumed through the tail despawn at the tail judgement.
        if (note.endTime < this.currentTime - velocityWindow * 0.6) continue;
        const cut = this.getHoldConsumedCutTime(note, noteState, col);
        if (cut == null || cut >= note.endTime - 1) continue;
      }

      const { x: colX, width: colWidth } = this.getColumnLayout(col, layout);
      const x = colX + 3;
      const barWidth = colWidth - 6;
      const assets = this.skinSettings.style === "bars" ? this.skinProfile.assets.columns[col] : undefined;
      const color = this.skinSettings.style === "bars" ? this.barTapColors[col] : this.colors[col];
      const circleTapColor = this.circleTapColors[col];
      const circleLnHeadColor = this.circleLnHeadColors[col];
      const circleDiameter = this.getCircleDiameter(layout);
      const circleRadius = circleDiameter / 2;
      const isArrowSkin = this.skinSettings.style === "arrows";
      const arrowSize = isArrowSkin ? this.getArrowSize(layout) : 0;
      const arrowDirection = isArrowSkin ? getColumnArrowDirection(col, this.keyCount) : "right";
      const arrowTapColor = this.circleTapColors[col];
      const arrowLnHeadColor = this.circleLnHeadColors[col];

      if (note.isHold) {
        const direction = this.skinSettings.upscroll ? 1 : -1;
        let headY = judgmentY + getVisualDelta(note.time) * pixelsPerMs * direction;
        const tailY = judgmentY + getVisualDelta(note.endTime) * pixelsPerMs * direction;
        const awaitingJudgment = !headResolved;
        // Where consumption at the line stopped. Non-null detaches the hold:
        // the remainder from the cut edge to the tail scrolls past the line
        // like stable/lazer broken or early-released holds.
        const consumedCut = headResolved ? this.getHoldConsumedCutTime(note, noteState, col) : null;
        const detached = consumedCut != null;
        if (detached && consumedCut > note.time) {
          headY = judgmentY + getVisualDelta(consumedCut) * pixelsPerMs * direction;
        }
        const shouldLetPassLine = detached || (awaitingJudgment && note.time < this.currentTime - 10);

        if (!shouldLetPassLine) headY = this.skinSettings.upscroll ? Math.max(headY, judgmentY) : Math.min(headY, judgmentY);
        const top = Math.min(headY, tailY);
        let bottom = Math.max(headY, tailY);
        if (!shouldLetPassLine && !this.skinSettings.upscroll) bottom = Math.min(bottom, judgmentY);
        if (top > h + 20 || bottom < -20) continue;

        // Detached remainders dim like the client's unheld hold bodies; a
        // missed-head hold still lights up while the key is physically down.
        const dimmed = detached && (noteState.headJudgment === 6
          ? !this.isColumnEffectivelyHeldAtTime(col, this.currentTime)
          : true);
        const bodyAlpha = dimmed ? 0.45 : 1;
        const headAlpha = dimmed ? 0.65 : 1;
        const headEndY = this.skinSettings.upscroll ? top : bottom;
        const tailEndY = this.skinSettings.upscroll ? bottom : top;
        const headVisibilityAlpha = this.getHiddenAlphaAtY(headEndY, layout);
        const headTrimDelta = isArrowSkin
          ? arrowSize * 0.5
          : this.skinSettings.style === "circles"
            ? circleDiameter * 0.5
            : noteHeight * 0.5;
        const tailTrimDelta = this.skinSettings.percy
          ? Math.min(20, Math.max(noteHeight * 0.9, headTrimDelta * 1.1))
          : 0;
        if (this.renderHoldSkinImages(layout, col, assets, colX, colWidth, top, bottom, headEndY, tailEndY, bodyAlpha, headAlpha, noteFadeHeight, layout)) {
          continue;
        }

        if (this.skinSettings.style === "circles") {
          const bodyWidth = Math.max(14, circleDiameter * 0.72);
          const bodyX = colX + colWidth / 2 - bodyWidth / 2;
          const headCenterY = this.getVisualCenterY(headEndY, circleRadius);
          const circleBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);
          if (circleBodyRange) {
            this.circleLnBodyWithTopFade(
              bodyX,
              circleBodyRange.top,
              bodyWidth,
              circleBodyRange.bottom - circleBodyRange.top,
              this.skinSettings.lnBodyColor,
              bodyAlpha,
              noteFadeHeight,
              0.55,
              layout,
            );
          }
          this.circleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, circleLnHeadColor, headAlpha * headVisibilityAlpha, noteFadeHeight, 0.55);
          if (this.skinSettings.outlineEnabled) {
            this.strokeCircleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, this.skinSettings.outlineColor, headAlpha * headVisibilityAlpha, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
          }
          continue;
        }

        if (isArrowSkin) {
          const bodyWidth = Math.max(14, arrowSize * 0.68);
          const bodyX = colX + colWidth / 2 - bodyWidth / 2;
          const headCenterY = this.getVisualCenterY(headEndY, arrowSize / 2);
          const arrowBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);
          if (arrowBodyRange) {
            this.arrowLnBodyWithTopFade(
              bodyX,
              arrowBodyRange.top,
              bodyWidth,
              arrowBodyRange.bottom - arrowBodyRange.top,
              this.skinSettings.lnBodyColor,
              bodyAlpha,
              noteFadeHeight,
              0.55,
              this.skinSettings.upscroll ? "bottom" : "top",
              layout,
            );
          }
          this.arrowShapeWithTopFade(
            colX + colWidth / 2,
            headCenterY,
            arrowSize,
            arrowDirection,
            arrowLnHeadColor,
            headAlpha * headVisibilityAlpha,
            this.skinSettings.outlineEnabled ? this.skinSettings.outlineColor : null,
            headAlpha * headVisibilityAlpha,
            this.skinSettings.outlineWidth,
            noteFadeHeight,
            0.55,
          );
          continue;
        }

        const barPercyTrim = this.skinSettings.percy
          ? Math.min(18, Math.max(noteHeight * 0.9, circleDiameter * 0.34))
          : 0;
        const tailDelta = this.skinSettings.upscroll ? -barPercyTrim : barPercyTrim;
        const bodyHeadY = headEndY;
        const bodyTailY = tailEndY + tailDelta;
        // Directional, like the skin-art path: the trimmed tail crosses the
        // head in the last stretch of a hold, and an absolute span would flip
        // there and draw the leftover past the receptor.
        const barBodyTop = this.skinSettings.upscroll ? bodyHeadY : bodyTailY;
        const barBodyBottom = this.skinSettings.upscroll ? bodyTailY : bodyHeadY;
        if (barBodyBottom > barBodyTop) {
          this.barLnBodyWithTopFade(x, barBodyTop, barWidth, barBodyBottom - barBodyTop, color, bodyAlpha, noteFadeHeight, 0.55, layout);
        }
      } else {
        // Unjudged taps keep scrolling past the receptors until the actual hit
        // (headTime) despawns them; falling behind on a dense section visibly
        // piles the notes up below the line like stable does.
        const noteY = judgmentY + getVisualDelta(note.time) * pixelsPerMs * (this.skinSettings.upscroll ? 1 : -1);
        if (noteY > h + 20 || noteY < -20) continue;

        if (assets?.tap) {
          const assetHeight = this.getNoteAssetHeight(assets.tap, colWidth, layout, Math.max(noteHeight, circleDiameter, arrowSize));
          const noteTop = this.skinSettings.upscroll ? noteY : noteY - assetHeight;
          const visibilityAlpha = this.getHiddenAlphaAtNoteEdge(noteTop, noteTop + assetHeight, layout);
          if (visibilityAlpha <= 0) continue;
          const alpha = this.topFadeAlpha(Math.max(0, Math.min(noteTop + assetHeight, noteFadeHeight)), noteFadeHeight, 0.55) * visibilityAlpha;
          this.drawSkinImage(assets.tap, colX + colWidth / 2, noteTop, colWidth, assetHeight, 0.5, 0, alpha);
          continue;
        }

        const noteVisibilityAlpha = this.getHiddenAlphaAtY(noteY, layout);
        if (noteVisibilityAlpha <= 0) continue;

        if (this.skinSettings.style === "circles") {
          const noteCenterY = this.getVisualCenterY(noteY, circleRadius);
          this.circleWithTopFade(colX + colWidth / 2, noteCenterY, circleRadius, circleTapColor, noteVisibilityAlpha, noteFadeHeight, 0.55);
          if (this.skinSettings.outlineEnabled) {
            this.strokeCircleWithTopFade(colX + colWidth / 2, noteCenterY, circleRadius, this.skinSettings.outlineColor, noteVisibilityAlpha, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
          }
          continue;
        }

        if (isArrowSkin) {
          const noteCenterY = this.getVisualCenterY(noteY, arrowSize / 2);
          this.arrowShapeWithTopFade(
            colX + colWidth / 2,
            noteCenterY,
            arrowSize,
            arrowDirection,
            arrowTapColor,
            noteVisibilityAlpha,
            this.skinSettings.outlineEnabled ? this.skinSettings.outlineColor : null,
            noteVisibilityAlpha,
            this.skinSettings.outlineWidth,
            noteFadeHeight,
            0.55,
          );
          continue;
        }

        const noteTop = this.skinSettings.upscroll ? noteY : noteY - noteHeight;
        this.roundRectWithTopFade(x, noteTop, barWidth, noteHeight, 4, color, 1, noteFadeHeight, 0.55, layout);
        this.roundRectWithTopFade(x + 1, noteTop, barWidth - 2, noteHeight, 4, color, 0.32, noteFadeHeight, 0.55, layout);
        this.roundRectWithTopFade(x + 2, noteTop + 1, barWidth - 4, noteHeight / 3, 2, "#ffffff", 0.2, noteFadeHeight, 0.55, layout);
      }
    }
  }

  private renderSegmentOverlays(layout: Layout) {
    const { judgmentY, pixelsPerMs, h } = layout;
    if (this.frames.length === 0 || !this.showInputOverlay || this.inputOverlayOnly) return;

    const currentScrollPosition = this.getScrollPosition(this.currentTime);
    const getVisualDelta = (targetTime: number) => this.getScrollPosition(targetTime) - currentScrollPosition;
    const timeWindow = (this.skinSettings.upscroll ? h - judgmentY : judgmentY) / pixelsPerMs;
    const velocityWindow = timeWindow / this.scrollVelocityMinMultiplier;
    const visibleMinTime = this.currentTime - velocityWindow * 0.2;
    const visibleMaxTime = this.currentTime + velocityWindow * 1.1;
    const hasNotes = this.notes.length > 0 && !this.inputOverlayOnly;

    for (let col = 0; col < this.keyCount; col++) {
      const { x: colX, width: colWidth } = this.getColumnLayout(col, layout);
      const x = colX + 2;
      const barWidth = colWidth - 4;
      const color = this.colors[col];
      const segments = this.segments[col];
      const startSegmentIndex = this.binarySearchSegmentEndIndex(segments, visibleMinTime);

      for (let i = startSegmentIndex; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.start > visibleMaxTime) break;

        const startY = judgmentY + getVisualDelta(seg.start) * pixelsPerMs * (this.skinSettings.upscroll ? 1 : -1);
        const endY = judgmentY + getVisualDelta(seg.end) * pixelsPerMs * (this.skinSettings.upscroll ? 1 : -1);
        if (startY < -20 && endY < -20) continue;
        if (startY > h + 20 && endY > h + 20) continue;

        const top = Math.min(startY, endY);
        const bottom = this.skinSettings.upscroll
          ? Math.max(Math.max(startY, endY), judgmentY)
          : Math.min(Math.max(startY, endY), judgmentY);
        if (bottom < top) continue;
        // A recorded key hold is one continuous segment, including where it
        // overlaps the chart's LN body.
        const barH = Math.max(bottom - top, 2);
        this.roundRect(x, top, barWidth, barH, 3, hasNotes ? this.inputOverlayColor : color, hasNotes ? 0.18 : 0.7);
        if (top < judgmentY && bottom > judgmentY - 20) {
          this.fillRect(x, top, barWidth, barH, this.inputOverlayColor, 0.08);
        }
      }
    }
  }

  private renderInputOverlayNotes(layout: Layout) {
    const { judgmentY, noteHeight, pixelsPerMs, h } = layout;
    if (this.frames.length === 0) return;

    const currentScrollPosition = this.getScrollPosition(this.currentTime);
    const getVisualDelta = (targetTime: number) => this.getScrollPosition(targetTime) - currentScrollPosition;
    const noteFadeHeight = this.barePlayfield ? Math.min(46, h * 0.11) : 0;
    const timeWindow = (this.skinSettings.upscroll ? h - judgmentY : judgmentY) / pixelsPerMs;
    const velocityWindow = timeWindow / this.scrollVelocityMinMultiplier;
    const visibleMinTime = this.currentTime - velocityWindow * 0.2;
    const visibleMaxTime = this.currentTime + velocityWindow * 1.1;
    const direction = this.skinSettings.upscroll ? 1 : -1;

    for (let col = 0; col < this.keyCount; col++) {
      const segments = this.segments[col];
      const startSegmentIndex = this.binarySearchSegmentEndIndex(segments, visibleMinTime);

      for (let i = startSegmentIndex; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.start > visibleMaxTime) break;

        const rawStartY = judgmentY + getVisualDelta(seg.start) * pixelsPerMs * direction;
        const rawEndY = judgmentY + getVisualDelta(seg.end) * pixelsPerMs * direction;
        const startY = seg.start <= this.currentTime && seg.end > this.currentTime
          ? judgmentY
          : rawStartY;
        const endY = rawEndY;
        if (startY < -20 && endY < -20) continue;
        if (startY > h + 20 && endY > h + 20) continue;

        const top = Math.min(startY, endY);
        const bottom = this.skinSettings.upscroll
          ? Math.max(Math.max(startY, endY), judgmentY)
          : Math.min(Math.max(startY, endY), judgmentY);
        if (bottom - top <= 0) continue;
        const headEndY = this.skinSettings.upscroll ? top : bottom;
        const tailEndY = this.skinSettings.upscroll ? bottom : top;
        const isHold = seg.end - seg.start > HOLD_VISUAL_GRACE_MS && bottom - top > noteHeight * 0.65;
        this.renderInputOverlayNoteSkin(layout, col, top, bottom, headEndY, tailEndY, isHold, noteFadeHeight);
      }
    }
  }

  private renderInputOverlayNoteSkin(
    layout: Layout,
    col: number,
    top: number,
    bottom: number,
    headEndY: number,
    tailEndY: number,
    isHold: boolean,
    noteFadeHeight: number,
  ) {
    const { noteHeight } = layout;
    const { x: colX, width: colWidth } = this.getColumnLayout(col, layout);
    const x = colX + 3;
    const barWidth = colWidth - 6;
    const assets = this.skinSettings.style === "bars" ? this.skinProfile.assets.columns[col] : undefined;
    const color = this.skinSettings.style === "bars" ? this.barTapColors[col] : this.colors[col];
    const circleTapColor = this.circleTapColors[col];
    const circleLnHeadColor = this.circleLnHeadColors[col];
    const circleDiameter = this.getCircleDiameter(layout);
    const circleRadius = circleDiameter / 2;
    const isArrowSkin = this.skinSettings.style === "arrows";
    const arrowSize = isArrowSkin ? this.getArrowSize(layout) : 0;
    const arrowDirection = isArrowSkin ? getColumnArrowDirection(col, this.keyCount) : "right";
    const arrowTapColor = this.circleTapColors[col];
    const arrowLnHeadColor = this.circleLnHeadColors[col];

    if (isHold) {
      const headTrimDelta = isArrowSkin
        ? arrowSize * 0.5
        : this.skinSettings.style === "circles"
          ? circleDiameter * 0.5
          : noteHeight * 0.5;
      const tailTrimDelta = this.skinSettings.percy
        ? Math.min(20, Math.max(noteHeight * 0.9, headTrimDelta * 1.1))
        : 0;

      if (this.renderHoldSkinImages(layout, col, assets, colX, colWidth, top, bottom, headEndY, tailEndY, 0.92, 0.96, noteFadeHeight)) {
        return;
      }

      if (this.skinSettings.style === "circles") {
        const bodyWidth = Math.max(14, circleDiameter * 0.72);
        const bodyX = colX + colWidth / 2 - bodyWidth / 2;
        const headCenterY = this.getVisualCenterY(headEndY, circleRadius);
        const inputCircleBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);
        if (inputCircleBodyRange) {
          this.circleLnBodyWithTopFade(bodyX, inputCircleBodyRange.top, bodyWidth, inputCircleBodyRange.bottom - inputCircleBodyRange.top, this.skinSettings.lnBodyColor, 0.92, noteFadeHeight, 0.55);
        }
        this.circleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, circleLnHeadColor, 0.96, noteFadeHeight, 0.55);
        if (this.skinSettings.outlineEnabled) {
          this.strokeCircleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, this.skinSettings.outlineColor, 0.96, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
        }
        return;
      }

      if (isArrowSkin) {
        const bodyWidth = Math.max(14, arrowSize * 0.68);
        const bodyX = colX + colWidth / 2 - bodyWidth / 2;
        const headCenterY = this.getVisualCenterY(headEndY, arrowSize / 2);
        const inputArrowBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);
        if (inputArrowBodyRange) {
          this.arrowLnBodyWithTopFade(
            bodyX,
            inputArrowBodyRange.top,
            bodyWidth,
            inputArrowBodyRange.bottom - inputArrowBodyRange.top,
            this.skinSettings.lnBodyColor,
            0.92,
            noteFadeHeight,
            0.55,
            this.skinSettings.upscroll ? "bottom" : "top",
          );
        }
        this.arrowShapeWithTopFade(
          colX + colWidth / 2,
          headCenterY,
          arrowSize,
          arrowDirection,
          arrowLnHeadColor,
          0.96,
          this.skinSettings.outlineEnabled ? this.skinSettings.outlineColor : null,
          0.96,
          this.skinSettings.outlineWidth,
          noteFadeHeight,
          0.55,
        );
        return;
      }

      const barPercyTrim = this.skinSettings.percy
        ? Math.min(18, Math.max(noteHeight * 0.9, circleDiameter * 0.34))
        : 0;
      const tailDelta = this.skinSettings.upscroll ? -barPercyTrim : barPercyTrim;
      const barBodyTop = Math.min(headEndY, tailEndY + tailDelta);
      const barBodyBottom = Math.max(headEndY, tailEndY + tailDelta);
      this.barLnBodyWithTopFade(x, barBodyTop, barWidth, barBodyBottom - barBodyTop, color, 0.92, noteFadeHeight, 0.55);
      return;
    }

    if (assets?.tap) {
      const assetHeight = this.getNoteAssetHeight(assets.tap, colWidth, layout, Math.max(noteHeight, circleDiameter, arrowSize));
      const noteTop = this.skinSettings.upscroll ? headEndY : headEndY - assetHeight;
      const alpha = this.topFadeAlpha(Math.max(0, Math.min(noteTop + assetHeight, noteFadeHeight)), noteFadeHeight, 0.55);
      this.drawSkinImage(assets.tap, colX + colWidth / 2, noteTop, colWidth, assetHeight, 0.5, 0, alpha * 0.96);
      return;
    }

    if (this.skinSettings.style === "circles") {
      const headCenterY = this.getVisualCenterY(headEndY, circleRadius);
      this.circleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, circleTapColor, 0.96, noteFadeHeight, 0.55);
      if (this.skinSettings.outlineEnabled) {
        this.strokeCircleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, this.skinSettings.outlineColor, 0.96, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
      }
      return;
    }

    if (isArrowSkin) {
      const headCenterY = this.getVisualCenterY(headEndY, arrowSize / 2);
      this.arrowShapeWithTopFade(
        colX + colWidth / 2,
        headCenterY,
        arrowSize,
        arrowDirection,
        arrowTapColor,
        0.96,
        this.skinSettings.outlineEnabled ? this.skinSettings.outlineColor : null,
        0.96,
        this.skinSettings.outlineWidth,
        noteFadeHeight,
        0.55,
      );
      return;
    }

    const noteTop = this.skinSettings.upscroll ? headEndY : headEndY - noteHeight;
    this.roundRectWithTopFade(x, noteTop, barWidth, noteHeight, 4, color, 0.96, noteFadeHeight, 0.55);
    this.roundRectWithTopFade(x + 1, noteTop, barWidth - 2, noteHeight, 4, color, 0.3, noteFadeHeight, 0.55);
    this.roundRectWithTopFade(x + 2, noteTop + 1, barWidth - 4, noteHeight / 3, 2, "#ffffff", 0.18, noteFadeHeight, 0.55);
  }

  private renderKeyInputHistory(
    layout: Layout,
    keyRowX: number,
    keyRowY: number,
    keyBoxWidth: number,
    _keyBoxHeight: number,
    keyGap: number,
  ) {
    if (!this.inputOverlayKeyHistory || this.frames.length === 0) return;

    const hudScale = this.getHudScale(layout);
    const bottom = keyRowY - 7 * hudScale;
    const requestedHeight = Math.min(240 * hudScale, Math.max(120 * hudScale, layout.h * 0.32));
    const top = Math.max(8, bottom - requestedHeight);
    const height = bottom - top;
    if (height < 32) return;

    const currentTime = this.currentTime;
    const currentScrollPosition = this.getScrollPosition(currentTime);
    const getVisualDelta = (targetTime: number) => this.getScrollPosition(targetTime) - currentScrollPosition;
    const historySpeedScale = 0.5;
    const historyPixelsPerMs = layout.pixelsPerMs * historySpeedScale;
    const maxTime = currentTime + height / Math.max(historyPixelsPerMs * this.scrollVelocityMinMultiplier, 0.001);
    const laneInset = (keyBoxWidth <= 32 * hudScale ? 3 : 4) * hudScale;
    const laneWidth = Math.max(8, keyBoxWidth - laneInset * 2);
    const minBlockHeight = (keyBoxWidth <= 32 * hudScale ? 8 : 10) * hudScale;
    const fadeHeight = Math.min(48 * hudScale, Math.max(28 * hudScale, height * 0.32));

    for (let col = 0; col < this.keyCount; col++) {
      const laneX = keyRowX + col * (keyBoxWidth + keyGap) + laneInset;
      const color = this.getSkinTapColor(col);

      const segments = this.segments[col];
      const startIndex = this.binarySearchSegmentEndIndex(segments, currentTime);
      for (let i = startIndex; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.start > maxTime) break;
        if (seg.end < currentTime) continue;

        const start = Math.max(seg.start, currentTime);
        const end = Math.min(seg.end, maxTime);
        const yStart = bottom - getVisualDelta(start) * historyPixelsPerMs;
        const yEnd = bottom - getVisualDelta(end) * historyPixelsPerMs;
        const rawTop = Math.min(yStart, yEnd);
        const rawBottom = Math.max(yStart, yEnd);
        if (rawBottom <= top || rawTop >= bottom) continue;

        let pieceTop = Math.max(top, rawTop);
        const pieceBottom = Math.min(bottom, rawBottom);
        if (pieceBottom - pieceTop < minBlockHeight) {
          pieceTop = Math.max(top, pieceBottom - minBlockHeight);
        }

        this.roundRect(
          laneX,
          pieceTop,
          laneWidth,
          Math.max(2, pieceBottom - pieceTop),
          2,
          color,
          seg.start <= currentTime && seg.end >= currentTime ? 0.72 : 0.46,
        );
      }

      this.graphics.rect(laneX, top, laneWidth, fadeHeight).fill({
        fill: this.getInputHistoryTopFadeGradient(),
        alpha: 1,
      });
    }
  }

  private renderJudgmentLine(layout: Layout) {
    // skin.ini JudgementLine + ColourJudgementLine: skins either disable the
    // bar or paint it into the stage (often black-on-black for circle decks).
    // Inventing white here put a line through art that has none in game.
    if (this.skinSettings.style !== "bars" || !this.skinProfile.judgementLine) return;
    const { playfieldX, playfieldWidth, judgmentY } = layout;
    const declaredColor = this.skinProfile.judgementLineColor;
    const rawColor = declaredColor || "#ffffff";
    const color = rawColor.slice(0, 7);
    const alpha = rawColor.length === 9 ? parseInt(rawColor.slice(7, 9), 16) / 255 : declaredColor ? 1 : 0.82;
    this.line(playfieldX, judgmentY, playfieldX + playfieldWidth, judgmentY, color, alpha, 2);
  }

  private renderReceptors(layout: Layout) {
    if (this.skinSettings.style === "circles") {
      this.renderCircleReceptors(layout);
      return;
    }
    if (this.skinSettings.style === "arrows") {
      this.renderArrowReceptors(layout);
      return;
    }

    const { judgmentY, receptorHeight } = layout;
    const currentState = this.currentKeyState;

    for (let col = 0; col < this.keyCount; col++) {
      const { x, width: colWidth } = this.getColumnLayout(col, layout);
      const pressed = (currentState & (1 << col)) !== 0;
      const assets = this.skinProfile.assets.columns[col];
      const receptorAsset = pressed
        ? assets?.receptorPressed ?? assets?.receptor
        : assets?.receptor;
      if (receptorAsset) {
        if (pressed) this.receptorFlashTimestamps[col] = this.currentTime;
        // The key area is stretched to the lane's width but keeps its NATIVE
        // height in the game's 768-space, standing on the stage's bottom edge
        // (hanging from the top on upscroll, which flips the stage). This is
        // lazer's LegacyKeyArea rule, shared with the stage furniture and the
        // catalog preview. Stretching it to the gap under the hit line instead
        // squashed tall key art into a flat smear.
        //
        // That bottom edge is the hit position's own distance below the line,
        // not the canvas edge; the two coincide only while the stage's
        // vertical scale matches its horizontal one. A preview widens its
        // lanes past what its height implies, and key art is padded so its
        // visible key lands on the hit position (aleju03's ring ends at unit
        // 450 of a 450 hit position, Teto's red line spans 391-399 for 393),
        // so the padding stretched with the lanes and dragged the key up off
        // the line notes land on. Measuring from the line keeps them together
        // at any scale, and the overflow runs off the canvas where it did.
        const native = this.getStageAssetNativeSize(receptorAsset);
        if (native) {
          const height = Math.max(1, native.height * (480 / 768) * layout.layoutScale);
          const stageEdge = getSkinStagePositionUnits(this.stagePosition("hitPosition")) * layout.layoutScale;
          if (this.skinSettings.upscroll) {
            this.drawSkinImage(receptorAsset, x + colWidth / 2, judgmentY - stageEdge, colWidth, height, 0.5, 0, 1, 0xffffff, true);
          } else {
            this.drawSkinImage(receptorAsset, x + colWidth / 2, judgmentY + stageEdge - height, colWidth, height, 0.5, 0, 1);
          }
        }
        continue;
      }
      const color = this.colors[col];
      if (pressed) this.receptorFlashTimestamps[col] = this.currentTime;

      const timeSinceFlash = this.currentTime - (this.receptorFlashTimestamps[col] || 0);
      const flashIntensity = pressed ? 1 : Math.max(0, 1 - timeSinceFlash / 120);

      const receptorY = this.skinSettings.upscroll ? judgmentY - receptorHeight - 2 : judgmentY + 2;
      if (flashIntensity > 0) {
        this.receptorBeam(x, this.skinSettings.upscroll ? judgmentY - 15 : judgmentY - 80, colWidth, 95, color, flashIntensity);
        this.roundRect(x + 3, receptorY, colWidth - 6, receptorHeight, 2, color, flashIntensity);
      } else {
        this.roundRect(x + 3, receptorY, colWidth - 6, receptorHeight, 2, "#ffffff", 0.12);
      }
    }
  }

  private renderArrowReceptors(layout: Layout) {
    const { judgmentY } = layout;
    const currentState = this.currentKeyState;
    const arrowSize = this.getArrowSize(layout);
    const receptorCenterY = this.getVisualCenterY(judgmentY, arrowSize / 2);

    for (let col = 0; col < this.keyCount; col++) {
      const { x, width: colWidth } = this.getColumnLayout(col, layout);
      const cx = x + colWidth / 2;
      const direction = getColumnArrowDirection(col, this.keyCount);
      const pressed = (currentState & (1 << col)) !== 0;
      if (pressed) this.receptorFlashTimestamps[col] = this.currentTime;
      const timeSinceFlash = this.currentTime - (this.receptorFlashTimestamps[col] || 0);
      const flashIntensity = pressed ? 1 : Math.max(0, 1 - timeSinceFlash / 140);

      this.arrowStroke(cx, receptorCenterY, arrowSize, direction, "#ffffff", Math.max(pressed ? 0.95 : 0.4, flashIntensity * 0.65), Math.max(2.5, arrowSize * 0.055));
    }
  }

  private renderCircleReceptors(layout: Layout) {
    const { judgmentY } = layout;
    const currentState = this.currentKeyState;
    const radius = this.getCircleDiameter(layout) / 2;
    const receptorCenterY = this.getVisualCenterY(judgmentY, radius);
    // Uncapped: a 3px ring on a fullscreen-sized receptor reads as a thin
    // aliased wire; the ring has to thicken with the circle.
    const strokeWidth = Math.max(2.5, radius * 0.11);

    for (let col = 0; col < this.keyCount; col++) {
      const { x, width: colWidth } = this.getColumnLayout(col, layout);
      const pressed = (currentState & (1 << col)) !== 0;
      // Presses brighten the ring only; filling the inside reads as a note.
      this.strokeCircle(x + colWidth / 2, receptorCenterY, radius, "#ffffff", pressed ? 1 : 0.5, strokeWidth);
    }
  }

  private getOverlayScale(layout: Layout, id: ReplayOverlayId): number {
    return this.getHudScale(layout) * this.overlaySettings[id].scale;
  }

  private getTextMeasureContext(): CanvasRenderingContext2D | null {
    if (this.textMeasureContext) return this.textMeasureContext;
    if (typeof document === "undefined") return null;
    this.textMeasureContext = document.createElement("canvas").getContext("2d");
    return this.textMeasureContext;
  }

  private measureTextWidth(
    text: string,
    fontSize: number,
    fontWeight: ReplayComboFontStyle["weight"] | "400" | "700" = "400",
    fontStyle: "normal" | "italic" = "normal",
    fontFamily = "Torus, sans-serif",
  ): number {
    const context = this.getTextMeasureContext();
    if (!context) return text.length * fontSize * 0.58;
    const font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    // Canvas measureText is called dozens of times per frame (every tabular
    // number re-measures all ten digits to find its advance), and the answer
    // only changes when the font does - which bumps textFontRevision.
    const key = `${font}|${text}`;
    const cached = this.textWidthCache.get(key);
    if (cached !== undefined) return cached;
    context.font = font;
    const width = context.measureText(text).width;
    if (this.textWidthCache.size > 4096) this.textWidthCache.clear();
    this.textWidthCache.set(key, width);
    return width;
  }

  private getTextOverlayWidth(
    text: string,
    fontSize: number,
    scale: number,
    fontWeight: ReplayComboFontStyle["weight"] | "400" | "700" = "400",
  ): number {
    return Math.ceil(this.measureTextWidth(text, fontSize, fontWeight) + 4 * scale);
  }

  private getSkinTapColor(col: number): string {
    if (this.skinSettings.style === "bars") return this.barTapColors[col] || this.colors[col];
    return this.skinProfile.tapColors[col] || this.skinProfile.tapColor || this.colors[col];
  }

  private getOverlayFrame(
    layout: Layout,
    id: ReplayOverlayId,
    width: number,
    height: number,
  ): ReplayOverlayFrame | null {
    const placement = this.overlaySettings[id];
    if (!placement.enabled) return null;
    const x = Math.max(0, Math.min(Math.max(0, layout.w - width), placement.x * layout.w));
    const y = Math.max(0, Math.min(Math.max(0, layout.h - height), placement.y * layout.h));
    const frame = { x, y, width, height };
    this.overlayHitboxes.push({ id, ...frame });
    return frame;
  }

  private getKeypressOverlayMetrics(scale: number): KeypressOverlayMetrics {
    const keyGap = Math.round((this.keyCount >= 8 ? 4 : 6) * scale);
    const keyBoxWidth = Math.round((this.keyCount >= 8 ? 36 : 40) * scale);
    const keyBoxHeight = Math.round(38 * scale);
    const width = this.keyCount * keyBoxWidth + Math.max(0, this.keyCount - 1) * keyGap;
    return { scale, keyGap, keyBoxWidth, keyBoxHeight, width, height: keyBoxHeight };
  }

  // Accuracy travels with the progress pie as one unit like the ingame
  // cluster; enabling the standalone progress overlay detaches the pie.
  private renderAccuracyOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "accuracy");
    const fontSize = 18 * scale;
    const textWidth = this.getTextOverlayWidth(this.hudCachedAccuracy, fontSize, scale, "700");
    const height = 26 * scale;
    const pieAttached = !this.overlaySettings.progress.enabled;
    const pieRadius = fontSize * 0.54;
    const pieSpan = pieAttached ? pieRadius * 2 + 6 * scale : 0;
    const frame = this.getOverlayFrame(layout, "accuracy", pieSpan + textWidth, height);
    if (!frame) return;
    if (pieAttached) this.drawProgressPie(frame.x + pieRadius, frame.y + height / 2, pieRadius);
    this.addText(this.hudCachedAccuracy, frame.x + pieSpan, frame.y + height / 2, {
      fontSize,
      fill: "#ffffff",
      alpha: 0.85,
      fontWeight: "700",
      anchorY: 0.5,
    });
  }

  private renderPpOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "pp");
    const width = this.getTextOverlayWidth(this.hudCachedPp, 18 * scale, scale, "700");
    const height = 26 * scale;
    const frame = this.getOverlayFrame(layout, "pp", width, height);
    if (!frame) return;
    this.addText(this.hudCachedPp, frame.x, frame.y, {
      fontSize: 18 * scale,
      fill: "#ffffff",
      alpha: 0.85,
      fontWeight: "700",
    });
  }

  private renderKpsOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "kps");
    const height = 20 * scale;

    const isIdle = this.hudCachedTotalKpsValue <= 0;
    const value = isIdle ? this.hudCachedMaxKps : this.hudCachedTotalKps;
    const suffix = isIdle ? "Max" : "Kps";
    const colorValue = isIdle ? this.hudCachedMaxKpsValue : this.hudCachedTotalKpsValue;
    const label = `${value} ${suffix}`;
    const width = this.getTextOverlayWidth(label, 15 * scale, scale, "700");
    const frame = this.getOverlayFrame(layout, "kps", width, height);
    if (!frame) return;

    this.addText(label, frame.x, frame.y + height / 2, {
      fontSize: 15 * scale,
      fill: this.getKpsOverlayColor(colorValue),
      alpha: 0.98,
      fontWeight: "700",
      anchorY: 0.5,
    });
  }

  private renderKeypressOverlay(layout: Layout) {
    const metrics = this.getKeypressOverlayMetrics(this.getOverlayScale(layout, "keypresses"));
    const { scale, keyGap, keyBoxWidth, keyBoxHeight } = metrics;
    const frame = this.getOverlayFrame(layout, "keypresses", metrics.width, metrics.height);
    if (!frame) return;

    const currentState = this.currentKeyState;
    this.renderKeyInputHistory(layout, frame.x, frame.y, keyBoxWidth, keyBoxHeight, keyGap);

    for (let col = 0; col < this.keyCount; col++) {
      const x = frame.x + col * (keyBoxWidth + keyGap);
      const pressed = (currentState & (1 << col)) !== 0;
      const color = this.getSkinTapColor(col);
      const keyFill = pressed ? "#0a0a12" : "#ffffff";
      const kpsFill = pressed ? "#0a0a12" : color;
      const keyAlpha = pressed ? 0.92 : 0.78;
      const kpsAlpha = pressed ? 0.76 : 0.9;
      const keyFontSize = (keyBoxWidth <= 32 * scale ? 12 : 13) * scale;
      const kpsFontSize = (keyBoxWidth <= 36 * scale ? 8 : 9) * scale;
      this.fillRect(x, frame.y, keyBoxWidth, keyBoxHeight, "#0a0a12", 0.82);
      this.rect(x, frame.y, keyBoxWidth, keyBoxHeight, "#ffffff", 0.12, 1);
      this.fillRect(x + 1, frame.y + 1, keyBoxWidth - 2, keyBoxHeight - 2, color, pressed ? 0.95 : 0.18);
      this.addText(String(col + 1), x + keyBoxWidth / 2, frame.y + 12 * scale, {
        fontSize: keyFontSize,
        fill: keyFill,
        alpha: keyAlpha,
        fontWeight: "700",
        anchorX: 0.5,
        anchorY: 0.5,
      });
      this.addText(this.hudCachedKeyKps[col], x + keyBoxWidth / 2, frame.y + 28 * scale, {
        fontSize: kpsFontSize,
        fill: kpsFill,
        alpha: kpsAlpha,
        fontWeight: "700",
        anchorX: 0.5,
        anchorY: 0.5,
      });
    }
  }

  private renderReplayMasterOverlay(layout: Layout) {
    if (!this.overlaySettings.replayMaster.enabled) return;
    const scale = Math.min(this.getOverlayScale(layout, "replayMaster"), layout.h / 384);
    const width = 216 * scale;
    const height = 384 * scale;
    const frame = this.getOverlayFrame(layout, "replayMaster", width, height);
    if (!frame) return;
    this.replayMasterTimeline ??= buildReplayMasterTimeline(this.notes, this.noteStates, this.segments, this.modRate);
    if (!this.overlaySettings.replayMaster.transparentBackground) {
      this.fillRect(frame.x, frame.y, width, height, "#000000", 1);
    }
    drawReplayMasterTimeline(this.replayMasterTimeline, this.currentTime, this.modRate, this.keyCount, width, height,
      (x, y, w, h, color) => this.fillRect(frame.x + x, frame.y + y, w, h, color, 1),
      this.overlaySettings.replayMaster.scrollSpeed);
  }

  private renderMissOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "misses");
    const labelFontSize = 9 * scale;
    const items = [
      { hand: "left" as const, label: "L MISS", value: this.hudCachedLeftMisses, color: HAND_COLORS.left },
      { hand: "right" as const, label: "R MISS", value: this.hudCachedRightMisses, color: HAND_COLORS.right },
    ];
    // Odd keymodes tag the side that owns the middle lane, so the split the
    // counter assumes is visible instead of a right-click surprise. Both
    // boxes widen together so the pair stays symmetric.
    const thumbTag = this.keyCount % 2 === 1 ? { text: "+ THUMB", fontSize: 7.5 * scale, gap: 5 * scale } : null;
    const labelSpan = Math.max(...items.map((item) => this.measureTextWidth(item.label, labelFontSize, "700")));
    const tagWidth = thumbTag ? this.measureTextWidth(thumbTag.text, thumbTag.fontSize, "700") : 0;
    const boxWidth = Math.max(
      60 * scale,
      thumbTag ? 9 * scale + labelSpan + thumbTag.gap + tagWidth + 6 * scale : 0,
    );
    const pitch = boxWidth + 8 * scale;
    const width = boxWidth * 2 + 8 * scale;
    const height = 36 * scale;
    const frame = this.getOverlayFrame(layout, "misses", width, height);
    if (!frame) return;

    items.forEach((item, index) => {
      const x = frame.x + index * pitch;
      this.fillRect(x, frame.y, boxWidth, height, "#0a0a12", 0.78);
      this.fillRect(x, frame.y, 3 * scale, height, item.color, 1);
      this.addText(item.label, x + 9 * scale, frame.y + 5 * scale, { fontSize: labelFontSize, fill: "#ffffff", alpha: 0.58, fontWeight: "700" });
      this.addText(item.value, x + 9 * scale, frame.y + 28 * scale, { fontSize: 16 * scale, fill: "#ffffff", alpha: 0.95, fontWeight: "700", anchorY: 1 });
      if (thumbTag && item.hand === this.missThumbHand) {
        const tagX = x + 9 * scale + labelSpan + thumbTag.gap;
        const tagY = frame.y + 5 * scale + (labelFontSize - thumbTag.fontSize) * 0.5;
        this.addText(thumbTag.text, tagX, tagY, {
          fontSize: thumbTag.fontSize,
          fill: this.missThumbTagHovered ? "#ffffff" : item.color,
          alpha: this.missThumbTagHovered ? 0.95 : 0.85,
          fontWeight: "700",
        });
        // Generous hit area: the whole label row from the tag to the box edge.
        this.missThumbTagHitbox = {
          x: tagX - 3 * scale,
          y: frame.y,
          width: boxWidth - (tagX - x) + 3 * scale,
          height: 16 * scale,
        };
      }
    });
  }

  private isMissThumbTagPoint(x: number, y: number): boolean {
    const tag = this.missThumbTagHitbox;
    if (!tag || this.hideHud) return false;
    return x >= tag.x && x <= tag.x + tag.width && y >= tag.y && y <= tag.y + tag.height;
  }

  private setMissThumbTagHovered(hovered: boolean) {
    if (this.missThumbTagHovered === hovered) return;
    this.missThumbTagHovered = hovered;
    if (!this._isPlaying) this.render();
  }

  private getHandAccuracyRows() {
    return [
      {
        label: "L",
        color: HAND_COLORS.left,
        text: this.hudCachedLeftHandAccuracy,
        value: this.hudCachedLeftHandAccuracyValue,
      },
      {
        label: "R",
        color: HAND_COLORS.right,
        text: this.hudCachedRightHandAccuracy,
        value: this.hudCachedRightHandAccuracyValue,
      },
    ];
  }

  private renderHandAccuracyOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "handAccuracy");
    switch (normalizeReplayHandAccuracyStyle(this.overlaySettings.handAccuracy.style)) {
      case "plain":
        this.renderHandAccuracyPlain(layout, scale);
        return;
      case "rings":
        this.renderHandAccuracyRings(layout, scale);
        return;
      case "balance":
        this.renderHandAccuracyBalance(layout, scale);
        return;
      default:
        this.renderHandAccuracyMeters(layout, scale);
    }
  }

  // One row per hand, each number underlined by its own meter. Reads like a
  // scoreboard and stacks under the accuracy readout without fighting it.
  private renderHandAccuracyMeters(layout: Layout, scale: number) {
    const valueFontSize = 16 * scale;
    const unitFontSize = 9.5 * scale;
    const labelFontSize = 9 * scale;
    const unitGap = 1.5 * scale;
    const labelSpan = 12 * scale;
    const rowPitch = 24 * scale;
    const trackHeight = Math.max(2, 3 * scale);
    // Sized off the widest reading rather than the current one, so the box
    // (and the drag hitbox with it) holds still while the numbers move.
    const width = Math.ceil(
      labelSpan
        + this.measureTextWidth("100.00", valueFontSize, "700")
        + unitGap
        + this.measureTextWidth("%", unitFontSize, "700"),
    );
    const height = rowPitch + 20 * scale + trackHeight;
    const frame = this.getOverlayFrame(layout, "handAccuracy", width, height);
    if (!frame) return;

    this.getHandAccuracyRows().forEach((row, index) => {
      const top = frame.y + index * rowPitch;
      const baseline = top + 17 * scale;
      const trackY = top + 20 * scale;
      this.addText(row.label, frame.x, baseline, {
        fontSize: labelFontSize,
        fill: row.color,
        alpha: 0.95,
        fontWeight: "700",
        anchorY: 1,
      });
      this.addText(row.text, frame.x + labelSpan, baseline, {
        fontSize: valueFontSize,
        fill: "#ffffff",
        alpha: 0.95,
        fontWeight: "700",
        tabularNums: true,
        anchorY: 1,
      });
      this.addText(
        "%",
        frame.x + labelSpan + this.measureTextWidth(row.text, valueFontSize, "700") + unitGap,
        baseline,
        { fontSize: unitFontSize, fill: "#ffffff", alpha: 0.5, fontWeight: "700", anchorY: 1 },
      );
      this.fillRect(frame.x, trackY, width, trackHeight, "#ffffff", 0.12);
      const fillWidth = width * handAccuracyMeterFill(row.value);
      if (fillWidth > 0.5) this.fillRect(frame.x, trackY, fillWidth, trackHeight, row.color, 0.95);
    });
  }

  // No meter at all: the two numbers, and the gap spelled out once on the
  // hand that is behind. The most restrained of the four.
  private renderHandAccuracyPlain(layout: Layout, scale: number) {
    const valueFontSize = 17 * scale;
    const unitFontSize = 10 * scale;
    const labelFontSize = 9 * scale;
    const unitGap = 1.5 * scale;
    const labelSpan = 13 * scale;
    const rowPitch = 21 * scale;
    const deltaFontSize = 10 * scale;
    const valueSpan = this.measureTextWidth("100.00", valueFontSize, "700")
      + unitGap
      + this.measureTextWidth("%", unitFontSize, "700");
    const deltaX = labelSpan + valueSpan + 8 * scale;
    const width = Math.ceil(deltaX + this.measureTextWidth("-00.00", deltaFontSize, "700"));
    const height = rowPitch + 17 * scale;
    const frame = this.getOverlayFrame(layout, "handAccuracy", width, height);
    if (!frame) return;

    const rows = this.getHandAccuracyRows();
    const gap = rows[0].value - rows[1].value;
    rows.forEach((row, index) => {
      const baseline = frame.y + index * rowPitch + 17 * scale;
      this.addText(row.label, frame.x, baseline, {
        fontSize: labelFontSize,
        fill: row.color,
        alpha: 0.95,
        fontWeight: "700",
        anchorY: 1,
      });
      this.addText(row.text, frame.x + labelSpan, baseline, {
        fontSize: valueFontSize,
        fill: "#ffffff",
        alpha: 0.95,
        fontWeight: "700",
        tabularNums: true,
        anchorY: 1,
      });
      this.addText(
        "%",
        frame.x + labelSpan + this.measureTextWidth(row.text, valueFontSize, "700") + unitGap,
        baseline,
        { fontSize: unitFontSize, fill: "#ffffff", alpha: 0.5, fontWeight: "700", anchorY: 1 },
      );
      const behind = index === 0 ? gap < 0 : gap > 0;
      if (!behind || Math.abs(gap) < 0.005) return;
      this.addText(`-${Math.abs(gap).toFixed(2)}`, frame.x + deltaX, baseline, {
        fontSize: deltaFontSize,
        fill: row.color,
        alpha: 0.85,
        fontWeight: "700",
        tabularNums: true,
        anchorY: 1,
      });
    });
  }

  // Two sweeps, like the progress pie the HUD already uses, with the hand's
  // letter in the middle and its number underneath.
  private renderHandAccuracyRings(layout: Layout, scale: number) {
    const radius = 15 * scale;
    const strokeWidth = Math.max(1.6, 3 * scale);
    const cellWidth = radius * 2 + 14 * scale;
    const valueFontSize = 12 * scale;
    const unitFontSize = 8 * scale;
    const width = Math.ceil(cellWidth * 2);
    const height = Math.ceil(radius * 2 + 18 * scale);
    const frame = this.getOverlayFrame(layout, "handAccuracy", width, height);
    if (!frame) return;

    this.getHandAccuracyRows().forEach((row, index) => {
      const cx = frame.x + cellWidth * index + cellWidth / 2;
      const cy = frame.y + radius + 1 * scale;
      this.strokeCircle(cx, cy, radius, "#ffffff", 0.14, strokeWidth);
      this.strokeArc(cx, cy, radius, handAccuracyMeterFill(row.value), row.color, 0.95, strokeWidth);
      this.addText(row.label, cx, cy, {
        fontSize: 11 * scale,
        fill: row.color,
        alpha: 0.95,
        fontWeight: "700",
        anchorX: 0.5,
        anchorY: 0.5,
      });
      const valueWidth = this.measureTextWidth(row.text, valueFontSize, "700");
      const unitWidth = this.measureTextWidth("%", unitFontSize, "700");
      const textX = cx - (valueWidth + unitWidth) / 2;
      const baseline = frame.y + height;
      this.addText(row.text, textX, baseline, {
        fontSize: valueFontSize,
        fill: "#ffffff",
        alpha: 0.95,
        fontWeight: "700",
        tabularNums: true,
        anchorY: 1,
      });
      this.addText("%", textX + valueWidth, baseline, {
        fontSize: unitFontSize,
        fill: "#ffffff",
        alpha: 0.5,
        fontWeight: "700",
        anchorY: 1,
      });
    });
  }

  // One meter filling outward from a centre tick: the hand that is dropping
  // acc is the short side, so the gap reads without any subtraction.
  private renderHandAccuracyBalance(layout: Layout, scale: number) {
    const valueFontSize = 17 * scale;
    const unitFontSize = 10 * scale;
    const labelFontSize = 9 * scale;
    const unitGap = 1.5 * scale;
    const unitWidth = this.measureTextWidth("%", unitFontSize, "700");
    const blockWidth = this.measureTextWidth("100.00", valueFontSize, "700") + unitGap + unitWidth;
    const width = Math.ceil(blockWidth * 2 + 22 * scale);
    const height = 38 * scale;
    const frame = this.getOverlayFrame(layout, "handAccuracy", width, height);
    if (!frame) return;

    const right = frame.x + width;
    const baseline = frame.y + 27 * scale;
    const trackY = frame.y + 32 * scale;
    const trackHeight = Math.max(2, 3.5 * scale);
    const centerX = frame.x + width / 2;
    const centerGap = 2 * scale;
    const armWidth = width / 2 - centerGap;
    const [left, rightHand] = this.getHandAccuracyRows();

    this.addText(left.label, frame.x, frame.y, {
      fontSize: labelFontSize,
      fill: left.color,
      alpha: 0.95,
      fontWeight: "700",
    });
    this.addText(rightHand.label, right, frame.y, {
      fontSize: labelFontSize,
      fill: rightHand.color,
      alpha: 0.95,
      fontWeight: "700",
      anchorX: 1,
    });

    const valueStyle = {
      fontSize: valueFontSize,
      fill: "#ffffff",
      alpha: 0.95,
      fontWeight: "700" as const,
      tabularNums: true,
      anchorY: 1,
    };
    const unitStyle = {
      fontSize: unitFontSize,
      fill: "#ffffff",
      alpha: 0.5,
      fontWeight: "700" as const,
      anchorY: 1,
    };

    this.addText(left.text, frame.x, baseline, valueStyle);
    this.addText(
      "%",
      frame.x + this.measureTextWidth(left.text, valueFontSize, "700") + unitGap,
      baseline,
      unitStyle,
    );
    this.addText("%", right, baseline, { ...unitStyle, anchorX: 1 });
    this.addText(rightHand.text, right - unitWidth - unitGap, baseline, { ...valueStyle, anchorX: 1 });

    this.roundRect(frame.x, trackY, width, trackHeight, trackHeight / 2, "#ffffff", 0.12);
    const leftWidth = armWidth * handAccuracyMeterFill(left.value);
    if (leftWidth > 0.5) {
      this.roundRect(centerX - centerGap - leftWidth, trackY, leftWidth, trackHeight, trackHeight / 2, left.color, 0.95);
    }
    const rightWidth = armWidth * handAccuracyMeterFill(rightHand.value);
    if (rightWidth > 0.5) {
      this.roundRect(centerX + centerGap, trackY, rightWidth, trackHeight, trackHeight / 2, rightHand.color, 0.95);
    }
    this.fillRect(centerX - Math.max(0.5, scale / 2), trackY - 2 * scale, Math.max(1, scale), trackHeight + 4 * scale, "#ffffff", 0.3);
  }

  private renderJudgementOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "judgements");
    const width = 50 * scale;
    const height = 108 * scale;
    const frame = this.getOverlayFrame(layout, "judgements", width, height);
    if (!frame) return;

    [
      { label: "MAX", value: this.hudCachedJudgmentCounts[1], color: JUDGMENT_COLORS[1] },
      { label: "300", value: this.hudCachedJudgmentCounts[2], color: JUDGMENT_COLORS[2] },
      { label: "200", value: this.hudCachedJudgmentCounts[3], color: JUDGMENT_COLORS[3] },
      { label: "100", value: this.hudCachedJudgmentCounts[4], color: JUDGMENT_COLORS[4] },
      { label: "50", value: this.hudCachedJudgmentCounts[5], color: JUDGMENT_COLORS[5] },
      { label: "MISS", value: this.hudCachedJudgmentCounts[6], color: JUDGMENT_COLORS[6] },
      { label: "UR", value: this.hudCachedUr, color: "#b3f5ff" },
    ].forEach((item, index) => {
      const y = frame.y + index * 15.5 * scale;
      this.addText(item.label, frame.x, y, { fontSize: 8.5 * scale, fill: item.color, fontWeight: "700" });
      this.addText(item.value, frame.x + 44 * scale, y, {
        fontSize: 8.5 * scale,
        fill: "#ffffff",
        alpha: 0.88,
        fontWeight: "700",
        anchorX: 1,
      });
    });
  }

  private renderProgressOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "progress");
    const size = 32 * scale;
    const frame = this.getOverlayFrame(layout, "progress", size, size);
    if (!frame) return;

    const progress = this.totalDuration > 0
      ? Math.max(0, Math.min(1, this.currentTime / this.totalDuration))
      : 0;
    const cx = frame.x + size / 2;
    const cy = frame.y + size / 2;
    const radius = size / 2 - 2.5 * scale;
    const strokeWidth = Math.max(1.4, 2 * scale);

    this.circle(cx, cy, radius, "#000000", 0.28);
    this.pieWedge(cx, cy, radius, progress, "#f0f0f0", 0.64);
    this.strokeCircle(cx, cy, radius, "#f0f0f0", 0.92, strokeWidth);
    this.circle(cx, cy, Math.max(1.8, 2.6 * scale), "#f0f0f0", 0.92);
  }

  private renderOverlaySelectionAffordances(layout: Layout) {
    this.overlayCloseButtons = [];
    if (!this.shouldRenderCustomOverlays(layout) || this.hideHud) return;
    this.pruneSelectedOverlays();

    for (const box of this.overlayHitboxes) {
      if (!this.selectedOverlayIds.has(box.id)) continue;
      const pad = this.getOverlaySelectionPad();
      this.fillRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2, "#5a8fff", 0.08);
      this.rect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2, "#5a8fff", 0.9, Math.max(1, layout.w * 0.0016));
      // Close button on the outline's top-right corner: one click disables
      // the overlay, same as unticking it in the settings.
      const radius = 8;
      const cx = Math.min(layout.w - radius - 1, box.x + box.width + pad);
      const cy = Math.max(radius + 1, box.y - pad);
      this.circle(cx, cy, radius, "#14141d", 0.96);
      this.strokeCircle(cx, cy, radius, "#5a8fff", 0.9, Math.max(1, layout.w * 0.0012));
      const arm = radius * 0.38;
      this.line(cx - arm, cy - arm, cx + arm, cy + arm, "#ffffff", 0.92, 1.4);
      this.line(cx - arm, cy + arm, cx + arm, cy - arm, "#ffffff", 0.92, 1.4);
      this.overlayCloseButtons.push({ id: box.id, x: cx, y: cy, radius: radius + 4 });
    }

    const marquee = this.getSelectionRect();
    if (!marquee || marquee.width < 1 || marquee.height < 1) return;
    this.fillRect(marquee.x, marquee.y, marquee.width, marquee.height, "#5a8fff", 0.14);
    this.rect(marquee.x, marquee.y, marquee.width, marquee.height, "#5a8fff", 0.95, Math.max(1, layout.w * 0.0016));
  }

  private isMobilePortraitLayout(layout: Layout): boolean {
    const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    return coarsePointer && layout.h > layout.w;
  }

  private shouldRenderCustomOverlays(layout: Layout): boolean {
    if (this.isMobilePortraitLayout(layout)) return false;
    return this.fullscreenLayout || layout.w >= 640;
  }

  // The judgement that popped over the playfield on the last hit. Lives apart
  // from the rest of the HUD because it belongs to the play rather than to the
  // interface: bare stages (side by side) draw it without any of the chrome.
  private renderJudgementPop(layout: Layout) {
    if (this.lastJudgment <= 0) return;
    const { h, playfieldX, playfieldWidth } = layout;
    const timeSince = this.currentTime - this.lastJudgmentTime;
    const judgementDuration = REPLAY_JUDGEMENT_POP_DURATION_MS
      + REPLAY_JUDGEMENT_HOLD_DURATION_MS
      + REPLAY_JUDGEMENT_FADE_DURATION_MS;
    if (timeSince >= judgementDuration) return;

    const playfieldCenterX = playfieldX + playfieldWidth / 2;
    const fadeStart = REPLAY_JUDGEMENT_POP_DURATION_MS + REPLAY_JUDGEMENT_HOLD_DURATION_MS;
    const fadeProgress = timeSince <= fadeStart
      ? 0
      : Math.max(0, Math.min(1, (timeSince - fadeStart) / REPLAY_JUDGEMENT_FADE_DURATION_MS));
    const alpha = 1 - fadeProgress;
    const popProgress = Math.max(0, Math.min(1, timeSince / REPLAY_JUDGEMENT_POP_DURATION_MS));
    const animationScale = 0.8 + 0.2 * easeOutElastic(popProgress);
    const judgementScale = getReplayJudgementScale(this.skinSettings) / 100;
    const judgmentAsset = this.getJudgementAsset(this.lastJudgment);
    const y = this.getStagePositionY(this.stagePosition("scorePosition"), layout);
    if (judgmentAsset) {
      const size = this.getJudgementDrawSize(judgmentAsset, layout, judgementScale * animationScale);
      this.drawSkinImage(judgmentAsset, playfieldCenterX, y, size.width, size.height, 0.5, 0.5, alpha);
    } else if (this.skinSettings.judgementSet === DEFAULT_REPLAY_JUDGEMENT_SET) {
      this.addText(
        JUDGMENT_LABELS[this.lastJudgment],
        playfieldCenterX,
        y,
        {
          fontSize: Math.max(16, h * 0.035) * judgementScale * animationScale,
          fill: JUDGMENT_COLORS[this.lastJudgment],
          fontWeight: "700",
          anchorX: 0.5,
          anchorY: 0.5,
          alpha,
        },
      );
    }
  }

  private renderHUD(layout: Layout) {
    const { w, h } = layout;

    this.renderJudgementPop(layout);
    this.renderCombo(layout);
    this.renderScoreBlock(layout);
    this.renderLeaderboard(layout);
    if (this.shouldRenderCustomOverlays(layout)) {
      this.renderReplayMasterOverlay(layout);
      this.renderKeypressOverlay(layout);
      this.renderKpsOverlay(layout);
      this.renderMissOverlay(layout);
      this.renderAccuracyOverlay(layout);
      this.renderHandAccuracyOverlay(layout);
      this.renderPpOverlay(layout);
      this.renderJudgementOverlay(layout);
      this.renderProgressOverlay(layout);
    }

    this.renderHitErrorBar(layout);
    this.addText(this.hudCachedTime, 8, h - 8, { fontSize: 11, fill: "#ffffff", alpha: 0.4, anchorY: 1 });
    this.addText(`${this.playbackSpeed * this.modRate}x`, w - 8, h - 8, {
      fontSize: 11,
      fill: "#ffffff",
      alpha: 0.4,
      anchorX: 1,
      anchorY: 1,
    });
    this.renderFailOverlay(layout);
    if (this.hidePerformanceStats) return;
    this.renderFpsCounter(layout);
    if (import.meta.env.DEV && this.app && w >= 520) {
      this.addText(
        `Renderer ${formatPixiRendererType(this.app.renderer.type, this.app.renderer.name)}`,
        w - 8,
        h - 76,
        {
          fontSize: 10,
          fill: "#ffffff",
          alpha: 0.42,
          fontWeight: "700",
          anchorX: 1,
          anchorY: 1,
        },
      );
    }
  }

  // The fail moment, styled per client: stable dims the stage and stamps
  // FAILED; lazer flashes red first, then settles into the same dim. The
  // state persists past the fail point so scrubbing beyond it still reads
  // as a dead run.
  private renderFailOverlay(layout: Layout) {
    if (this.failTime == null || this.currentTime < this.failTime) return;
    const { w, h } = layout;
    const elapsed = this.currentTime - this.failTime;
    const t = Math.max(0, Math.min(1, elapsed / 700));
    const isLazer = this.ruleset.accuracyMode === "lazer";
    if (isLazer && elapsed < 260) {
      this.fillRect(0, 0, w, h, "#ff2222", 0.34 * (1 - elapsed / 260));
    }
    this.fillRect(0, 0, w, h, "#000000", (isLazer ? 0.6 : 0.55) * t);
    const centerX = layout.playfieldX + layout.playfieldWidth / 2;
    this.addText("FAILED", centerX, h * 0.42, {
      fontSize: Math.max(30, h * 0.07),
      fill: isLazer ? "#ff6666" : "#ffffff",
      alpha: 0.95 * t,
      fontWeight: "700",
      anchorX: 0.5,
      anchorY: 0.5,
    });
  }

  // The fps readout, cloned per client. Stable: the classic bottom-right
  // pills, amber "935/960fps" over a green "1.5ms" frame-time box, black bold
  // text. Lazer: plain green "1.0 ms" over "721 fps" text, no boxes.
  private renderFpsCounter(layout: Layout) {
    const { w, h } = layout;
    const fps = this.measuredFps;
    if (fps <= 0) return;
    // Slightly under the shared HUD scale: full size read as too chunky in
    // the corner next to the score block.
    const s = Math.min(this.getHudScale(layout), 1.35) * 0.85;
    const frameMs = 1000 / fps;
    const msText = `${frameMs.toFixed(1)}ms`;
    const right = w - 8;
    const bottom = h - 24;

    if (this.ruleset.accuracyMode === "lazer") {
      const color = fps >= 55 ? "#b3d944" : fps >= 30 ? "#ffcc22" : "#ff6666";
      this.addText(`${frameMs.toFixed(1)} ms`, right, bottom - 19 * s, {
        fontSize: 16 * s,
        fill: color,
        alpha: 0.95,
        fontWeight: "600",
        tabularNums: true,
        anchorX: 1,
        anchorY: 1,
      });
      this.addText(`${fps} fps`, right, bottom, {
        fontSize: 14.5 * s,
        fill: color,
        alpha: 0.9,
        fontWeight: "600",
        tabularNums: true,
        anchorX: 1,
        anchorY: 1,
      });
      return;
    }

    const target = this.getFpsTarget();
    const pillHeight = 24 * s;
    const padX = 8 * s;
    const bigText = String(fps);
    const smallText = `/${target}fps`;
    const bigWidth = this.measureTextWidth(bigText, 16 * s, "700");
    const smallWidth = this.measureTextWidth(smallText, 11.5 * s, "700");
    const fpsPillWidth = bigWidth + smallWidth + padX * 2 + 1;
    const msWidth = this.measureTextWidth(msText, 15 * s, "700");
    const msPillWidth = msWidth + padX * 2;
    const msPillY = bottom - pillHeight;
    const fpsPillY = msPillY - pillHeight - 6 * s;

    this.roundRect(right - fpsPillWidth, fpsPillY, fpsPillWidth, pillHeight, 5 * s, "#f2a127", 0.95);
    this.addText(bigText, right - fpsPillWidth + padX, fpsPillY + pillHeight / 2, {
      fontSize: 16 * s,
      fill: "#221503",
      fontWeight: "700",
      tabularNums: true,
      anchorY: 0.5,
    });
    this.addText(smallText, right - padX, fpsPillY + pillHeight / 2 + 2 * s, {
      fontSize: 11.5 * s,
      fill: "#221503",
      alpha: 0.72,
      fontWeight: "700",
      tabularNums: true,
      anchorX: 1,
      anchorY: 0.5,
    });

    this.roundRect(right - msPillWidth, msPillY, msPillWidth, pillHeight, 5 * s, fps >= 30 ? "#aad620" : "#e05555", 0.95);
    this.addText(msText, right - msPillWidth / 2, msPillY + pillHeight / 2, {
      fontSize: 15 * s,
      fill: "#17210a",
      fontWeight: "700",
      tabularNums: true,
      anchorX: 0.5,
      anchorY: 0.5,
    });
  }

  // --- osu!-style fixed HUD -------------------------------------------------
  // Both clients anchor the score in the top-right corner, so nothing sits
  // over the centered playfield. Stable formats the score zero-padded to 8
  // digits, lazer comma-separated. Fixed like the real clients, not
  // draggable; the pie + accuracy cluster lives in the draggable "accuracy"
  // overlay except on small layouts, where overlays don't render and it
  // stays pinned under the score.

  private renderScoreBlock(layout: Layout) {
    const { w, h } = layout;
    const hudScale = this.getHudScale(layout);
    const margin = Math.max(6, Math.round(w * 0.005));
    // Height-proportional already; multiplying by hudScale too would double
    // up now that the hud scale applies outside fullscreen.
    const scoreFontSize = Math.min(42, Math.max(18, h * 0.044));
    const scoreRight = w - margin;
    const scoreTop = Math.max(2, h * 0.004);
    this.drawHudNumberText(this.hudCachedScore, scoreRight, scoreTop, scoreFontSize, "right", 0.97);

    const accFontSize = scoreFontSize * 0.44;
    const accY = scoreTop + scoreFontSize * 1.12;
    let modTop = accY + accFontSize * 1.7;
    if (!this.shouldRenderCustomOverlays(layout)) {
      // Phones draw the accuracy here (no draggable overlays), and 44% of
      // an already-clamped score font lands around 8px; floor it readable.
      const mobileAccSize = Math.max(13, accFontSize);
      const accWidth = this.drawHudNumberText(this.hudCachedAccuracy, scoreRight, accY, mobileAccSize, "right", 0.92);
      // On portrait phones the corner is already cramped; the accuracy
      // number stands alone and the pie waits for landscape.
      const portrait = typeof window !== "undefined" && window.innerHeight > window.innerWidth;
      if (!portrait) {
        const pieRadius = mobileAccSize * 0.54;
        this.drawProgressPie(
          scoreRight - accWidth - pieRadius - 9 * hudScale,
          accY + mobileAccSize * 0.62,
          pieRadius,
        );
      }
      modTop = accY + mobileAccSize * 1.7;
    }
    this.renderModIcons(layout, scoreRight, modTop);
  }

  // Mod badges under the score block, drawn with the real client art: stable
  // stamps its classic selection-mod sprites, lazer its tinted shield badges.
  // Both stacks stay up for the whole play: stable's early fade-out belongs to
  // a client without a seek bar, and here it just hid the mods from anyone who
  // seeked.
  private renderModIcons(layout: Layout, rightX: number, topY: number) {
    const mods = this.modAcronyms.filter((mod) => mod && mod !== "CL");
    if (mods.length === 0) return;

    const isLazer = this.ruleset.accuracyMode === "lazer";
    const alpha = isLazer ? 0.94 : 1;
    const hudScale = this.getHudScale(layout);
    if (isLazer) this.renderLazerModBadges(mods, rightX, topY, hudScale, alpha);
    else this.renderStableModBadges(mods, rightX, topY, hudScale, alpha);
  }

  // Stable's square icons stack right-to-left with a slight overlap, the
  // rightmost on top.
  private renderStableModBadges(mods: string[], rightX: number, topY: number, hudScale: number, alpha: number) {
    const iconHeight = 42 * hudScale;
    const advance = iconHeight * 0.66;
    const centerY = topY + iconHeight / 2;
    const placed: { acronym: string; centerX: number }[] = [];
    let centerX = rightX - iconHeight / 2;
    for (let index = mods.length - 1; index >= 0; index--) {
      placed.push({ acronym: mods[index], centerX });
      centerX -= advance;
    }
    // Draw left-to-right so the overlap keeps the newer icon on top.
    placed.reverse();
    for (const icon of placed) {
      const asset = getStableModIconAsset(icon.acronym);
      if (asset) {
        const width = this.getAssetWidthForHeight(asset, iconHeight, iconHeight);
        this.drawSkinImage(asset, icon.centerX, centerY, width, iconHeight, 0.5, 0.5, alpha);
      } else {
        this.drawFallbackModPill(icon.acronym, icon.centerX, centerY, hudScale, alpha);
      }
    }
  }

  private renderLazerModBadges(mods: string[], rightX: number, topY: number, hudScale: number, alpha: number) {
    const badgeHeight = 26 * hudScale;
    const badgeWidth = badgeHeight * LAZER_MOD_BADGE_ASPECT;
    const gap = 5 * hudScale;
    const inset = 1 * hudScale;
    const centerY = topY + badgeHeight / 2;
    let x = rightX;
    for (let index = mods.length - 1; index >= 0; index--) {
      const acronym = mods[index];
      x -= badgeWidth;
      const centerX = x + badgeWidth / 2;
      const color = MOD_BADGE_TYPE_COLORS[acronym] ?? "#ff6666";
      const glyphColor = darkenModBadgeColor(color);
      this.drawSkinImage(LAZER_MOD_BADGE_SHAPE_ASSET, centerX, centerY, badgeWidth, badgeHeight, 0.5, 0.5, alpha, hexToNumber(color));
      const glyphFile = MOD_BADGE_FILE_NAMES[acronym];
      if (glyphFile) {
        this.drawSkinImage(getLazerModGlyphAsset(glyphFile), centerX, centerY, badgeWidth - 2 * inset, badgeHeight - 2 * inset, 0.5, 0.5, alpha, hexToNumber(glyphColor));
      } else {
        this.addText(acronym, centerX, centerY, {
          fontSize: 12 * hudScale,
          fill: glyphColor,
          alpha,
          fontWeight: "700",
          anchorX: 0.5,
          anchorY: 0.5,
        });
      }
      x -= gap;
    }
  }

  // For stable mods with no extracted sprite; keeps unknown acronyms visible.
  private drawFallbackModPill(acronym: string, centerX: number, centerY: number, hudScale: number, alpha: number) {
    const fontSize = 11 * hudScale;
    const height = 20 * hudScale;
    const width = this.measureTextWidth(acronym, fontSize, "700") + 14 * hudScale;
    this.roundRect(centerX - width / 2, centerY - height / 2, width, height, 5 * hudScale, MOD_BADGE_TYPE_COLORS[acronym] ?? "#9aa0b0", alpha);
    this.addText(acronym, centerX, centerY, {
      fontSize,
      fill: "#141414",
      alpha: Math.min(1, alpha + 0.05),
      fontWeight: "700",
      anchorX: 0.5,
      anchorY: 0.5,
    });
  }

  // The ingame leaderboard, stable-style: slots whose background fades out
  // to the right, name over score on the left, cyan combo bottom-right, and
  // a big ghosted rank number filling the slot. Like stable, the board
  // scrolls with the player while keeping the actual #1 pinned on top: on a
  // full board you see #1 then fight #50 first, the ranks between counting
  // down as the player climbs, overtaken slots sliding out below.
  // Overtakes burst a soft white bloom over the player
  // slot (stable) or pulse it in the accent blue (lazer). It is a draggable
  // overlay ("leaderboard") like the rest of the custom HUD.
  private renderLeaderboard(layout: Layout) {
    if (!this.shouldRenderCustomOverlays(layout)) return;
    this.renderSpectatorLabel(layout);
    if (this.leaderboardEntries.length === 0 || !this.scoreSimulator) return;

    const playerScore = this.scoreSimulator.value;
    const entries = this.leaderboardEntries;
    let rank = 0;
    while (rank < entries.length && entries[rank].score > playerScore) rank++;

    const nowWall = performance.now();
    if (this.leaderboardPrevRank != null && rank < this.leaderboardPrevRank && !this.suppressOvertakeFlash) {
      this.leaderboardFlashAt = nowWall;
    }
    this.leaderboardPrevRank = rank;
    this.suppressOvertakeFlash = false;
    if (this.leaderboardHidden) {
      this.leaderboardSlotYs.clear();
      this.leaderboardAnimTs = 0;
      return;
    }

    const scale = this.getOverlayScale(layout, "leaderboard");
    const slotWidth = 152 * scale;
    const slotHeight = 40 * scale;
    const gap = 2 * scale;
    const isLazer = this.ruleset.accuracyMode === "lazer";

    interface Row {
      key: string;
      name: string;
      score: number;
      combo: number;
      kind: ReplayLeaderboardRowKind;
      rankNumber: number;
    }
    // Like stable, other rows keep their real board ranks forever (no live
    // renumbering when the player slides past), and the player is unranked
    // until they actually overtake someone; from then on they wear the rank
    // of whoever they most recently displaced.
    const merged: Row[] = entries.map((entry, index) => ({
      key: `e${index}`,
      name: entry.name,
      score: entry.score,
      combo: entry.combo,
      kind: "other" as ReplayLeaderboardRowKind,
      rankNumber: entry.rank ?? index + 1,
    }));
    merged.splice(rank, 0, {
      key: "player",
      name: this.leaderboardPlayerName,
      score: playerScore,
      combo: this.combo,
      kind: "player",
      rankNumber: rank < entries.length ? entries[rank].rank ?? rank + 1 : 0,
    });
    // The visible stack pins the actual #1 on the first slot (stable always
    // shows the top score you're chasing; if the watched player takes it,
    // the pin naturally becomes the next best) and keeps the player on the
    // bottom slot with the next targets in between, so the shown ranks count
    // down as they climb. Near the top the pin merges into the contiguous
    // list and overtaken scores fill in below.
    const maxRows = 6;
    const pinsTop = rank >= maxRows;
    const windowBase = pinsTop ? rank - (maxRows - 2) : 0;
    const rows = pinsTop
      ? [merged[0], ...merged.slice(windowBase, rank + 1)]
      : merged.slice(0, maxRows);
    const playerRowIndex = rows.findIndex((row) => row.kind === "player");
    if (playerRowIndex > 0 && rows[playerRowIndex - 1].kind === "other") {
      rows[playerRowIndex - 1].kind = "target";
    }

    const advance = slotHeight + gap;
    const totalHeight = rows.length * advance - gap;
    const frame = this.getOverlayFrame(layout, "leaderboard", slotWidth, totalHeight);
    if (!frame) {
      this.leaderboardSlotYs.clear();
      this.leaderboardAnimTs = 0;
      return;
    }

    const freshMount = this.leaderboardSlotYs.size === 0;
    const dt = this.leaderboardAnimTs > 0 ? Math.min(120, nowWall - this.leaderboardAnimTs) : 16;
    this.leaderboardAnimTs = nowWall;
    const ease = 1 - Math.exp(-dt / 90);
    const seen = new Set<string>();
    const slotFor = (index: number): number | null => {
      if (!pinsTop) return index <= maxRows ? index : null;
      if (index === 0) return 0;
      const slot = index - windowBase + 1;
      return slot >= 1 && slot <= maxRows ? slot : null;
    };
    // Rows one slot beyond the window keep animating so overtaken scores
    // slide out through the bottom (fading on the way) instead of vanishing.
    // Entering targets spawn behind the pinned slot and slide down out of
    // it; the pin and then the player draw last to stay on top of sliders.
    let pinnedDraw: { row: Row; y: number } | null = null;
    let playerDraw: { row: Row; y: number } | null = null;
    merged.forEach((row, index) => {
      const slot = slotFor(index);
      if (slot == null) return;
      const targetY = frame.y + slot * advance;
      const currentY = this.leaderboardSlotYs.get(row.key);
      const y = currentY == null
        ? (freshMount || slot === 0 || slot >= maxRows ? targetY : targetY - advance)
        : currentY + (targetY - currentY) * ease;
      this.leaderboardSlotYs.set(row.key, y);
      seen.add(row.key);
      const overshoot = Math.max(frame.y - y, y + slotHeight - (frame.y + totalHeight));
      const slideAlpha = overshoot > 0 ? Math.max(0, 1 - overshoot / slotHeight) : 1;
      if (slideAlpha <= 0.02) return;
      if (row.kind === "player") {
        playerDraw = { row, y };
        return;
      }
      if (pinsTop && index === 0) {
        pinnedDraw = { row, y };
        return;
      }
      this.drawLeaderboardSlot(row, frame.x, y, slotWidth, slotHeight, scale, isLazer, nowWall, slideAlpha);
    });
    if (pinnedDraw != null) {
      const draw = pinnedDraw as { row: Row; y: number };
      this.drawLeaderboardSlot(draw.row, frame.x, draw.y, slotWidth, slotHeight, scale, isLazer, nowWall, 1);
    }
    if (playerDraw != null) {
      const draw = playerDraw as { row: Row; y: number };
      this.drawLeaderboardSlot(draw.row, frame.x, draw.y, slotWidth, slotHeight, scale, isLazer, nowWall, 1);
    }
    for (const key of [...this.leaderboardSlotYs.keys()]) {
      if (!seen.has(key)) this.leaderboardSlotYs.delete(key);
    }
  }

  // osu!-style spectator counter riding just above the scoreboard's slot,
  // with the names of the watchers who asked to be named listed under it.
  // It is not an overlay itself: it follows the leaderboard's position but
  // survives the board being Tab-hidden or removed outright, and is never
  // draggable or selectable.
  //
  // The block grows upward, so the counter keeps its place just above the
  // board however many names arrive. What it may never do is grow past the
  // top of the stage and come back down over the board, so the list only
  // spends room that is actually there: a short stage, or a board dragged
  // near the top, drops to however many lines fit and says how many it left
  // out. The room is what decides, not the name count.
  private renderSpectatorLabel(layout: Layout) {
    if (this.spectatorCount <= 0) return;
    const scale = this.getOverlayScale(layout, "leaderboard");
    const height = 26 * scale;
    const width = 152 * scale;
    const nameHeight = 17 * scale;
    const gap = 4 * scale;
    const names = this.spectatorNames;
    const placement = this.overlaySettings.leaderboard;
    const anchorX = Math.max(0, Math.min(Math.max(0, layout.w - width), placement.x * layout.w));
    const anchorY = Math.max(0, Math.min(Math.max(0, layout.h - height), placement.y * layout.h));

    const room = Math.max(0, Math.floor((anchorY - height - gap) / nameHeight));
    const budget = Math.min(names.length, room, MAX_SPECTATOR_NAMES_DRAWN);
    // The trailing "+N more" costs a line of its own, and is worth it only
    // when at least one name is left above it: with room for a single line
    // the counter already carries the number.
    const truncated = budget < names.length;
    const drawn = truncated ? Math.max(0, budget - 1) : budget;
    const remainder = drawn > 0 && truncated ? names.length - drawn : 0;
    const lines = drawn + (remainder > 0 ? 1 : 0);

    const y = Math.max(0, anchorY - height - lines * nameHeight - gap);
    this.addText(`Spectators (${this.spectatorCount})`, anchorX + 8 * scale, y + height / 2, {
      fontSize: 15 * scale,
      fill: "#ffffff",
      alpha: 0.95,
      fontWeight: "600",
      anchorY: 0.5,
    });
    for (let i = 0; i < drawn; i++) {
      this.addText(names[i]!, anchorX + 8 * scale, y + height + (i + 0.5) * nameHeight, {
        fontSize: 13 * scale,
        fill: "#ffffff",
        alpha: 0.8,
        fontWeight: "400",
        anchorY: 0.5,
      });
    }
    if (remainder > 0) {
      this.addText(`+${remainder} more`, anchorX + 8 * scale, y + height + (drawn + 0.5) * nameHeight, {
        fontSize: 13 * scale,
        fill: "#ffffff",
        alpha: 0.55,
        fontWeight: "400",
        anchorY: 0.5,
      });
    }
  }

  private getLeaderboardSlotGradient(color: string): FillGradient {
    let gradient = this.leaderboardSlotGradients.get(color);
    if (!gradient) {
      gradient = new FillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        textureSpace: "local",
        textureSize: 128,
        colorStops: [
          { offset: 0, color: colorWithAlpha(color, 0.92) },
          { offset: 0.7, color: colorWithAlpha(color, 0.58) },
          { offset: 1, color: colorWithAlpha(color, 0.16) },
        ],
      });
      this.leaderboardSlotGradients.set(color, gradient);
    }
    return gradient;
  }

  private drawLeaderboardSlot(
    row: { name: string; score: number; combo: number; kind: ReplayLeaderboardRowKind; rankNumber: number },
    x: number,
    y: number,
    width: number,
    height: number,
    scale: number,
    isLazer: boolean,
    nowWall: number,
    rowAlpha: number,
  ) {
    const flashElapsed = nowWall - this.leaderboardFlashAt;
    const flashDuration = isLazer ? 420 : 800;
    const flashActive = row.kind === "player" && flashElapsed >= 0 && flashElapsed < flashDuration;
    const flashStrength = flashActive ? (1 - flashElapsed / flashDuration) ** 1.4 : 0;

    if (isLazer) {
      const radius = 9 * scale;
      const background = row.kind === "player" ? "#123a52" : row.kind === "target" ? "#4a1d1d" : "#000000";
      const backgroundAlpha = row.kind === "player" ? 0.82 : row.kind === "target" ? 0.62 : 0.55;
      this.graphics.roundRect(x, y, width, height, radius).fill({ color: hexToNumber(background), alpha: backgroundAlpha * rowAlpha });
      if (row.kind === "player") {
        this.graphics.roundRect(x, y, width, height, radius).stroke({
          color: hexToNumber("#66ccff"),
          alpha: (0.55 + flashStrength * 0.45) * rowAlpha,
          width: Math.max(1.2, (1.4 + flashStrength * 1.6) * scale),
        });
      }
      if (flashActive) {
        this.graphics.roundRect(x, y, width, height, radius).fill({ color: 0x66ccff, alpha: 0.4 * flashStrength * rowAlpha });
      }
    } else {
      const background = row.kind === "player" ? "#1f4a6e" : row.kind === "target" ? "#6e1f1f" : "#0c0c12";
      this.graphics.rect(x, y, width, height).fill({ fill: this.getLeaderboardSlotGradient(background), alpha: rowAlpha });
      if (flashActive) {
        // Stable's overtake burst: the slot whites out hard while a huge
        // soft bloom explodes from its left edge, bleeding well past the
        // board; stacked layers push the core into overexposure.
        this.fillRect(x, y, width, height, "#ffffff", 0.75 * flashStrength * rowAlpha);
        const glow = this.getLeaderboardGlowAsset();
        if (glow) {
          const glowCx = x + width * 0.16;
          const glowCy = y + height / 2;
          this.drawSkinImage(glow, glowCx, glowCy, width * 3, height * 5, 0.5, 0.5, 0.95 * flashStrength * rowAlpha);
          this.drawSkinImage(glow, glowCx, glowCy, width * 1.6, height * 2.6, 0.5, 0.5, flashStrength * rowAlpha);
          this.drawSkinImage(glow, glowCx, glowCy, width * 0.9, height * 1.5, 0.5, 0.5, flashStrength * rowAlpha);
        }
      }
    }

    // Ghosted rank number filling the slot's right side, stable-style. An
    // unranked player slot (hasn't overtaken anyone yet) shows none.
    if (row.rankNumber > 0) {
      this.addText(String(row.rankNumber), x + width - 5 * scale, y + height * 0.52, {
        fontSize: height * 0.82,
        fill: "#ffffff",
        alpha: (row.kind === "player" ? 0.28 : 0.15) * rowAlpha,
        fontWeight: "700",
        tabularNums: true,
        anchorX: 1,
        anchorY: 0.5,
      });
    }

    const textAlpha = (row.kind === "other" ? 0.85 : 0.97) * rowAlpha;
    this.addText(row.name, x + 7 * scale, y + 3 * scale, {
      fontSize: 13 * scale,
      fill: "#ffffff",
      alpha: textAlpha,
      fontWeight: "700",
    });
    this.addText(row.score.toLocaleString("en-US"), x + 7 * scale, y + height - 3 * scale, {
      fontSize: 12 * scale,
      fill: "#ffffff",
      alpha: textAlpha * 0.93,
      tabularNums: true,
      anchorY: 1,
    });
    this.addText(`${row.combo.toLocaleString("en-US")}x`, x + width - 8 * scale, y + height - 3 * scale, {
      fontSize: 11.5 * scale,
      fill: isLazer ? "#66ccff" : "#7fd8f2",
      alpha: 0.95 * rowAlpha,
      tabularNums: true,
      anchorX: 1,
      anchorY: 1,
    });
  }

  // A radial white falloff rendered once to a canvas; the overtake bloom
  // stretches it into wide soft ellipses over the player slot.
  private getLeaderboardGlowAsset(): ReplaySkinImageAsset | null {
    if (this.leaderboardGlowAsset) return this.leaderboardGlowAsset;
    if (typeof document === "undefined") return null;
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.22, "rgba(255,255,255,0.98)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.55)");
    gradient.addColorStop(0.7, "rgba(255,255,255,0.18)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    const src = "internal:leaderboard-glow";
    this.skinTextureCache.set(src, Texture.from(canvas));
    this.leaderboardGlowAsset = { name: "leaderboard-glow", src };
    return this.leaderboardGlowAsset;
  }

  private drawHudNumberText(
    text: string,
    anchorX: number,
    y: number,
    fontSize: number,
    align: "right" | "center",
    alpha: number,
  ): number {
    const fontWeight = "400";
    const digitAdvance = Math.max(
      ...Array.from({ length: 10 }, (_, digit) => this.measureTextWidth(String(digit), fontSize, fontWeight)),
    );
    const chars = Array.from(text);
    const advances = chars.map((char) => (
      char >= "0" && char <= "9" ? digitAdvance : this.measureTextWidth(char, fontSize, fontWeight)
    ));
    const totalWidth = advances.reduce((sum, advance) => sum + advance, 0);
    let x = align === "right" ? anchorX - totalWidth : anchorX - totalWidth / 2;
    const shadowOffset = Math.max(1, fontSize * 0.045);
    chars.forEach((char, index) => {
      const cx = x + advances[index] / 2;
      this.addText(char, cx + shadowOffset, y + shadowOffset, {
        fontSize,
        fill: "#000000",
        alpha: alpha * 0.45,
        anchorX: 0.5,
      });
      this.addText(char, cx, y, {
        fontSize,
        fill: "#ffffff",
        alpha,
        anchorX: 0.5,
      });
      x += advances[index];
    });
    return totalWidth;
  }

  private drawProgressPie(cx: number, cy: number, radius: number) {
    const progress = this.totalDuration > 0
      ? Math.max(0, Math.min(1, this.currentTime / this.totalDuration))
      : 0;
    const strokeWidth = Math.max(1.2, radius * 0.11);
    this.circle(cx, cy, radius, "#000000", 0.28);
    this.pieWedge(cx, cy, radius, progress, "#f0f0f0", 0.64);
    this.strokeCircle(cx, cy, radius, "#f0f0f0", 0.92, strokeWidth);
    this.circle(cx, cy, Math.max(1.6, radius * 0.16), "#f0f0f0", 0.92);
  }

  // The hit error ("early/late") meter, styled after each client's bottom
  // bar: colored bands sized by the real hit windows (blue = 300, green =
  // 100, orange = 50 in stable's default palette), fading judgement ticks,
  // and a rolling-average marker.
  private renderHitErrorBar(layout: Layout) {
    const { h, playfieldX, playfieldWidth, judgmentY } = layout;
    const centerX = playfieldX + playfieldWidth / 2;
    const range = this.hitWindows.meh;
    if (!(range > 0)) return;

    const scale = Math.min(this.getHudScale(layout), 1.3);
    const receptorBottom = this.skinSettings.style === "circles" || this.skinSettings.style === "arrows"
      ? judgmentY
      : judgmentY + layout.receptorHeight + 2;
    const barY = Math.min(h - 12, receptorBottom > h - 44 ? receptorBottom + 14 : h - 26);
    const halfWidth = Math.min(playfieldWidth * 0.45, 170 * scale);
    const pxPerMs = halfWidth / range;
    const isLazer = this.ruleset.accuracyMode === "lazer";

    const colors = isLazer
      ? { inner: "#66ccff", mid: "#b3d944", outer: "#ffcc22" }
      : { inner: "#46b8e8", mid: "#85cc26", outer: "#e8a733" };
    const bandHeight = (isLazer ? 6 : 5) * scale;
    const bandRadius = isLazer ? bandHeight / 2 : 0;
    const drawBand = (halfMs: number, color: string, alpha: number) => {
      const half = Math.min(halfWidth, halfMs * pxPerMs);
      if (half <= 0) return;
      this.roundRect(centerX - half, barY - bandHeight / 2, half * 2, bandHeight, bandRadius, color, alpha);
    };
    drawBand(this.hitWindows.meh, colors.outer, 0.8);
    drawBand(this.hitWindows.ok, colors.mid, 0.85);
    drawBand(this.hitWindows.great, colors.inner, 0.9);

    // Center marker.
    this.fillRect(centerX - 1, barY - 9 * scale, 2, 18 * scale, "#ffffff", isLazer ? 0.65 : 0.9);

    const tickColorFor = (offset: number) => {
      const abs = Math.abs(offset);
      if (abs <= this.hitWindows.great) return colors.inner;
      if (abs <= this.hitWindows.ok) return colors.mid;
      return colors.outer;
    };
    const tickHeight = 14 * scale;
    this.recentHitOffsets.forEach((offset, index) => {
      const normalized = Math.max(-1, Math.min(1, offset / range));
      const x = centerX + normalized * halfWidth;
      // Ticks decay continuously with age like the clients fade theirs,
      // instead of stepping every tick one slot dimmer per new hit; the
      // extra ramp over the oldest few keeps window eviction from popping.
      const age = this.currentTime - this.recentHitTimes[index];
      const timeFade = Math.max(0, 1 - age / 4000);
      const evictionFade = Math.min(1, (index + 1) / 6);
      const alpha = 0.1 + 0.76 * timeFade * evictionFade;
      this.roundRect(x - 1, barY - tickHeight / 2, 2, tickHeight, isLazer ? 1 : 0, "#ffffff", alpha);
    });
    const last = this.recentHitOffsets[this.recentHitOffsets.length - 1];
    if (last != null) {
      const normalized = Math.max(-1, Math.min(1, last / range));
      this.roundRect(centerX + normalized * halfWidth - 1.5, barY - tickHeight / 2, 3, tickHeight, isLazer ? 1.5 : 0, tickColorFor(last), 0.95);
    }

    // Rolling-average marker: stable points a triangle down from above the
    // bar; lazer floats a dot under it. Both clients glide it toward each
    // new average (lazer eases its arrow over 400ms), so damp the displayed
    // position instead of snapping per hit.
    if (this.recentHitOffsets.length > 0) {
      const mean = this.urSum / this.recentHitOffsets.length;
      const nowWall = performance.now();
      const dt = nowWall - this.hitErrorAvgTs;
      this.hitErrorAvgTs = nowWall;
      if (this.hitErrorAvgDisplayed == null || dt > 500) {
        this.hitErrorAvgDisplayed = mean;
      } else {
        this.hitErrorAvgDisplayed += (mean - this.hitErrorAvgDisplayed) * (1 - Math.exp(-dt / 90));
      }
      const avgX = centerX + Math.max(-1, Math.min(1, this.hitErrorAvgDisplayed / range)) * halfWidth;
      if (isLazer) {
        this.circle(avgX, barY + bandHeight / 2 + 5 * scale, 2.6 * scale, "#ffffff", 0.95);
      } else {
        const size = 8 * scale;
        const tipY = barY - bandHeight / 2 - 2;
        this.graphics
          .poly([avgX, tipY, avgX - size / 2, tipY - size, avgX + size / 2, tipY - size])
          .fill({ color: 0xffffff, alpha: 0.92 });
      }
    }
  }

  private renderCombo(layout: Layout) {
    // skin.ini pushed the counter off the bottom of the stage for this
    // keymode, which is how a skin says "no combo counter": the game draws
    // none there, so neither does the stage.
    if (this.skinProfile.comboHidden) return;
    const animation = this.getComboAnimationState();
    const breakAnimation = this.getComboBreakAnimationState();
    if (!animation && !breakAnimation) return;

    const { h, playfieldX, playfieldWidth } = layout;
    const playfieldCenterX = playfieldX + playfieldWidth / 2;
    const comboY = this.getStagePositionY(this.stagePosition("comboPosition"), layout);
    const comboFont = getReplayComboFontStyle(this.skinSettings.comboFontSet);
    const fontSize = Math.max(22, h * 0.05);
    const drawCombo = (state: { value: number; scaleX: number; scaleY: number; alpha: number; color: string; tint: number }) => {
      const text = String(state.value);
      if (this.skinSettings.comboFontSet === DEFAULT_REPLAY_COMBO_FONT_SET && this.renderComboImages(text, playfieldCenterX, comboY, layout, state)) return;
      this.renderTabularComboText(text, playfieldCenterX, comboY, fontSize, comboFont, state);
    };

    if (animation) drawCombo(animation);
    if (breakAnimation) drawCombo(breakAnimation);
  }

  private renderTabularComboText(
    text: string,
    centerX: number,
    centerY: number,
    fontSize: number,
    comboFont: ReplayComboFontStyle,
    animation: { scaleX: number; scaleY: number; alpha: number; color: string },
  ) {
    const fontWeight = comboFont.weight;
    const fontStyle = comboFont.style;
    const fontFamily = comboFont.family;
    const digitAdvance = Math.max(
      ...Array.from({ length: 10 }, (_, digit) => (
        this.measureTextWidth(String(digit), fontSize, fontWeight, fontStyle, fontFamily)
      )),
    );
    const charAdvances = Array.from(text).map((char) => (
      char >= "0" && char <= "9"
        ? digitAdvance
        : Math.max(digitAdvance, this.measureTextWidth(char, fontSize, fontWeight, fontStyle, fontFamily))
    ));
    const totalWidth = charAdvances.reduce((sum, width) => sum + width, 0);
    let x = centerX - totalWidth / 2;

    Array.from(text).forEach((char, index) => {
      const advance = charAdvances[index];
      this.addComboText(char, x + advance / 2, centerY, {
        fontSize,
        fill: animation.color,
        alpha: animation.alpha * 0.85,
        fontFamily,
        fontWeight,
        fontStyle,
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: animation.scaleX,
        scaleY: animation.scaleY,
      });
      x += advance;
    });
  }

  // Pooled exactly like addText. This used to allocate a Text per digit per
  // frame and destroy it on the next one, so a visible combo counter cost a
  // glyph rasterisation plus a GPU texture upload and delete for every digit
  // of every frame - the single most expensive thing in the frame, and the
  // reason fps tracked the combo's digit count instead of the note density.
  private addComboText(
    text: string,
    x: number,
    y: number,
    options: {
      fontSize: number;
      fill: string;
      alpha: number;
      fontFamily: string;
      fontWeight: ReplayComboFontStyle["weight"];
      fontStyle?: "normal" | "italic";
      anchorX: number;
      anchorY: number;
      scaleX: number;
      scaleY: number;
    },
  ) {
    let label = this.comboTextPool[this.comboTextPoolCursor] as
      | (Text & { __sig?: string; __ax?: number; __ay?: number })
      | undefined;
    if (!label) {
      label = new Text({
        text: "",
        style: { fontFamily: options.fontFamily },
      }) as Text & { __sig?: string; __ax?: number; __ay?: number };
      this.comboTextPool.push(label);
      this.comboTextLayer.addChild(label);
    }

    this.comboTextPoolCursor++;
    if (!label.visible) label.visible = true;

    const fontStyle = options.fontStyle ?? "normal";
    const sig = `${this.textFontRevision}|${options.fontSize}|${options.fontFamily}|${options.fontWeight}|${fontStyle}|${options.fill}`;
    if (label.__sig !== sig) {
      label.style.fontFamily = options.fontFamily;
      label.style.fontSize = options.fontSize;
      label.style.fontWeight = options.fontWeight;
      label.style.fontStyle = fontStyle;
      label.style.fill = options.fill;
      label.__sig = sig;
    }
    if (label.text !== text) label.text = text;

    if (label.x !== x) label.x = x;
    if (label.y !== y) label.y = y;
    if (label.alpha !== options.alpha) label.alpha = options.alpha;
    if (label.scale.x !== options.scaleX || label.scale.y !== options.scaleY) {
      label.scale.set(options.scaleX, options.scaleY);
    }
    if (label.__ax !== options.anchorX || label.__ay !== options.anchorY) {
      label.anchor.set(options.anchorX, options.anchorY);
      label.__ax = options.anchorX;
      label.__ay = options.anchorY;
    }
  }

  private getComboAnimationState(): { value: number; scaleX: number; scaleY: number; alpha: number; color: string; tint: number } | null {
    if (this.combo <= 0) return null;
    let scaleX = 1;
    let scaleY = 1;
    let alpha = 1;
    if (this.comboAnimationKind === "hit") {
      const elapsed = this.currentTime - this.comboAnimationTime;
      if (elapsed >= 0 && elapsed < REPLAY_COMBO_POP_DURATION_MS) {
        const progress = Math.max(0, Math.min(1, elapsed / REPLAY_COMBO_POP_DURATION_MS));
        const eased = easeOutQuad(progress);
        scaleY = REPLAY_COMBO_POP_SCALE_Y - (REPLAY_COMBO_POP_SCALE_Y - 1) * eased;
        alpha = this.comboAnimationValue <= 1
          ? Math.min(1, elapsed / REPLAY_COMBO_FADE_IN_DURATION_MS)
          : 1;
      }
    }

    return {
      value: this.combo,
      scaleX,
      scaleY,
      alpha,
      color: "#ffffff",
      tint: 0xffffff,
    };
  }

  private getComboBreakAnimationState(): { value: number; scaleX: number; scaleY: number; alpha: number; color: string; tint: number } | null {
    if (this.comboAnimationKind !== "break") return null;
    const elapsed = this.currentTime - this.comboAnimationTime;
    if (elapsed < 0 || elapsed > REPLAY_COMBO_BREAK_DURATION_MS || this.comboAnimationValue <= 0) return null;
    const progress = Math.max(0, Math.min(1, elapsed / REPLAY_COMBO_BREAK_DURATION_MS));
    const scale = 1 + (REPLAY_COMBO_BREAK_SCALE - 1) * progress;
    return {
      value: this.comboAnimationValue,
      scaleX: scale,
      scaleY: scale,
      alpha: 0.8 * (1 - progress),
      color: "#ff5555",
      tint: 0xff5555,
    };
  }

  private getCurrentKeyState(): number {
    const t = this.currentTime;
    const f = this.frames;
    if (f.length === 0) return 0;
    let cursor = this.keyStateCursor;
    if (cursor >= f.length) cursor = f.length - 1;
    while (cursor + 1 < f.length && f[cursor + 1].time <= t) cursor++;
    while (cursor > 0 && f[cursor].time > t) cursor--;
    this.keyStateCursor = cursor;
    return f[cursor].keyState;
  }

  private getHealthAtTime(time: number): number {
    const frames = this.lifeBarFrames;
    if (frames.length === 0) return 1;
    if (time <= frames[0].time) return frames[0].health;

    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (frames[mid].time <= time) lo = mid;
      else hi = mid - 1;
    }

    const current = frames[lo];
    const next = frames[lo + 1];
    if (!next || next.time <= current.time) return current.health;

    const t = (time - current.time) / (next.time - current.time);
    return current.health + (next.health - current.health) * Math.max(0, Math.min(1, t));
  }

  private buildFallbackLifeBarFrames(events: ReplayJudgementEvent[]): ReplayLifeBarFrame[] {
    const frames: ReplayLifeBarFrame[] = [{ time: 0, health: 1 }];
    let health = 1;

    const deltas: Partial<Record<Judgment, number>> = {
      1: 0.010,
      2: 0.008,
      3: 0.004,
      4: 0,
      5: -0.016,
      6: -0.055,
    };

    for (const event of events) {
      if (event.judgment == null || event.judgment === 0) continue;
      health = Math.max(0, Math.min(1, health + (deltas[event.judgment] ?? 0)));
      frames.push({ time: event.time, health });
    }

    return frames;
  }

  private isColumnEffectivelyHeldAtTime(column: number, time: number, graceMs = HOLD_VISUAL_GRACE_MS): boolean {
    if (column < 0 || column >= this.keyCount) return false;
    const segments = this.segments[column];
    const startIndex = this.binarySearchSegmentEndIndex(segments, time - graceMs);
    for (let i = startIndex; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.start > time + graceMs) break;
      if (seg.start - graceMs <= time && seg.end + graceMs > time) return true;
    }
    return false;
  }

  // The chart time up to which a hold's body has been consumed at the judgment
  // line. Returns null while the hold is attached (head hit and the column is
  // still held with the tail pending) or the head outcome is pending. A missed
  // head consumes nothing, so the cut stays at the head; the caller renders the
  // remainder from the cut edge to the tail scrolling past the line.
  private getHoldConsumedCutTime(note: ManiaNote, noteState: ReplayNoteState, column: number): number | null {
    if (noteState.headTime > this.currentTime) return null;
    if (noteState.headJudgment === 6) return note.time;

    const tailTime = noteState.tailTime ?? note.endTime;
    if (tailTime <= this.currentTime) {
      // Tail already judged: a non-miss tail consumed the note whole (the
      // client despawns it at the judgement even on an early release inside
      // the window), as did holding through the judgement (too-long-hold
      // miss). Otherwise consumption stopped at the last release.
      if (noteState.tailJudgment !== 6) return note.endTime;
      if (this.isColumnEffectivelyHeldAtTime(column, tailTime, 0)) return note.endTime;
      return this.clampHoldCutTime(this.getLastReleaseAtOrBefore(column, tailTime), note);
    }

    if (this.isColumnEffectivelyHeldAtTime(column, this.currentTime)) return null;
    return this.clampHoldCutTime(this.getLastReleaseAtOrBefore(column, this.currentTime), note);
  }

  private clampHoldCutTime(releaseTime: number | null, note: ManiaNote): number {
    return Math.max(note.time, Math.min(releaseTime ?? note.time, note.endTime));
  }

  private getLastReleaseAtOrBefore(column: number, time: number): number | null {
    const segments = this.segments[column];
    const index = this.binarySearchSegmentEndIndex(segments, time);
    if (index < segments.length && segments[index].end <= time) return segments[index].end;
    return index > 0 ? segments[index - 1].end : null;
  }

  private binarySearchNoteIndex(targetTime: number): number {
    let lo = 0;
    let hi = this.notes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].time < targetTime) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private binarySearchSegmentEndIndex(segments: ReplaySegment[], targetTime: number): number {
    let lo = 0;
    let hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].end < targetTime) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private lowerBound(values: number[], target: number): number {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private upperBound(values: number[], target: number): number {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private getStagePositionY(position: number, layout: Layout): number {
    return layout.h * (this.skinSettings.upscroll ? position : MANIA_REFERENCE_HEIGHT - position) / MANIA_REFERENCE_HEIGHT;
  }

  private getVisualCenterY(anchorY: number, halfSize: number): number {
    return this.skinSettings.upscroll ? anchorY + halfSize : anchorY - halfSize;
  }

  private getHoldBodyRange(headCutoffY: number, tailEndY: number, tailTrimDelta: number): { top: number; bottom: number } | null {
    const tailY = tailEndY + (this.skinSettings.upscroll ? -tailTrimDelta : tailTrimDelta);
    if (this.skinSettings.upscroll) {
      return tailY > headCutoffY ? { top: headCutoffY, bottom: tailY } : null;
    }
    return tailY < headCutoffY ? { top: tailY, bottom: headCutoffY } : null;
  }

  private getHudScale(layout: Layout): number {
    // The inline stage is fullscreen-sized now, so the HUD scales with the
    // stage everywhere, not just in true fullscreen. Small canvases clamp to
    // 1 via layoutScale.
    return Math.min(1.45, Math.max(1, layout.layoutScale * 0.85));
  }

  private getJudgementAspectScale(asset: ReplaySkinImageAsset): number {
    const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
    const declaredWidth = asset.width && asset.width > 0 ? asset.width / scale : 0;
    const declaredHeight = asset.height && asset.height > 0 ? asset.height / scale : 0;
    const texture = this.getTexture(asset);
    const width = declaredWidth > 0 ? declaredWidth : texture.width / scale;
    const height = declaredHeight > 0 ? declaredHeight : texture.height / scale;
    if (!(width > 0) || !(height > 0)) return 1;
    const aspect = width / height;
    if (aspect <= REPLAY_JUDGEMENT_REFERENCE_ASPECT) return 1;
    return REPLAY_JUDGEMENT_REFERENCE_ASPECT / aspect;
  }

  // True while the judgements on screen are the imported skin's own art: the
  // "skin" set is selected and this keymode actually has art for it.
  private usingSkinJudgements(): boolean {
    return getReplayJudgementSetAssets(this.skinSettings.judgementSet) == null
      && Object.values(this.skinProfile.assets.judgements).some(Boolean);
  }

  private getJudgementDrawSize(asset: ReplaySkinImageAsset, layout: Layout, scale: number): { width: number; height: number } {
    const native = this.usingSkinJudgements() ? this.getStageAssetNativeSize(asset) : null;
    if (native) {
      // Imported judgement art draws at its native size in the game's
      // 768-space, the rule every other piece of skin art follows. The
      // fraction-of-canvas sizing below belongs to the built-in sets, which
      // are authored for it; putting skin art through it drew it about 1.6x
      // too big. Only absurdly wide art is reined in, at the stage's width.
      const unit = (480 / 768) * layout.layoutScale * scale;
      const width = native.width * unit;
      const maxWidth = layout.playfieldWidth * 0.9;
      const fit = width > maxWidth ? maxWidth / width : 1;
      return { width: Math.max(1, width * fit), height: Math.max(1, native.height * unit * fit) };
    }
    const rawHeight = this.getHudAssetHeight(asset, layout.h * REPLAY_JUDGEMENT_ASSET_HEIGHT_RATIO, layout);
    const clampedHeight = Math.min(layout.h * 0.085, Math.max(layout.h * 0.04, rawHeight));
    const height = clampedHeight * scale * this.getJudgementAspectScale(asset);
    return { width: this.getAssetWidthForHeight(asset, height, height * 2), height };
  }

  private getJudgementAsset(judgment: Judgment): ReplaySkinImageAsset | undefined {
    // The "skin" set means the imported skin's own art, which lives per
    // keymode. A skin without art for this keymode (4K-only skin on a 7K
    // chart) must fall back to the default built-in set instead of erasing
    // judgements entirely.
    const skinAssets = this.skinProfile.assets.judgements;
    const assets = getReplayJudgementSetAssets(this.skinSettings.judgementSet)
      ?? (this.usingSkinJudgements() ? skinAssets : getReplayJudgementSetAssets(DEFAULT_REPLAY_JUDGEMENT_SET))
      ?? skinAssets;
    switch (judgment) {
      case 1:
        return assets.hit300g;
      case 2:
        return assets.hit300;
      case 3:
        return assets.hit200;
      case 4:
        return assets.hit100;
      case 5:
        return assets.hit50;
      case 6:
        return assets.hit0;
      default:
        return undefined;
    }
  }

  private renderHoldSkinImages(
    layout: Layout,
    col: number,
    assets: ReplaySkinColumnAssets | undefined,
    colX: number,
    colWidth: number,
    top: number,
    bottom: number,
    headEndY: number,
    tailEndY: number,
    bodyAlpha: number,
    headAlpha: number,
    fadeHeight: number,
    visibilityLayout?: Layout,
  ): boolean {
    if (!assets?.lnHead && !assets?.lnBody && !assets?.lnTail) return false;

    const bodyAsset = assets.lnBody;
    const headAsset = assets.lnHead ?? assets.tap;
    const tailAsset = assets.lnTail;
    const headHeight = headAsset ? this.getNoteAssetHeight(headAsset, colWidth, layout, layout.noteHeight) : layout.noteHeight;
    // A cap that draws nothing occupies no box. Skins routinely point the tail
    // at a blank placeholder (a 1x1 or 5x4 transparent png, or the default
    // mania-note#T they never authored) because the body image already ends in
    // its own rounded cap. Sizing a box off that placeholder's aspect invents a
    // lane-width-tall cap out of one transparent pixel, and since the body's
    // cascade starts at the box's far edge, the hold grows by that much and
    // eats the gap to the next note. Zero here, and likewise with no tail asset
    // at all: the body then runs to the end line exactly, as in game.
    const tailArtTop = tailAsset ? this.lnTailArtTop(tailAsset) : null;
    const tailHeight = tailAsset && tailArtTop !== null
      ? this.getNoteAssetHeight(tailAsset, colWidth, layout, layout.noteHeight)
      : 0;
    // Stable runs the body to the MIDDLE of the head cap, not to its far
    // edge (the shared rule in longNoteGeometry). Cap art is widest at its
    // centre, so a body carried past that pokes out around a round note as a
    // nub of body colour below it. The tail end is the opposite: the cascade
    // counts from the box's far edge, because that is the origin a Percy body
    // authors its transparent lead-in against. No tail trim on this path - the
    // "cut LN tail" delta would slide that lead-in down the hold and open a
    // band of backdrop under the cap, so it stays with the built-in styles.
    const tailBoxTop = this.skinSettings.upscroll ? tailEndY : tailEndY - tailHeight;
    const bodyHeadY = this.skinSettings.upscroll ? headEndY + headHeight / 2 : headEndY - headHeight / 2;
    const bodyTailY = this.skinSettings.upscroll ? tailBoxTop + tailHeight : tailBoxTop;
    // Directional, NOT min/max: the body runs from the tail end toward the
    // head and is spent once the tail reaches the head's centre, which every
    // hold played through does in its last half-cap at the receptor. Taking
    // the absolute span flipped it there and drew the remainder on the far
    // side of the centre - under a round cap that reads as two dark corners
    // poking out below the head, growing until the tail lands. The built-in
    // styles already stop instead of flipping (getHoldBodyRange returns null).
    const bodyTop = this.skinSettings.upscroll ? bodyHeadY : bodyTailY;
    const bodyBottom = this.skinSettings.upscroll ? bodyTailY : bodyHeadY;
    // Where the body stops being DRAWN is a separate question from where its
    // cascade starts: it stops at the cap's centre, stable's rule, so the join
    // hides under the widest part of the art and a hollow cap (ArrowMania's
    // roof is two thin strokes) has nothing showing through its middle. Art
    // that sits shy of the centre gets a pixel more so it cannot leave a seam.
    // A blank cap has no box (tailHeight 0) and so nothing to clip against.
    let clipTop = bodyTop;
    let clipBottom = bodyBottom;
    if (tailHeight > 0) {
      const centreY = tailBoxTop + tailHeight / 2;
      let capEdgeY = centreY;
      // Downscroll draws the cap flipped, so the texture's top edge is the one
      // facing the body in both directions.
      if (typeof tailArtTop === "number") {
        const artEdgeY = tailBoxTop + (this.skinSettings.upscroll ? tailArtTop : 1 - tailArtTop) * tailHeight;
        capEdgeY = this.skinSettings.upscroll ? Math.max(centreY, artEdgeY + 1) : Math.min(centreY, artEdgeY - 1);
      }
      if (this.skinSettings.upscroll) clipBottom = Math.min(clipBottom, capEdgeY);
      else clipTop = Math.max(clipTop, capEdgeY);
    }

    if (bodyAsset && clipBottom > clipTop) {
      const baseAlpha = bodyAlpha * this.topFadeAlpha(Math.max(0, Math.min(bodyBottom, fadeHeight)), fadeHeight, 0.55);
      for (const full of this.lnBodyTiles(bodyAsset, colWidth, bodyTop, bodyBottom, this.skinProfile.noteBodyStyles[col] ?? 1)) {
        const tile = clipLnBodyTile(full, clipTop, clipBottom);
        if (!tile) continue;
        const tileHeight = tile.bottom - tile.top;
        if (tileHeight <= 0) continue;
        const fracSpan = tile.fracBottom - tile.fracTop;
        this.forEachVisibilitySegment(tile.top, tile.bottom, visibilityLayout, (segmentTop, segmentBottom, visibilityAlpha) => {
          // A tail-anchored tile runs its source upward on upscroll, so the
          // segment's slice of it is measured from the tile's other end.
          const nearOffset = tile.flipY ? tile.bottom - segmentBottom : segmentTop - tile.top;
          const farOffset = tile.flipY ? tile.bottom - segmentTop : segmentBottom - tile.top;
          this.drawSkinImageVerticalStrip(
            bodyAsset,
            colX + colWidth / 2,
            segmentTop,
            colWidth,
            segmentBottom - segmentTop,
            tile.fracTop + fracSpan * (nearOffset / tileHeight),
            tile.fracTop + fracSpan * (farOffset / tileHeight),
            baseAlpha * visibilityAlpha,
            tile.flipY,
          );
        });
      }
    } else if (clipBottom > clipTop) {
      // Span-checked here too: a spent body is no body, and the flat fallback
      // used to be handed a negative height for those frames.
      this.barLnBodyWithTopFade(colX + 3, clipTop, colWidth - 6, clipBottom - clipTop, this.skinSettings.lnBodyColor, bodyAlpha, fadeHeight, 0.55, visibilityLayout);
    }

    if (tailAsset && tailHeight > 0) {
      const tailTop = tailBoxTop;
      const alpha = bodyAlpha
        * this.topFadeAlpha(Math.max(0, Math.min(tailTop + tailHeight, fadeHeight)), fadeHeight, 0.55)
        * this.getHiddenAlphaForVerticalSpan(tailTop, tailTop + tailHeight, visibilityLayout);
      // Stable flips the tail texture vertically on downscroll (lazer's
      // LegacyHoldNoteTailPiece inverts the scroll direction), so tail art is
      // authored upside down; mirror it back.
      this.drawSkinImage(tailAsset, colX + colWidth / 2, tailTop, colWidth, tailHeight, 0.5, 0, alpha, 0xffffff, !this.skinSettings.upscroll);
    }

    if (headAsset) {
      const headTop = this.skinSettings.upscroll ? headEndY : headEndY - headHeight;
      const alpha = headAlpha
        * this.topFadeAlpha(Math.max(0, Math.min(headTop + headHeight, fadeHeight)), fadeHeight, 0.55)
        * (visibilityLayout ? this.getHiddenAlphaAtNoteEdge(headTop, headTop + headHeight, visibilityLayout) : 1);
      this.drawSkinImage(headAsset, colX + colWidth / 2, headTop, colWidth, headHeight, 0.5, 0, alpha);
    }

    if (!bodyAsset && !headAsset && !tailAsset && bottom > top) return false;
    return true;
  }

  // The tail cap's art top as a fraction of its texture height, starting the
  // read on first use. "pending" until it lands, so the opening frames stop
  // the body at the cap's centre rather than stalling the loop on a decode;
  // null once a finished scan proved the cap fully transparent.
  private lnTailArtTop(asset: ReplaySkinImageAsset): number | null | "pending" {
    readLnTailArtTop(asset.src);
    const value = lnTailArtTopCache.get(asset.src);
    // Not ?? - a cached null means "scanned, blank" and must pass through.
    return value === undefined ? "pending" : value;
  }

  // Stable's default NoteBodyStyle cascades the LN body instead of stretching
  // it: the art runs at its natural aspect from the tail end toward the head
  // and repeats when the hold outruns it. Percy bodies live or die by this -
  // one 4000px tall strip whose rounded cap sits behind a transparent
  // lead-in, so the hold shows a cap and reads shorter than it is. Stretched,
  // both collapse into a couple of pixels and the tail goes flat. But a skin
  // can declare otherwise: style 0 stretches one copy over the whole hold
  // (short gradient bodies are authored for exactly that, and cascading them
  // instead reads as a ladder of repeated caps), style 2 cascades from the
  // head end rather than the tail.
  private lnBodyTiles(
    asset: ReplaySkinImageAsset,
    colWidth: number,
    bodyTop: number,
    bodyBottom: number,
    bodyStyle: number,
  ): LnBodyTile[] {
    // The upscroll flip on the stretched copy keeps the art's cap end facing
    // the tail, the same orientation every cascade path below draws with.
    const stretched: LnBodyTile[] = [{ top: bodyTop, bottom: bodyBottom, fracTop: 0, fracBottom: 1, flipY: bodyStyle === 0 && this.skinSettings.upscroll }];
    if (bodyStyle === 0) return stretched;
    const span = bodyBottom - bodyTop;
    if (!(span > 0) || !(colWidth > 0)) return stretched;
    const texture = this.getTexture(asset);
    const sourceWidth = asset.width && asset.width > 0 ? asset.width : texture.width;
    const sourceHeight = asset.height && asset.height > 0 ? asset.height : texture.height;
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) return stretched;
    const tileHeight = sourceHeight * (colWidth / sourceWidth);
    if (!(tileHeight > 0)) return stretched;

    const upscroll = this.skinSettings.upscroll;
    // The cascade counts outward from its anchor end - the tail for style 1,
    // the head for style 2. When that anchor sits at the bottom of the span
    // the tiles stack upward and the art mirrors, so its top row keeps facing
    // the anchor; that is exactly the old flipY-on-upscroll rule, generalised.
    const anchorAtTop = (bodyStyle === 2) === upscroll;
    const tiles: LnBodyTile[] = [];
    // Whole-pixel edges: two half-covered rows composited one after the other
    // come to less than full opacity, which reads as a seam at every boundary.
    // Both edges round the same way, so neighbouring tiles stay flush.
    const push = (offset: number, end: number, fracTop: number, fracBottom: number) => {
      const near = Math.round(offset);
      const far = Math.round(end);
      if (far <= near) return;
      tiles.push({
        top: anchorAtTop ? bodyTop + near : bodyBottom - far,
        bottom: anchorAtTop ? bodyTop + far : bodyBottom - near,
        fracTop,
        fracBottom,
        flipY: !anchorAtTop,
      });
    };

    if (sourceHeight / sourceWidth >= LN_BODY_STRIP_ASPECT) {
      // A strip this tall is drawn to cover any hold on its own, and ours may
      // have been cropped at import to fit the GPU's texture limit. Repeating
      // it would replay the art's transparent lead-in partway up the hold,
      // which reads as an LN cut in half. Run one copy from the tail and hold
      // its last rows for whatever is left over.
      const covered = Math.min(span, tileHeight);
      push(0, covered, 0, covered / tileHeight);
      if (span - covered > 0.5) push(covered, span, Math.max(0, 1 - LN_BODY_FILLER_ROWS / sourceHeight), 1);
      return tiles.length > 0 ? tiles : stretched;
    }

    if (span > tileHeight * MAX_LN_BODY_TILES) return stretched;
    for (let offset = 0; offset < span - 0.01 && tiles.length < MAX_LN_BODY_TILES; offset += tileHeight) {
      const end = Math.min(span, offset + tileHeight);
      push(offset, end, 0, (end - offset) / tileHeight);
    }
    return tiles.length > 0 ? tiles : stretched;
  }

  private getNoteAssetHeight(asset: ReplaySkinImageAsset, columnWidth: number, layout: Layout, fallbackHeight: number): number {
    const heightScaleWidth = Math.max(1, this.skinProfile.noteHeightScale * layout.layoutScale);
    return this.getAssetHeightForWidth(asset, columnWidth, heightScaleWidth, fallbackHeight);
  }

  private getHudAssetHeight(asset: ReplaySkinImageAsset, fallbackHeight: number, layout: Layout): number {
    const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
    const assetHeight = asset.height && asset.height > 0 ? asset.height / scale : 0;
    return assetHeight > 0 ? assetHeight * (layout.h / 480) : fallbackHeight;
  }

  private getAssetHeightForWidth(asset: ReplaySkinImageAsset, targetWidth: number, heightScaleWidth: number, fallbackHeight: number): number {
    const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
    const width = asset.width && asset.width > 0 ? asset.width / scale : this.getTexture(asset).width / scale;
    const height = asset.height && asset.height > 0 ? asset.height / scale : this.getTexture(asset).height / scale;
    if (width > 0 && height > 0) return Math.max(1, height * (heightScaleWidth / width));
    return Math.max(1, fallbackHeight || targetWidth);
  }

  private getAssetWidthForHeight(asset: ReplaySkinImageAsset, targetHeight: number, fallbackWidth: number): number {
    const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
    const width = asset.width && asset.width > 0 ? asset.width / scale : this.getTexture(asset).width / scale;
    const height = asset.height && asset.height > 0 ? asset.height / scale : this.getTexture(asset).height / scale;
    if (width > 0 && height > 0) return Math.max(1, width * (targetHeight / height));
    return Math.max(1, fallbackWidth);
  }

  // Skin digits draw at their native size in the game's 768-space, times the
  // combo counter's own scale (skin.ini has no such key; lazer's HUD editor
  // writes it to MainHUDComponents.json, and shrinking the counter is one of
  // the first things players do there).
  private getComboUnitScale(layout: Layout): number {
    return (480 / 768) * layout.layoutScale * this.skinProfile.comboScale;
  }

  private getComboGlyphSize(asset: ReplaySkinImageAsset, layout: Layout): { width: number; height: number } {
    const native = this.getStageAssetNativeSize(asset);
    if (native) {
      const unit = this.getComboUnitScale(layout);
      return { width: Math.max(1, native.width * unit), height: Math.max(1, native.height * unit) };
    }
    const fallbackHeight = Math.max(22, layout.h * 0.05);
    return { width: fallbackHeight * 0.7, height: fallbackHeight };
  }

  private renderComboImages(
    text: string,
    centerX: number,
    centerY: number,
    layout: Layout,
    animation: { scaleX: number; scaleY: number; alpha: number; color: string; tint: number },
  ): boolean {
    const combo = this.skinProfile.assets.combo;
    if (!combo) return false;

    const glyphs = Array.from(text).map((char) => {
      if (char >= "0" && char <= "9") return combo.digits[Number(char)] ?? null;
      if (char.toLowerCase() === "x") return combo.x ?? null;
      return null;
    });
    if (!glyphs.every((glyph): glyph is ReplaySkinImageAsset => Boolean(glyph))) return false;

    const sizes = glyphs.map((asset) => this.getComboGlyphSize(asset, layout));
    const tabularDigitWidths = combo.digits
      .filter((asset): asset is ReplaySkinImageAsset => Boolean(asset))
      .map((asset) => this.getComboGlyphSize(asset, layout).width);
    const overlap = combo.overlap * this.getComboUnitScale(layout);
    const cellWidth = Math.max(...sizes.map((size) => size.width), ...tabularDigitWidths);
    const totalWidth = (cellWidth * sizes.length) - (overlap * Math.max(0, sizes.length - 1));
    let x = centerX - totalWidth / 2;
    glyphs.forEach((asset, index) => {
      const size = sizes[index];
      const glyphCenterX = x + cellWidth / 2;
      if (asset) this.drawSkinImage(
        asset,
        glyphCenterX,
        centerY,
        size.width * animation.scaleX,
        size.height * animation.scaleY,
        0.5,
        0.5,
        animation.alpha * 0.9,
        animation.tint,
      );
      x += cellWidth - overlap;
    });
    return true;
  }

  private getCircleDiameter(layout: Layout): number {
    const laneSizedDiameter = layout.laneWidth * 0.9;
    const minDiameter = this.barePlayfield ? 38 : 28;
    return Math.max(18, Math.min(layout.laneWidth - 4, Math.max(minDiameter, laneSizedDiameter)));
  }

  private getArrowSize(layout: Layout): number {
    const laneSized = layout.laneWidth * 0.92;
    const minSize = this.barePlayfield ? 36 : 26;
    return Math.max(20, Math.min(layout.laneWidth - 2, Math.max(minSize, laneSized)));
  }

  private arrowStroke(cx: number, cy: number, size: number, direction: ArrowDirection, color: string, alpha: number, width: number) {
    if (size <= 0 || alpha <= 0) return;
    this.graphics.path(buildArrowPath(cx, cy, size, direction)).stroke({
      color: hexToNumber(color),
      alpha,
      width,
      cap: "round",
      join: "round",
    });
  }

  private arrowShape(
    cx: number,
    cy: number,
    size: number,
    direction: ArrowDirection,
    fillColor: string,
    fillAlpha: number,
    outlineColor: string | null,
    outlineAlpha: number,
    outlineWidth: number,
  ) {
    if (size <= 0 || fillAlpha <= 0) return;
    const path = buildArrowPath(cx, cy, size, direction);
    if (outlineColor && outlineAlpha > 0 && outlineWidth > 0) {
      this.graphics.path(path).stroke({
        color: hexToNumber(outlineColor),
        alpha: outlineAlpha,
        width: outlineWidth,
        cap: "round",
        join: "round",
      });
    }
    this.graphics.path(path).fill({ color: hexToNumber(fillColor), alpha: fillAlpha });
  }

  private arrowShapeWithTopFade(
    cx: number,
    cy: number,
    size: number,
    direction: ArrowDirection,
    fillColor: string,
    fillAlpha: number,
    outlineColor: string | null,
    outlineAlpha: number,
    outlineWidth: number,
    fadeHeight: number,
    minAlpha = 0,
  ) {
    if (size <= 0 || fillAlpha <= 0) return;
    const half = size / 2;
    const faded = this.topFadeAlpha(Math.max(0, Math.min(cy + half, fadeHeight)), fadeHeight, minAlpha);
    this.arrowShape(cx, cy, size, direction, fillColor, fillAlpha * faded, outlineColor, outlineAlpha * faded, outlineWidth);
  }

  private fillRect(x: number, y: number, w: number, h: number, color: string, alpha: number) {
    if (w <= 0 || h <= 0) return;
    this.graphics.rect(x, y, w, h).fill({ color: hexToNumber(color), alpha });
  }

  private fillRectInto(g: Graphics, x: number, y: number, w: number, h: number, color: string, alpha: number) {
    if (w <= 0 || h <= 0) return;
    g.rect(x, y, w, h).fill({ color: hexToNumber(color), alpha });
  }

  private rectInto(g: Graphics, x: number, y: number, w: number, h: number, color: string, alpha: number, width: number) {
    if (w <= 0 || h <= 0) return;
    g.rect(x, y, w, h).stroke({ color: hexToNumber(color), alpha, width });
  }

  private lineInto(g: Graphics, x1: number, y1: number, x2: number, y2: number, color: string, alpha: number, width: number) {
    g.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: hexToNumber(color), alpha, width });
  }

  private lineWithTopFadeInto(
    g: Graphics,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    alpha: number,
    width: number,
    fadeHeight: number,
  ) {
    if (fadeHeight <= 0 || y1 !== 0 || x1 !== x2) {
      this.lineInto(g, x1, y1, x2, y2, color, alpha, width);
      return;
    }

    const sliceCount = 8;
    const sliceHeight = fadeHeight / sliceCount;
    for (let i = 0; i < sliceCount; i++) {
      const y = sliceHeight * i;
      this.lineInto(g, x1, y, x2, y + sliceHeight + 0.5, color, alpha * this.topFadeAlpha(y + sliceHeight, fadeHeight), width);
    }
    this.lineInto(g, x1, fadeHeight, x2, y2, color, alpha, width);
  }

  private roundRect(x: number, y: number, w: number, h: number, radius: number, color: string, alpha: number) {
    if (w <= 0 || h <= 0) return;
    this.graphics.roundRect(x, y, w, h, radius).fill({ color: hexToNumber(color), alpha });
  }

  private circle(x: number, y: number, radius: number, color: string, alpha: number) {
    if (radius <= 0 || alpha <= 0) return;
    this.graphics.circle(x, y, radius).fill({ color: hexToNumber(color), alpha });
  }

  private pieWedge(x: number, y: number, radius: number, progress: number, color: string, alpha: number) {
    if (radius <= 0 || progress <= 0 || alpha <= 0) return;
    if (progress >= 0.999) {
      this.circle(x, y, radius, color, alpha);
      return;
    }

    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + progress * Math.PI * 2;
    const steps = Math.max(4, Math.ceil(progress * 32));
    const path = new GraphicsPath().moveTo(x, y);
    for (let i = 0; i <= steps; i += 1) {
      const ratio = i / steps;
      const angle = startAngle + (endAngle - startAngle) * ratio;
      path.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    }
    path.closePath();
    this.graphics.path(path).fill({ color: hexToNumber(color), alpha });
  }

  private topFadeAlpha(y: number, fadeHeight: number, minAlpha = 0) {
    if (fadeHeight <= 0) return 1;
    const ratio = Math.min(1, Math.max(0, y / fadeHeight));
    return minAlpha + (1 - minAlpha) * ratio;
  }

  private resetHiddenCoverage() {
    this.hiddenCoverageReference = getManiaHiddenCoverageReference(this.combo);
    this.hiddenCoverageUpdatedAt = this.currentTime;
  }

  private updateHiddenCoverage() {
    // Hidden and Fade In share lazer's combo-scaled coverage; Cover is fixed.
    if (!this.hasHiddenMod && !this.hasFadeInMod) return;

    const elapsed = this.currentTime - this.hiddenCoverageUpdatedAt;
    const target = getManiaHiddenCoverageReference(this.combo);

    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 1000) {
      this.hiddenCoverageReference = target;
    } else {
      this.hiddenCoverageReference = dampManiaHiddenCoverageReference(this.hiddenCoverageReference, target, elapsed);
    }
    this.hiddenCoverageUpdatedAt = this.currentTime;
  }

  private getHiddenCoveragePx(layout: Layout): number {
    // Cover uses lazer's plain PlayfieldCoveringWrapper: the covered area is a
    // direct proportion of the playfield with no legacy hit-position scaling.
    if (this.coverMod != null) return layout.h * this.coverMod.coverage;
    return getManiaHiddenCoverageReferencePx({
      coverageReference: this.hiddenCoverageReference,
      hitPosition: this.stagePosition("hitPosition") ?? MANIA_HIT_TARGET_POSITION,
      playfieldHeight: layout.h,
      referenceHeight: MANIA_REFERENCE_HEIGHT,
    });
  }

  // Fade In covers the spawn edge (AlongScroll); Hidden covers the receptor
  // side (AgainstScroll); Cover picks a side via its direction setting.
  private coverIsAlongScroll(): boolean {
    if (this.coverMod != null) return this.coverMod.alongScroll;
    return this.hasFadeInMod;
  }

  private getHiddenAlphaAtY(y: number, layout?: Layout): number {
    if (!layout || !this.hasVisibilityMod) return 1;
    if (this.coverIsAlongScroll()) {
      const distanceFromSpawn = this.skinSettings.upscroll ? layout.h - y : y;
      const coveragePx = this.getHiddenCoveragePx(layout);
      const fadePx = Math.max(1, getManiaHiddenFadePx(layout.h));
      return Math.max(0, Math.min(1, (distanceFromSpawn - coveragePx) / fadePx));
    }
    return getManiaHiddenAlphaAtY({
      coveragePx: this.getHiddenCoveragePx(layout),
      fadePx: getManiaHiddenFadePx(layout.h),
      judgmentY: layout.judgmentY,
      upscroll: this.skinSettings.upscroll,
      y,
    });
  }

  private getHiddenAlphaAtNoteEdge(top: number, bottom: number, layout: Layout): number {
    return this.getHiddenAlphaAtY(this.skinSettings.upscroll ? top : bottom, layout);
  }

  private getHiddenAlphaForVerticalSpan(top: number, bottom: number, layout?: Layout): number {
    if (!layout || !this.hasVisibilityMod) return 1;
    return (
      this.getHiddenAlphaAtY(top, layout) +
      this.getHiddenAlphaAtY((top + bottom) / 2, layout) +
      this.getHiddenAlphaAtY(bottom, layout)
    ) / 3;
  }

  // Walks [top, bottom] as vertical runs of visibility-mod alpha, mirroring
  // lazer's per-pixel playfield cover: fully covered runs are dropped, the
  // fade band is cut into ~8px slices, and constant-alpha runs collapse into
  // one draw. Tall LN bodies fade in/out through the cover as they scroll
  // instead of popping in as a whole.
  private forEachVisibilitySegment(
    top: number,
    bottom: number,
    visibilityLayout: Layout | undefined,
    draw: (segmentTop: number, segmentBottom: number, visibilityAlpha: number) => void,
  ) {
    if (!visibilityLayout || !this.hasVisibilityMod) {
      draw(top, bottom, 1);
      return;
    }

    const start = Math.max(top, 0);
    const end = Math.min(bottom, visibilityLayout.h);
    if (end <= start) return;

    // Slices fine enough (~64 steps across the fade band) that the alpha
    // staircase stays under ~2 8-bit levels; anything coarser reads as
    // horizontal banding on wide bodies. Constant-alpha runs merge below, so
    // only the fade band pays for the granularity.
    const targetSliceHeight = Math.max(2, getManiaHiddenFadePx(visibilityLayout.h) / 64);
    const sliceCount = Math.max(1, Math.ceil((end - start) / targetSliceHeight));
    const sliceHeight = (end - start) / sliceCount;
    let runStart = start;
    let runAlpha = this.getHiddenAlphaAtY(start + sliceHeight / 2, visibilityLayout);

    for (let i = 1; i < sliceCount; i++) {
      const sliceTop = start + sliceHeight * i;
      const alpha = this.getHiddenAlphaAtY(sliceTop + sliceHeight / 2, visibilityLayout);
      if (alpha === runAlpha) continue;
      if (runAlpha > 0) draw(runStart, sliceTop, runAlpha);
      runStart = sliceTop;
      runAlpha = alpha;
    }
    if (runAlpha > 0) draw(runStart, end, runAlpha);
  }

  private roundRectWithTopFade(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    color: string,
    alpha: number,
    fadeHeight: number,
    minAlpha = 0,
    visibilityLayout?: Layout,
  ) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const useVisibility = !!visibilityLayout && this.hasVisibilityMod;
    if (!useVisibility && (fadeHeight <= 0 || y >= fadeHeight)) {
      this.roundRect(x, y, w, h, radius, color, alpha);
      return;
    }

    const bottom = y + h;
    if (bottom <= 0) return;
    const start = Math.max(y, 0);
    const sliceEnd = useVisibility && visibilityLayout ? Math.min(bottom, visibilityLayout.h) : Math.min(bottom, fadeHeight);
    if (sliceEnd <= start) return;
    const sliceCount = useVisibility ? Math.max(6, Math.ceil((sliceEnd - start) / 8)) : 6;
    const sliceHeight = (sliceEnd - start) / sliceCount;

    for (let i = 0; i < sliceCount; i++) {
      const sliceY = start + sliceHeight * i;
      const topAlpha = this.topFadeAlpha(sliceY + sliceHeight, fadeHeight, minAlpha);
      const visibilityAlpha = this.getHiddenAlphaAtY(sliceY + sliceHeight / 2, visibilityLayout);
      const sliceAlpha = alpha * topAlpha * visibilityAlpha;
      this.roundRect(x, sliceY, w, sliceHeight + 0.5, radius, color, sliceAlpha);
    }

    if (!useVisibility && bottom > fadeHeight) {
      this.roundRect(x, fadeHeight, w, bottom - fadeHeight, radius, color, alpha);
    }
  }

  private circleLnBodyWithTopFade(
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    alpha: number,
    _fadeHeight: number,
    _minAlpha = 0,
    visibilityLayout?: Layout,
  ) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const bottom = y + h;
    if (bottom <= 0) return;
    if (visibilityLayout && this.hasVisibilityMod) {
      const radius = Math.min(w / 2, h / 2);
      this.lnBodyWithVisibility(x, w, y, bottom, color, alpha, radius, radius, visibilityLayout);
      return;
    }
    this.roundRect(x, y, w, h, w / 2, color, alpha);
  }

  private arrowLnBodyWithTopFade(
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    alpha: number,
    _fadeHeight: number,
    _minAlpha = 0,
    roundedEnd: "top" | "bottom" = "top",
    visibilityLayout?: Layout,
  ) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const bottom = y + h;
    if (bottom <= 0) return;
    const radius = Math.min(w / 2, h);
    if (visibilityLayout && this.hasVisibilityMod) {
      this.lnBodyWithVisibility(
        x,
        w,
        y,
        bottom,
        color,
        alpha,
        roundedEnd === "top" ? radius : 0,
        roundedEnd === "bottom" ? radius : 0,
        visibilityLayout,
      );
      return;
    }
    if (roundedEnd === "bottom") {
      const path = new GraphicsPath()
        .moveTo(x, y)
        .lineTo(x, bottom - radius)
        .quadraticCurveTo(x, bottom, x + radius, bottom)
        .lineTo(x + w - radius, bottom)
        .quadraticCurveTo(x + w, bottom, x + w, bottom - radius)
        .lineTo(x + w, y)
        .closePath();
      this.graphics.path(path).fill({ color: hexToNumber(color), alpha });
      return;
    }

    const path = new GraphicsPath()
      .moveTo(x, bottom)
      .lineTo(x, y + radius)
      .quadraticCurveTo(x, y, x + radius, y)
      .lineTo(x + w - radius, y)
      .quadraticCurveTo(x + w, y, x + w, y + radius)
      .lineTo(x + w, bottom)
      .closePath();
    this.graphics.path(path).fill({ color: hexToNumber(color), alpha });
  }

  private barLnBodyWithTopFade(
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    alpha: number,
    fadeHeight: number,
    minAlpha = 0,
    visibilityLayout?: Layout,
  ) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const bottom = y + h;
    if (bottom <= 0) return;

    if (visibilityLayout && this.hasVisibilityMod) {
      this.forEachVisibilitySegment(y, bottom, visibilityLayout, (segmentTop, segmentBottom, visibilityAlpha) => {
        const topAlpha = this.topFadeAlpha(Math.max(0, Math.min(segmentBottom, fadeHeight)), fadeHeight, minAlpha);
        this.fillRect(x, segmentTop, w, segmentBottom - segmentTop, color, alpha * topAlpha * visibilityAlpha);
      });
      return;
    }

    if (fadeHeight <= 0 || y >= fadeHeight) {
      this.fillRect(x, y, w, h, color, alpha);
      return;
    }

    const start = Math.max(y, 0);
    const sliceEnd = Math.min(bottom, fadeHeight);
    if (sliceEnd <= start) return;
    const sliceCount = 10;
    const sliceHeight = (sliceEnd - start) / sliceCount;

    for (let i = 0; i < sliceCount; i++) {
      const sliceY = start + sliceHeight * i;
      const sliceAlpha = alpha * this.topFadeAlpha(sliceY + sliceHeight, fadeHeight, minAlpha);
      // Exact shared edges: overlapping translucent slices double-blend into
      // visible seam lines.
      this.fillRect(x, sliceY, w, sliceHeight, color, sliceAlpha);
    }

    if (bottom > fadeHeight) {
      this.fillRect(x, fadeHeight, w, bottom - fadeHeight, color, alpha);
    }
  }

  // LN body under visibility mods: the rounded caps draw as whole pieces (one
  // alpha each) so they stay round through the fade band, and the straight
  // middle fades as uniform-alpha runs. Runs share exact edges - overlapping
  // translucent slices would double-blend into visible seam lines.
  private lnBodyWithVisibility(
    x: number,
    w: number,
    top: number,
    bottom: number,
    color: string,
    alpha: number,
    topRadius: number,
    bottomRadius: number,
    visibilityLayout: Layout,
  ) {
    const h = bottom - top;
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const capTop = Math.max(0, Math.min(topRadius, h / 2));
    const capBottom = Math.max(0, Math.min(bottomRadius, h / 2));
    if (h <= capTop + capBottom + 4) {
      const spanAlpha = this.getHiddenAlphaForVerticalSpan(top, bottom, visibilityLayout);
      this.lnBodySegment(x, w, top, bottom, color, alpha * spanAlpha, capTop, capBottom);
      return;
    }

    // Caps sample their alpha at the inner seam so they blend into the
    // adjacent run with no visible step; the tip being slightly off has no
    // neighboring edge to compare against.
    if (capTop > 0) {
      const capAlpha = this.getHiddenAlphaAtY(top + capTop, visibilityLayout);
      this.lnBodySegment(x, w, top, top + capTop, color, alpha * capAlpha, capTop, 0);
    }
    if (capBottom > 0) {
      const capAlpha = this.getHiddenAlphaAtY(bottom - capBottom, visibilityLayout);
      this.lnBodySegment(x, w, bottom - capBottom, bottom, color, alpha * capAlpha, 0, capBottom);
    }
    this.forEachVisibilitySegment(top + capTop, bottom - capBottom, visibilityLayout, (segmentTop, segmentBottom, visibilityAlpha) => {
      this.lnBodySegment(x, w, segmentTop, segmentBottom, color, alpha * visibilityAlpha, 0, 0);
    });
  }

  // One vertical run of an LN body, with corners rounded only where the run
  // touches the body's real end caps.
  private lnBodySegment(
    x: number,
    w: number,
    top: number,
    bottom: number,
    color: string,
    alpha: number,
    topRadius: number,
    bottomRadius: number,
  ) {
    const h = bottom - top;
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const rTop = Math.max(0, Math.min(topRadius, h));
    const rBottom = Math.max(0, Math.min(bottomRadius, h));
    if (rTop <= 0 && rBottom <= 0) {
      this.fillRect(x, top, w, h, color, alpha);
      return;
    }

    const path = new GraphicsPath().moveTo(x + rTop, top).lineTo(x + w - rTop, top);
    if (rTop > 0) path.quadraticCurveTo(x + w, top, x + w, top + rTop);
    path.lineTo(x + w, bottom - rBottom);
    if (rBottom > 0) path.quadraticCurveTo(x + w, bottom, x + w - rBottom, bottom);
    path.lineTo(x + rBottom, bottom);
    if (rBottom > 0) path.quadraticCurveTo(x, bottom, x, bottom - rBottom);
    path.lineTo(x, top + rTop);
    if (rTop > 0) path.quadraticCurveTo(x, top, x + rTop, top);
    path.closePath();
    this.graphics.path(path).fill({ color: hexToNumber(color), alpha });
  }

  private circleWithTopFade(
    x: number,
    y: number,
    radius: number,
    color: string,
    alpha: number,
    fadeHeight: number,
    minAlpha = 0,
  ) {
    if (radius <= 0 || alpha <= 0) return;
    const fadedAlpha = alpha * this.topFadeAlpha(Math.max(0, Math.min(y + radius, fadeHeight)), fadeHeight, minAlpha);
    this.circle(x, y, radius, color, fadedAlpha);
  }

  private rect(x: number, y: number, w: number, h: number, color: string, alpha: number, width: number) {
    if (w <= 0 || h <= 0) return;
    this.graphics.rect(x, y, w, h).stroke({ color: hexToNumber(color), alpha, width });
  }

  private strokeCircle(x: number, y: number, radius: number, color: string, alpha: number, width: number) {
    if (radius <= 0 || alpha <= 0) return;
    this.graphics.circle(x, y, radius).stroke({ color: hexToNumber(color), alpha, width });
  }

  private strokeArc(x: number, y: number, radius: number, progress: number, color: string, alpha: number, width: number) {
    if (radius <= 0 || alpha <= 0 || progress <= 0) return;
    if (progress >= 0.999) {
      this.strokeCircle(x, y, radius, color, alpha, width);
      return;
    }
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + progress * Math.PI * 2;
    const steps = Math.max(4, Math.ceil(progress * 48));
    const path = new GraphicsPath();
    for (let i = 0; i <= steps; i += 1) {
      const angle = startAngle + (endAngle - startAngle) * (i / steps);
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    this.graphics.path(path).stroke({ color: hexToNumber(color), alpha, width, cap: "round" });
  }

  private strokeCircleWithTopFade(x: number, y: number, radius: number, color: string, alpha: number, width: number, fadeHeight: number, minAlpha = 0) {
    if (radius <= 0 || alpha <= 0) return;
    const fadedAlpha = alpha * this.topFadeAlpha(Math.max(0, Math.min(y + radius, fadeHeight)), fadeHeight, minAlpha);
    this.strokeCircle(x, y, radius, color, fadedAlpha, width);
  }

  private line(x1: number, y1: number, x2: number, y2: number, color: string, alpha: number, width: number) {
    this.graphics.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: hexToNumber(color), alpha, width });
  }

  private receptorBeam(x: number, y: number, w: number, h: number, color: string, intensity: number) {
    if (w <= 0 || h <= 0) return;
    this.graphics.rect(x, y, w, h).fill({
      fill: this.getReceptorBeamGradient(color),
      alpha: intensity,
    });
  }

  private addText(
    text: string,
    x: number,
    y: number,
    options: {
      fontSize: number;
      fill: string;
      alpha?: number;
      fontFamily?: string;
      fontWeight?: ReplayComboFontStyle["weight"] | "400" | "700";
      fontStyle?: "normal" | "italic";
      tabularNums?: boolean;
      anchorX?: number;
      anchorY?: number;
      scaleX?: number;
      scaleY?: number;
    },
  ) {
    let label = this.textPool[this.textPoolCursor] as
      | (Text & { __sig?: string; __ax?: number; __ay?: number })
      | undefined;
    if (!label) {
      label = new Text({
        text: "",
        style: {
          fontFamily: "Torus, sans-serif",
        },
      }) as Text & { __sig?: string; __ax?: number; __ay?: number };
      this.textPool.push(label);
      this.textLayer.addChild(label);
    }

    this.textPoolCursor++;
    if (!label.visible) label.visible = true;

    const fontFamily = options.fontFamily ?? "Torus, sans-serif";
    const fontWeight = options.fontWeight ?? "400";
    const fontStyle = options.fontStyle ?? "normal";
    const fontVariantNumeric = options.tabularNums ? "tabular-nums" : "normal";
    const sig = `${this.textFontRevision}|${options.fontSize}|${fontFamily}|${fontWeight}|${fontStyle}|${fontVariantNumeric}|${options.fill}`;
    if (label.__sig !== sig) {
      label.style.fontFamily = fontFamily;
      label.style.fontSize = options.fontSize;
      label.style.fontWeight = fontWeight;
      label.style.fontStyle = fontStyle;
      (label.style as Text["style"] & { fontVariantNumeric?: string }).fontVariantNumeric = fontVariantNumeric;
      label.style.fill = options.fill;
      label.__sig = sig;
    }
    if (label.text !== text) label.text = text;

    if (label.x !== x) label.x = x;
    if (label.y !== y) label.y = y;
    const alpha = options.alpha ?? 1;
    if (label.alpha !== alpha) label.alpha = alpha;
    const scaleX = options.scaleX ?? 1;
    const scaleY = options.scaleY ?? 1;
    if (label.scale.x !== scaleX || label.scale.y !== scaleY) label.scale.set(scaleX, scaleY);

    const ax = options.anchorX ?? 0;
    const ay = options.anchorY ?? 0;
    if (label.__ax !== ax || label.__ay !== ay) {
      label.anchor.set(ax, ay);
      label.__ax = ax;
      label.__ay = ay;
    }
  }

  private drawSkinImage(
    asset: ReplaySkinImageAsset,
    x: number,
    y: number,
    width: number,
    height: number,
    anchorX: number,
    anchorY: number,
    alpha: number,
    tint = 0xffffff,
    flipY = false,
  ) {
    if (width <= 0 || height <= 0 || alpha <= 0) return;
    const texture = this.getTexture(asset);
    if (texture === Texture.EMPTY) return;

    const pool = this.activeSkinSprites;
    let sprite = pool.sprites[pool.cursor];
    if (!sprite) {
      sprite = new Sprite(texture);
      pool.sprites.push(sprite);
      pool.layer.addChild(sprite);
    }

    pool.cursor++;
    sprite.visible = true;
    sprite.texture = texture;
    // A flipped sprite mirrors about its anchor, so the anchor swaps sides to
    // keep the drawn rect at [y, y + height].
    sprite.anchor.set(anchorX, flipY ? 1 - anchorY : anchorY);
    sprite.x = x;
    sprite.y = y;
    sprite.width = width;
    sprite.height = height;
    // Pooled sprites keep their scale sign and rotation across draws; set
    // both explicitly.
    sprite.rotation = 0;
    sprite.scale.y = (flipY ? -1 : 1) * Math.abs(sprite.scale.y);
    sprite.alpha = alpha;
    sprite.tint = tint;
  }

  // Draws a skin image rotated 90° counter-clockwise: the art's left edge
  // lands at yBottom and it extends `length` px upward, `thickness` px to the
  // right of x. fillFrac < 1 crops the art's width (the scorebar fill) so the
  // drawn strip shortens without stretching the texture.
  private drawSkinImageRotatedCcw(
    asset: ReplaySkinImageAsset,
    x: number,
    yBottom: number,
    length: number,
    thickness: number,
    alpha: number,
    fillFrac = 1,
  ) {
    if (length <= 0 || thickness <= 0 || alpha <= 0 || fillFrac <= 0) return;
    const texture = this.getTexture(asset);
    if (texture === Texture.EMPTY) return;
    const frac = Math.min(1, fillFrac);

    const pool = this.activeSkinSprites;
    const slot = pool.cursor;
    let sprite = pool.sprites[slot];
    if (!sprite) {
      sprite = new Sprite(texture);
      pool.sprites.push(sprite);
      pool.layer.addChild(sprite);
    }
    pool.cursor++;

    // Rotated atlas frames don't slice cleanly; those draw at full length.
    if (frac >= 1 || texture.rotate !== 0) {
      sprite.texture = texture;
    } else {
      let strip = pool.stripTextures[slot];
      if (!strip || strip.destroyed) {
        strip = new Texture({
          source: texture.source,
          frame: new Rectangle(0, 0, texture.source.width, texture.source.height),
          orig: new Rectangle(0, 0, texture.source.width, texture.source.height),
          dynamic: true,
        });
        pool.stripTextures[slot] = strip;
      } else if (strip.source !== texture.source) {
        strip.source = texture.source;
      }
      const baseFrame = texture.frame;
      strip.frame.x = baseFrame.x;
      strip.frame.y = baseFrame.y;
      strip.frame.width = baseFrame.width * frac;
      strip.frame.height = baseFrame.height;
      strip.orig.x = 0;
      strip.orig.y = 0;
      strip.orig.width = strip.frame.width;
      strip.orig.height = strip.frame.height;
      strip.update();
      sprite.texture = strip;
    }

    sprite.visible = true;
    sprite.anchor.set(0, 0);
    sprite.x = x;
    sprite.y = yBottom;
    sprite.width = length * frac;
    sprite.height = thickness;
    sprite.rotation = -Math.PI / 2;
    sprite.scale.y = Math.abs(sprite.scale.y);
    sprite.alpha = alpha;
    sprite.tint = 0xffffff;
  }

  // Draws only the [fracTop, fracBottom] vertical band of a skin image, so LN
  // bodies can fade per-pixel through the visibility-mod cover. The strip is a
  // pooled sub-frame texture over the already-uploaded source; no GPU uploads.
  private drawSkinImageVerticalStrip(
    asset: ReplaySkinImageAsset,
    x: number,
    y: number,
    width: number,
    height: number,
    fracTop: number,
    fracBottom: number,
    alpha: number,
    flipY = false,
  ) {
    if (width <= 0 || height <= 0 || alpha <= 0 || fracBottom <= fracTop) return;
    if (fracTop <= 0 && fracBottom >= 1) {
      this.drawSkinImage(asset, x, y, width, height, 0.5, 0, alpha, 0xffffff, flipY);
      return;
    }

    const texture = this.getTexture(asset);
    if (texture === Texture.EMPTY) return;
    // Rotated atlas frames don't slice cleanly; draw whole as a fallback.
    if (texture.rotate !== 0) {
      this.drawSkinImage(asset, x, y, width, height, 0.5, 0, alpha, 0xffffff, flipY);
      return;
    }

    const pool = this.activeSkinSprites;
    const slot = pool.cursor;
    let sprite = pool.sprites[slot];
    if (!sprite) {
      sprite = new Sprite(texture);
      pool.sprites.push(sprite);
      pool.layer.addChild(sprite);
    }
    pool.cursor++;

    let strip = pool.stripTextures[slot];
    if (!strip || strip.destroyed) {
      strip = new Texture({
        source: texture.source,
        frame: new Rectangle(0, 0, texture.source.width, texture.source.height),
        // Pixi aliases orig to the frame rectangle unless one is passed, and
        // both get mutated independently per strip draw.
        orig: new Rectangle(0, 0, texture.source.width, texture.source.height),
        dynamic: true,
      });
      pool.stripTextures[slot] = strip;
    } else if (strip.source !== texture.source) {
      strip.source = texture.source;
    }

    const baseFrame = texture.frame;
    strip.frame.x = baseFrame.x;
    strip.frame.width = baseFrame.width;
    strip.frame.y = baseFrame.y + baseFrame.height * fracTop;
    strip.frame.height = baseFrame.height * (fracBottom - fracTop);
    strip.orig.x = 0;
    strip.orig.y = 0;
    strip.orig.width = strip.frame.width;
    strip.orig.height = strip.frame.height;
    strip.update();

    sprite.visible = true;
    sprite.texture = strip;
    // A flipped sprite mirrors about its anchor, so the anchor swaps sides to
    // keep the drawn band at [y, y + height].
    sprite.anchor.set(0.5, flipY ? 1 : 0);
    sprite.x = x;
    sprite.y = y;
    sprite.width = width;
    sprite.height = height;
    // Reset any rotation left behind by another draw on this slot.
    sprite.rotation = 0;
    sprite.scale.y = (flipY ? -1 : 1) * Math.abs(sprite.scale.y);
    sprite.alpha = alpha;
    sprite.tint = 0xffffff;
  }

  private getTexture(asset: ReplaySkinImageAsset): Texture {
    const cached = this.skinTextureCache.get(asset.src);
    if (cached) return cached;

    if (Assets.cache.has(asset.src)) {
      const texture = Assets.get<Texture>(asset.src);
      this.skinTextureCache.set(asset.src, texture);
      return texture;
    }

    this.loadSkinTexture(asset.src);
    return Texture.EMPTY;
  }

  private loadSkinTexture(src: string) {
    if (this.skinTextureFailedSources.has(src) || this.skinTextureLoadPromises.has(src)) return;

    const promise = Assets.load<Texture>(src)
      .then((texture) => {
        if (!texture) return null;
        this.skinTextureCache.set(src, texture);
        return texture;
      })
      .catch(() => {
        this.skinTextureFailedSources.add(src);
        return null;
      })
      .finally(() => {
        this.skinTextureLoadPromises.delete(src);
        if (!this.destroyed) this.render();
      });

    this.skinTextureLoadPromises.set(src, promise);
  }

  private prewarmSkinTextures() {
    if (!this.app) return;
    const assets = this.skinProfile.assets;
    for (const column of assets.columns) {
      if (column.tap) this.getTexture(column.tap);
      if (column.lnHead) this.getTexture(column.lnHead);
      if (column.lnBody) this.getTexture(column.lnBody);
      if (column.lnTail) this.getTexture(column.lnTail);
      if (column.receptor) this.getTexture(column.receptor);
      if (column.receptorPressed) this.getTexture(column.receptorPressed);
    }
    for (const judgement of Object.values(assets.judgements)) {
      if (judgement) this.getTexture(judgement);
    }
    const judgementSetAssets = getReplayJudgementSetAssets(this.skinSettings.judgementSet);
    if (judgementSetAssets) {
      for (const judgement of Object.values(judgementSetAssets)) {
        if (judgement) this.getTexture(judgement);
      }
    }
    if (assets.combo) {
      for (const digit of assets.combo.digits) {
        if (digit) this.getTexture(digit);
      }
      if (assets.combo.x) this.getTexture(assets.combo.x);
    }
    const stage = assets.stage;
    for (const asset of [stage.left, stage.right, stage.bottom, stage.hint, stage.light, stage.lighting, stage.scorebarBg, stage.scorebarColour, stage.scorebarMarker]) {
      if (asset) this.getTexture(asset);
    }
  }

  private beginSkinSpriteFrame() {
    this.gameplaySkinSprites.cursor = 0;
    this.hudSkinSprites.cursor = 0;
    this.activeSkinSprites = this.gameplaySkinSprites;
  }

  private finishSkinSpriteFrame() {
    for (const pool of [this.gameplaySkinSprites, this.hudSkinSprites]) {
      for (let i = pool.cursor; i < pool.sprites.length; i++) {
        pool.sprites[i].visible = false;
      }
    }
  }

  private beginTextFrame() {
    this.textPoolCursor = 0;
    this.comboTextPoolCursor = 0;
  }

  private finishTextFrame() {
    for (let i = this.textPoolCursor; i < this.textPool.length; i++) {
      this.textPool[i].visible = false;
    }
    for (let i = this.comboTextPoolCursor; i < this.comboTextPool.length; i++) {
      this.comboTextPool[i].visible = false;
    }
  }

  private clearTextLayer() {
    const children = this.textLayer.removeChildren();
    for (const child of children) child.destroy();
    this.textPool = [];
    this.textPoolCursor = 0;
  }

  private clearComboTextLayer() {
    const children = this.comboTextLayer.removeChildren();
    for (const child of children) child.destroy();
    this.comboTextPool = [];
    this.comboTextPoolCursor = 0;
  }

  private clearSkinSprites() {
    for (const pool of [this.gameplaySkinSprites, this.hudSkinSprites]) {
      const children = pool.layer.removeChildren();
      for (const child of children) child.destroy();
      for (const strip of pool.stripTextures) {
        if (strip && !strip.destroyed) strip.destroy(false);
      }
      pool.stripTextures = [];
      pool.sprites = [];
      pool.cursor = 0;
    }
    this.activeSkinSprites = this.gameplaySkinSprites;
    this.skinTextureCache.clear();
  }

  private getReceptorBeamGradient(color: string): FillGradient {
    const cached = this.receptorBeamGradients.get(color);
    if (cached) return cached;

    const gradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      textureSpace: "local",
      textureSize: 128,
      colorStops: [
        { offset: 0, color: colorWithAlpha(color, 0) },
        { offset: 0.58, color: colorWithAlpha(color, 0.2) },
        { offset: 1, color: colorWithAlpha(color, 0.7) },
      ],
    });
    this.receptorBeamGradients.set(color, gradient);
    return gradient;
  }

  private getInputHistoryTopFadeGradient(): FillGradient {
    if (this.inputHistoryTopFadeGradient) return this.inputHistoryTopFadeGradient;

    this.inputHistoryTopFadeGradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      textureSpace: "local",
      textureSize: 128,
      colorStops: [
        { offset: 0, color: colorWithAlpha("#000000", 0.94) },
        { offset: 0.45, color: colorWithAlpha("#000000", 0.52) },
        { offset: 1, color: colorWithAlpha("#000000", 0) },
      ],
    });
    return this.inputHistoryTopFadeGradient;
  }

  private getFlashlightFadeToClearGradient(): FillGradient {
    if (this.flashlightFadeToClearGradient) return this.flashlightFadeToClearGradient;

    this.flashlightFadeToClearGradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      textureSpace: "local",
      textureSize: 128,
      colorStops: [
        { offset: 0, color: colorWithAlpha("#000000", 1) },
        { offset: 1, color: colorWithAlpha("#000000", 0) },
      ],
    });
    return this.flashlightFadeToClearGradient;
  }

  private getFlashlightFadeToDimGradient(): FillGradient {
    if (this.flashlightFadeToDimGradient) return this.flashlightFadeToDimGradient;

    this.flashlightFadeToDimGradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      textureSpace: "local",
      textureSize: 128,
      colorStops: [
        { offset: 0, color: colorWithAlpha("#000000", 0) },
        { offset: 1, color: colorWithAlpha("#000000", 1) },
      ],
    });
    return this.flashlightFadeToDimGradient;
  }

  private rebuildBackgroundSprites() {
    if (!this.app) return;

    if (this.previousBackgroundSprite) {
      this.backgroundLayer.removeChild(this.previousBackgroundSprite);
      this.previousBackgroundSprite.destroy({ texture: false, textureSource: false });
      this.previousBackgroundSprite = null;
    }

    if (this.backgroundSprite && this.previousBackgroundImage) {
      this.previousBackgroundSprite = this.backgroundSprite;
    } else if (this.backgroundSprite) {
      this.backgroundLayer.removeChild(this.backgroundSprite);
      this.backgroundSprite.destroy({ texture: false, textureSource: false });
    }

    this.backgroundSprite = this.backgroundImage
      ? new Sprite(Texture.from(this.backgroundImage))
      : null;

    if (this.previousBackgroundSprite && !this.backgroundLayer.children.includes(this.previousBackgroundSprite)) {
      this.backgroundLayer.addChild(this.previousBackgroundSprite);
    }
    if (this.backgroundSprite) this.backgroundLayer.addChild(this.backgroundSprite);
    this.positionBackgroundSprites();
  }

  private positionBackgroundSprites() {
    const layout = this.getLayout();
    for (const sprite of [this.previousBackgroundSprite, this.backgroundSprite]) {
      if (!sprite || sprite.texture.width <= 0 || sprite.texture.height <= 0) continue;
      const imgAspect = sprite.texture.width / sprite.texture.height;
      const canvasAspect = layout.w / layout.h;
      if (imgAspect > canvasAspect) {
        sprite.height = layout.h * BACKGROUND_OVERSCAN_SCALE;
        sprite.width = layout.h * imgAspect * BACKGROUND_OVERSCAN_SCALE;
        sprite.x = (layout.w - sprite.width) / 2;
        sprite.y = (layout.h - sprite.height) / 2;
      } else {
        sprite.width = layout.w * BACKGROUND_OVERSCAN_SCALE;
        sprite.height = (layout.w / imgAspect) * BACKGROUND_OVERSCAN_SCALE;
        sprite.x = (layout.w - sprite.width) / 2;
        sprite.y = (layout.h - sprite.height) / 2;
      }
    }
  }

  // Everything the HUD would be showing right now, for chrome drawn outside
  // the canvas. Reads the same accumulators the HUD does, so a stats panel
  // next to the stage can never drift from the stage itself.
  getLiveStats(): ReplayLiveStats {
    const counts = this.judgmentCounts;
    let totalJudgements = 0;
    for (let i = 1; i < counts.length; i++) totalJudgements += counts[i];
    const mean = this.totalHits > 0 ? this.totalHitOffsetSum / this.totalHits : 0;
    const variance = this.totalHits > 1
      ? Math.max(0, this.totalHitOffsetSumSq / this.totalHits - mean * mean)
      : 0;
    return {
      counts: counts.slice(),
      totalJudgements,
      accuracy: this.getAccuracy(),
      combo: this.combo,
      maxCombo: this.maxComboSoFar,
      score: this.scoreSimulator?.value ?? 0,
      pp: this.getPp(),
      maxPp: this.maxPp,
      unstableRate: Math.sqrt(variance) * 10,
      early: this.earlyHits,
      late: this.lateHits,
      meanOffsetMs: mean,
    };
  }

  getDiagnostics(): { rendererBackend: string; judgementBuildMs: number | null } {
    return {
      rendererBackend: this.app ? formatPixiRendererType(this.app.renderer.type, this.app.renderer.name) : "uninitialized",
      judgementBuildMs: this.judgementBuildMs,
    };
  }

  destroy() {
    // Route cleanup can win a race with ready(), whose cancelled continuation
    // also calls destroy. Keep teardown idempotent so the late continuation
    // cannot destroy Pixi children or shared textures twice.
    if (this.destroyed) return;
    this.destroyed = true;
    this.removeTextFontListener?.();
    this.removeTextFontListener = null;
    this.pause();
    this.resumeAfterContextRestore = false;
    this.canvas.style.visibility = "hidden";
    if (this.handleContextLost) {
      this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
      this.handleContextLost = null;
    }
    if (this.handleContextRestored) {
      this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
      this.handleContextRestored = null;
    }
    this.removeOverlayPointerHandlers();
    this.previousBackgroundImage = null;
    this.backgroundTransitionStartedAt = 0;
    this.clearStoryboardSprites();
    for (const url of this.storyboardRetainedUrls) releaseStoryboardTexture(url);
    this.storyboardRetainedUrls = [];
    this.storyboardData = null;
    this.storyboardActiveSet = null;
    // Pooled storyboard sprites are detached from the stage, so the app
    // destroy below cannot reach them.
    for (const sprite of this.storyboardSpritePool) sprite.destroy();
    this.storyboardSpritePool = [];
    const destroyApp = () => {
      if (!this.app) return;
      this.clearTextLayer();
      this.clearComboTextLayer();
      this.clearSkinSprites();
      for (const gradient of this.receptorBeamGradients.values()) gradient.destroy();
      this.receptorBeamGradients.clear();
      destroyReplayPixiApplication(this.app);
      this.app = null;
    };
    if (this.app) {
      destroyApp();
    } else {
      void this.initPromise.then(destroyApp);
    }
  }
}
