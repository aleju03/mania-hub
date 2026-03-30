import type { ReplayFrame } from "../../lib/types";
import type { ManiaNote } from "../../lib/beatmap-parser";

// Column colors for mania key modes (matching osu!mania circle skin)
const COLUMN_COLORS: Record<number, string[]> = {
  1: ["#fff"],
  2: ["#5a8fff", "#5a8fff"],
  3: ["#5a8fff", "#fff", "#5a8fff"],
  4: ["#5a8fff", "#de31ae", "#de31ae", "#5a8fff"],
  5: ["#5a8fff", "#de31ae", "#fff", "#de31ae", "#5a8fff"],
  6: ["#5a8fff", "#de31ae", "#fff", "#fff", "#de31ae", "#5a8fff"],
  7: ["#5a8fff", "#de31ae", "#fff", "#ffcc22", "#fff", "#de31ae", "#5a8fff"],
  8: ["#5a8fff", "#de31ae", "#fff", "#ffcc22", "#ffcc22", "#fff", "#de31ae", "#5a8fff"],
  9: ["#5a8fff", "#de31ae", "#fff", "#ffcc22", "#88da20", "#ffcc22", "#fff", "#de31ae", "#5a8fff"],
  10: ["#5a8fff", "#de31ae", "#fff", "#ffcc22", "#88da20", "#88da20", "#ffcc22", "#fff", "#de31ae", "#5a8fff"],
};

export class ManiaReplayRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frames: ReplayFrame[];
  private notes: ManiaNote[];
  private keyCount: number;
  private currentTime = 0;
  private playbackSpeed = 1;
  private _isPlaying = false;
  private scrollSpeed = 0.4;
  private animFrameId = 0;
  private lastRenderTime = 0;
  private colors: string[];
  private totalDuration: number;
  private segments: { start: number; end: number }[][];

  constructor(
    canvas: HTMLCanvasElement,
    frames: ReplayFrame[],
    keyCount: number,
    notes: ManiaNote[] = [],
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.frames = frames;
    this.notes = notes;
    this.keyCount = keyCount;
    this.colors = COLUMN_COLORS[keyCount] || this.generateColors(keyCount);

    const frameDuration = frames.length > 0 ? frames[frames.length - 1].time : 0;
    const noteDuration = notes.length > 0 ? Math.max(...notes.map((n) => n.endTime)) : 0;
    this.totalDuration = Math.max(frameDuration, noteDuration);

    this.segments = this.computeSegments();
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
    if (!this._isPlaying) this.render();
  }

  setSpeed(speed: number) { this.playbackSpeed = speed; }

  setZoom(zoom: number) {
    this.scrollSpeed = 0.2 + zoom * 0.4;
    if (!this._isPlaying) this.render();
  }

  get time() { return this.currentTime; }
  get duration() { return this.totalDuration; }

  private tick() {
    if (!this._isPlaying) return;
    const now = performance.now();
    const dt = (now - this.lastRenderTime) * this.playbackSpeed;
    this.lastRenderTime = now;
    this.currentTime += dt;
    if (this.currentTime >= this.totalDuration) { this.currentTime = this.totalDuration; this._isPlaying = false; }
    this.render();
    if (this._isPlaying) this.animFrameId = requestAnimationFrame(() => this.tick());
  }

  private render() {
    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1a1016";
    ctx.fillRect(0, 0, w, h);

    const colWidth = w / this.keyCount;
    const judgmentY = h * 0.88;
    const noteH = 12;

    // Column backgrounds
    for (let col = 0; col < this.keyCount; col++) {
      const x = col * colWidth;
      ctx.fillStyle = col % 2 === 0 ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)";
      ctx.fillRect(x, 0, colWidth, h);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    // Judgment line
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, judgmentY); ctx.lineTo(w, judgmentY); ctx.stroke();

    // Draw beatmap notes (scrolling down towards judgment line)
    if (this.notes.length > 0) {
      for (const note of this.notes) {
        const col = note.column;
        if (col >= this.keyCount) continue;

        const x = col * colWidth + 3;
        const barWidth = colWidth - 6;
        const color = this.colors[col];

        // Note Y: notes at current time appear at judgmentY, future notes scroll down from top
        const noteY = judgmentY - (note.time - this.currentTime) * this.scrollSpeed;

        if (note.isHold) {
          const endY = judgmentY - (note.endTime - this.currentTime) * this.scrollSpeed;
          const top = Math.min(noteY, endY);
          const bottom = Math.max(noteY, endY);
          if (top > h + 20 || bottom < -20) continue;

          // Hold body
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.roundRect(x + 2, top, barWidth - 4, bottom - top, 2);
          ctx.fill();

          // Hold head & tail
          ctx.globalAlpha = 0.9;
          ctx.beginPath(); ctx.roundRect(x, bottom - noteH, barWidth, noteH, 4); ctx.fill();
          ctx.beginPath(); ctx.roundRect(x, top, barWidth, noteH / 2, 2); ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          if (noteY > h + 20 || noteY < -20) continue;

          // Regular note
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.roundRect(x, noteY - noteH, barWidth, noteH, 4);
          ctx.fill();

          // Note highlight
          ctx.globalAlpha = 0.4;
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.roundRect(x + 2, noteY - noteH + 1, barWidth - 4, noteH / 3, 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }

    // Draw key press segments (from replay data) as overlay
    if (this.frames.length > 0) {
      for (let col = 0; col < this.keyCount; col++) {
        const x = col * colWidth + 2;
        const barWidth = colWidth - 4;
        const color = this.colors[col];

        for (const seg of this.segments[col]) {
          const startY = judgmentY - (seg.start - this.currentTime) * this.scrollSpeed;
          const endY = judgmentY - (seg.end - this.currentTime) * this.scrollSpeed;
          if (startY < -20 && endY < -20) continue;
          if (startY > h + 20 && endY > h + 20) continue;

          const top = Math.min(startY, endY);
          const bottom = Math.max(startY, endY);
          const barH = Math.max(bottom - top, 2);

          // Translucent overlay showing actual key presses
          ctx.fillStyle = color;
          ctx.globalAlpha = this.notes.length > 0 ? 0.25 : 0.8;
          ctx.beginPath();
          ctx.roundRect(x, top, barWidth, barH, 3);
          ctx.fill();

          if (top < judgmentY && bottom > judgmentY - 20) {
            ctx.globalAlpha = 0.15;
            ctx.shadowColor = color;
            ctx.shadowBlur = 12;
            ctx.fillRect(x, top, barWidth, barH);
            ctx.shadowBlur = 0;
          }
          ctx.globalAlpha = 1;
        }
      }
    }

    // Key press indicators at bottom
    const indicatorH = h * 0.07;
    const currentState = this.getCurrentKeyState();

    for (let col = 0; col < this.keyCount; col++) {
      const x = col * colWidth;
      const pressed = (currentState & (1 << col)) !== 0;

      ctx.fillStyle = pressed ? this.colors[col] : "rgba(255,255,255,0.05)";
      ctx.globalAlpha = pressed ? 0.9 : 0.5;
      ctx.beginPath();
      ctx.roundRect(x + 2, judgmentY, colWidth - 4, indicatorH, 3);
      ctx.fill();

      if (pressed) {
        ctx.shadowColor = this.colors[col];
        ctx.shadowBlur = 20;
        ctx.fillRect(x + 2, judgmentY, colWidth - 4, indicatorH);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    }

    // Time & speed
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "11px Torus, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${Math.floor(this.currentTime / 60000)}:${String(Math.floor((this.currentTime % 60000) / 1000)).padStart(2, "0")}`, 8, h - 8);
    ctx.textAlign = "right";
    ctx.fillText(`${this.playbackSpeed}x`, w - 8, h - 8);
  }

  private getCurrentKeyState(): number {
    let lo = 0, hi = this.frames.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.frames[mid].time <= this.currentTime) lo = mid; else hi = mid - 1; }
    return this.frames[lo]?.keyState ?? 0;
  }

  destroy() { this.pause(); }
}
