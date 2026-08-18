// @vitest-environment node
/* The roster carries each sprite's own proportion so a still can draw it at
   the shape it actually is. That number is copied from the file, which means
   it can go stale the moment somebody swaps a sprite - so it is checked
   against the file rather than trusted. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { canHoldNote, NOTE_SPRITES, noteSpriteBox, noteSpritePath } from "./note-sprites";

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
async function pngSize(name: string): Promise<{ width: number; height: number }> {
  const buffer = await readFile(`public${noteSpritePath(name)}`);
  expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe("NOTE_SPRITES", () => {
  it("names files that exist, at the proportion the roster claims", async () => {
    for (const sprite of NOTE_SPRITES) {
      const { width, height } = await pngSize(sprite.name);
      expect({ name: sprite.name, ratio: Number((width / height).toFixed(4)) })
        .toEqual({ name: sprite.name, ratio: Number(sprite.ratio.toFixed(4)) });
    }
  });

  it("calls a sprite a bar exactly when it is wider than it is tall", async () => {
    for (const sprite of NOTE_SPRITES) {
      const { width, height } = await pngSize(sprite.name);
      expect({ name: sprite.name, bar: sprite.aspect === "bar" })
        .toEqual({ name: sprite.name, bar: width / height > 1.3 });
    }
  });

  it("has no duplicate names", () => {
    expect(new Set(NOTE_SPRITES.map((sprite) => sprite.name)).size).toBe(NOTE_SPRITES.length);
  });
});

describe("noteSpriteBox", () => {
  /* The bug this replaced: ManiaRain draws every bar in one 1.4 x 0.3 box, so
     bar-red - natively about twice as flat as the other three - got squashed
     into a pointed sliver once it was tilted on a still. */
  it("draws every sprite at its own proportion", () => {
    for (const sprite of NOTE_SPRITES) {
      const box = noteSpriteBox(sprite, 40);
      expect({ name: sprite.name, ratio: Number((box.width / box.height).toFixed(3)) })
        .toEqual({ name: sprite.name, ratio: Number(sprite.ratio.toFixed(3)) });
    }
  });

  /* Sized by ink rather than by width, so a flatter bar does not also read as
     a lighter one next to a circle of the same nominal size. */
  it("gives a bar about as much ink as a circle of the same size", () => {
    const circle = noteSpriteBox(NOTE_SPRITES.find((sprite) => sprite.name === "circle-blue")!, 40);
    const circleInk = (Math.PI / 4) * circle.width * circle.height;
    for (const sprite of NOTE_SPRITES.filter((sprite) => sprite.aspect === "bar")) {
      const box = noteSpriteBox(sprite, 40);
      expect(Math.abs((box.width * box.height) / circleInk - 1)).toBeLessThan(0.05);
    }
  });

  it("scales linearly with the size it is given", () => {
    for (const sprite of NOTE_SPRITES) {
      const small = noteSpriteBox(sprite, 20);
      const large = noteSpriteBox(sprite, 40);
      expect(large.width / small.width).toBeCloseTo(2, 6);
      expect(large.height / small.height).toBeCloseTo(2, 6);
    }
  });
});

describe("canHoldNote", () => {
  /* A hold's body runs up behind its head, which an up or down arrow cannot
     carry: the body would come out of the arrow's back. */
  it("refuses the two arrows a body cannot trail behind", () => {
    const refused = NOTE_SPRITES.filter((sprite) => !canHoldNote(sprite)).map((sprite) => sprite.name);
    expect(refused.sort()).toEqual([
      "arrow-down-gray", "arrow-down-green", "arrow-up-gray", "arrow-up-pink",
    ]);
  });
});
