import type { ReplayFrame } from "../../lib/types";
import type { ManiaNote } from "../../lib/beatmap-parser";
import type { ManiaSkin } from "../../lib/skin-parser";
import { getNoteImage, getHoldHeadImage, getHoldBodyImage, getHoldTailImage, getKeyImage } from "../../lib/skin-parser";

// Column colors for mania key modes (matching osu!mania circle skin)
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

// osu!mania hit window formulas: base - 3 * OD (except MAX which is fixed at 16ms)
// speedRate (DT=1.5, HT=0.75) shrinks/expands windows like the real game.
function getHitWindows(od: number, speedRate = 1) {
  const s = 1 / speedRate;
  return {
    perfect: 16 * s,
    great: (64 - 3 * od) * s,
    good: (97 - 3 * od) * s,
    ok: (127 - 3 * od) * s,
    meh: (151 - 3 * od) * s,
    miss: (188 - 3 * od) * s,
  };
}

// Judgment type: 0=pending, 1=MAX, 2=300, 3=200, 4=100, 5=50, 6=miss
type Judgment = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const JUDGMENT_COLORS: Record<number, string> = {
  1: "#b3f5ff",  // MAX - rainbow/cyan
  2: "#ffcc22",  // 300 - yellow
  3: "#88da20",  // 200 - green
  4: "#5a8fff",  // 100 - blue
  5: "#cc8800",  // 50 - orange
  6: "#ff4444",  // miss - red
};

const JUDGMENT_LABELS: Record<number, string> = {
  1: "MAX", 2: "300", 3: "200", 4: "100", 5: "50", 6: "MISS",
};

// Scoring weights for accuracy (osu!mania)
const JUDGMENT_WEIGHTS: Record<number, number> = {
  1: 6, 2: 6, 3: 4, 4: 2, 5: 1, 6: 0,
};
const HOLD_VISUAL_GRACE_MS = 60;

interface RealJudgments {
  countGeki: number;  // MAX
  count300: number;
  countKatu: number;  // 200
  count100: number;
  count50: number;
  countMiss: number;
}

interface RendererOptions {
  backgroundImage?: HTMLImageElement;
  backgroundDim?: number;
  od?: number;
  showInputOverlay?: boolean;
  realJudgments?: RealJudgments;
  mods?: string[]; // mod acronyms, e.g. ["DT", "MR"]
}

interface Layout {
  w: number;
  h: number;
  playfieldWidth: number;
  playfieldX: number;
  laneWidth: number;
  judgmentY: number;
  noteHeight: number;
  receptorHeight: number;
  pixelsPerMs: number;
}

interface NoteHitResult {
  judgment: Judgment;     // 0=pending
  hitTime: number;        // when the note was judged
  releaseTime: number;    // matched segment end for hold visibility
  offsetMs: number;       // signed hit offset for UR/judgment visuals
}

type Hand = "left" | "right" | "center";

export class ManiaReplayRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frames: ReplayFrame[];
  private notes: ManiaNote[];
  private keyCount: number;
  private currentTime = 0;
  private playbackSpeed = 1;
  private modRate = 1;
  private _isPlaying = false;
  private scrollSpeed = 0.74; // default = speed 32: 0.1 + (32/40) * 0.8
  private animFrameId = 0;
  private lastRenderTime = 0;
  private colors: string[];
  private totalDuration: number;
  private segments: { start: number; end: number }[][];
  private maxHoldDuration: number;

  // Background
  private backgroundImage: HTMLImageElement | null = null;
  private backgroundDim = 80;
  private od = 8;
  private showInputOverlay = true;
  private skin: ManiaSkin | null = null;
  private realJudgments: RealJudgments | null = null;
  private realTotal = 0;

  // Receptor flash state
  private receptorFlashTimestamps: number[];

  // Hit detection results (pre-computed)
  private hitResults: NoteHitResult[];

  // Live stats (computed incrementally during playback)
  private combo = 0;
  private maxComboSoFar = 0;
  private statsScanIndex = 0;
  private judgmentCounts: number[] = [0, 0, 0, 0, 0, 0, 0]; // indexed by Judgment
  private leftHandMisses = 0;
  private rightHandMisses = 0;
  private recentHitOffsets: number[] = [];

  // Last judgment display
  private lastJudgment: Judgment = 0;
  private lastJudgmentTime = 0;

  constructor(
    canvas: HTMLCanvasElement,
    frames: ReplayFrame[],
    keyCount: number,
    notes: ManiaNote[] = [],
    options?: RendererOptions,
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.frames = frames;
    this.keyCount = keyCount;
    this.colors = COLUMN_COLORS[keyCount] || this.generateColors(keyCount);

    // Apply mod transformations to notes
    const mods = new Set((options?.mods ?? []).filter(Boolean).map((m) => m.toUpperCase()));
    const mirror = mods.has("MR");
    this.modRate = mods.has("DT") || mods.has("NC") ? 1.5 : mods.has("HT") ? 0.75 : 1;
    this.notes = mirror
      ? notes.map((n) => ({ ...n, column: keyCount - 1 - n.column }))
      : [...notes];

    this.backgroundImage = options?.backgroundImage ?? null;
    this.backgroundDim = options?.backgroundDim ?? 80;
    this.od = options?.od ?? 8;
    this.showInputOverlay = options?.showInputOverlay ?? true;
    this.realJudgments = options?.realJudgments ?? null;
    if (this.realJudgments) {
      const rj = this.realJudgments;
      this.realTotal = rj.countGeki + rj.count300 + rj.countKatu + rj.count100 + rj.count50 + rj.countMiss;
    }
    this.receptorFlashTimestamps = new Array(keyCount).fill(0);

    const frameDuration = frames.length > 0 ? frames[frames.length - 1].time : 0;
    const noteDuration = notes.length > 0 ? Math.max(...notes.map((n) => n.endTime)) : 0;
    this.totalDuration = Math.max(frameDuration, noteDuration);

    this.maxHoldDuration = 0;
    for (const n of notes) {
      if (n.isHold) {
        const dur = n.endTime - n.time;
        if (dur > this.maxHoldDuration) this.maxHoldDuration = dur;
      }
    }

    this.segments = this.computeSegments();
    this.hitResults = this.computeHitResults();
    this.resize();
    this.render();
  }

  private generateColors(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `hsl(${(i / n) * 360}, 70%, 60%)`);
  }

  private computeSegments(): { start: number; end: number }[][] {
    const segs: { start: number; end: number }[][] = Array.from({ length: this.keyCount }, () => []);
    const active: (number | null)[] = new Array(this.keyCount).fill(null);

    for (const frame of this.frames) {
      for (let col = 0; col < this.keyCount; col++) {
        const pressed = (frame.keyState & (1 << col)) !== 0;
        if (pressed && active[col] === null) {
          active[col] = frame.time;
        } else if (!pressed && active[col] !== null) {
          segs[col].push({ start: active[col]!, end: frame.time });
          active[col] = null;
        }
      }
    }
    for (let col = 0; col < this.keyCount; col++) {
      if (active[col] !== null) segs[col].push({ start: active[col]!, end: this.totalDuration });
    }

    return segs;
  }

  // Pre-compute hit results for every note by matching to replay key presses.
  // Each key press (segment) can only be consumed by one note per column.
  // Notes are processed per-column in time order for correct matching.
  private computeHitResults(): NoteHitResult[] {
    const results: NoteHitResult[] = new Array(this.notes.length);
    for (let i = 0; i < this.notes.length; i++) {
      results[i] = { judgment: 0, hitTime: 0, releaseTime: 0, offsetMs: 0 };
    }

    if (this.frames.length === 0 || this.notes.length === 0) return results;

    const hw = getHitWindows(this.od, this.modRate);

    // Group note indices by column
    const notesByCol: number[][] = Array.from({ length: this.keyCount }, () => []);
    for (let i = 0; i < this.notes.length; i++) {
      const col = this.notes[i].column;
      if (col < this.keyCount) notesByCol[col].push(i);
    }

    // Process each column independently
    for (let col = 0; col < this.keyCount; col++) {
      const colNotes = notesByCol[col];
      const colSegs = this.segments[col];
      let segStart = 0; // next unconsumed segment

      for (const noteIdx of colNotes) {
        const note = this.notes[noteIdx];

        // Advance past consumed/expired segments
        while (segStart < colSegs.length && colSegs[segStart].start < note.time - hw.miss) {
          segStart++;
        }

        // Find the first unconsumed segment whose start is within the hit window
        let matched = false;
        for (let s = segStart; s < colSegs.length; s++) {
          const seg = colSegs[s];
          if (seg.start > note.time + hw.miss) break;

          const delta = Math.abs(seg.start - note.time);
          let judgment: Judgment;
          if (delta <= hw.perfect) judgment = 1;
          else if (delta <= hw.great) judgment = 2;
          else if (delta <= hw.good) judgment = 3;
          else if (delta <= hw.ok) judgment = 4;
          else if (delta <= hw.meh) judgment = 5;
          else continue;

          // For hold notes, degrade judgment based on tail release timing.
          // Early release before the hold body ends by more than the miss
          // window counts as a miss. Otherwise tail windows are 1.75x head.
          if (note.isHold && note.endTime > note.time) {
            const earlyRelease = note.endTime - seg.end;
            if (earlyRelease > (hw.ok + hw.miss) / 2) {
              judgment = 6; // released way too early → miss
            } else {
              const tailDelta = Math.abs(seg.end - note.endTime);
              const ts = 1.75;
              let tailJudgment: Judgment;
              if (tailDelta <= hw.perfect * ts) tailJudgment = 1;
              else if (tailDelta <= hw.great * ts) tailJudgment = 2;
              else tailJudgment = 3; // caps at 200
              if (tailJudgment > judgment) judgment = tailJudgment;
            }
          }

          results[noteIdx] = {
            judgment,
            hitTime: seg.start,
            releaseTime: seg.end,
            offsetMs: seg.start - note.time,
          };
          segStart = s + 1;
          matched = true;
          break;
        }

        if (!matched) {
          results[noteIdx] = { judgment: 6, hitTime: note.time + hw.miss, releaseTime: 0, offsetMs: 0 };
        }
      }
    }

    return results;
  }

  // Recompute live stats (combo, accuracy) up to currentTime
  private recomputeStatsUpTo(time: number) {
    this.statsScanIndex = 0;
    this.combo = 0;
    this.maxComboSoFar = 0;
    this.judgmentCounts = [0, 0, 0, 0, 0, 0, 0];
    this.leftHandMisses = 0;
    this.rightHandMisses = 0;
    this.recentHitOffsets = [];
    this.advanceStats(time);
  }

  private advanceStats(upToTime?: number) {
    const time = upToTime ?? this.currentTime;
    while (this.statsScanIndex < this.notes.length) {
      const hr = this.hitResults[this.statsScanIndex];
      if (hr.judgment === 0) break; // pending (shouldn't happen with pre-computed)
      if (hr.hitTime > time) break;

      this.judgmentCounts[hr.judgment]++;
      if (hr.judgment <= 5) {
        // Hit (MAX through 50)
        this.combo++;
        if (this.combo > this.maxComboSoFar) this.maxComboSoFar = this.combo;
        this.recentHitOffsets.push(hr.offsetMs);
        if (this.recentHitOffsets.length > 40) this.recentHitOffsets.shift();
      } else {
        // Miss
        this.combo = 0;
        const hand = this.getHandForColumn(this.notes[this.statsScanIndex]?.column ?? -1);
        if (hand === "left") this.leftHandMisses++;
        if (hand === "right") this.rightHandMisses++;
      }

      this.lastJudgment = hr.judgment;
      this.lastJudgmentTime = hr.hitTime;
      this.statsScanIndex++;
    }
  }

  private getAccuracy(): number {
    const counts = this.getDisplayCounts();
    let totalWeight = 0;
    let totalNotes = 0;
    for (let j = 1; j <= 6; j++) {
      totalWeight += counts[j] * JUDGMENT_WEIGHTS[j];
      totalNotes += counts[j];
    }
    return totalNotes > 0 ? (totalWeight / (totalNotes * 6)) * 100 : 100;
  }

  // Returns judgment counts for display: uses live hit detection during
  // playback, but snaps to real header data once all notes are judged.
  private getDisplayCounts(): number[] {
    if (!this.realJudgments || this.realTotal === 0) return this.judgmentCounts;

    let judgedSoFar = 0;
    for (let j = 1; j <= 6; j++) judgedSoFar += this.judgmentCounts[j];

    if (judgedSoFar >= this.notes.length) {
      const rj = this.realJudgments;
      return [0, rj.countGeki, rj.count300, rj.countKatu, rj.count100, rj.count50, rj.countMiss];
    }

    return this.judgmentCounts;
  }

  private getHandForColumn(column: number): Hand {
    if (column < 0 || column >= this.keyCount) return "center";
    const leftCount = Math.floor(this.keyCount / 2);
    const rightStart = this.keyCount - leftCount;
    if (column < leftCount) return "left";
    if (column >= rightStart) return "right";
    return "center";
  }

  private getUr(): number {
    if (this.recentHitOffsets.length < 2) return 0;
    const mean = this.recentHitOffsets.reduce((sum, value) => sum + value, 0) / this.recentHitOffsets.length;
    const variance = this.recentHitOffsets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / this.recentHitOffsets.length;
    return Math.sqrt(variance) * 10;
  }

  // --- Layout ---

  private getLayout(): Layout {
    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;

    let playfieldWidth: number;
    let laneWidth: number;

    if (this.skin) {
      // Use skin column widths, scaled to fit canvas
      const skinTotalWidth = this.skin.config.columnWidth.reduce((a, b) => a + b, 0);
      const maxWidth = Math.min(w * 0.7, 60 * this.keyCount);
      const scale = Math.min(1, maxWidth / skinTotalWidth);
      playfieldWidth = skinTotalWidth * scale;
      laneWidth = playfieldWidth / this.keyCount; // average for layout reference
    } else {
      const baseRatio = 0.25 + this.keyCount * 0.025;
      playfieldWidth = Math.min(w * Math.min(baseRatio, 0.6), 50 * this.keyCount);
      laneWidth = playfieldWidth / this.keyCount;
    }

    const playfieldX = (w - playfieldWidth) / 2;
    // osu! stable HitPosition: higher value = closer to bottom.
    // Formula from lazer: bottomPadding = (480 - clamp(hitPos, 240, 480)) * 1.6
    // Then judgmentY = h - (bottomPadding / 480) * h (scale to canvas height)
    let judgmentY: number;
    if (this.skin) {
      const clamped = Math.max(240, Math.min(480, this.skin.config.hitPosition));
      const bottomPadding = (480 - clamped) * 1.6;
      judgmentY = h - (bottomPadding / (480 * 1.6)) * h;
    } else {
      judgmentY = h * 0.88;
    }
    const noteHeight = Math.max(10, h * 0.02);
    const receptorHeight = Math.max(6, h * 0.012);
    const pixelsPerMs = this.scrollSpeed;

    return { w, h, playfieldWidth, playfieldX, laneWidth, judgmentY, noteHeight, receptorHeight, pixelsPerMs };
  }

  // Get the X position and width of a specific column, accounting for skin column widths
  private getColumnLayout(col: number, layout: Layout): { x: number; width: number } {
    if (!this.skin) {
      return { x: layout.playfieldX + col * layout.laneWidth, width: layout.laneWidth };
    }
    const skinWidths = this.skin.config.columnWidth;
    const skinTotalWidth = skinWidths.reduce((a, b) => a + b, 0);
    const scale = layout.playfieldWidth / skinTotalWidth;
    let x = layout.playfieldX;
    for (let i = 0; i < col; i++) {
      x += skinWidths[i] * scale;
    }
    return { x, width: skinWidths[col] * scale };
  }

  // --- Public API ---

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
  }

  play() {
    if (this._isPlaying) return;
    this._isPlaying = true;
    this.lastRenderTime = performance.now();
    this.tick();
  }

  pause() {
    this._isPlaying = false;
    if (this.animFrameId) { cancelAnimationFrame(this.animFrameId); this.animFrameId = 0; }
  }

  get isPlaying() { return this._isPlaying; }

  seek(timeMs: number) {
    this.currentTime = Math.max(0, Math.min(timeMs, this.totalDuration));
    this.recomputeStatsUpTo(this.currentTime);
    if (!this._isPlaying) this.render();
  }

  setSpeed(speed: number) { this.playbackSpeed = speed; }

  setScrollSpeed(speed: number) {
    // osu!mania scroll speed 1-40 → pixels per ms
    this.scrollSpeed = 0.1 + (speed / 40) * 0.8;
    if (!this._isPlaying) this.render();
  }

  setBackgroundDim(dim: number) {
    this.backgroundDim = dim;
    if (!this._isPlaying) this.render();
  }

  setBackgroundImage(img: HTMLImageElement) {
    this.backgroundImage = img;
    if (!this._isPlaying) this.render();
  }

  setShowInputOverlay(show: boolean) {
    this.showInputOverlay = show;
    if (!this._isPlaying) this.render();
  }

  setSkin(skin: ManiaSkin | null) {
    this.skin = skin;
    if (!this._isPlaying) this.render();
  }

  get time() { return this.currentTime; }
  get duration() { return this.totalDuration; }

  // --- Tick loop ---

  private tick() {
    if (!this._isPlaying) return;
    const now = performance.now();
    const dt = (now - this.lastRenderTime) * this.playbackSpeed * this.modRate;
    this.lastRenderTime = now;
    this.currentTime += dt;
    if (this.currentTime >= this.totalDuration) { this.currentTime = this.totalDuration; this._isPlaying = false; }
    this.advanceStats();
    this.render();
    if (this._isPlaying) this.animFrameId = requestAnimationFrame(() => this.tick());
  }

  // --- Rendering ---

  private render() {
    const layout = this.getLayout();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, layout.w, layout.h);

    this.renderBackground(ctx, layout);
    this.renderPlayfield(ctx, layout);
    this.renderSegmentOverlays(ctx, layout);

    // keysUnderNotes: draw receptors before notes so notes render on top
    if (this.skin?.config.keysUnderNotes) {
      this.renderReceptors(ctx, layout);
      this.renderJudgmentLine(ctx, layout);
      this.renderNotes(ctx, layout);
    } else {
      this.renderNotes(ctx, layout);
      this.renderJudgmentLine(ctx, layout);
      this.renderReceptors(ctx, layout);
    }
    this.renderHUD(ctx, layout);
  }

  private renderBackground(ctx: CanvasRenderingContext2D, layout: Layout) {
    const { w, h } = layout;

    if (this.backgroundImage) {
      const imgAspect = this.backgroundImage.width / this.backgroundImage.height;
      const canvasAspect = w / h;
      let dw: number, dh: number, dx: number, dy: number;

      if (imgAspect > canvasAspect) {
        dh = h; dw = h * imgAspect;
        dx = (w - dw) / 2; dy = 0;
      } else {
        dw = w; dh = w / imgAspect;
        dx = 0; dy = (h - dh) / 2;
      }

      ctx.drawImage(this.backgroundImage, dx, dy, dw, dh);
      ctx.fillStyle = `rgba(0, 0, 0, ${this.backgroundDim / 100})`;
      ctx.fillRect(0, 0, w, h);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#0a0a18");
      grad.addColorStop(0.5, "#1a1016");
      grad.addColorStop(1, "#0c0c14");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
  }

  private renderPlayfield(ctx: CanvasRenderingContext2D, layout: Layout) {
    const { w, h, playfieldX, playfieldWidth } = layout;

    // Darken areas outside the playfield
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fillRect(0, 0, playfieldX, h);
    ctx.fillRect(playfieldX + playfieldWidth, 0, w - playfieldX - playfieldWidth, h);

    // Lane backgrounds
    for (let col = 0; col < this.keyCount; col++) {
      const { x, width } = this.getColumnLayout(col, layout);
      if (this.skin && this.skin.config.columnColors[col]) {
        ctx.fillStyle = this.skin.config.columnColors[col];
        ctx.fillRect(x, 0, width, h);
      } else {
        ctx.fillStyle = col % 2 === 0 ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)";
        ctx.fillRect(x, 0, width, h);
      }
    }

    // Lane dividers
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= this.keyCount; i++) {
      const { x } = i < this.keyCount ? this.getColumnLayout(i, layout) : { x: playfieldX + playfieldWidth };
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Stage borders (skin images or default strokes)
    if (this.skin?.images.stageLeft) {
      const img = this.skin.images.stageLeft;
      const borderWidth = Math.max(8, img.width * (h / img.height));
      ctx.drawImage(img, playfieldX - borderWidth, 0, borderWidth, h);
    }
    if (this.skin?.images.stageRight) {
      const img = this.skin.images.stageRight;
      const borderWidth = Math.max(8, img.width * (h / img.height));
      ctx.drawImage(img, playfieldX + playfieldWidth, 0, borderWidth, h);
    }
    if (!this.skin?.images.stageLeft && !this.skin?.images.stageRight) {
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 2;
      ctx.strokeRect(playfieldX, 0, playfieldWidth, h);
    }
  }

  private renderNotes(ctx: CanvasRenderingContext2D, layout: Layout) {
    const { judgmentY, noteHeight, pixelsPerMs, h } = layout;

    if (this.notes.length === 0) return;

    const timeWindow = judgmentY / pixelsPerMs;
    const visibleMinTime = this.currentTime - timeWindow * 0.15;
    const visibleMaxTime = this.currentTime + timeWindow * 1.1;

    let startIdx = this.binarySearchNoteIndex(visibleMinTime - this.maxHoldDuration);

    for (let i = startIdx; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.time > visibleMaxTime) break;

      const col = note.column;
      if (col >= this.keyCount) continue;

      const hr = this.hitResults[i];
      if (hr.judgment !== 0 && hr.hitTime <= this.currentTime) {
        if (note.isHold && hr.judgment <= 5 && note.endTime > this.currentTime) {
          // Still holding — render the remaining portion
        } else {
          continue;
        }
      }

      const { x: colX, width: colWidth } = this.getColumnLayout(col, layout);
      const x = colX + 3;
      const barWidth = colWidth - 6;
      const color = this.colors[col];

      if (note.isHold) {
        let headY = judgmentY - (note.time - this.currentTime) * pixelsPerMs;
        const tailY = judgmentY - (note.endTime - this.currentTime) * pixelsPerMs;
        const awaitingJudgment = hr.hitTime > this.currentTime;
        const shouldLetPassLine = awaitingJudgment && note.time < this.currentTime - 10;
        const withinMatchedSegment = this.currentTime < hr.releaseTime;
        const stillPhysicallyHeld = withinMatchedSegment || this.isColumnEffectivelyHeldAtTime(col, this.currentTime);
        const releasedEarly =
          hr.judgment >= 1 &&
          hr.judgment <= 5 &&
          this.currentTime < note.endTime &&
          !stillPhysicallyHeld;

        if (!shouldLetPassLine) {
          headY = Math.min(headY, judgmentY);
        }
        const top = Math.min(headY, tailY);
        let bottom = Math.max(headY, tailY);

        if (!shouldLetPassLine) {
          bottom = Math.min(bottom, judgmentY);
        }

        if (top > h + 20 || bottom < -20) continue;

        const bodyImg = this.skin ? getHoldBodyImage(this.skin, col) : null;
        const headImg = this.skin ? getHoldHeadImage(this.skin, col) : null;
        const tailImg = this.skin ? getHoldTailImage(this.skin, col) : null;

        ctx.globalAlpha = releasedEarly ? 0.45 : 1;

        // Hold body — stretch to fill the full hold duration
        if (bodyImg) {
          ctx.drawImage(bodyImg, colX, top, colWidth, bottom - top);
        } else {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(x, top, barWidth, bottom - top, 2);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.globalAlpha = releasedEarly ? 0.55 : 1;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Hold head — draw at bottom of hold body, same height as regular notes
        ctx.globalAlpha = releasedEarly ? 0.65 : 1;
        if (bottom > top + noteHeight) {
          if (headImg) {
            const imgH = this.getSkinNoteHeight(headImg, colWidth, noteHeight);
            ctx.drawImage(headImg, colX, bottom - imgH, colWidth, imgH);
          } else {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.roundRect(x, bottom - noteHeight, barWidth, noteHeight, 4);
            ctx.fill();
          }
        }

        // Hold tail — draw at top of hold body (skip if image is trivially small like 1x1 transparent pixel)
        if (tailImg && tailImg.width > 2 && tailImg.height > 2) {
          const imgH = this.getSkinNoteHeight(tailImg, colWidth, noteHeight * 0.6);
          ctx.drawImage(tailImg, colX, top, colWidth, imgH);
        } else if (!tailImg) {
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.roundRect(x, top, barWidth, noteHeight / 2, 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else {
        if (note.time < this.currentTime - 10 && hr.hitTime > this.currentTime) continue;

        const noteY = judgmentY - (note.time - this.currentTime) * pixelsPerMs;
        if (noteY > h + 20 || noteY < -20) continue;

        const noteImg = this.skin ? getNoteImage(this.skin, col) : null;

        if (noteImg) {
          const imgH = this.getSkinNoteHeight(noteImg, colWidth, noteHeight);
          ctx.drawImage(noteImg, colX, noteY - imgH, colWidth, imgH);
        } else {
          // Default canvas rendering
          ctx.fillStyle = color;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.roundRect(x, noteY - noteHeight, barWidth, noteHeight, 4);
          ctx.fill();

          ctx.save();
          ctx.shadowColor = color;
          ctx.shadowBlur = 5;
          ctx.fill();
          ctx.restore();

          ctx.globalAlpha = 0.2;
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.roundRect(x + 2, noteY - noteHeight + 1, barWidth - 4, noteHeight / 3, 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  private renderSegmentOverlays(ctx: CanvasRenderingContext2D, layout: Layout) {
    const { judgmentY, pixelsPerMs, h } = layout;

    if (this.frames.length === 0 || !this.showInputOverlay) return;

    const timeWindow = judgmentY / pixelsPerMs;
    const visibleMinTime = this.currentTime - timeWindow * 0.15;
    const visibleMaxTime = this.currentTime + timeWindow * 1.1;
    const hasNotes = this.notes.length > 0;
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

        const hr = this.hitResults[i];
        if (hr.judgment !== 0 && hr.hitTime <= this.currentTime) {
          if (!(hr.judgment <= 5 && note.endTime > this.currentTime)) {
            continue;
          }
        }

        let headY = judgmentY - (note.time - this.currentTime) * pixelsPerMs;
        const tailY = judgmentY - (note.endTime - this.currentTime) * pixelsPerMs;
        headY = Math.min(headY, judgmentY);

        const top = Math.min(headY, tailY);
        const bottom = Math.min(Math.max(headY, tailY), judgmentY);
        if (top > h + 20 || bottom < -20 || bottom - top <= 0) continue;

        holdOcclusionRanges[note.column].push({ top, bottom });
      }

      holdOcclusionRanges.forEach((ranges) => {
        ranges.sort((a, b) => a.top - b.top);
      });
    }

    for (let col = 0; col < this.keyCount; col++) {
      const { x: colX, width: colWidth } = this.getColumnLayout(col, layout);
      const x = colX + 2;
      const barWidth = colWidth - 4;
      const color = this.colors[col];
      const occlusions = holdOcclusionRanges[col];

      for (const seg of this.segments[col]) {
        if (seg.end < this.currentTime - timeWindow * 0.15) continue;
        if (seg.start > this.currentTime + timeWindow * 1.1) break;

        const startY = judgmentY - (seg.start - this.currentTime) * pixelsPerMs;
        const endY = judgmentY - (seg.end - this.currentTime) * pixelsPerMs;
        if (startY < -20 && endY < -20) continue;
        if (startY > h + 20 && endY > h + 20) continue;

        const top = Math.min(startY, endY);
        const bottom = Math.min(Math.max(startY, endY), judgmentY);
        let cursor = top;

        const drawOverlayPiece = (pieceTop: number, pieceBottom: number) => {
          const barH = Math.max(pieceBottom - pieceTop, 2);
          if (barH <= 0) return;

          ctx.fillStyle = hasNotes ? "#a855f7" : color;
          ctx.globalAlpha = hasNotes ? 0.18 : 0.7;
          ctx.beginPath();
          ctx.roundRect(x, pieceTop, barWidth, barH, 3);
          ctx.fill();

          if (pieceTop < judgmentY && pieceBottom > judgmentY - 20) {
            ctx.globalAlpha = 0.08;
            ctx.save();
            ctx.shadowColor = "#a855f7";
            ctx.shadowBlur = 12;
            ctx.fillRect(x, pieceTop, barWidth, barH);
            ctx.restore();
          }
          ctx.globalAlpha = 1;
        };

        if (!occlusions.length) {
          drawOverlayPiece(top, bottom);
          continue;
        }

        for (const range of occlusions) {
          if (range.bottom <= cursor) continue;
          if (range.top >= bottom) break;

          if (range.top > cursor) {
            drawOverlayPiece(cursor, Math.min(range.top, bottom));
          }
          cursor = Math.max(cursor, range.bottom);
          if (cursor >= bottom) break;
        }

        if (cursor < bottom) {
          drawOverlayPiece(cursor, bottom);
        }
      }
    }
  }

  private renderJudgmentLine(ctx: CanvasRenderingContext2D, layout: Layout) {
    const { playfieldX, playfieldWidth, judgmentY } = layout;

    if (this.skin?.images.stageHint) {
      const img = this.skin.images.stageHint;
      // Stage hint is a thin bar at the judgment line — cap height to stay subtle
      const hintHeight = Math.min(Math.max(4, layout.h * 0.015), 12);
      ctx.drawImage(img, playfieldX, judgmentY - hintHeight / 2, playfieldWidth, hintHeight);
    } else {
      ctx.save();
      ctx.shadowColor = "#ffffff";
      ctx.shadowBlur = 8;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playfieldX, judgmentY);
      ctx.lineTo(playfieldX + playfieldWidth, judgmentY);
      ctx.stroke();
      ctx.restore();
    }
  }

  private renderReceptors(ctx: CanvasRenderingContext2D, layout: Layout) {
    const { judgmentY, receptorHeight } = layout;
    const currentState = this.getCurrentKeyState();

    for (let col = 0; col < this.keyCount; col++) {
      const { x, width: colWidth } = this.getColumnLayout(col, layout);
      const pressed = (currentState & (1 << col)) !== 0;
      const color = this.colors[col];

      if (pressed) {
        this.receptorFlashTimestamps[col] = this.currentTime;
      }

      const timeSinceFlash = this.currentTime - (this.receptorFlashTimestamps[col] || 0);
      const flashIntensity = pressed ? 1.0 : Math.max(0, 1.0 - timeSinceFlash / 120);

      // Skin key images
      const keyImg = this.skin ? getKeyImage(this.skin, col, pressed) : null;

      if (keyImg) {
        // Draw skin key image at judgment line, same sizing logic as notes
        const imgH = this.getSkinNoteHeight(keyImg, colWidth, receptorHeight + 6);
        ctx.globalAlpha = pressed ? 1 : 0.8;
        ctx.drawImage(keyImg, x, judgmentY + 2, colWidth, imgH);
        ctx.globalAlpha = 1;

        // Column glow on press
        if (flashIntensity > 0 && this.skin?.images.stageLight) {
          const lightImg = this.skin.images.stageLight;
          const lightH = Math.min(100, colWidth * (lightImg.height / lightImg.width));
          const lightColor = this.skin.config.columnLightColors[col];
          ctx.globalAlpha = 0.5 * flashIntensity;
          ctx.drawImage(lightImg, x, judgmentY - lightH, colWidth, lightH);
          ctx.globalAlpha = 1;
          if (lightColor) {
            ctx.fillStyle = lightColor;
            ctx.globalAlpha = 0.15 * flashIntensity;
            ctx.fillRect(x, judgmentY - lightH, colWidth, lightH);
            ctx.globalAlpha = 1;
          }
        } else if (flashIntensity > 0) {
          // Default beam glow even with skin keys
          const grad = ctx.createLinearGradient(x, judgmentY - 80, x, judgmentY + 15);
          grad.addColorStop(0, "transparent");
          grad.addColorStop(0.6, this.colorWithAlpha(color, 0.2 * flashIntensity));
          grad.addColorStop(1, this.colorWithAlpha(color, 0.7 * flashIntensity));
          ctx.fillStyle = grad;
          ctx.fillRect(x, judgmentY - 80, colWidth, 95);
        }
      } else if (flashIntensity > 0) {
        const grad = ctx.createLinearGradient(x, judgmentY - 80, x, judgmentY + 15);
        grad.addColorStop(0, "transparent");
        grad.addColorStop(0.6, this.colorWithAlpha(color, 0.2 * flashIntensity));
        grad.addColorStop(1, this.colorWithAlpha(color, 0.7 * flashIntensity));
        ctx.fillStyle = grad;
        ctx.fillRect(x, judgmentY - 80, colWidth, 95);

        ctx.fillStyle = color;
        ctx.globalAlpha = flashIntensity;
        ctx.beginPath();
        ctx.roundRect(x + 3, judgmentY + 2, colWidth - 6, receptorHeight, 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.roundRect(x + 3, judgmentY + 2, colWidth - 6, receptorHeight, 2);
        ctx.fill();
      }
    }
  }

  private renderHUD(ctx: CanvasRenderingContext2D, layout: Layout) {
    const { w, h, playfieldX, playfieldWidth, judgmentY } = layout;
    const playfieldCenterX = playfieldX + playfieldWidth / 2;
    const playfieldMiddleY = judgmentY * 0.5; // vertical center of the play area

    // --- Judgment text (centered in playfield, fades out) ---
    if (this.lastJudgment > 0) {
      const timeSince = this.currentTime - this.lastJudgmentTime;
      if (timeSince < 400) {
        const alpha = Math.max(0, 1.0 - timeSince / 400);
        const jColor = JUDGMENT_COLORS[this.lastJudgment];
        const label = JUDGMENT_LABELS[this.lastJudgment];
        const offsetY = -timeSince * 0.03;

        ctx.save();
        ctx.font = `bold ${Math.max(16, h * 0.035)}px Torus, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = jColor;
        ctx.globalAlpha = alpha;
        ctx.fillText(label, playfieldCenterX, playfieldMiddleY + offsetY);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    // --- Combo (centered in playfield, above judgment) ---
    if (this.combo > 0) {
      ctx.save();
      const fontSize = Math.max(22, h * 0.05);
      ctx.font = `bold ${fontSize}px Torus, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.fillText(`${this.combo}x`, playfieldCenterX, playfieldMiddleY - h * 0.06);
      ctx.restore();
    }

    // --- Live accuracy (top-right outside the playfield) ---
    const acc = this.getAccuracy();
    ctx.save();
    ctx.font = `bold ${Math.max(16, h * 0.032)}px Torus, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fillText(`${acc.toFixed(2)}%`, playfieldX + playfieldWidth + 16, 16);
    ctx.restore();

    // --- Left-side key overlay + hand misses ---
    const currentState = this.getCurrentKeyState();
    const keyBoxSize = 32;
    const keyGap = 6;
    const keyRowWidth = this.keyCount * keyBoxSize + Math.max(0, this.keyCount - 1) * keyGap;
    const keyRowX = Math.max(12, playfieldX - keyRowWidth - 18);
    const keyRowY = judgmentY - 36;

    for (let col = 0; col < this.keyCount; col++) {
      const x = keyRowX + col * (keyBoxSize + keyGap);
      const pressed = (currentState & (1 << col)) !== 0;
      const color = this.colors[col];

      ctx.fillStyle = "rgba(10, 10, 18, 0.82)";
      ctx.fillRect(x, keyRowY, keyBoxSize, keyBoxSize);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, keyRowY, keyBoxSize, keyBoxSize);

      if (pressed) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.fillRect(x + 1, keyRowY + 1, keyBoxSize - 2, keyBoxSize - 2);
      } else {
        ctx.fillStyle = this.colorWithAlpha(color, 0.18);
        ctx.fillRect(x + 1, keyRowY + 1, keyBoxSize - 2, keyBoxSize - 2);
      }

      ctx.globalAlpha = 1;
      ctx.font = "bold 14px Torus, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = pressed ? "rgba(10,10,18,0.9)" : "rgba(255,255,255,0.75)";
      ctx.fillText(String(col + 1), x + keyBoxSize / 2, keyRowY + keyBoxSize / 2 + 0.5);
    }

    const missStats = [
      { label: "L MISS", value: String(this.leftHandMisses), color: "#5a8fff" },
      { label: "R MISS", value: String(this.rightHandMisses), color: "#de31ae" },
    ];
    missStats.forEach((item, index) => {
      const x = keyRowX + index * 68;
      const y = keyRowY + keyBoxSize + 10;
      ctx.fillStyle = "rgba(10, 10, 18, 0.78)";
      ctx.fillRect(x, y, 60, 36);
      ctx.fillStyle = item.color;
      ctx.fillRect(x, y, 3, 36);
      ctx.font = "bold 9px Torus, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(255,255,255,0.58)";
      ctx.fillText(item.label, x + 9, y + 5);
      ctx.font = "bold 16px Torus, sans-serif";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillText(item.value, x + 9, y + 32);
    });

    // --- Right-side live judgment counter ---
    const judgmentCounterX = playfieldX + playfieldWidth + 16;
    const judgmentCounterY = 52;
    const displayCounts = this.getDisplayCounts();
    const judgmentItems = [
      { label: "MAX", value: displayCounts[1], color: JUDGMENT_COLORS[1] },
      { label: "300", value: displayCounts[2], color: JUDGMENT_COLORS[2] },
      { label: "200", value: displayCounts[3], color: JUDGMENT_COLORS[3] },
      { label: "100", value: displayCounts[4], color: JUDGMENT_COLORS[4] },
      { label: "50", value: displayCounts[5], color: JUDGMENT_COLORS[5] },
      { label: "MISS", value: displayCounts[6], color: JUDGMENT_COLORS[6] },
    ];

    judgmentItems.forEach((item, index) => {
      const y = judgmentCounterY + index * 18;
      ctx.font = "bold 10px Torus, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = item.color;
      ctx.fillText(item.label, judgmentCounterX, y);
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fillText(String(item.value), judgmentCounterX + 52, y);
    });

    // --- Bottom-center UR bar ---
    const urBarWidth = Math.min(playfieldWidth * 0.68, 180);
    const urBarX = playfieldCenterX - urBarWidth / 2;
    const urBarY = h - 26;
    const urRange = getHitWindows(this.od).meh;

    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(urBarX, urBarY, urBarWidth, 3);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(playfieldCenterX - 1, urBarY - 4, 2, 11);

    this.recentHitOffsets.forEach((offset, index) => {
      const normalized = Math.max(-1, Math.min(1, offset / urRange));
      const x = playfieldCenterX + normalized * (urBarWidth / 2);
      const alpha = 0.2 + ((index + 1) / this.recentHitOffsets.length) * 0.8;
      ctx.fillStyle = this.colorWithAlpha("#b3f5ff", alpha);
      ctx.fillRect(x - 1.5, urBarY - 3, 3, 9);
    });

    ctx.font = "bold 10px Torus, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.fillText(`UR ${this.getUr().toFixed(0)}`, playfieldCenterX, urBarY - 6);

    // --- Time display (bottom-left) ---
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "11px Torus, sans-serif";
    ctx.textAlign = "left";
    const mins = Math.floor(this.currentTime / 60000);
    const secs = String(Math.floor((this.currentTime % 60000) / 1000)).padStart(2, "0");
    ctx.fillText(`${mins}:${secs}`, 8, h - 8);

    // Speed display (bottom-right)
    ctx.textAlign = "right";
    ctx.fillText(`${this.playbackSpeed * this.modRate}x`, w - 8, h - 8);
  }

  // --- Utilities ---

  private getCurrentKeyState(): number {
    let lo = 0, hi = this.frames.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.frames[mid].time <= this.currentTime) lo = mid; else hi = mid - 1; }
    return this.frames[lo]?.keyState ?? 0;
  }

  private isColumnPressedAtTime(column: number, time: number): boolean {
    if (column < 0 || column >= this.keyCount) return false;
    const segments = this.segments[column];
    for (const seg of segments) {
      if (seg.start > time) break;
      if (seg.start <= time && seg.end > time) return true;
    }
    return false;
  }

  private isColumnEffectivelyHeldAtTime(column: number, time: number, graceMs = HOLD_VISUAL_GRACE_MS): boolean {
    if (column < 0 || column >= this.keyCount) return false;
    const segments = this.segments[column];
    for (const seg of segments) {
      if (seg.start > time + graceMs) break;
      if (seg.start - graceMs <= time && seg.end + graceMs > time) return true;
    }
    return false;
  }

  private binarySearchNoteIndex(targetTime: number): number {
    let lo = 0, hi = this.notes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].time < targetTime) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Calculate note height for skin images. Skin note images are drawn at column width;
  // height preserves aspect ratio but is capped to avoid oversized rendering.
  // @2x images have double pixel density, so their logical size is halved.
  private getSkinNoteHeight(img: HTMLImageElement, colWidth: number, minHeight: number): number {
    // Detect @2x: if the image is significantly larger than expected column width
    const is2x = img.width > colWidth * 1.5;
    const logicalW = is2x ? img.width / 2 : img.width;
    const logicalH = is2x ? img.height / 2 : img.height;
    const aspectH = colWidth * (logicalH / logicalW);
    // Cap height: notes should not be taller than the column width (for circles/squares)
    return Math.max(minHeight, Math.min(aspectH, colWidth));
  }

  private colorWithAlpha(hexColor: string, alpha: number): string {
    let r = 0, g = 0, b = 0;
    if (hexColor.startsWith("#")) {
      const hex = hexColor.slice(1);
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else if (hex.length === 6) {
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      }
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  destroy() { this.pause(); }
}
