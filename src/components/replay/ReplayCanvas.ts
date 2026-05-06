import { Application, Container, FillGradient, Graphics, GraphicsPath, Matrix, Sprite, Text, Texture } from "pixi.js";
import type { ReplayFrame, ReplayLifeBarFrame } from "../../lib/types";
import type { ManiaNote, ManiaScrollVelocity } from "../../lib/beatmap-parser";
import type { Judgment, ManiaReplayHitWindows, ManiaReplayRuleset, ReplayJudgementEvent, ReplayNoteState } from "../../lib/mania-replay-judgement";
import { buildReplaySegments, calculateReplayAccuracy, getManiaReplayHitWindows, getManiaReplayRuleset, simulateManiaReplayJudgements } from "../../lib/mania-replay-judgement";
import { DEFAULT_REPLAY_SKIN_SETTINGS, REPLAY_SKIN_DEFAULT_HIT_POSITION, getReplaySkinProfile, normalizeReplaySkinSettings } from "../../lib/replay-skin";
import type { ReplaySkinColumnAssets, ReplaySkinImageAsset, ReplaySkinKeymodeProfile, ReplaySkinSettings } from "../../lib/replay-skin";
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
const MANIA_MAX_TIME_RANGE = 11485;
const MANIA_REFERENCE_HEIGHT = 768;
const MANIA_DEFAULT_HIT_POSITION = (480 - 402) * 1.6;
const MANIA_HIT_TARGET_POSITION = REPLAY_SKIN_DEFAULT_HIT_POSITION;
const MANIA_BAR_NOTE_HEIGHT_RATIO = 0.22;

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
          allowLegacyScoreReconciliation: this.ruleset.accuracyMode === "stable",
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
    for (let col = 0; col < this.keyCount; col++) {
      const v = this.formatKeyKps(this.getKeyKps(col, this.currentTime));
      if (this.hudCachedKeyKps[col] !== v) this.hudCachedKeyKps[col] = v;
    }
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
    const averageColumnWidth = configuredColumnWidths.reduce((sum, width) => sum + width, 0) / Math.max(1, configuredColumnWidths.length);
    const baseRatio = this.barePlayfield
      ? 0.4 + this.keyCount * 0.045
      : 0.25 + this.keyCount * 0.025;
    const desiredPlayfieldWidth = configuredColumnWidths.reduce((sum, width) => sum + width, 0)
      + configuredColumnSpacings.reduce((sum, width) => sum + width, 0);
    const fullscreenPlayfieldScale = this.fullscreenLayout
      ? Math.min(1.7, Math.max(1, h / 640))
      : 1;
    const maxPlayfieldWidth = Math.min(
      w * Math.min(baseRatio * (averageColumnWidth / 50), this.barePlayfield ? 0.82 : 0.72),
      desiredPlayfieldWidth * fullscreenPlayfieldScale,
    );
    const layoutScale = desiredPlayfieldWidth > 0 ? maxPlayfieldWidth / desiredPlayfieldWidth : 1;
    const playfieldWidth = desiredPlayfieldWidth * layoutScale;
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
    if (!this.inputOverlayOnly) this.renderNotes(layout);
    this.renderJudgmentLine(layout);
    if (!this.skinSettings.keysUnderNotes) this.renderReceptors(layout);
    if (this.showHealthBar) this.renderHealthBar(layout);
    if (!this.hideHud) this.renderHUD(layout);
    else if (this.showCombo) this.renderCombo(layout);
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
    const isCircleSkin = this.skinSettings.style === "circles";
    const showColumnDividers = !isCircleSkin;
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
          this.circleWithTopFade(colX + colWidth / 2, headEndY, circleRadius, circleLnHeadColor, headAlpha, noteFadeHeight, 0.55);
          if (this.skinSettings.outlineEnabled) {
            this.strokeCircleWithTopFade(colX + colWidth / 2, headEndY, circleRadius, this.skinSettings.outlineColor, headAlpha, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
          }
          continue;
        }

        if (isArrowSkin) {
          const bodyWidth = Math.max(14, arrowSize * 0.68);
          const bodyX = colX + colWidth / 2 - bodyWidth / 2;
          const tailDelta = this.skinSettings.upscroll ? -tailTrimDelta : tailTrimDelta;
          const bodyHeadY = headEndY;
          const bodyTailY = tailEndY + tailDelta;
          const bodyTop = Math.min(bodyHeadY, bodyTailY);
          const bodyBottom = Math.max(bodyHeadY, bodyTailY);
          this.circleLnBodyWithTopFade(bodyX, bodyTop, bodyWidth, bodyBottom - bodyTop, this.skinSettings.lnBodyColor, bodyAlpha, noteFadeHeight, 0.55);
          this.arrowShapeWithTopFade(
            colX + colWidth / 2,
            headEndY,
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
          this.circleWithTopFade(colX + colWidth / 2, noteY, circleRadius, circleTapColor, 1, noteFadeHeight, 0.55);
          if (this.skinSettings.outlineEnabled) {
            this.strokeCircleWithTopFade(colX + colWidth / 2, noteY, circleRadius, this.skinSettings.outlineColor, 1, this.skinSettings.outlineWidth, noteFadeHeight, 0.55);
          }
          continue;
        }

        if (isArrowSkin) {
          this.arrowShapeWithTopFade(
            colX + colWidth / 2,
            noteY,
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
    if (this.frames.length === 0 || !this.showInputOverlay || this.inputOverlayKeyHistory) return;

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

  private renderKeyInputHistory(
    layout: Layout,
    keyRowX: number,
    keyRowY: number,
    keyBoxWidth: number,
    _keyBoxHeight: number,
    keyGap: number,
  ) {
    if (!this.showInputOverlay || !this.inputOverlayKeyHistory || this.frames.length === 0) return;

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
      this.fillRect(laneX, top, laneWidth, height, "#05050a", 0.34);

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
          this.inputOverlayColor,
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

    for (let col = 0; col < this.keyCount; col++) {
      const { x, width: colWidth } = this.getColumnLayout(col, layout);
      const cx = x + colWidth / 2;
      const direction = getColumnArrowDirection(col, this.keyCount);
      const pressed = (currentState & (1 << col)) !== 0;
      if (pressed) this.receptorFlashTimestamps[col] = this.currentTime;
      const timeSinceFlash = this.currentTime - (this.receptorFlashTimestamps[col] || 0);
      const flashIntensity = pressed ? 1 : Math.max(0, 1 - timeSinceFlash / 140);

      this.arrowStroke(cx, judgmentY, arrowSize, direction, "#ffffff", Math.max(pressed ? 0.95 : 0.4, flashIntensity * 0.65), 1.5);
    }
  }

  private renderCircleReceptors(layout: Layout) {
    const { judgmentY } = layout;
    const currentState = this.currentKeyState;
    const radius = this.getCircleDiameter(layout) / 2;
    const strokeWidth = Math.max(2, Math.min(3, radius * 0.12));

    for (let col = 0; col < this.keyCount; col++) {
      const { x, width: colWidth } = this.getColumnLayout(col, layout);
      const pressed = (currentState & (1 << col)) !== 0;
      this.circle(x + colWidth / 2, judgmentY, radius, "#ffffff", 0);
      this.strokeCircle(x + colWidth / 2, judgmentY, radius, "#ffffff", pressed ? 1 : 0.5, strokeWidth);
    }
  }

  private renderHUD(layout: Layout) {
    const { w, h, playfieldX, playfieldWidth, judgmentY } = layout;
    const playfieldCenterX = playfieldX + playfieldWidth / 2;
    const scoreY = this.getStagePositionY(this.skinSettings.scorePosition, layout);
    const hudScale = this.getHudScale(layout);

    if (this.lastJudgment > 0) {
      const timeSince = this.currentTime - this.lastJudgmentTime;
      if (timeSince < 400) {
        const alpha = Math.max(0, 1 - timeSince / 400);
        const judgmentAsset = this.getJudgementAsset(this.lastJudgment);
        const y = scoreY - timeSince * 0.03;
        if (judgmentAsset) {
          const targetHeight = this.getHudAssetHeight(judgmentAsset, h * 0.075, layout);
          const targetWidth = this.getAssetWidthForHeight(judgmentAsset, targetHeight, targetHeight * 2);
          this.drawSkinImage(judgmentAsset, playfieldCenterX, y, targetWidth, targetHeight, 0.5, 0.5, alpha);
        } else {
          this.addText(
            JUDGMENT_LABELS[this.lastJudgment],
            playfieldCenterX,
            y,
            {
              fontSize: Math.max(16, h * 0.035),
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

    const compactHud = w < 520;

    this.addText(this.hudCachedAccuracy, playfieldX + playfieldWidth + 16, 16, {
      fontSize: Math.max(16, h * 0.032),
      fill: "#ffffff",
      alpha: 0.85,
      fontWeight: "700",
    });

    const currentState = this.currentKeyState;
    const keyGap = Math.round((this.keyCount >= 8 ? 4 : 6) * hudScale);
    const desiredKeyBoxWidth = Math.round((this.keyCount >= 8 ? 36 : 40) * hudScale);
    const availableKeyRowWidth = Math.max(0, playfieldX - 30 * hudScale);
    const fittedKeyBoxWidth = Math.floor(
      (availableKeyRowWidth - Math.max(0, this.keyCount - 1) * keyGap) / Math.max(1, this.keyCount),
    );
    const keyBoxWidth = Math.max(
      Math.round(30 * hudScale),
      Math.min(desiredKeyBoxWidth, Number.isFinite(fittedKeyBoxWidth) ? fittedKeyBoxWidth : desiredKeyBoxWidth),
    );
    const keyBoxHeight = Math.round(38 * hudScale);
    const keyRowWidth = this.keyCount * keyBoxWidth + Math.max(0, this.keyCount - 1) * keyGap;
    const keyRowX = Math.max(12 * hudScale, playfieldX - keyRowWidth - 18 * hudScale);
    const keyRowY = judgmentY - 42 * hudScale;

    if (!compactHud) {
      this.renderKeyInputHistory(layout, keyRowX, keyRowY, keyBoxWidth, keyBoxHeight, keyGap);

      for (let col = 0; col < this.keyCount; col++) {
        const x = keyRowX + col * (keyBoxWidth + keyGap);
        const pressed = (currentState & (1 << col)) !== 0;
        const color = this.colors[col];
        const keyFill = pressed ? "#0a0a12" : "#ffffff";
        const kpsFill = pressed ? "#0a0a12" : color;
        const keyAlpha = pressed ? 0.92 : 0.78;
        const kpsAlpha = pressed ? 0.76 : 0.9;
        const keyFontSize = (keyBoxWidth <= 32 * hudScale ? 12 : 13) * hudScale;
        const kpsFontSize = (keyBoxWidth <= 36 * hudScale ? 8 : 9) * hudScale;
        this.fillRect(x, keyRowY, keyBoxWidth, keyBoxHeight, "#0a0a12", 0.82);
        this.rect(x, keyRowY, keyBoxWidth, keyBoxHeight, "#ffffff", 0.12, 1);
        this.fillRect(x + 1, keyRowY + 1, keyBoxWidth - 2, keyBoxHeight - 2, color, pressed ? 0.95 : 0.18);
        this.addText(String(col + 1), x + keyBoxWidth / 2, keyRowY + 12 * hudScale, {
          fontSize: keyFontSize,
          fill: keyFill,
          alpha: keyAlpha,
          fontWeight: "700",
          anchorX: 0.5,
          anchorY: 0.5,
        });
        this.addText(this.hudCachedKeyKps[col], x + keyBoxWidth / 2, keyRowY + 28 * hudScale, {
          fontSize: kpsFontSize,
          fill: kpsFill,
          alpha: kpsAlpha,
          fontWeight: "700",
          anchorX: 0.5,
          anchorY: 0.5,
        });
      }

      [
        { label: "L MISS", value: this.hudCachedLeftMisses, color: "#5a8fff" },
        { label: "R MISS", value: this.hudCachedRightMisses, color: "#de31ae" },
      ].forEach((item, index) => {
        const x = keyRowX + index * 68 * hudScale;
        const y = keyRowY + keyBoxHeight + 10 * hudScale;
        this.fillRect(x, y, 60 * hudScale, 36 * hudScale, "#0a0a12", 0.78);
        this.fillRect(x, y, 3 * hudScale, 36 * hudScale, item.color, 1);
        this.addText(item.label, x + 9 * hudScale, y + 5 * hudScale, { fontSize: 9 * hudScale, fill: "#ffffff", alpha: 0.58, fontWeight: "700" });
        this.addText(item.value, x + 9 * hudScale, y + 28 * hudScale, { fontSize: 16 * hudScale, fill: "#ffffff", alpha: 0.95, fontWeight: "700", anchorY: 1 });
      });
    }

    const judgmentCounterX = playfieldX + playfieldWidth + 16;
    const judgmentCounterY = 52 * hudScale;
    [
      { label: "MAX", value: this.hudCachedJudgmentCounts[1], color: JUDGMENT_COLORS[1] },
      { label: "300", value: this.hudCachedJudgmentCounts[2], color: JUDGMENT_COLORS[2] },
      { label: "200", value: this.hudCachedJudgmentCounts[3], color: JUDGMENT_COLORS[3] },
      { label: "100", value: this.hudCachedJudgmentCounts[4], color: JUDGMENT_COLORS[4] },
      { label: "50", value: this.hudCachedJudgmentCounts[5], color: JUDGMENT_COLORS[5] },
      { label: "MISS", value: this.hudCachedJudgmentCounts[6], color: JUDGMENT_COLORS[6] },
      { label: "UR", value: this.hudCachedUr, color: "#b3f5ff" },
    ].forEach((item, index) => {
      const y = judgmentCounterY + index * 18 * hudScale;
      this.addText(item.label, judgmentCounterX, y, { fontSize: 10 * hudScale, fill: item.color, fontWeight: "700" });
      this.addText(item.value, judgmentCounterX + 52 * hudScale, y, {
        fontSize: 10 * hudScale,
        fill: "#ffffff",
        alpha: 0.88,
        fontWeight: "700",
        anchorX: 1,
      });
    });

    const urBarWidth = Math.min(playfieldWidth * 0.68, 180);
    const urBarX = playfieldCenterX - urBarWidth / 2;
    const receptorBottom = this.skinSettings.style === "circles"
      ? judgmentY + this.getCircleDiameter(layout) / 2
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
    if (this.renderComboImages(`${this.combo}x`, playfieldCenterX, comboY, layout)) return;
    this.addText(`${this.combo}x`, playfieldCenterX, comboY, {
      fontSize: Math.max(22, h * 0.05),
      fill: "#ffffff",
      alpha: 0.85,
      fontWeight: "700",
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

  private getHudScale(layout: Layout): number {
    if (!this.fullscreenLayout) return 1;
    return Math.min(1.45, Math.max(1, layout.layoutScale * 0.85));
  }

  private getJudgementAsset(judgment: Judgment): ReplaySkinImageAsset | undefined {
    const assets = this.skinProfile.assets.judgements;
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
          fontWeight: "700",
          anchorX: 0.5,
          anchorY: 0.5,
        });
      }
      x += size.width - overlap;
    });
    return true;
  }

  private getCircleDiameter(layout: Layout): number {
    const laneSizedDiameter = layout.laneWidth * 0.74;
    const minDiameter = this.barePlayfield ? 38 : 28;
    return Math.max(18, Math.min(layout.laneWidth - 4, Math.max(minDiameter, laneSizedDiameter)));
  }

  private getArrowSize(layout: Layout): number {
    const laneSized = layout.laneWidth * 0.86;
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
      fontWeight?: "400" | "700";
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

    const fontWeight = options.fontWeight ?? "400";
    const sig = `${options.fontSize}|${fontWeight}|${options.fill}`;
    if (label.__sig !== sig) {
      label.style.fontSize = options.fontSize;
      label.style.fontWeight = fontWeight;
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
    const texture = Texture.from(asset.src);
    this.skinTextureCache.set(asset.src, texture);
    return texture;
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
        sprite.height = layout.h;
        sprite.width = layout.h * imgAspect;
        sprite.x = (layout.w - sprite.width) / 2;
        sprite.y = 0;
      } else {
        sprite.width = layout.w;
        sprite.height = layout.w / imgAspect;
        sprite.x = 0;
        sprite.y = (layout.h - sprite.height) / 2;
      }
    }
  }

  destroy() {
    this.pause();
    this.destroyed = true;
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
