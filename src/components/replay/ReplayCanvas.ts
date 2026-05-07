import { Application, Assets, Container, FillGradient, Graphics, GraphicsPath, Matrix, Sprite, Text, Texture } from "pixi.js";
import type { ReplayFrame, ReplayLifeBarFrame } from "../../lib/types";
import type { ManiaNote, ManiaScrollVelocity } from "../../lib/beatmap-parser";
import type { Judgment, ManiaReplayHitWindows, ManiaReplayRuleset, ReplayJudgementEvent, ReplayNoteState } from "../../lib/mania-replay-judgement";
import { buildReplaySegments, calculateReplayAccuracy, getManiaReplayHitWindows, getManiaReplayRuleset, simulateManiaReplayJudgements } from "../../lib/mania-replay-judgement";
import { DEFAULT_REPLAY_OVERLAY_SETTINGS, REPLAY_OVERLAY_MAX_SCALE, REPLAY_OVERLAY_MIN_SCALE, normalizeReplayOverlaySettings } from "../../lib/replay-overlays";
import type { ReplayOverlayId, ReplayOverlaySettings } from "../../lib/replay-overlays";
import { DEFAULT_REPLAY_COMBO_FONT_SET, DEFAULT_REPLAY_JUDGEMENT_SET, DEFAULT_REPLAY_SKIN_SETTINGS, REPLAY_SKIN_DEFAULT_HIT_POSITION, getReplayComboFontStyle, getReplayJudgementSetAssets, getReplaySkinProfile, normalizeReplaySkinSettings } from "../../lib/replay-skin";
import type { ReplayComboFontStyle, ReplaySkinColumnAssets, ReplaySkinImageAsset, ReplaySkinKeymodeProfile, ReplaySkinSettings } from "../../lib/replay-skin";
import type { ReplayHitCounts } from "../../lib/replay-validation";
import { buildStableReplayComboEvents, resolveReplayJudgementEvents } from "../../lib/replay-validation";
import { formatPixiRendererType } from "./renderer-debug";

type ReplaySegment = {
  start: number;
  end: number;
};

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

const JUDGMENT_LABELS: Record<number, string> = {
  1: "MAX", 2: "300", 3: "200", 4: "100", 5: "50", 6: "MISS",
};

const HOLD_VISUAL_GRACE_MS = 60;
const BACKGROUND_FADE_DURATION_MS = 180;
const KEY_KPS_WINDOW_MS = 1000;
const REPLAY_JUDGEMENT_ASSET_HEIGHT_RATIO = 0.055;
const REPLAY_JUDGEMENT_POP_DURATION_MS = 280;
const REPLAY_JUDGEMENT_HOLD_DURATION_MS = 80;
const REPLAY_JUDGEMENT_FADE_DURATION_MS = 80;
const REPLAY_JUDGEMENT_REFERENCE_ASPECT = 256 / 72;
const MANIA_MAX_TIME_RANGE = 11485;
const MANIA_REFERENCE_HEIGHT = 768;
const MANIA_SKIN_STAGE_HEIGHT = 480;
const MANIA_DEFAULT_HIT_POSITION = (480 - 402) * 1.6;
const MANIA_HIT_TARGET_POSITION = REPLAY_SKIN_DEFAULT_HIT_POSITION;
const MANIA_BAR_NOTE_HEIGHT_RATIO = 0.22;
const BACKGROUND_OVERSCAN_SCALE = 1.02;

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

interface RendererOptions {
  backgroundImage?: HTMLImageElement;
  backgroundDim?: number;
  isConvert?: boolean;
  isLazer?: boolean;
  od?: number;
  showInputOverlay?: boolean;
  inputOverlayOnly?: boolean;
  inputOverlayColor?: string;
  inputOverlayKeyHistory?: boolean;
  mods?: string[];
  speedMultiplier?: number;
  transparentBackground?: boolean;
  hideHud?: boolean;
  showCombo?: boolean;
  initialCombo?: number;
  barePlayfield?: boolean;
  scrollVelocities?: ManiaScrollVelocity[];
  expectedCounts?: ReplayHitCounts;
  lifeBarFrames?: ReplayLifeBarFrame[];
  showHealthBar?: boolean;
  skinSettings?: ReplaySkinSettings;
  overlaySettings?: ReplayOverlaySettings;
  onOverlaySettingsChange?: (settings: ReplayOverlaySettings) => void;
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

type Hand = "left" | "right" | "center";
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

export class ManiaReplayRenderer {
  private canvas: HTMLCanvasElement;
  private app: Application | null = null;
  private graphics = new Graphics();
  private textLayer = new Container();
  private textPool: Text[] = [];
  private textPoolCursor = 0;
  private skinSpriteLayer = new Container();
  private skinSpritePool: Sprite[] = [];
  private skinSpritePoolCursor = 0;
  private skinTextureCache = new Map<string, Texture>();
  private skinTextureLoadPromises = new Map<string, Promise<Texture | null>>();
  private skinTextureFailedSources = new Set<string>();
  private backgroundLayer = new Container();
  private backgroundSprite: Sprite | null = null;
  private previousBackgroundSprite: Sprite | null = null;
  private receptorBeamGradients = new Map<string, FillGradient>();
  private inputHistoryTopFadeGradient: FillGradient | null = null;
  private initPromise: Promise<void>;
  private destroyed = false;

  private frames: ReplayFrame[];
  private notes: ManiaNote[];
  private lifeBarFrames: ReplayLifeBarFrame[];
  private keypressTimesByColumn: number[][];
  private keyCount: number;
  private currentTime = 0;
  private playbackSpeed = 1;
  private modRate = 1;
  private _isPlaying = false;
  private scrollSpeed = 20;
  private animFrameId = 0;
  private lastRenderTime = 0;
  private audioClockAnchorTime: number | null = null;
  private audioClockAnchorNow = 0;
  private fpsSampleStartedAt = 0;
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
  private transparentBackground = false;
  private hideHud = false;
  private showCombo = false;
  private initialCombo = 0;
  private barePlayfield = false;
  private showHealthBar = true;
  private skinSettings: ReplaySkinSettings = DEFAULT_REPLAY_SKIN_SETTINGS;
  private overlaySettings: ReplayOverlaySettings = DEFAULT_REPLAY_OVERLAY_SETTINGS;
  private onOverlaySettingsChange: ((settings: ReplayOverlaySettings) => void) | null = null;
  private overlayHitboxes: ReplayOverlayHitbox[] = [];
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
  private fullscreenLayout = false;

  private externalClock: (() => { time: number; stalled: boolean } | null) | null = null;
  private receptorFlashTimestamps: number[];
  private judgmentEvents: ReplayJudgementEvent[];
  private noteStates: ReplayNoteState[];
  private comboEvents: ReplayComboEvent[];

  private combo = 0;
  private maxComboSoFar = 0;
  private statsScanIndex = 0;
  private comboScanIndex = 0;
  private judgmentCounts: number[] = [0, 0, 0, 0, 0, 0, 0];
  private leftHandMisses = 0;
  private rightHandMisses = 0;
  private recentHitOffsets: number[] = [];
  private lastJudgment: Judgment = 0;
  private lastJudgmentTime = 0;

  private cachedLayout: Layout | null = null;
  private cachedColumns: { x: number; width: number }[] = [];
  private keyStateCursor = 0;
  private currentKeyState = 0;
  private urSum = 0;
  private urSumSq = 0;

  private staticGraphics = new Graphics();
  private staticDirty = true;

  private hudSnapshotTime = -Infinity;
  private hudCachedAccuracy = "100.00%";
  private hudCachedUr = "0";
  private hudCachedTime = "0:00";
  private hudCachedFps = "--";
  private hudCachedJudgmentCounts: string[] = ["0", "0", "0", "0", "0", "0", "0"];
  private hudCachedLeftMisses = "0";
  private hudCachedRightMisses = "0";
  private hudCachedKeyKps: string[] = [];
  private hudCachedTotalKps = "0";


  constructor(
    canvas: HTMLCanvasElement,
    frames: ReplayFrame[],
    keyCount: number,
    notes: ManiaNote[] = [],
    options?: RendererOptions,
  ) {
    this.canvas = canvas;
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
    this.hudCachedKeyKps = new Array(keyCount).fill("0");
    this.colors = COLUMN_COLORS[keyCount] || this.generateColors(keyCount);
    for (const c of this.colors) hexToNumber(c);

    const mods = new Set((options?.mods ?? []).filter(Boolean).map((m) => m.toUpperCase()));
    const mirror = mods.has("MR");
    const speedMultiplier = Number(options?.speedMultiplier);
    this.modRate = Number.isFinite(speedMultiplier) && speedMultiplier > 0
      ? speedMultiplier
      : mods.has("DT") || mods.has("NC")
        ? 1.5
        : mods.has("HT") || mods.has("DC")
          ? 0.75
          : 1;
    this.notes = mirror
      ? notes.map((n) => ({ ...n, column: keyCount - 1 - n.column }))
      : [...notes];
    this.ruleset = getManiaReplayRuleset(options?.isLazer ?? false, [...mods], options?.isConvert ?? false, this.modRate);

    this.backgroundImage = options?.backgroundImage ?? null;
    this.backgroundDim = options?.backgroundDim ?? 80;
    this.od = options?.od ?? 8;
    this.showInputOverlay = options?.showInputOverlay ?? false;
    this.inputOverlayOnly = options?.inputOverlayOnly ?? false;
    this.inputOverlayColor = options?.inputOverlayColor ?? "#a855f7";
    this.inputOverlayKeyHistory = options?.inputOverlayKeyHistory ?? false;
    this.transparentBackground = options?.transparentBackground ?? false;
    this.hideHud = options?.hideHud ?? false;
    this.showCombo = options?.showCombo ?? false;
    this.initialCombo = Math.max(0, Math.floor(options?.initialCombo ?? 0));
    this.combo = this.initialCombo;
    this.maxComboSoFar = this.combo;
    this.barePlayfield = options?.barePlayfield ?? false;
    this.showHealthBar = options?.showHealthBar ?? true;
    this.skinSettings = normalizeReplaySkinSettings(options?.skinSettings);
    this.overlaySettings = normalizeReplayOverlaySettings(options?.overlaySettings);
    this.onOverlaySettingsChange = options?.onOverlaySettingsChange ?? null;
    this.updateSkinCache();
    this.scrollVelocities = options?.scrollVelocities ?? [];
    this.prepareScrollVelocities();
    this.receptorFlashTimestamps = new Array(keyCount).fill(0);
    this.hitWindows = getManiaReplayHitWindows(this.od, this.ruleset);

    const frameDuration = frames.length > 0 ? frames[frames.length - 1].time : 0;
    const noteDuration = notes.length > 0 ? Math.max(...notes.map((n) => n.endTime)) : 0;
    const replayTailGrace = this.hitWindows.miss * 1.5;
    this.totalDuration = Math.max(frameDuration, noteDuration + replayTailGrace);

    this.maxHoldDuration = 0;
    for (const n of notes) {
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
        legacyReplayFrameRounding: options?.expectedCounts != null,
      },
    );
    const rawStableComboEvents = this.ruleset.accuracyMode === "stable"
      ? buildStableReplayComboEvents(this.notes, simulated.noteStates)
      : null;
    this.judgmentEvents = options?.expectedCounts
      ? resolveReplayJudgementEvents(simulated.events, options.expectedCounts, {
          allowLegacyScoreReconciliation: false,
          comboBreakTimes: rawStableComboEvents
            ?.filter((event) => event.kind === "break")
            .map((event) => event.time),
          lifeBarFrames: this.lifeBarFrames,
        }).events
      : simulated.events;
    if (this.lifeBarFrames.length === 0) {
      this.lifeBarFrames = this.buildFallbackLifeBarFrames(this.judgmentEvents);
    }
    this.noteStates = simulated.noteStates;
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

    this.measureCanvas();
    this.initPromise = this.initPixi();
    this.installOverlayPointerHandlers();
  }

  private async initPixi() {
    const app = new Application();
    await app.init({
      canvas: this.canvas,
      width: Math.max(1, this.cssWidth),
      height: Math.max(1, this.cssHeight),
      resolution: this.dpr,
      autoDensity: true,
      autoStart: false,
      antialias: true,
      backgroundAlpha: 0,
      preference: ["webgl", "canvas"],
    });

    if (this.destroyed) {
      app.destroy({ removeView: false }, { children: true });
      return;
    }

    this.app = app;
    app.stage.addChild(this.backgroundLayer);
    app.stage.addChild(this.staticGraphics);
    app.stage.addChild(this.graphics);
    app.stage.addChild(this.skinSpriteLayer);
    app.stage.addChild(this.textLayer);
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

  private generateColors(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `#${Math.floor(0xffffff * (0.45 + 0.55 * Math.sin((i / n) * Math.PI))).toString(16).padStart(6, "0")}`);
  }

  private recomputeStatsUpTo(time: number) {
    this.statsScanIndex = 0;
    this.comboScanIndex = 0;
    this.combo = this.initialCombo;
    this.maxComboSoFar = this.combo;
    this.judgmentCounts = [0, 0, 0, 0, 0, 0, 0];
    this.leftHandMisses = 0;
    this.rightHandMisses = 0;
    this.recentHitOffsets = [];
    this.urSum = 0;
    this.urSumSq = 0;
    this.lastJudgment = 0;
    this.lastJudgmentTime = 0;
    this.keyStateCursor = 0;
    this.advanceStats(time);
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

      if (event.judgment > 0) this.judgmentCounts[event.judgment]++;

      if (event.judgment <= 5) {
        const offset = event.offsetMs;
        this.recentHitOffsets.push(offset);
        this.urSum += offset;
        this.urSumSq += offset * offset;
        if (this.recentHitOffsets.length > 40) {
          const removed = this.recentHitOffsets.shift()!;
          this.urSum -= removed;
          this.urSumSq -= removed * removed;
        }
      } else {
        const hand = this.getHandForColumn(event.column);
        if (hand === "left") this.leftHandMisses++;
        if (hand === "right") this.rightHandMisses++;
      }

      this.lastJudgment = event.judgment;
      this.lastJudgmentTime = event.time;
      this.statsScanIndex++;
    }

    while (this.comboScanIndex < this.comboEvents.length) {
      const event = this.comboEvents[this.comboScanIndex];
      if (event.time > time) break;

      if (event.kind === "break") {
        this.combo = 0;
      } else {
        this.combo++;
        this.maxComboSoFar = Math.max(this.maxComboSoFar, this.combo);
      }

      this.comboScanIndex++;
    }
  }

  private getAccuracy(): number {
    return calculateReplayAccuracy(this.judgmentCounts, this.ruleset.accuracyMode);
  }

  private updateHudSnapshotIfNeeded() {
    const elapsed = performance.now() - this.hudSnapshotTime;
    if (elapsed < 50 && Number.isFinite(this.hudSnapshotTime)) return;
    this.hudSnapshotTime = performance.now();

    this.hudCachedAccuracy = `${this.getAccuracy().toFixed(2)}%`;
    this.hudCachedUr = String(Math.round(this.getUr()));
    const wallTime = this.currentTime / this.modRate;
    const mins = Math.floor(wallTime / 60000);
    const secs = String(Math.floor((wallTime % 60000) / 1000)).padStart(2, "0");
    this.hudCachedTime = `${mins}:${secs}`;
    this.hudCachedFps = this.measuredFps > 0 ? String(this.measuredFps) : "--";
    for (let i = 1; i < this.judgmentCounts.length; i++) {
      const v = String(this.judgmentCounts[i]);
      if (this.hudCachedJudgmentCounts[i] !== v) this.hudCachedJudgmentCounts[i] = v;
    }
    this.hudCachedLeftMisses = String(this.leftHandMisses);
    this.hudCachedRightMisses = String(this.rightHandMisses);
    let totalKps = 0;
    for (let col = 0; col < this.keyCount; col++) {
      const keyKps = this.getKeyKps(col, this.currentTime);
      totalKps += keyKps;
      const v = this.formatKeyKps(keyKps);
      if (this.hudCachedKeyKps[col] !== v) this.hudCachedKeyKps[col] = v;
    }
    this.hudCachedTotalKps = this.formatKeyKps(totalKps);
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
  }

  private getHandForColumn(column: number): Hand {
    if (column < 0 || column >= this.keyCount) return "center";
    const leftCount = Math.floor(this.keyCount / 2);
    const rightStart = leftCount;
    if (column < leftCount) return "left";
    if (column >= rightStart) return "right";
    return "center";
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
    const windowStart = Math.max(0, time - KEY_KPS_WINDOW_MS);
    const start = this.lowerBound(presses, windowStart);
    const end = this.upperBound(presses, time);
    return Math.max(0, end - start) * (1000 / KEY_KPS_WINDOW_MS);
  }

  private formatKeyKps(kps: number): string {
    return String(Math.round(kps));
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
    this.scrollVelocityMinMultiplier = Math.min(1, ...this.scrollVelocityMultipliers);

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
    const dprCap = coarsePointer ? 1.5 : 2;
    this.dpr = Math.min(window.devicePixelRatio || 1, dprCap);
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
    const targetLayoutScale = h / MANIA_SKIN_STAGE_HEIGHT;
    const maxPlayfieldWidth = Math.min(
      w * (this.barePlayfield ? 0.82 : 0.72),
      desiredPlayfieldWidth * targetLayoutScale,
    );
    const layoutScale = desiredPlayfieldWidth > 0 ? maxPlayfieldWidth / desiredPlayfieldWidth : 1;
    const playfieldWidth = desiredPlayfieldWidth * layoutScale;
    const averageColumnWidth = configuredColumnWidths.reduce((sum, width) => sum + width, 0) / Math.max(1, configuredColumnWidths.length);
    const laneWidth = averageColumnWidth * layoutScale;
    const barePreviewBias = this.barePlayfield && this.keyCount >= 5 && w >= 380 ? 0.32 : 0.5;
    const playfieldX = (w - playfieldWidth) * barePreviewBias;
    const hitPosition = this.skinSettings.hitPosition ?? MANIA_HIT_TARGET_POSITION;
    const judgmentY = h * (this.skinSettings.upscroll ? hitPosition : MANIA_REFERENCE_HEIGHT - hitPosition) / MANIA_REFERENCE_HEIGHT;
    const noteHeight = Math.max(6, this.skinProfile.noteHeightScale * layoutScale * MANIA_BAR_NOTE_HEIGHT_RATIO);
    const receptorHeight = Math.max(6, h * 0.012);
    const scrollTimeRange = (MANIA_MAX_TIME_RANGE / Math.max(1, Math.min(40, this.scrollSpeed))) * this.modRate;
    const scrollLength = h * (MANIA_REFERENCE_HEIGHT - MANIA_DEFAULT_HIT_POSITION) / MANIA_REFERENCE_HEIGHT;
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
    this.resetFpsCounter(this.lastRenderTime);
    this.tick();
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

  seek(timeMs: number) {
    this.currentTime = Math.max(0, Math.min(timeMs, this.totalDuration));
    this.recomputeStatsUpTo(this.currentTime);
    this.lastRenderTime = performance.now();
    this.resetAudioClockSmoothing();
    this.render();
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

  setBackgroundImage(img: HTMLImageElement | null) {
    if (img === this.backgroundImage) return;
    const shouldFade = this.backgroundImage && img;
    this.previousBackgroundImage = shouldFade ? this.backgroundImage : null;
    this.backgroundImage = img;
    this.backgroundTransitionStartedAt = shouldFade ? performance.now() : 0;
    this.rebuildBackgroundSprites();
    if (!this._isPlaying) this.render();
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
    const hitbox = this.getOverlayAtPoint(point.x, point.y);
    const desktopSelection = this.canUseDesktopOverlaySelection(event);
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

    this.canvas.style.cursor = this.getOverlayPointerCursor(point.x, point.y);
  };

  private handleOverlayPointerEnd = (event: PointerEvent) => {
    this.activeOverlayPointers.delete(event.pointerId);
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
    const point = this.getCanvasPointerPoint(event);
    this.canvas.style.cursor = this.getOverlayPointerCursor(point.x, point.y);
  };

  private handleOverlayPointerLeave = () => {
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
    this.fpsSampleStartedAt = now;
    this.fpsFrameCount = 0;
    this.measuredFps = 0;
  }

  private updateFpsCounter(now: number) {
    if (this.fpsSampleStartedAt <= 0) this.resetFpsCounter(now);
    this.fpsFrameCount++;
    const elapsed = now - this.fpsSampleStartedAt;
    if (elapsed >= 500) {
      this.measuredFps = Math.round((this.fpsFrameCount * 1000) / elapsed);
      this.fpsSampleStartedAt = now;
      this.fpsFrameCount = 0;
    }
  }

  private render() {
    if (!this.app) return;

    const layout = this.getLayout();
    this.currentKeyState = this.getCurrentKeyState();
    this.updateHudSnapshotIfNeeded();

    if (this.staticDirty) {
      this.staticGraphics.clear();
      this.renderStaticPlayfield(layout);
      this.staticDirty = false;
    }

    this.graphics.clear();
    this.beginSkinSpriteFrame();
    this.beginTextFrame();

    this.renderBackground(layout);
    this.renderSegmentOverlays(layout);
    if (this.skinSettings.keysUnderNotes) this.renderReceptors(layout);
    if (this.showInputOverlay && this.inputOverlayOnly) {
      this.renderInputOverlayNotes(layout);
    } else {
      this.renderNotes(layout);
    }
    this.renderJudgmentLine(layout);
    if (!this.skinSettings.keysUnderNotes) this.renderReceptors(layout);
    if (this.showHealthBar) this.renderHealthBar(layout);
    this.overlayHitboxes = [];
    if (!this.hideHud) this.renderHUD(layout);
    else if (this.showCombo) this.renderCombo(layout);
    this.renderOverlaySelectionAffordances(layout);
    this.finishSkinSpriteFrame();
    this.finishTextFrame();
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
    const showColumnDividers = this.skinSettings.style === "bars";
    const g = this.staticGraphics;

    if (!this.barePlayfield) {
      this.fillRectInto(g, 0, 0, playfieldX, h, "#000000", 0.24);
      this.fillRectInto(g, playfieldX + playfieldWidth, 0, w - playfieldX - playfieldWidth, h, "#000000", 0.24);
      this.fillRectInto(g, playfieldX, 0, playfieldWidth, h, "#000000", 0.12);

      for (let col = 0; showColumnDividers && col < this.keyCount; col++) {
        const { x, width } = this.getColumnLayout(col, layout);
        this.fillRectInto(g, x, 0, width, h, "#ffffff", col % 2 === 0 ? 0.02 : 0.04);
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
    } else {
      this.rectInto(g, playfieldX, 0, playfieldWidth, h, "#ffffff", 0.15, 2);
    }
  }

  private renderHealthBar(layout: Layout) {
    if (this.lifeBarFrames.length === 0) return;

    const { h, playfieldX, playfieldWidth } = layout;
    const health = this.getHealthAtTime(this.currentTime);
    const barWidth = Math.max(6, Math.min(8, layout.laneWidth * 0.14));
    const x = playfieldX + playfieldWidth + 13;
    const height = Math.max(136, h * 0.52);
    const y = h - height;
    const fillHeight = height * health;
    const fillY = y + height - fillHeight;
    const color = health <= 0.2 ? "#ff4444" : health <= 0.45 ? "#ffcc22" : "#b3f5ff";

    this.fillRect(x, y, barWidth, height, "#05050a", 0.62);
    this.fillRect(x, fillY, barWidth, fillHeight, color, 0.96);
    this.rect(x - 0.5, y, barWidth + 1, height, "#ffffff", 0.26, 1);
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
    const searchMinTime = Math.min(visibleMinTime, this.currentTime - velocityWindow * 0.4);
    const searchMaxTime = visibleMaxTime;
    const startIdx = this.binarySearchNoteIndex(searchMinTime - this.maxHoldDuration);

    for (let i = startIdx; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.time > searchMaxTime) break;
      const col = note.column;
      if (col >= this.keyCount) continue;

      const noteState = this.noteStates[i];
      const headResolved = noteState.headTime <= this.currentTime;
      const tailResolved = noteState.tailTime != null && noteState.tailTime <= this.currentTime;

      if (headResolved && (!note.isHold || tailResolved)) continue;

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
        const shouldLetPassLine = awaitingJudgment && note.time < this.currentTime - 10;
        const withinMatchedSegment = this.currentTime < noteState.releaseTime;
        const stillPhysicallyHeld = withinMatchedSegment || this.isColumnEffectivelyHeldAtTime(col, this.currentTime);
        const releasedEarly =
          noteState.bodyBreakTime != null &&
          noteState.bodyBreakTime <= this.currentTime &&
          this.currentTime < (noteState.tailTime ?? note.endTime) &&
          !stillPhysicallyHeld;

        if (!shouldLetPassLine) headY = this.skinSettings.upscroll ? Math.max(headY, judgmentY) : Math.min(headY, judgmentY);
        const top = Math.min(headY, tailY);
        let bottom = Math.max(headY, tailY);
        if (!shouldLetPassLine && !this.skinSettings.upscroll) bottom = Math.min(bottom, judgmentY);
        if (top > h + 20 || bottom < -20) continue;

        const bodyAlpha = releasedEarly ? 0.45 : 1;
        const headAlpha = releasedEarly ? 0.65 : 1;
        const headEndY = this.skinSettings.upscroll ? top : bottom;
        const tailEndY = this.skinSettings.upscroll ? bottom : top;
        const headTrimDelta = isArrowSkin
          ? arrowSize * 0.5
          : this.skinSettings.style === "circles"
            ? circleDiameter * 0.5
            : noteHeight * 0.5;
        const tailTrimDelta = this.skinSettings.percy
          ? Math.min(20, Math.max(noteHeight * 0.9, headTrimDelta * 1.1))
          : 0;
        if (this.renderHoldSkinImages(layout, assets, colX, colWidth, top, bottom, headEndY, tailEndY, tailTrimDelta, bodyAlpha, headAlpha, noteFadeHeight)) {
          continue;
        }

        if (this.skinSettings.style === "circles") {
          const bodyWidth = Math.max(14, circleDiameter * 0.72);
          const bodyX = colX + colWidth / 2 - bodyWidth / 2;
          const headInsetTop = this.skinSettings.upscroll ? 0 : tailTrimDelta;
          const headInsetBottom = this.skinSettings.upscroll ? tailTrimDelta : 0;
          const bodyTop = top + headInsetTop;
          const bodyBottom = Math.max(bodyTop, bottom - headInsetBottom);
          const headCenterY = this.getVisualCenterY(headEndY, circleRadius);
          this.circleLnBodyWithTopFade(
            bodyX,
            bodyTop,
            bodyWidth,
            bodyBottom - bodyTop,
            this.skinSettings.lnBodyColor,
            bodyAlpha,
            noteFadeHeight,
            0.55,
          );
          this.circleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, circleLnHeadColor, headAlpha, noteFadeHeight, 0.55);
          if (this.skinSettings.outlineEnabled) {
            this.strokeCircleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, this.skinSettings.outlineColor, headAlpha, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
          }
          continue;
        }

        if (isArrowSkin) {
          const bodyWidth = Math.max(14, arrowSize * 0.68);
          const bodyX = colX + colWidth / 2 - bodyWidth / 2;
          const tailDelta = this.skinSettings.upscroll ? -tailTrimDelta : tailTrimDelta;
          const headCenterY = this.getVisualCenterY(headEndY, arrowSize / 2);
          const bodyHeadY = headCenterY;
          const bodyTailY = tailEndY + tailDelta;
          const bodyTop = Math.min(bodyHeadY, bodyTailY);
          const bodyBottom = Math.max(bodyHeadY, bodyTailY);
          this.arrowLnBodyWithTopFade(bodyX, bodyTop, bodyWidth, bodyBottom - bodyTop, this.skinSettings.lnBodyColor, bodyAlpha, noteFadeHeight, 0.55);
          this.arrowShapeWithTopFade(
            colX + colWidth / 2,
            headCenterY,
            arrowSize,
            arrowDirection,
            arrowLnHeadColor,
            headAlpha,
            this.skinSettings.outlineEnabled ? this.skinSettings.outlineColor : null,
            headAlpha,
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
        const barBodyTop = Math.min(bodyHeadY, bodyTailY);
        const barBodyBottom = Math.max(bodyHeadY, bodyTailY);
        this.barLnBodyWithTopFade(x, barBodyTop, barWidth, barBodyBottom - barBodyTop, color, bodyAlpha, noteFadeHeight, 0.55);
      } else {
        if (note.time < this.currentTime - 10 && !headResolved) continue;

        const noteY = judgmentY + getVisualDelta(note.time) * pixelsPerMs * (this.skinSettings.upscroll ? 1 : -1);
        if (noteY > h + 20 || noteY < -20) continue;

        if (assets?.tap) {
          const assetHeight = this.getNoteAssetHeight(assets.tap, colWidth, layout, Math.max(noteHeight, circleDiameter, arrowSize));
          const noteTop = this.skinSettings.upscroll ? noteY : noteY - assetHeight;
          const alpha = this.topFadeAlpha(Math.max(0, Math.min(noteTop + assetHeight, noteFadeHeight)), noteFadeHeight, 0.55);
          this.drawSkinImage(assets.tap, colX + colWidth / 2, noteTop, colWidth, assetHeight, 0.5, 0, alpha);
          continue;
        }

        if (this.skinSettings.style === "circles") {
          const noteCenterY = this.getVisualCenterY(noteY, circleRadius);
          this.circleWithTopFade(colX + colWidth / 2, noteCenterY, circleRadius, circleTapColor, 1, noteFadeHeight, 0.55);
          if (this.skinSettings.outlineEnabled) {
            this.strokeCircleWithTopFade(colX + colWidth / 2, noteCenterY, circleRadius, this.skinSettings.outlineColor, 1, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
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
            1,
            this.skinSettings.outlineEnabled ? this.skinSettings.outlineColor : null,
            1,
            this.skinSettings.outlineWidth,
            noteFadeHeight,
            0.55,
          );
          continue;
        }

        const noteTop = this.skinSettings.upscroll ? noteY : noteY - noteHeight;
        this.roundRectWithTopFade(x, noteTop, barWidth, noteHeight, 4, color, 1, noteFadeHeight, 0.55);
        this.roundRectWithTopFade(x + 1, noteTop, barWidth - 2, noteHeight, 4, color, 0.32, noteFadeHeight, 0.55);
        this.roundRectWithTopFade(x + 2, noteTop + 1, barWidth - 4, noteHeight / 3, 2, "#ffffff", 0.2, noteFadeHeight, 0.55);
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
    const holdOcclusionRanges: Array<Array<{ top: number; bottom: number }>> = Array.from(
      { length: this.keyCount },
      () => [],
    );

    if (hasNotes) {
      const startIdx = this.binarySearchNoteIndex(visibleMinTime - this.maxHoldDuration);
      for (let i = startIdx; i < this.notes.length; i++) {
        const note = this.notes[i];
        if (note.time > visibleMaxTime) break;
        if (!note.isHold || note.column >= this.keyCount) continue;

        const noteState = this.noteStates[i];
        const headResolved = noteState.headTime <= this.currentTime;
        const tailResolved = noteState.tailTime != null && noteState.tailTime <= this.currentTime;
        if (headResolved && tailResolved) continue;

        let headY = judgmentY + getVisualDelta(note.time) * pixelsPerMs * (this.skinSettings.upscroll ? 1 : -1);
        const tailY = judgmentY + getVisualDelta(note.endTime) * pixelsPerMs * (this.skinSettings.upscroll ? 1 : -1);
        if (headResolved) headY = this.skinSettings.upscroll ? Math.max(headY, judgmentY) : Math.min(headY, judgmentY);

        const top = Math.min(headY, tailY);
        const bottom = this.skinSettings.upscroll
          ? Math.max(Math.max(headY, tailY), judgmentY)
          : Math.min(Math.max(headY, tailY), judgmentY);
        if (top > h + 20 || bottom < -20 || bottom - top <= 0) continue;
        holdOcclusionRanges[note.column].push({ top, bottom });
      }
      holdOcclusionRanges.forEach((ranges) => ranges.sort((a, b) => a.top - b.top));
    }

    for (let col = 0; col < this.keyCount; col++) {
      const { x: colX, width: colWidth } = this.getColumnLayout(col, layout);
      const x = colX + 2;
      const barWidth = colWidth - 4;
      const color = this.colors[col];
      const occlusions = holdOcclusionRanges[col];
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
        let cursor = top;

        const drawOverlayPiece = (pieceTop: number, pieceBottom: number) => {
          const barH = Math.max(pieceBottom - pieceTop, 2);
          if (barH <= 0) return;
          this.roundRect(x, pieceTop, barWidth, barH, 3, hasNotes ? this.inputOverlayColor : color, hasNotes ? 0.18 : 0.7);
          if (pieceTop < judgmentY && pieceBottom > judgmentY - 20) {
            this.fillRect(x, pieceTop, barWidth, barH, this.inputOverlayColor, 0.08);
          }
        };

        if (!occlusions.length) {
          drawOverlayPiece(top, bottom);
          continue;
        }

        for (const range of occlusions) {
          if (range.bottom <= cursor) continue;
          if (range.top >= bottom) break;
          if (range.top > cursor) drawOverlayPiece(cursor, Math.min(range.top, bottom));
          cursor = Math.max(cursor, range.bottom);
          if (cursor >= bottom) break;
        }
        if (cursor < bottom) drawOverlayPiece(cursor, bottom);
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

      if (this.renderHoldSkinImages(layout, assets, colX, colWidth, top, bottom, headEndY, tailEndY, tailTrimDelta, 0.92, 0.96, noteFadeHeight)) {
        return;
      }

      if (this.skinSettings.style === "circles") {
        const bodyWidth = Math.max(14, circleDiameter * 0.72);
        const bodyX = colX + colWidth / 2 - bodyWidth / 2;
        const headInsetTop = this.skinSettings.upscroll ? 0 : tailTrimDelta;
        const headInsetBottom = this.skinSettings.upscroll ? tailTrimDelta : 0;
        const bodyTop = top + headInsetTop;
        const bodyBottom = Math.max(bodyTop, bottom - headInsetBottom);
        const headCenterY = this.getVisualCenterY(headEndY, circleRadius);
        this.circleLnBodyWithTopFade(bodyX, bodyTop, bodyWidth, bodyBottom - bodyTop, this.skinSettings.lnBodyColor, 0.92, noteFadeHeight, 0.55);
        this.circleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, circleLnHeadColor, 0.96, noteFadeHeight, 0.55);
        if (this.skinSettings.outlineEnabled) {
          this.strokeCircleWithTopFade(colX + colWidth / 2, headCenterY, circleRadius, this.skinSettings.outlineColor, 0.96, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
        }
        return;
      }

      if (isArrowSkin) {
        const bodyWidth = Math.max(14, arrowSize * 0.68);
        const bodyX = colX + colWidth / 2 - bodyWidth / 2;
        const tailDelta = this.skinSettings.upscroll ? -tailTrimDelta : tailTrimDelta;
        const headCenterY = this.getVisualCenterY(headEndY, arrowSize / 2);
        const bodyTop = Math.min(headCenterY, tailEndY + tailDelta);
        const bodyBottom = Math.max(headCenterY, tailEndY + tailDelta);
        this.arrowLnBodyWithTopFade(bodyX, bodyTop, bodyWidth, bodyBottom - bodyTop, this.skinSettings.lnBodyColor, 0.92, noteFadeHeight, 0.55);
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
    if (this.skinSettings.style !== "bars") return;
    const { playfieldX, playfieldWidth, judgmentY } = layout;
    this.line(playfieldX, judgmentY, playfieldX + playfieldWidth, judgmentY, "#ffffff", 0.82, 2);
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
        const receptorHeight = this.getAssetHeightForWidth(receptorAsset, colWidth, colWidth, layout.receptorHeight);
        const receptorY = this.skinSettings.upscroll ? judgmentY - receptorHeight : judgmentY;
        this.drawSkinImage(receptorAsset, x + colWidth / 2, receptorY, colWidth, receptorHeight, 0.5, 0, 1);
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

      this.arrowStroke(cx, receptorCenterY, arrowSize, direction, "#ffffff", Math.max(pressed ? 0.95 : 0.4, flashIntensity * 0.65), 2.25);
    }
  }

  private renderCircleReceptors(layout: Layout) {
    const { judgmentY } = layout;
    const currentState = this.currentKeyState;
    const radius = this.getCircleDiameter(layout) / 2;
    const receptorCenterY = this.getVisualCenterY(judgmentY, radius);
    const strokeWidth = Math.max(2, Math.min(3, radius * 0.12));

    for (let col = 0; col < this.keyCount; col++) {
      const { x, width: colWidth } = this.getColumnLayout(col, layout);
      const pressed = (currentState & (1 << col)) !== 0;
      this.circle(x + colWidth / 2, receptorCenterY, radius, "#ffffff", 0);
      this.strokeCircle(x + colWidth / 2, receptorCenterY, radius, "#ffffff", pressed ? 1 : 0.5, strokeWidth);
    }
  }

  private getOverlayScale(layout: Layout, id: ReplayOverlayId): number {
    return this.getHudScale(layout) * this.overlaySettings[id].scale;
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
    const frame = this.getRawOverlayFrame(layout, id, width, height);
    if (!frame) return null;
    this.overlayHitboxes.push({ id, ...frame });
    return frame;
  }

  private getRawOverlayFrame(
    layout: Layout,
    id: ReplayOverlayId,
    width: number,
    height: number,
  ): ReplayOverlayFrame | null {
    const placement = this.overlaySettings[id];
    if (!placement.enabled) return null;
    const x = Math.max(0, Math.min(Math.max(0, layout.w - width), placement.x * layout.w));
    const y = Math.max(0, Math.min(Math.max(0, layout.h - height), placement.y * layout.h));
    return { x, y, width, height };
  }

  private getKeypressOverlayMetrics(scale: number): KeypressOverlayMetrics {
    const keyGap = Math.round((this.keyCount >= 8 ? 4 : 6) * scale);
    const keyBoxWidth = Math.round((this.keyCount >= 8 ? 36 : 40) * scale);
    const keyBoxHeight = Math.round(38 * scale);
    const width = this.keyCount * keyBoxWidth + Math.max(0, this.keyCount - 1) * keyGap;
    return { scale, keyGap, keyBoxWidth, keyBoxHeight, width, height: keyBoxHeight };
  }

  private keypressOverlayOverlapsPlayfield(layout: Layout, frame: ReplayOverlayFrame, margin: number): boolean {
    const playfieldLeft = layout.playfieldX;
    const playfieldRight = layout.playfieldX + layout.playfieldWidth;
    return frame.x < playfieldRight + margin && frame.x + frame.width > playfieldLeft - margin;
  }

  private getLargestKeypressScaleForWidth(preferredScale: number, minScale: number, maxWidth: number): number {
    if (maxWidth <= 0 || this.getKeypressOverlayMetrics(minScale).width > maxWidth) return minScale;

    let low = minScale;
    let high = preferredScale;
    for (let i = 0; i < 12; i++) {
      const mid = (low + high) / 2;
      if (this.getKeypressOverlayMetrics(mid).width <= maxWidth) low = mid;
      else high = mid;
    }
    return low;
  }

  private getSmartKeypressOverlayFrame(layout: Layout, preferredScale: number): { frame: ReplayOverlayFrame; metrics: KeypressOverlayMetrics } | null {
    let metrics = this.getKeypressOverlayMetrics(preferredScale);
    const rawFrame = this.getRawOverlayFrame(layout, "keypresses", metrics.width, metrics.height);
    if (!rawFrame) return null;

    const margin = Math.max(8, Math.min(22, layout.w * 0.012));
    if (!this.keypressOverlayOverlapsPlayfield(layout, rawFrame, margin)) {
      return { frame: rawFrame, metrics };
    }

    const playfieldLeft = layout.playfieldX;
    const playfieldRight = layout.playfieldX + layout.playfieldWidth;
    const playfieldCenter = playfieldLeft + layout.playfieldWidth / 2;
    const rawCenter = rawFrame.x + rawFrame.width / 2;
    const leftSpace = Math.max(0, playfieldLeft - margin);
    const rightSpace = Math.max(0, layout.w - playfieldRight - margin);
    const minScale = Math.min(preferredScale, this.getHudScale(layout) * REPLAY_OVERLAY_MIN_SCALE);
    const minWidth = this.getKeypressOverlayMetrics(minScale).width;

    let side: "left" | "right" = rawCenter <= playfieldCenter ? "left" : "right";
    const preferredSpace = side === "left" ? leftSpace : rightSpace;
    const fallbackSpace = side === "left" ? rightSpace : leftSpace;
    if (preferredSpace < minWidth && fallbackSpace > preferredSpace) {
      side = side === "left" ? "right" : "left";
    }

    const availableWidth = side === "left" ? leftSpace : rightSpace;
    const smartScale = metrics.width > availableWidth
      ? this.getLargestKeypressScaleForWidth(preferredScale, minScale, availableWidth)
      : preferredScale;
    metrics = this.getKeypressOverlayMetrics(smartScale);

    const targetX = side === "left"
      ? playfieldLeft - margin - metrics.width
      : playfieldRight + margin;
    const frame = {
      x: Math.max(0, Math.min(Math.max(0, layout.w - metrics.width), targetX)),
      y: Math.max(0, Math.min(Math.max(0, layout.h - metrics.height), rawFrame.y)),
      width: metrics.width,
      height: metrics.height,
    };
    return { frame, metrics };
  }

  private renderAccuracyOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "accuracy");
    const width = 94 * scale;
    const height = 26 * scale;
    const frame = this.getOverlayFrame(layout, "accuracy", width, height);
    if (!frame) return;
    this.addText(this.hudCachedAccuracy, frame.x, frame.y, {
      fontSize: 18 * scale,
      fill: "#ffffff",
      alpha: 0.85,
      fontWeight: "700",
    });
  }

  private renderKpsOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "kps");
    const width = 54 * scale;
    const height = 38 * scale;
    const frame = this.getOverlayFrame(layout, "kps", width, height);
    if (!frame) return;

    this.fillRect(frame.x, frame.y, width, height, "#0a0a12", 0.82);
    this.rect(frame.x, frame.y, width, height, "#ffffff", 0.12, 1);
    this.fillRect(frame.x + 1, frame.y + 1, 3 * scale, height - 2, this.inputOverlayColor, 0.95);
    this.addText("KPS", frame.x + width / 2, frame.y + 5 * scale, {
      fontSize: 7 * scale,
      fill: "#ffffff",
      alpha: 0.52,
      fontWeight: "700",
      anchorX: 0.5,
    });
    this.addText(this.hudCachedTotalKps, frame.x + width / 2, frame.y + 34 * scale, {
      fontSize: 17 * scale,
      fill: "#ffffff",
      alpha: 0.95,
      fontWeight: "700",
      anchorX: 0.5,
      anchorY: 1,
    });
  }

  private renderKeypressOverlay(layout: Layout) {
    const result = this.getSmartKeypressOverlayFrame(layout, this.getOverlayScale(layout, "keypresses"));
    if (!result) return;
    const { frame, metrics } = result;
    const { scale, keyGap, keyBoxWidth, keyBoxHeight } = metrics;
    this.overlayHitboxes.push({ id: "keypresses", ...frame });

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

  private renderMissOverlay(layout: Layout) {
    const scale = this.getOverlayScale(layout, "misses");
    const width = 128 * scale;
    const height = 36 * scale;
    const frame = this.getOverlayFrame(layout, "misses", width, height);
    if (!frame) return;

    [
      { label: "L MISS", value: this.hudCachedLeftMisses, color: "#5a8fff" },
      { label: "R MISS", value: this.hudCachedRightMisses, color: "#de31ae" },
    ].forEach((item, index) => {
      const x = frame.x + index * 68 * scale;
      this.fillRect(x, frame.y, 60 * scale, height, "#0a0a12", 0.78);
      this.fillRect(x, frame.y, 3 * scale, height, item.color, 1);
      this.addText(item.label, x + 9 * scale, frame.y + 5 * scale, { fontSize: 9 * scale, fill: "#ffffff", alpha: 0.58, fontWeight: "700" });
      this.addText(item.value, x + 9 * scale, frame.y + 28 * scale, { fontSize: 16 * scale, fill: "#ffffff", alpha: 0.95, fontWeight: "700", anchorY: 1 });
    });
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
    if (!this.shouldRenderCustomOverlays(layout) || this.hideHud) return;
    this.pruneSelectedOverlays();

    for (const box of this.overlayHitboxes) {
      if (!this.selectedOverlayIds.has(box.id)) continue;
      const pad = this.getOverlaySelectionPad();
      this.fillRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2, "#5a8fff", 0.08);
      this.rect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2, "#5a8fff", 0.9, Math.max(1, layout.w * 0.0016));
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

  private renderHUD(layout: Layout) {
    const { w, h, playfieldX, playfieldWidth, judgmentY } = layout;
    const playfieldCenterX = playfieldX + playfieldWidth / 2;
    const scoreY = this.getStagePositionY(this.skinSettings.scorePosition, layout);

    if (this.lastJudgment > 0) {
      const timeSince = this.currentTime - this.lastJudgmentTime;
      const judgementDuration = REPLAY_JUDGEMENT_POP_DURATION_MS
        + REPLAY_JUDGEMENT_HOLD_DURATION_MS
        + REPLAY_JUDGEMENT_FADE_DURATION_MS;
      if (timeSince < judgementDuration) {
        const fadeStart = REPLAY_JUDGEMENT_POP_DURATION_MS + REPLAY_JUDGEMENT_HOLD_DURATION_MS;
        const fadeProgress = timeSince <= fadeStart
          ? 0
          : Math.max(0, Math.min(1, (timeSince - fadeStart) / REPLAY_JUDGEMENT_FADE_DURATION_MS));
        const alpha = 1 - fadeProgress;
        const popProgress = Math.max(0, Math.min(1, timeSince / REPLAY_JUDGEMENT_POP_DURATION_MS));
        const animationScale = 0.8 + 0.2 * easeOutElastic(popProgress);
        const judgmentAsset = this.getJudgementAsset(this.lastJudgment);
        const y = scoreY;
        if (judgmentAsset) {
          const rawHeight = this.getHudAssetHeight(judgmentAsset, h * REPLAY_JUDGEMENT_ASSET_HEIGHT_RATIO, layout);
          const clampedHeight = Math.min(h * 0.085, Math.max(h * 0.04, rawHeight));
          const aspectScale = this.getJudgementAspectScale(judgmentAsset);
          const targetHeight = clampedHeight * animationScale * aspectScale;
          const targetWidth = this.getAssetWidthForHeight(judgmentAsset, targetHeight, targetHeight * 2);
          this.drawSkinImage(judgmentAsset, playfieldCenterX, y, targetWidth, targetHeight, 0.5, 0.5, alpha);
        } else if (this.skinSettings.judgementSet === DEFAULT_REPLAY_JUDGEMENT_SET) {
          this.addText(
            JUDGMENT_LABELS[this.lastJudgment],
            playfieldCenterX,
            y,
            {
              fontSize: Math.max(16, h * 0.035) * animationScale,
              fill: JUDGMENT_COLORS[this.lastJudgment],
              fontWeight: "700",
              anchorX: 0.5,
              anchorY: 0.5,
              alpha,
            },
          );
        }
      }
    }

    this.renderCombo(layout);
    if (this.shouldRenderCustomOverlays(layout)) {
      this.renderKeypressOverlay(layout);
      this.renderKpsOverlay(layout);
      this.renderMissOverlay(layout);
      this.renderAccuracyOverlay(layout);
      this.renderJudgementOverlay(layout);
      this.renderProgressOverlay(layout);
    }

    const urBarWidth = Math.min(playfieldWidth * 0.68, 180);
    const urBarX = playfieldCenterX - urBarWidth / 2;
    const receptorBottom = this.skinSettings.style === "circles" || this.skinSettings.style === "arrows"
      ? judgmentY
      : judgmentY + layout.receptorHeight + 2;
    const urBarY = Math.min(h - 10, receptorBottom > h - 40 ? receptorBottom + 12 : h - 26);
    const urRange = this.hitWindows.meh;

    this.fillRect(urBarX, urBarY, urBarWidth, 3, "#ffffff", 0.08);
    this.fillRect(playfieldCenterX - 1, urBarY - 4, 2, 11, "#ffffff", 0.25);
    this.recentHitOffsets.forEach((offset, index) => {
      const normalized = Math.max(-1, Math.min(1, offset / urRange));
      const x = playfieldCenterX + normalized * (urBarWidth / 2);
      const alpha = 0.2 + ((index + 1) / this.recentHitOffsets.length) * 0.8;
      this.fillRect(x - 1.5, urBarY - 3, 3, 9, "#b3f5ff", alpha);
    });
    this.addText(this.hudCachedTime, 8, h - 8, { fontSize: 11, fill: "#ffffff", alpha: 0.4, anchorY: 1 });
    this.addText(`${this.playbackSpeed * this.modRate}x`, w - 8, h - 8, {
      fontSize: 11,
      fill: "#ffffff",
      alpha: 0.4,
      anchorX: 1,
      anchorY: 1,
    });
    this.addText(`FPS ${this.hudCachedFps}`, w - 8, 8, {
      fontSize: 11,
      fill: this.measuredFps >= 55 || this.measuredFps === 0 ? "#ffffff" : "#ffcc22",
      alpha: 0.52,
      fontWeight: "700",
      anchorX: 1,
    });
    if (import.meta.env.DEV && this.app && w >= 520) {
      this.addText(
        `Renderer ${formatPixiRendererType(this.app.renderer.type, this.app.renderer.name)}`,
        w - 8,
        24,
        {
          fontSize: 10,
          fill: "#ffffff",
          alpha: 0.42,
          fontWeight: "700",
          anchorX: 1,
        },
      );
    }
  }

  private renderCombo(layout: Layout) {
    if (this.combo <= 0) return;

    const { h, playfieldX, playfieldWidth } = layout;
    const playfieldCenterX = playfieldX + playfieldWidth / 2;
    const comboY = this.getStagePositionY(this.skinSettings.comboPosition, layout);
    if (this.skinSettings.comboFontSet === DEFAULT_REPLAY_COMBO_FONT_SET && this.renderComboImages(`${this.combo}x`, playfieldCenterX, comboY, layout)) return;
    const comboFont = getReplayComboFontStyle(this.skinSettings.comboFontSet);
    this.addText(`${this.combo}x`, playfieldCenterX, comboY, {
      fontSize: Math.max(22, h * 0.05),
      fill: "#ffffff",
      alpha: 0.85,
      fontFamily: comboFont.family,
      fontWeight: comboFont.weight,
      fontStyle: comboFont.style,
      anchorX: 0.5,
      anchorY: 0.5,
    });
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

  private getHudScale(layout: Layout): number {
    if (!this.fullscreenLayout) return 1;
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

  private getJudgementAsset(judgment: Judgment): ReplaySkinImageAsset | undefined {
    const assets = getReplayJudgementSetAssets(this.skinSettings.judgementSet) ?? this.skinProfile.assets.judgements;
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
    assets: ReplaySkinColumnAssets | undefined,
    colX: number,
    colWidth: number,
    top: number,
    bottom: number,
    headEndY: number,
    tailEndY: number,
    tailTrimDelta: number,
    bodyAlpha: number,
    headAlpha: number,
    fadeHeight: number,
  ): boolean {
    if (!assets?.lnHead && !assets?.lnBody && !assets?.lnTail) return false;

    const bodyAsset = assets.lnBody;
    const headAsset = assets.lnHead ?? assets.tap;
    const tailAsset = assets.lnTail;
    const headHeight = headAsset ? this.getNoteAssetHeight(headAsset, colWidth, layout, layout.noteHeight) : layout.noteHeight;
    const tailHeight = tailAsset ? this.getNoteAssetHeight(tailAsset, colWidth, layout, layout.noteHeight) : layout.noteHeight;
    const tailDelta = this.skinSettings.upscroll ? -tailTrimDelta : tailTrimDelta;
    const bodyHeadY = headEndY;
    const bodyTailY = tailEndY + tailDelta;
    const bodyTop = Math.min(bodyHeadY, bodyTailY);
    const bodyBottom = Math.max(bodyHeadY, bodyTailY);

    if (bodyAsset && bodyBottom > bodyTop) {
      const alpha = bodyAlpha * this.topFadeAlpha(Math.max(0, Math.min(bodyBottom, fadeHeight)), fadeHeight, 0.55);
      this.drawSkinImage(bodyAsset, colX + colWidth / 2, bodyTop, colWidth, bodyBottom - bodyTop, 0.5, 0, alpha);
    } else {
      this.barLnBodyWithTopFade(colX + 3, bodyTop, colWidth - 6, bodyBottom - bodyTop, this.skinSettings.lnBodyColor, bodyAlpha, fadeHeight, 0.55);
    }

    if (tailAsset) {
      const tailTop = this.skinSettings.upscroll ? tailEndY - tailHeight : tailEndY;
      const alpha = bodyAlpha * this.topFadeAlpha(Math.max(0, Math.min(tailTop + tailHeight, fadeHeight)), fadeHeight, 0.55);
      this.drawSkinImage(tailAsset, colX + colWidth / 2, tailTop, colWidth, tailHeight, 0.5, 0, alpha);
    }

    if (headAsset) {
      const headTop = this.skinSettings.upscroll ? headEndY : headEndY - headHeight;
      const alpha = headAlpha * this.topFadeAlpha(Math.max(0, Math.min(headTop + headHeight, fadeHeight)), fadeHeight, 0.55);
      this.drawSkinImage(headAsset, colX + colWidth / 2, headTop, colWidth, headHeight, 0.5, 0, alpha);
    }

    if (!bodyAsset && !headAsset && !tailAsset && bottom > top) return false;
    return true;
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

  private renderComboImages(text: string, centerX: number, centerY: number, layout: Layout): boolean {
    const combo = this.skinProfile.assets.combo;
    if (!combo) return false;

    const glyphs = Array.from(text).map((char) => {
      if (char >= "0" && char <= "9") return combo.digits[Number(char)] ?? null;
      if (char.toLowerCase() === "x") return combo.x ?? null;
      return null;
    });
    if (!glyphs.some(Boolean)) return false;

    const fallbackHeight = Math.max(22, layout.h * 0.05);
    const comboFont = getReplayComboFontStyle(this.skinSettings.comboFontSet);
    const sizes = glyphs.map((asset) => {
      if (!asset) return { width: fallbackHeight * 0.45, height: fallbackHeight };
      const height = this.getHudAssetHeight(asset, fallbackHeight, layout);
      return { width: this.getAssetWidthForHeight(asset, height, fallbackHeight * 0.7), height };
    });
    const overlap = combo.overlap * (layout.h / 480);
    const totalWidth = sizes.reduce((sum, size, index) => sum + size.width - (index > 0 ? overlap : 0), 0);
    let x = centerX - totalWidth / 2;
    glyphs.forEach((asset, index) => {
      const size = sizes[index];
      if (asset) this.drawSkinImage(asset, x, centerY - size.height / 2, size.width, size.height, 0, 0, 0.9);
      else {
        this.addText(text[index], x + size.width / 2, centerY, {
          fontSize: fallbackHeight,
          fill: "#ffffff",
          alpha: 0.85,
          fontFamily: comboFont.family,
          fontWeight: comboFont.weight,
          fontStyle: comboFont.style,
          anchorX: 0.5,
          anchorY: 0.5,
        });
      }
      x += size.width - overlap;
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
  ) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    if (fadeHeight <= 0 || y >= fadeHeight) {
      this.roundRect(x, y, w, h, radius, color, alpha);
      return;
    }

    const bottom = y + h;
    if (bottom <= 0) return;
    const fadeBottom = Math.min(bottom, fadeHeight);
    const start = Math.max(y, 0);
    const sliceCount = 6;
    const sliceHeight = (fadeBottom - start) / sliceCount;

    for (let i = 0; i < sliceCount; i++) {
      const sliceY = start + sliceHeight * i;
      const sliceAlpha = alpha * this.topFadeAlpha(sliceY + sliceHeight, fadeHeight, minAlpha);
      this.roundRect(x, sliceY, w, sliceHeight + 0.5, radius, color, sliceAlpha);
    }

    if (bottom > fadeHeight) {
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
  ) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const bottom = y + h;
    if (bottom <= 0) return;
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
  ) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const bottom = y + h;
    if (bottom <= 0) return;
    const radius = Math.min(w / 2, h);
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
  ) {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    if (fadeHeight <= 0 || y >= fadeHeight) {
      this.fillRect(x, y, w, h, color, alpha);
      return;
    }

    const bottom = y + h;
    if (bottom <= 0) return;
    const fadeBottom = Math.min(bottom, fadeHeight);
    const start = Math.max(y, 0);
    const sliceCount = 10;
    const sliceHeight = (fadeBottom - start) / sliceCount;

    for (let i = 0; i < sliceCount; i++) {
      const sliceY = start + sliceHeight * i;
      const sliceAlpha = alpha * this.topFadeAlpha(sliceY + sliceHeight, fadeHeight, minAlpha);
      this.fillRect(x, sliceY, w, sliceHeight + 0.5, color, sliceAlpha);
    }

    if (bottom > fadeHeight) {
      this.fillRect(x, fadeHeight, w, bottom - fadeHeight, color, alpha);
    }
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
      anchorX?: number;
      anchorY?: number;
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
    if (label.text !== text) label.text = text;

    const fontFamily = options.fontFamily ?? "Torus, sans-serif";
    const fontWeight = options.fontWeight ?? "400";
    const fontStyle = options.fontStyle ?? "normal";
    const sig = `${options.fontSize}|${fontFamily}|${fontWeight}|${fontStyle}|${options.fill}`;
    if (label.__sig !== sig) {
      label.style.fontFamily = fontFamily;
      label.style.fontSize = options.fontSize;
      label.style.fontWeight = fontWeight;
      label.style.fontStyle = fontStyle;
      label.style.fill = options.fill;
      label.__sig = sig;
    }

    if (label.x !== x) label.x = x;
    if (label.y !== y) label.y = y;
    const alpha = options.alpha ?? 1;
    if (label.alpha !== alpha) label.alpha = alpha;

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
  ) {
    if (width <= 0 || height <= 0 || alpha <= 0) return;
    const texture = this.getTexture(asset);
    if (texture === Texture.EMPTY) return;

    let sprite = this.skinSpritePool[this.skinSpritePoolCursor];
    if (!sprite) {
      sprite = new Sprite(texture);
      this.skinSpritePool.push(sprite);
      this.skinSpriteLayer.addChild(sprite);
    }

    this.skinSpritePoolCursor++;
    sprite.visible = true;
    sprite.texture = texture;
    sprite.anchor.set(anchorX, anchorY);
    sprite.x = x;
    sprite.y = y;
    sprite.width = width;
    sprite.height = height;
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
  }

  private beginSkinSpriteFrame() {
    this.skinSpritePoolCursor = 0;
  }

  private finishSkinSpriteFrame() {
    for (let i = this.skinSpritePoolCursor; i < this.skinSpritePool.length; i++) {
      this.skinSpritePool[i].visible = false;
    }
  }

  private beginTextFrame() {
    this.textPoolCursor = 0;
  }

  private finishTextFrame() {
    for (let i = this.textPoolCursor; i < this.textPool.length; i++) {
      this.textPool[i].visible = false;
    }
  }

  private clearTextLayer() {
    const children = this.textLayer.removeChildren();
    for (const child of children) child.destroy();
  }

  private clearSkinSprites() {
    const children = this.skinSpriteLayer.removeChildren();
    for (const child of children) child.destroy();
    this.skinSpritePool = [];
    this.skinSpritePoolCursor = 0;
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

  destroy() {
    this.pause();
    this.destroyed = true;
    this.removeOverlayPointerHandlers();
    this.previousBackgroundImage = null;
    this.backgroundTransitionStartedAt = 0;
    const destroyApp = () => {
      if (!this.app) return;
      this.clearTextLayer();
      this.clearSkinSprites();
      for (const gradient of this.receptorBeamGradients.values()) gradient.destroy();
      this.receptorBeamGradients.clear();
      this.app.destroy({ removeView: false }, { children: true });
      this.app = null;
    };
    if (this.app) {
      destroyApp();
    } else {
      void this.initPromise.then(destroyApp);
    }
  }
}
