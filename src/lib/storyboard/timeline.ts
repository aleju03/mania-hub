// Time-domain evaluation of compiled storyboard sprites. Everything here is
// allocation-free per frame: states evaluate into caller-owned scratch
// objects and the active set reuses its arrays.

import { applyStoryboardEasing } from "./easing";
import {
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
} from "./types";

export interface StoryboardSpriteState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  alpha: number;
  tint: number;
  flipH: boolean;
  flipV: boolean;
  additive: boolean;
  frameIndex: number;
}

export function createStoryboardSpriteState(): StoryboardSpriteState {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    alpha: 1,
    tint: 0xffffff,
    flipH: false,
    flipV: false,
    additive: false,
    frameIndex: 0,
  };
}

// Value of one channel at time t. Before the first segment starts the channel
// holds that segment's start value; between/after segments it holds the most
// recently started segment's end value (osu! command semantics).
function evalChannel(sprite: CompiledStoryboardSprite, channel: number, t: number, defaultValue: number): number {
  const lo = sprite.chanStart[channel];
  const hi = sprite.chanStart[channel + 1];
  if (lo === hi) return defaultValue;

  const seg = sprite.seg;
  // Binary search for the last segment with start <= t.
  let left = lo;
  let right = hi - 1;
  if (t < seg[lo * SB_SEG_STRIDE]) return seg[lo * SB_SEG_STRIDE + 3];
  while (left < right) {
    const mid = (left + right + 1) >> 1;
    if (seg[mid * SB_SEG_STRIDE] <= t) left = mid;
    else right = mid - 1;
  }

  const base = left * SB_SEG_STRIDE;
  const start = seg[base];
  const end = seg[base + 1];
  const from = seg[base + 3];
  const to = seg[base + 4];
  if (t >= end || end <= start) return to;
  const progress = applyStoryboardEasing(seg[base + 2], (t - start) / (end - start));
  return from + (to - from) * progress;
}

function clampColor(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

export function evaluateStoryboardSprite(
  sprite: CompiledStoryboardSprite,
  t: number,
  out: StoryboardSpriteState,
): void {
  out.x = evalChannel(sprite, SB_CHAN_X, t, sprite.defaultX);
  out.y = evalChannel(sprite, SB_CHAN_Y, t, sprite.defaultY);
  out.scaleX = evalChannel(sprite, SB_CHAN_SCALE_X, t, 1);
  out.scaleY = evalChannel(sprite, SB_CHAN_SCALE_Y, t, 1);
  out.rotation = evalChannel(sprite, SB_CHAN_ROTATION, t, 0);
  out.alpha = evalChannel(sprite, SB_CHAN_ALPHA, t, 1);

  const r = clampColor(evalChannel(sprite, SB_CHAN_COLOR_R, t, 255));
  const g = clampColor(evalChannel(sprite, SB_CHAN_COLOR_G, t, 255));
  const b = clampColor(evalChannel(sprite, SB_CHAN_COLOR_B, t, 255));
  out.tint = (r << 16) | (g << 8) | b;

  out.flipH = false;
  out.flipV = false;
  out.additive = false;
  const params = sprite.params;
  if (params) {
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (t < p.start || t > p.end) continue;
      if (p.type === SB_PARAM_FLIP_H) out.flipH = true;
      else if (p.type === SB_PARAM_FLIP_V) out.flipV = true;
      else if (p.type === SB_PARAM_ADDITIVE) out.additive = true;
    }
  }

  if (sprite.framePaths) {
    const frameCount = sprite.framePaths.length;
    const elapsed = t - sprite.startTime;
    let index = elapsed <= 0 ? 0 : Math.floor(elapsed / sprite.frameDelay);
    if (sprite.frameLoopForever) index %= frameCount;
    else if (index >= frameCount) index = frameCount - 1;
    out.frameIndex = index;
  } else {
    out.frameIndex = 0;
  }
}

export interface StoryboardActiveSetUpdate {
  entered: CompiledStoryboardSprite[];
  exited: CompiledStoryboardSprite[];
  active: CompiledStoryboardSprite[];
}

// Tracks which sprites are alive at the playhead. Forward playback advances a
// cursor over the start-sorted sprite list; a backward seek rebuilds from the
// beginning (a one-off linear walk, cheap even for 31k sprites).
export class StoryboardActiveSet {
  private readonly sorted: CompiledStoryboardSprite[];
  private cursor = 0;
  private lastTime = -Infinity;
  private readonly active: CompiledStoryboardSprite[] = [];
  private readonly entered: CompiledStoryboardSprite[] = [];
  private readonly exited: CompiledStoryboardSprite[] = [];
  private readonly update_: StoryboardActiveSetUpdate;

  constructor(sprites: CompiledStoryboardSprite[]) {
    this.sorted = [...sprites].sort((a, b) => a.startTime - b.startTime || a.order - b.order);
    this.update_ = { entered: this.entered, exited: this.exited, active: this.active };
  }

  update(t: number): StoryboardActiveSetUpdate {
    this.entered.length = 0;
    this.exited.length = 0;

    if (t < this.lastTime) {
      this.exited.push(...this.active);
      this.active.length = 0;
      this.cursor = 0;
    }
    this.lastTime = t;

    while (this.cursor < this.sorted.length && this.sorted[this.cursor].startTime <= t) {
      const sprite = this.sorted[this.cursor++];
      if (sprite.endTime >= t) {
        this.active.push(sprite);
        this.entered.push(sprite);
      }
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const sprite = this.active[i];
      if (sprite.endTime < t) {
        this.exited.push(sprite);
        this.active[i] = this.active[this.active.length - 1];
        this.active.pop();
      }
    }

    return this.update_;
  }
}
