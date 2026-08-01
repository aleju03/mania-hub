import { describe, expect, it } from "vitest";
import { applyStoryboardEasing } from "./easing";
import { parseStoryboardTexts } from "./parser";
import {
  StoryboardActiveSet,
  createStoryboardSpriteState,
  evaluateStoryboardSprite,
} from "./timeline";
import type { CompiledStoryboardSprite } from "./types";

function parseSprite(lines: string[]): CompiledStoryboardSprite {
  const result = parseStoryboardTexts([["[Events]", ...lines].join("\n")]);
  expect(result.sprites.length).toBeGreaterThan(0);
  return result.sprites[0];
}

function stateAt(sprite: CompiledStoryboardSprite, t: number) {
  const state = createStoryboardSpriteState();
  evaluateStoryboardSprite(sprite, t, state);
  return state;
}

describe("applyStoryboardEasing", () => {
  it("is linear for id 0 and clamps input", () => {
    expect(applyStoryboardEasing(0, 0.25)).toBe(0.25);
    expect(applyStoryboardEasing(0, -1)).toBe(0);
    expect(applyStoryboardEasing(0, 2)).toBe(1);
  });

  it("matches quad in/out for legacy ids 1 and 2", () => {
    expect(applyStoryboardEasing(1, 0.5)).toBeCloseTo(0.75, 10);
    expect(applyStoryboardEasing(2, 0.5)).toBeCloseTo(0.25, 10);
    expect(applyStoryboardEasing(4, 0.5)).toBeCloseTo(0.75, 10);
    expect(applyStoryboardEasing(3, 0.5)).toBeCloseTo(0.25, 10);
  });

  it("hits the endpoints for every easing id", () => {
    // Elastic curves are genuinely ~5e-4 off at the boundaries, matching
    // osu-framework's implementation.
    for (let id = 0; id <= 34; id++) {
      expect(applyStoryboardEasing(id, 0)).toBeCloseTo(0, 2);
      expect(applyStoryboardEasing(id, 1)).toBeCloseTo(1, 2);
    }
  });

  it("evaluates a few known curves", () => {
    expect(applyStoryboardEasing(16, 0.5)).toBeCloseTo(Math.sin(Math.PI / 4), 10);
    expect(applyStoryboardEasing(33, 1 / 2.75 / 2)).toBeCloseTo(7.5625 * (1 / 5.5) * (1 / 5.5), 10);
    expect(applyStoryboardEasing(30, 0.5)).toBeGreaterThan(applyStoryboardEasing(0, 0.5));
  });
});

describe("evaluateStoryboardSprite", () => {
  it("interpolates a fade and holds edge values", () => {
    const sprite = parseSprite(['Sprite,Foreground,Centre,"a.png",100,200', " F,0,1000,2000,0,1"]);
    expect(stateAt(sprite, 500).alpha).toBe(0);
    expect(stateAt(sprite, 1500).alpha).toBeCloseTo(0.5, 5);
    expect(stateAt(sprite, 3000).alpha).toBe(1);
    expect(stateAt(sprite, 1500).x).toBe(100);
    expect(stateAt(sprite, 1500).y).toBe(200);
  });

  it("holds the previous end value in gaps between segments", () => {
    const sprite = parseSprite([
      'Sprite,Foreground,Centre,"a.png",0,0',
      " MX,0,0,100,0,50",
      " MX,0,500,600,80,100",
    ]);
    expect(stateAt(sprite, 300).x).toBe(50);
    expect(stateAt(sprite, 550).x).toBeCloseTo(90, 5);
    expect(stateAt(sprite, 700).x).toBe(100);
    expect(stateAt(sprite, -100).x).toBe(0);
  });

  it("applies easing to interpolation", () => {
    const sprite = parseSprite(['Sprite,Foreground,Centre,"a.png",0,0', " F,2,0,1000,0,1"]);
    expect(stateAt(sprite, 500).alpha).toBeCloseTo(0.25, 5);
  });

  it("evaluates zero-duration commands as instant switches", () => {
    const sprite = parseSprite(['Sprite,Foreground,Centre,"a.png",0,0', " F,0,1000,,1", " F,0,2000,,0"]);
    expect(stateAt(sprite, 999).alpha).toBe(1);
    expect(stateAt(sprite, 1500).alpha).toBe(1);
    expect(stateAt(sprite, 2500).alpha).toBe(0);
  });

  it("computes tint from colour commands", () => {
    const sprite = parseSprite(['Sprite,Foreground,Centre,"a.png",0,0', " C,0,0,1000,255,0,0,0,0,255"]);
    expect(stateAt(sprite, 0).tint).toBe(0xff0000);
    expect(stateAt(sprite, 1000).tint).toBe(0x0000ff);
    const mid = stateAt(sprite, 500).tint;
    expect(mid >> 16).toBeCloseTo(128, -1);
  });

  it("applies parameter flags inside their interval", () => {
    const sprite = parseSprite([
      'Sprite,Foreground,Centre,"a.png",0,0',
      " F,0,0,1000,1",
      " P,0,100,200,H",
      " P,0,300,300,A",
    ]);
    expect(stateAt(sprite, 50).flipH).toBe(false);
    expect(stateAt(sprite, 150).flipH).toBe(true);
    expect(stateAt(sprite, 250).flipH).toBe(false);
    expect(stateAt(sprite, 250).additive).toBe(false);
    expect(stateAt(sprite, 600).additive).toBe(true);
  });

  it("selects animation frames with loop and clamp modes", () => {
    const looping = parseSprite([
      'Animation,Foreground,Centre,"fx.png",0,0,3,100,LoopForever',
      " F,0,0,1000,1",
    ]);
    expect(stateAt(looping, 0).frameIndex).toBe(0);
    expect(stateAt(looping, 150).frameIndex).toBe(1);
    expect(stateAt(looping, 350).frameIndex).toBe(0);

    const once = parseSprite([
      'Animation,Foreground,Centre,"fx.png",0,0,3,100,LoopOnce',
      " F,0,0,1000,1",
    ]);
    expect(stateAt(once, 950).frameIndex).toBe(2);
  });
});

describe("StoryboardActiveSet", () => {
  function makeSprites(): CompiledStoryboardSprite[] {
    const result = parseStoryboardTexts([
      [
        "[Events]",
        'Sprite,Foreground,Centre,"a.png",0,0',
        " F,0,0,1000,1",
        'Sprite,Foreground,Centre,"b.png",0,0',
        " F,0,500,1500,1",
        'Sprite,Foreground,Centre,"c.png",0,0',
        " F,0,2000,3000,1",
      ].join("\n"),
    ]);
    return result.sprites;
  }

  it("activates and expires sprites as time advances", () => {
    const set = new StoryboardActiveSet(makeSprites());
    let update = set.update(100);
    expect(update.active.map((sprite) => sprite.filePath)).toEqual(["a.png"]);
    update = set.update(700);
    expect(update.entered.map((sprite) => sprite.filePath)).toEqual(["b.png"]);
    expect(update.active).toHaveLength(2);
    update = set.update(1600);
    expect(update.exited.map((sprite) => sprite.filePath).sort()).toEqual(["a.png", "b.png"]);
    expect(update.active).toHaveLength(0);
  });

  it("skips sprites jumped over entirely and rebuilds on backward seeks", () => {
    const set = new StoryboardActiveSet(makeSprites());
    let update = set.update(2500);
    expect(update.active.map((sprite) => sprite.filePath)).toEqual(["c.png"]);
    update = set.update(600);
    expect(update.active.map((sprite) => sprite.filePath).sort()).toEqual(["a.png", "b.png"]);
    expect(update.exited.map((sprite) => sprite.filePath)).toEqual(["c.png"]);
  });
});
