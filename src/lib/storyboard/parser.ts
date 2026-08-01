// Streaming parser for osu! storyboard events (.osb files and the [Events]
// section of .osu files). Elements compile straight into the compact
// per-channel segment arrays the evaluator consumes, so a million-command
// storyboard never holds a million command objects at once.
//
// Supported: [Variables] substitution, Sprite/Animation declarations (word or
// numeric event types), F/M/MX/MY/S/V/R/C/P commands with easing, chained
// value shorthand, standard loops (L). Triggers (T) are parsed and skipped,
// Sample/Video events are counted but not rendered.

import {
  SB_CHANNEL_COUNT,
  SB_CHAN_ALPHA,
  SB_CHAN_COLOR_B,
  SB_CHAN_COLOR_G,
  SB_CHAN_COLOR_R,
  SB_CHAN_ROTATION,
  SB_CHAN_SCALE_X,
  SB_CHAN_SCALE_Y,
  SB_CHAN_X,
  SB_CHAN_Y,
  SB_PARAM_ADDITIVE,
  SB_PARAM_FLIP_H,
  SB_PARAM_FLIP_V,
  SB_SEG_STRIDE,
  type CompiledStoryboardSprite,
  type StoryboardParamInterval,
  type StoryboardParamType,
  type StoryboardParseResult,
} from "./types";

// Backstops against hostile or broken files (e.g. a loop with a huge count).
// A real heavy storyboard (Mawaru VIP) has ~1.05M segments total.
const DEFAULT_MAX_TOTAL_SEGMENTS = 6_000_000;
const DEFAULT_MAX_SEGMENTS_PER_SPRITE = 250_000;
const MAX_LOOP_ITERATIONS = 100_000;
const MAX_ANIMATION_FRAMES = 1_000;

interface PendingSegment {
  chan: number;
  easing: number;
  start: number;
  end: number;
  from: number;
  to: number;
  idx: number;
}

interface PendingParam {
  type: StoryboardParamType;
  start: number;
  end: number; // Infinity marks "until the sprite's lifetime ends"
}

interface PendingSprite {
  layer: number;
  originX: number;
  originY: number;
  filePath: string;
  framePaths: string[] | null;
  frameDelay: number;
  frameLoopForever: boolean;
  x: number;
  y: number;
  segs: PendingSegment[];
  params: PendingParam[];
}

interface PendingLoop {
  start: number;
  count: number;
  trigger: boolean;
  segs: PendingSegment[];
  params: PendingParam[];
}

export interface StoryboardParserOptions {
  startOrder?: number;
  maxTotalSegments?: number;
  maxSegmentsPerSprite?: number;
}

const ORIGIN_ANCHORS: Record<string, [number, number]> = {
  topleft: [0, 0],
  centre: [0.5, 0.5],
  center: [0.5, 0.5],
  centreleft: [0, 0.5],
  topright: [1, 0],
  bottomcentre: [0.5, 1],
  bottomcenter: [0.5, 1],
  topcentre: [0.5, 0],
  topcenter: [0.5, 0],
  custom: [0, 0],
  centreright: [1, 0.5],
  centerright: [1, 0.5],
  bottomleft: [0, 1],
  bottomright: [1, 1],
  "0": [0, 0],
  "1": [0.5, 0.5],
  "2": [0, 0.5],
  "3": [1, 0],
  "4": [0.5, 1],
  "5": [0.5, 0],
  "6": [0, 0],
  "7": [1, 0.5],
  "8": [0, 1],
  "9": [1, 1],
};

const LAYER_INDICES: Record<string, number> = {
  background: 0,
  fail: 1,
  pass: 2,
  foreground: 3,
  overlay: 4,
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
};

export function normalizeStoryboardPath(path: string): string {
  let p = path.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  p = p.replace(/\\/g, "/").toLowerCase();
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  return p;
}

// Frame index goes before the extension: "sb/frame.png" x3 ->
// sb/frame0.png, sb/frame1.png, sb/frame2.png.
export function getAnimationFramePaths(basePath: string, frameCount: number): string[] {
  const count = Math.min(Math.max(1, Math.floor(frameCount)), MAX_ANIMATION_FRAMES);
  const dot = basePath.lastIndexOf(".");
  const slash = basePath.lastIndexOf("/");
  const stem = dot > slash ? basePath.slice(0, dot) : basePath;
  const ext = dot > slash ? basePath.slice(dot) : "";
  const frames: string[] = new Array(count);
  for (let i = 0; i < count; i++) frames[i] = `${stem}${i}${ext}`;
  return frames;
}

// Comma split that keeps quoted file paths (which may contain commas) intact.
export function splitStoryboardLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

export class StoryboardParser {
  private readonly maxTotalSegments: number;
  private readonly maxSegmentsPerSprite: number;

  private section: "events" | "variables" | "other" = "other";
  private variables: [string, string][] = [];
  private variablesSorted = false;
  private current: PendingSprite | null = null;
  private loop: PendingLoop | null = null;
  private order: number;
  private segIdx = 0;

  private sprites: CompiledStoryboardSprite[] = [];
  private referencedPaths = new Set<string>();
  private segmentCount = 0;
  private droppedSegments = 0;
  private sampleCount = 0;
  private videoCount = 0;
  private triggerCount = 0;

  constructor(options: StoryboardParserOptions = {}) {
    this.order = options.startOrder ?? 0;
    this.maxTotalSegments = options.maxTotalSegments ?? DEFAULT_MAX_TOTAL_SEGMENTS;
    this.maxSegmentsPerSprite = options.maxSegmentsPerSprite ?? DEFAULT_MAX_SEGMENTS_PER_SPRITE;
  }

  // Call between files: closes any open element and resets section state so a
  // .osu fed after a .osb starts clean (variables are kept; only .osb files
  // declare them, and .osu events may still be fed through the same parser).
  beginFile(): void {
    this.closeSprite();
    this.section = "other";
  }

  feedLine(rawLine: string): void {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) return;

    const first = line.charCodeAt(0);
    // Section headers and variable declarations never start with whitespace.
    if (first === 91 /* [ */) {
      this.closeSprite();
      const trimmed = line.trim();
      if (trimmed === "[Events]") this.section = "events";
      else if (trimmed === "[Variables]") this.section = "variables";
      else this.section = "other";
      return;
    }

    if (this.section === "variables") {
      if (first === 36 /* $ */) {
        const eq = line.indexOf("=");
        if (eq > 1) {
          this.variables.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
          this.variablesSorted = false;
        }
      }
      return;
    }

    if (this.section !== "events") return;
    if (first === 47 /* / */ && line.charCodeAt(1) === 47) return;

    if (first === 32 /* space */ || first === 95 /* _ */) {
      this.feedCommandLine(line);
      return;
    }

    this.feedElementLine(line);
  }

  finish(): StoryboardParseResult {
    this.closeSprite();
    return {
      sprites: this.sprites,
      referencedPaths: this.referencedPaths,
      segmentCount: this.segmentCount,
      droppedSegments: this.droppedSegments,
      sampleCount: this.sampleCount,
      videoCount: this.videoCount,
      triggerCount: this.triggerCount,
      nextOrder: this.order,
    };
  }

  private substituteVariables(line: string): string {
    if (this.variables.length === 0 || !line.includes("$")) return line;
    if (!this.variablesSorted) {
      // Longest names first so $bg2 never matches a shorter $bg.
      this.variables.sort((a, b) => b[0].length - a[0].length);
      this.variablesSorted = true;
    }
    let out = line;
    for (const [name, value] of this.variables) {
      if (out.includes(name)) out = out.split(name).join(value);
    }
    return out;
  }

  private feedElementLine(rawLine: string): void {
    this.closeSprite();
    const line = this.substituteVariables(rawLine);
    const parts = splitStoryboardLine(line);
    const type = parts[0].trim();

    if (type === "Sprite" || type === "4") {
      this.beginSprite(parts, null);
    } else if (type === "Animation" || type === "6") {
      this.beginSprite(parts, {
        frameCount: parseInt(parts[6], 10),
        frameDelay: parseFloat(parts[7]),
        loopType: (parts[8] ?? "").trim(),
      });
    } else if (type === "Sample" || type === "5") {
      this.sampleCount++;
    } else if (type === "Video" || type === "1") {
      this.videoCount++;
    }
    // "0" (background), "2"/"Break", "3" (colour) carry no storyboard sprites.
  }

  private beginSprite(
    parts: string[],
    anim: { frameCount: number; frameDelay: number; loopType: string } | null,
  ): void {
    if (parts.length < 4) return;
    const layer = LAYER_INDICES[parts[1].trim().toLowerCase()];
    const origin = ORIGIN_ANCHORS[parts[2].trim().toLowerCase()] ?? ORIGIN_ANCHORS.topleft;
    if (layer === undefined) return;

    const filePath = normalizeStoryboardPath(parts[3]);
    if (!filePath) return;

    const x = parseFloat(parts[4]);
    const y = parseFloat(parts[5]);

    let framePaths: string[] | null = null;
    let frameDelay = 0;
    let frameLoopForever = true;
    if (anim) {
      if (!Number.isFinite(anim.frameCount) || anim.frameCount < 1) return;
      framePaths = getAnimationFramePaths(filePath, anim.frameCount);
      frameDelay = Number.isFinite(anim.frameDelay) && anim.frameDelay > 0 ? anim.frameDelay : 1000 / 60;
      frameLoopForever = anim.loopType !== "LoopOnce" && anim.loopType !== "1";
      for (const frame of framePaths) this.referencedPaths.add(frame);
    } else {
      this.referencedPaths.add(filePath);
    }

    this.current = {
      layer,
      originX: origin[0],
      originY: origin[1],
      filePath,
      framePaths,
      frameDelay,
      frameLoopForever,
      x: Number.isFinite(x) ? x : 320,
      y: Number.isFinite(y) ? y : 240,
      segs: [],
      params: [],
    };
  }

  private feedCommandLine(rawLine: string): void {
    if (!this.current) return;

    let depth = 0;
    while (depth < rawLine.length) {
      const code = rawLine.charCodeAt(depth);
      if (code !== 32 && code !== 95) break;
      depth++;
    }
    if (depth >= rawLine.length) return;

    const line = this.substituteVariables(rawLine.slice(depth));
    const parts = line.includes('"') ? splitStoryboardLine(line) : line.split(",");
    const type = parts[0];

    if (type === "L") {
      this.closeLoop();
      const start = parseFloat(parts[1]);
      const count = parseInt(parts[2], 10);
      if (!Number.isFinite(start)) return;
      this.loop = {
        start,
        count: Number.isFinite(count) ? Math.min(Math.max(1, count), MAX_LOOP_ITERATIONS) : 1,
        trigger: false,
        segs: [],
        params: [],
      };
      return;
    }

    if (type === "T") {
      this.closeLoop();
      this.triggerCount++;
      // Triggered command groups fire off gameplay events; the replay viewer
      // does not run them, but their child commands must still be swallowed.
      this.loop = { start: 0, count: 0, trigger: true, segs: [], params: [] };
      return;
    }

    if (depth >= 2 && this.loop) {
      this.appendCommand(parts, this.loop.segs, this.loop.params);
      return;
    }

    this.closeLoop();
    this.appendCommand(parts, this.current.segs, this.current.params);
  }

  private appendCommand(parts: string[], segs: PendingSegment[], params: PendingParam[]): void {
    if (parts.length < 5) return;
    const type = parts[0];
    const easingRaw = parseInt(parts[1], 10);
    const easing = Number.isFinite(easingRaw) && easingRaw >= 0 && easingRaw <= 34 ? easingRaw : 0;
    const start = parseFloat(parts[2]);
    if (!Number.isFinite(start)) return;
    const endRaw = parts[3].trim();
    let end = endRaw === "" ? start : parseFloat(endRaw);
    if (!Number.isFinite(end)) end = start;
    if (end < start) end = start;

    if (type === "P") {
      const flag = (parts[4] ?? "").trim();
      const paramType = flag === "H" ? SB_PARAM_FLIP_H : flag === "V" ? SB_PARAM_FLIP_V : flag === "A" ? SB_PARAM_ADDITIVE : null;
      if (paramType === null) return;
      // A zero-duration parameter applies from its start time onward.
      params.push({ type: paramType, start, end: end > start ? end : Infinity });
      return;
    }

    let channels: number[];
    let groupSize: number;
    switch (type) {
      case "F":
        channels = [SB_CHAN_ALPHA];
        groupSize = 1;
        break;
      case "MX":
        channels = [SB_CHAN_X];
        groupSize = 1;
        break;
      case "MY":
        channels = [SB_CHAN_Y];
        groupSize = 1;
        break;
      case "M":
        channels = [SB_CHAN_X, SB_CHAN_Y];
        groupSize = 2;
        break;
      case "S":
        channels = [SB_CHAN_SCALE_X, SB_CHAN_SCALE_Y];
        groupSize = 1;
        break;
      case "V":
        channels = [SB_CHAN_SCALE_X, SB_CHAN_SCALE_Y];
        groupSize = 2;
        break;
      case "R":
        channels = [SB_CHAN_ROTATION];
        groupSize = 1;
        break;
      case "C":
        channels = [SB_CHAN_COLOR_R, SB_CHAN_COLOR_G, SB_CHAN_COLOR_B];
        groupSize = 3;
        break;
      default:
        return;
    }

    const valueCount = parts.length - 4;
    const groups = Math.floor(valueCount / groupSize);
    if (groups < 1) return;

    const duration = end - start;
    // k value groups produce max(1, k-1) consecutive segments per channel
    // (the chained shorthand: F,0,0,500,0,1,0 fades in over [0,500] and back
    // out over [500,1000]).
    const segmentGroups = Math.max(1, groups - 1);

    for (let g = 0; g < segmentGroups; g++) {
      const fromBase = 4 + g * groupSize;
      const toBase = groups === 1 ? fromBase : fromBase + groupSize;
      const segStart = start + g * duration;
      const segEnd = segStart + duration;
      for (let c = 0; c < channels.length; c++) {
        // S drives both scale channels from its single value group.
        const valueOffset = groupSize === 1 ? 0 : c;
        const from = parseFloat(parts[fromBase + valueOffset]);
        const to = parseFloat(parts[toBase + valueOffset]);
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
        if (this.segmentCount >= this.maxTotalSegments || segs.length >= this.maxSegmentsPerSprite) {
          this.droppedSegments++;
          continue;
        }
        segs.push({ chan: channels[c], easing, start: segStart, end: segEnd, from, to, idx: this.segIdx++ });
        this.segmentCount++;
      }
    }
  }

  private closeLoop(): void {
    const loop = this.loop;
    if (!loop) return;
    this.loop = null;
    if (loop.trigger || !this.current) return;
    if (loop.segs.length === 0 && loop.params.length === 0) return;

    // One iteration spans from 0 to the latest inner end time.
    let duration = 0;
    for (const seg of loop.segs) duration = Math.max(duration, seg.end);
    for (const param of loop.params) {
      if (Number.isFinite(param.end)) duration = Math.max(duration, param.end);
      else duration = Math.max(duration, param.start);
    }

    const iterations = duration > 0 ? loop.count : 1;
    const sprite = this.current;
    for (let i = 0; i < iterations; i++) {
      const offset = loop.start + i * duration;
      for (const seg of loop.segs) {
        if (this.segmentCount >= this.maxTotalSegments || sprite.segs.length >= this.maxSegmentsPerSprite) {
          this.droppedSegments++;
          continue;
        }
        sprite.segs.push({
          chan: seg.chan,
          easing: seg.easing,
          start: offset + seg.start,
          end: offset + seg.end,
          from: seg.from,
          to: seg.to,
          idx: this.segIdx++,
        });
        this.segmentCount++;
      }
      for (const param of loop.params) {
        sprite.params.push({
          type: param.type,
          start: offset + param.start,
          end: Number.isFinite(param.end) ? offset + param.end : Infinity,
        });
      }
    }
  }

  private closeSprite(): void {
    this.closeLoop();
    const sprite = this.current;
    this.current = null;
    if (!sprite) return;
    if (sprite.segs.length === 0 && sprite.params.length === 0) return;

    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const seg of sprite.segs) {
      if (seg.start < minTime) minTime = seg.start;
      if (seg.end > maxTime) maxTime = seg.end;
    }
    for (const param of sprite.params) {
      if (param.start < minTime) minTime = param.start;
      if (Number.isFinite(param.end) && param.end > maxTime) maxTime = param.end;
    }
    if (!Number.isFinite(minTime)) return;
    if (!Number.isFinite(maxTime)) maxTime = minTime;

    // Bucket per channel preserving insertion order, then order by start time.
    const byChannel: PendingSegment[][] = [];
    for (let c = 0; c < SB_CHANNEL_COUNT; c++) byChannel.push([]);
    for (const seg of sprite.segs) byChannel[seg.chan].push(seg);

    const chanStart = new Int32Array(SB_CHANNEL_COUNT + 1);
    let total = 0;
    for (let c = 0; c < SB_CHANNEL_COUNT; c++) {
      chanStart[c] = total;
      byChannel[c].sort((a, b) => a.start - b.start || a.idx - b.idx);
      total += byChannel[c].length;
    }
    chanStart[SB_CHANNEL_COUNT] = total;

    const seg = new Float32Array(total * SB_SEG_STRIDE);
    let w = 0;
    for (let c = 0; c < SB_CHANNEL_COUNT; c++) {
      for (const s of byChannel[c]) {
        seg[w] = s.start;
        seg[w + 1] = s.end;
        seg[w + 2] = s.easing;
        seg[w + 3] = s.from;
        seg[w + 4] = s.to;
        w += SB_SEG_STRIDE;
      }
    }

    let params: StoryboardParamInterval[] | null = null;
    if (sprite.params.length > 0) {
      params = sprite.params.map((p) => ({
        type: p.type,
        start: p.start,
        end: Number.isFinite(p.end) ? p.end : maxTime,
      }));
    }

    this.sprites.push({
      layer: sprite.layer,
      originX: sprite.originX,
      originY: sprite.originY,
      filePath: sprite.filePath,
      framePaths: sprite.framePaths,
      frameDelay: sprite.frameDelay,
      frameLoopForever: sprite.frameLoopForever,
      defaultX: sprite.x,
      defaultY: sprite.y,
      startTime: minTime,
      endTime: maxTime,
      order: this.order++,
      seg,
      chanStart,
      params,
    });
  }
}

export function parseStoryboardTexts(texts: string[], options: StoryboardParserOptions = {}): StoryboardParseResult {
  const parser = new StoryboardParser(options);
  for (const text of texts) {
    parser.beginFile();
    for (const line of iterateLines(text)) parser.feedLine(line);
  }
  return parser.finish();
}

// Chunked variant for the browser: yields to the event loop periodically so a
// 40 MB .osb does not freeze the page while parsing.
export async function parseStoryboardTextsAsync(
  texts: string[],
  options: StoryboardParserOptions = {},
  linesPerChunk = 40_000,
): Promise<StoryboardParseResult> {
  const parser = new StoryboardParser(options);
  let sinceYield = 0;
  for (const text of texts) {
    parser.beginFile();
    for (const line of iterateLines(text)) {
      parser.feedLine(line);
      if (++sinceYield >= linesPerChunk) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  return parser.finish();
}

// Line iterator that avoids materializing a 1M-entry array up front.
function* iterateLines(text: string): Generator<string> {
  let start = 0;
  // Strip a UTF-8 BOM so the first section header is recognized.
  if (text.charCodeAt(0) === 0xfeff) start = 1;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) yield text.slice(start);
      return;
    }
    yield text.slice(start, nl);
    start = nl + 1;
  }
}

// Cheap detector for storyboard content in a .osu file's [Events] section,
// used to decide whether a storyboard pipeline is worth starting at all.
export function osuFileHasStoryboardElements(osuContent: string): boolean {
  let inEvents = false;
  for (const line of iterateLines(osuContent)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inEvents = trimmed === "[Events]";
      continue;
    }
    if (!inEvents || trimmed.length === 0 || trimmed.startsWith("//")) continue;
    if (
      trimmed.startsWith("Sprite,") ||
      trimmed.startsWith("Animation,") ||
      trimmed.startsWith("4,") ||
      trimmed.startsWith("6,")
    ) {
      return true;
    }
  }
  return false;
}
