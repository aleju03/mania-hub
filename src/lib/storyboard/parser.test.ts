import { describe, expect, it } from "vitest";
import {
  getAnimationFramePaths,
  normalizeStoryboardPath,
  osuFileHasStoryboardElements,
  parseStoryboardTexts,
  parseStoryboardTextsAsync,
  splitStoryboardLine,
} from "./parser";
import { buildStoryboardHitsoundEvents } from "./triggers";
import {
  SB_CHAN_ALPHA,
  SB_CHAN_ROTATION,
  SB_CHAN_SCALE_X,
  SB_CHAN_SCALE_Y,
  SB_CHAN_X,
  SB_CHAN_Y,
  SB_PARAM_ADDITIVE,
  SB_SEG_STRIDE,
  type CompiledStoryboardSprite,
} from "./types";

function channelSegments(sprite: CompiledStoryboardSprite, channel: number): number[][] {
  const out: number[][] = [];
  for (let i = sprite.chanStart[channel]; i < sprite.chanStart[channel + 1]; i++) {
    out.push([...sprite.seg.slice(i * SB_SEG_STRIDE, (i + 1) * SB_SEG_STRIDE)]);
  }
  return out;
}

describe("normalizeStoryboardPath", () => {
  it("strips quotes, lowercases, and flips backslashes", () => {
    expect(normalizeStoryboardPath('"SB\\Fore\\Light.PNG"')).toBe("sb/fore/light.png");
    expect(normalizeStoryboardPath("./sb//a.png")).toBe("sb//a.png");
    expect(normalizeStoryboardPath("bg.jpg")).toBe("bg.jpg");
  });
});

describe("splitStoryboardLine", () => {
  it("keeps commas inside quoted paths intact", () => {
    expect(splitStoryboardLine('Sprite,Background,Centre,"a, b.png",320,240')).toEqual([
      "Sprite",
      "Background",
      "Centre",
      '"a, b.png"',
      "320",
      "240",
    ]);
  });

  it("falls back to a plain split without quotes", () => {
    expect(splitStoryboardLine("F,0,0,100,1")).toEqual(["F", "0", "0", "100", "1"]);
  });
});

describe("getAnimationFramePaths", () => {
  it("inserts the frame index before the extension", () => {
    expect(getAnimationFramePaths("sb/frame.png", 3)).toEqual(["sb/frame0.png", "sb/frame1.png", "sb/frame2.png"]);
  });

  it("appends when there is no extension", () => {
    expect(getAnimationFramePaths("sb/frame", 2)).toEqual(["sb/frame0", "sb/frame1"]);
  });
});

describe("parseStoryboardTexts", () => {
  it("parses a simple sprite with commands", () => {
    const result = parseStoryboardTexts([
      [
        "[Events]",
        'Sprite,Background,Centre,"bg.jpg",320,240',
        " F,0,1000,2000,0,1",
        " M,0,1000,2000,0,0,640,480",
      ].join("\n"),
    ]);

    expect(result.sprites).toHaveLength(1);
    const sprite = result.sprites[0];
    expect(sprite.layer).toBe(0);
    expect(sprite.originX).toBe(0.5);
    expect(sprite.originY).toBe(0.5);
    expect(sprite.filePath).toBe("bg.jpg");
    expect(sprite.startTime).toBe(1000);
    expect(sprite.endTime).toBe(2000);
    expect(channelSegments(sprite, SB_CHAN_ALPHA)).toEqual([[1000, 2000, 0, 0, 1]]);
    expect(channelSegments(sprite, SB_CHAN_X)).toEqual([[1000, 2000, 0, 0, 640]]);
    expect(channelSegments(sprite, SB_CHAN_Y)).toEqual([[1000, 2000, 0, 0, 480]]);
    expect(result.referencedPaths.has("bg.jpg")).toBe(true);
  });

  it("supports numeric event types, layers, and origins", () => {
    const result = parseStoryboardTexts([
      ["[Events]", '4,3,1,"fg.png",100,200', " F,0,0,100,1"].join("\n"),
    ]);
    expect(result.sprites).toHaveLength(1);
    expect(result.sprites[0].layer).toBe(3);
    expect(result.sprites[0].originX).toBe(0.5);
  });

  it("handles underscore-indented commands", () => {
    const result = parseStoryboardTexts([
      ["[Events]", 'Sprite,Foreground,TopLeft,"a.png",0,0', "_F,0,0,100,0,1"].join("\n"),
    ]);
    expect(channelSegments(result.sprites[0], SB_CHAN_ALPHA)).toEqual([[0, 100, 0, 0, 1]]);
  });

  it("expands chained shorthand values into consecutive segments", () => {
    const result = parseStoryboardTexts([
      ["[Events]", 'Sprite,Foreground,Centre,"a.png",0,0', " F,0,0,500,0,1,0"].join("\n"),
    ]);
    expect(channelSegments(result.sprites[0], SB_CHAN_ALPHA)).toEqual([
      [0, 500, 0, 0, 1],
      [500, 1000, 0, 1, 0],
    ]);
    expect(result.sprites[0].endTime).toBe(1000);
  });

  it("treats a single value group as a static hold", () => {
    const result = parseStoryboardTexts([
      ["[Events]", 'Sprite,Foreground,Centre,"a.png",0,0', " R,0,538,1038,1.5"].join("\n"),
    ]);
    expect(channelSegments(result.sprites[0], SB_CHAN_ROTATION)).toEqual([[538, 1038, 0, 1.5, 1.5]]);
  });

  it("applies S to both scale channels and V independently", () => {
    const result = parseStoryboardTexts([
      [
        "[Events]",
        'Sprite,Foreground,Centre,"a.png",0,0',
        " S,0,0,100,1,2",
        'Sprite,Foreground,Centre,"b.png",0,0',
        " V,0,0,100,1,3,2,4",
      ].join("\n"),
    ]);
    expect(channelSegments(result.sprites[0], SB_CHAN_SCALE_X)).toEqual([[0, 100, 0, 1, 2]]);
    expect(channelSegments(result.sprites[0], SB_CHAN_SCALE_Y)).toEqual([[0, 100, 0, 1, 2]]);
    expect(channelSegments(result.sprites[1], SB_CHAN_SCALE_X)).toEqual([[0, 100, 0, 1, 2]]);
    expect(channelSegments(result.sprites[1], SB_CHAN_SCALE_Y)).toEqual([[0, 100, 0, 3, 4]]);
  });

  it("substitutes [Variables] with longest-name-first matching", () => {
    const result = parseStoryboardTexts([
      [
        "[Variables]",
        "$bg=bg.jpg",
        "$bg2=other.png",
        "[Events]",
        'Sprite,Background,Centre,"$bg2",320,240',
        " F,0,0,100,1",
      ].join("\n"),
    ]);
    expect(result.sprites[0].filePath).toBe("other.png");
  });

  it("expands loops with iteration offsets", () => {
    const result = parseStoryboardTexts([
      [
        "[Events]",
        'Sprite,Foreground,Centre,"a.png",0,0',
        " L,1000,3",
        "  F,0,0,100,0,1",
        "  F,0,100,200,1,0",
      ].join("\n"),
    ]);
    expect(channelSegments(result.sprites[0], SB_CHAN_ALPHA)).toEqual([
      [1000, 1100, 0, 0, 1],
      [1100, 1200, 0, 1, 0],
      [1200, 1300, 0, 0, 1],
      [1300, 1400, 0, 1, 0],
      [1400, 1500, 0, 0, 1],
      [1500, 1600, 0, 1, 0],
    ]);
    expect(result.sprites[0].startTime).toBe(1000);
    expect(result.sprites[0].endTime).toBe(1600);
  });

  it("returns to sprite-level commands after a loop", () => {
    const result = parseStoryboardTexts([
      [
        "[Events]",
        'Sprite,Foreground,Centre,"a.png",0,0',
        " L,0,2",
        "  MX,0,0,50,10,20",
        " MY,0,500,600,1,2",
      ].join("\n"),
    ]);
    const sprite = result.sprites[0];
    expect(channelSegments(sprite, SB_CHAN_X)).toHaveLength(2);
    expect(channelSegments(sprite, SB_CHAN_Y)).toEqual([[500, 600, 0, 1, 2]]);
  });

  it("skips trigger groups when no hit objects were supplied", () => {
    const result = parseStoryboardTexts([
      [
        "[Events]",
        'Sprite,Foreground,Centre,"a.png",0,0',
        " F,0,0,100,1",
        " T,HitSound,0,10000",
        "  F,0,0,100,0",
        " R,0,200,300,0,1",
      ].join("\n"),
    ]);
    const sprite = result.sprites[0];
    expect(result.triggerCount).toBe(1);
    expect(channelSegments(sprite, SB_CHAN_ALPHA)).toEqual([[0, 100, 0, 1, 1]]);
    expect(channelSegments(sprite, SB_CHAN_ROTATION)).toEqual([[200, 300, 0, 0, 1]]);
  });

  it("replays a trigger group at every matching hit object", () => {
    const events = buildStoryboardHitsoundEvents([
      { time: 500, sample: { bank: "soft", additionBank: "soft", additions: 2, index: 0 } },
      { time: 700, sample: { bank: "soft", additionBank: "soft", additions: 8, index: 0 } },
      { time: 900, sample: { bank: "soft", additionBank: "soft", additions: 2, index: 0 } },
      // Outside the trigger window.
      { time: 2000, sample: { bank: "soft", additionBank: "soft", additions: 2, index: 0 } },
    ]);
    const result = parseStoryboardTexts(
      [
        [
          "[Events]",
          'Sprite,Foreground,Centre,"a.png",0,0',
          " T,HitSoundSoftWhistle,0,1000",
          "  F,0,0,50,1",
          "  MY,0,0,50,100,80",
        ].join("\n"),
      ],
      { hitsoundEvents: events },
    );
    const sprite = result.sprites[0];
    expect(channelSegments(sprite, SB_CHAN_ALPHA)).toEqual([
      [500, 550, 0, 1, 1],
      [900, 950, 0, 1, 1],
    ]);
    expect(channelSegments(sprite, SB_CHAN_Y)).toEqual([
      [500, 550, 0, 100, 80],
      [900, 950, 0, 100, 80],
    ]);
    expect(sprite.startTime).toBe(500);
    expect(sprite.endTime).toBe(950);
  });

  it("drops trigger groups that never fire, and Passing/Failing ones", () => {
    const events = buildStoryboardHitsoundEvents([
      { time: 500, sample: { bank: "drum", additionBank: "drum", additions: 8, index: 0 } },
    ]);
    const result = parseStoryboardTexts(
      [
        [
          "[Events]",
          'Sprite,Foreground,Centre,"a.png",0,0',
          " F,0,0,100,1",
          " T,HitSoundSoftWhistle,0,1000",
          "  MY,0,0,50,100,80",
          " T,Passing,0,1000",
          "  MX,0,0,50,100,80",
        ].join("\n"),
      ],
      { hitsoundEvents: events },
    );
    const sprite = result.sprites[0];
    expect(result.triggerCount).toBe(2);
    expect(channelSegments(sprite, SB_CHAN_Y)).toEqual([]);
    expect(channelSegments(sprite, SB_CHAN_X)).toEqual([]);
  });

  it("records parameter intervals, making zero-duration ones permanent", () => {
    const result = parseStoryboardTexts([
      [
        "[Events]",
        'Sprite,Foreground,Centre,"a.png",0,0',
        " F,0,0,1000,1",
        " P,0,100,200,H",
        " P,0,300,300,A",
      ].join("\n"),
    ]);
    const sprite = result.sprites[0];
    expect(sprite.params).toEqual([
      { type: 0, start: 100, end: 200 },
      { type: SB_PARAM_ADDITIVE, start: 300, end: 1000 },
    ]);
  });

  it("collects animation frame paths and honors LoopOnce", () => {
    const result = parseStoryboardTexts([
      ["[Events]", 'Animation,Foreground,Centre,"sb/fx.png",0,0,3,50,LoopOnce', " F,0,0,1000,1"].join("\n"),
    ]);
    const sprite = result.sprites[0];
    expect(sprite.framePaths).toEqual(["sb/fx0.png", "sb/fx1.png", "sb/fx2.png"]);
    expect(sprite.frameDelay).toBe(50);
    expect(sprite.frameLoopForever).toBe(false);
    expect(result.referencedPaths.has("sb/fx1.png")).toBe(true);
  });

  it("drops sprites without commands and counts samples/videos", () => {
    const result = parseStoryboardTexts([
      [
        "[Events]",
        '0,0,"bg.jpg",0,0',
        "2,1000,2000",
        'Sprite,Foreground,Centre,"unused.png",0,0',
        'Sample,5000,0,"clap.wav",70',
        'Video,-100,"intro.mp4"',
      ].join("\n"),
    ]);
    expect(result.sprites).toHaveLength(0);
    expect(result.sampleCount).toBe(1);
    expect(result.videoCount).toBe(1);
    // Declared images stay referenced so bundles still include them.
    expect(result.referencedPaths.has("unused.png")).toBe(true);
  });

  it("ignores content outside [Events] and stops at the next section", () => {
    const result = parseStoryboardTexts([
      [
        "[General]",
        "AudioFilename: audio.mp3",
        "[Events]",
        'Sprite,Foreground,Centre,"a.png",0,0',
        " F,0,0,100,1",
        "[TimingPoints]",
        "500,343,4,2,1,60,1,0",
      ].join("\n"),
    ]);
    expect(result.sprites).toHaveLength(1);
  });

  it("merges multiple files with increasing order", () => {
    const osb = ["[Events]", 'Sprite,Foreground,Centre,"a.png",0,0', " F,0,0,100,1"].join("\n");
    const osu = ["[Events]", 'Sprite,Foreground,Centre,"b.png",0,0', " F,0,0,100,1"].join("\n");
    const result = parseStoryboardTexts([osb, osu]);
    expect(result.sprites.map((sprite) => sprite.filePath)).toEqual(["a.png", "b.png"]);
    expect(result.sprites[0].order).toBeLessThan(result.sprites[1].order);
  });

  it("handles \\r\\n line endings and a BOM", () => {
    const text = `﻿[Events]\r\nSprite,Foreground,Centre,"a.png",0,0\r\n F,0,0,100,1\r\n`;
    const result = parseStoryboardTexts([text]);
    expect(result.sprites).toHaveLength(1);
  });

  it("swaps inverted command times to zero duration", () => {
    const result = parseStoryboardTexts([
      ["[Events]", 'Sprite,Foreground,Centre,"a.png",0,0', " F,0,500,100,0,1"].join("\n"),
    ]);
    expect(channelSegments(result.sprites[0], SB_CHAN_ALPHA)).toEqual([[500, 500, 0, 0, 1]]);
  });

  it("caps runaway loops via the segment budget", () => {
    const result = parseStoryboardTexts(
      [
        ["[Events]", 'Sprite,Foreground,Centre,"a.png",0,0', " L,0,99999", "  F,0,0,100,0,1"].join("\n"),
      ],
      { maxSegmentsPerSprite: 10 },
    );
    expect(result.sprites[0].chanStart[SB_CHAN_ALPHA + 1] - result.sprites[0].chanStart[SB_CHAN_ALPHA]).toBe(10);
    expect(result.droppedSegments).toBeGreaterThan(0);
  });

  it("parses async in chunks with identical output", async () => {
    const text = [
      "[Events]",
      'Sprite,Foreground,Centre,"a.png",0,0',
      " F,0,0,100,0,1",
      " MX,0,0,100,0,640",
    ].join("\n");
    const sync = parseStoryboardTexts([text]);
    const async_ = await parseStoryboardTextsAsync([text], {}, 2);
    expect(async_.sprites).toHaveLength(sync.sprites.length);
    expect([...async_.sprites[0].seg]).toEqual([...sync.sprites[0].seg]);
  });
});

describe("osuFileHasStoryboardElements", () => {
  it("detects sprites in the events section only", () => {
    expect(
      osuFileHasStoryboardElements(
        ["[Events]", '0,0,"bg.jpg",0,0', 'Sprite,Foreground,Centre,"a.png",0,0'].join("\n"),
      ),
    ).toBe(true);
    expect(
      osuFileHasStoryboardElements(["[Events]", '0,0,"bg.jpg",0,0', "2,100,200"].join("\n")),
    ).toBe(false);
    expect(
      osuFileHasStoryboardElements(["[Metadata]", "Title:Sprite,foo"].join("\n")),
    ).toBe(false);
  });
});
