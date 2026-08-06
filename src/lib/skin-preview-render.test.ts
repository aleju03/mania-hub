import { describe, expect, it } from "vitest";

import {
  bodyTileRects,
  buildSkinPreviewPattern,
  computeSkinPreviewLayout,
  lnTailArtEdgeFraction,
  longNoteGeometry,
  mulberry32,
  SKIN_PREVIEW_HEIGHT,
  SKIN_PREVIEW_WIDTH,
} from "./skin-preview-render";

describe("computeSkinPreviewLayout", () => {
  const profile = { columnWidth: 36, columnWidths: [], columnSpacing: 0, columnStart: null };

  it("scales lanes like the game (skin units are 480ths of the height)", () => {
    const layout = computeSkinPreviewLayout(profile, 4);
    // 36-unit columns at a 720-high canvas: 36 * (720 / 480) = 54px each.
    expect(layout.laneWidths[0]).toBeCloseTo(36 * (SKIN_PREVIEW_HEIGHT / 480), 5);
    expect(layout.laneXs).toHaveLength(4);
    expect(layout.laneWidths).toHaveLength(4);
  });

  it("puts an undeclared stage at stable's default ColumnStart, left of centre", () => {
    const layout = computeSkinPreviewLayout(profile, 4);
    expect(layout.stageX).toBeCloseTo(136 * (SKIN_PREVIEW_HEIGHT / 480), 5);
  });

  it("positions the stage at the skin's ColumnStart (RESIDENT sits at the left)", () => {
    const layout = computeSkinPreviewLayout(
      { columnWidth: 28, columnWidths: [28, 22, 28, 22, 28, 22, 28], columnSpacing: 0, columnStart: 120 },
      7,
    );
    expect(layout.stageX).toBeCloseTo(120 * (SKIN_PREVIEW_HEIGHT / 480), 5);
  });

  it("lands the 427 - width/2 centring formula in the middle of the card", () => {
    // O2Jam FHD 4K: ColumnStart 316 with four 55-unit columns.
    const layout = computeSkinPreviewLayout(
      { columnWidth: 55, columnWidths: [55, 55, 55, 55], columnSpacing: 0, columnStart: 316 },
      4,
    );
    const center = layout.stageX + layout.stageWidth / 2;
    // The author rounded 316.67 down to 316, so allow the same slack.
    expect(Math.abs(center - SKIN_PREVIEW_WIDTH / 2)).toBeLessThan(2);
  });

  it("keeps a far-right ColumnStart on the card", () => {
    const layout = computeSkinPreviewLayout({ ...profile, columnStart: 830 }, 4);
    expect(layout.stageX + layout.stageWidth).toBeLessThanOrEqual(SKIN_PREVIEW_WIDTH);
  });

  it("clamps ultra-wide stages to the canvas", () => {
    const layout = computeSkinPreviewLayout({ columnWidth: 160, columnWidths: [], columnSpacing: 0, columnStart: null }, 10);
    expect(layout.stageWidth).toBeLessThanOrEqual(SKIN_PREVIEW_WIDTH * 0.94 + 0.001);
    expect(layout.stageX).toBeGreaterThanOrEqual(0);
    expect(layout.stageX + layout.stageWidth).toBeLessThanOrEqual(SKIN_PREVIEW_WIDTH + 0.001);
  });

  it("honours per-column widths from the skin", () => {
    const layout = computeSkinPreviewLayout({ columnWidth: 30, columnWidths: [30, 60, 30, 60], columnSpacing: 0, columnStart: null }, 4);
    expect(layout.laneWidths[1]).toBeCloseTo(layout.laneWidths[0] * 2, 5);
    // lanes tile the stage without gaps when spacing is zero
    expect(layout.laneXs[1]).toBeCloseTo(layout.laneXs[0] + layout.laneWidths[0], 5);
  });

  it("keeps the hit line inside the canvas", () => {
    const layout = computeSkinPreviewLayout(profile, 7);
    expect(layout.hitLineY).toBeGreaterThan(0);
    expect(layout.hitLineY).toBeLessThan(SKIN_PREVIEW_HEIGHT);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 20; i += 1) {
      expect(a()).toBe(b());
    }
  });

  it("stays within [0, 1)", () => {
    const random = mulberry32(99);
    for (let i = 0; i < 100; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("buildSkinPreviewPattern", () => {
  it("produces the identical pattern on every call for a keymode", () => {
    expect(buildSkinPreviewPattern(4)).toEqual(buildSkinPreviewPattern(4));
    expect(buildSkinPreviewPattern(7)).toEqual(buildSkinPreviewPattern(7));
  });

  it("keeps all notes inside their columns and above the hit line", () => {
    for (const keys of [1, 4, 7, 10]) {
      const pattern = buildSkinPreviewPattern(keys);
      const hitLineY = SKIN_PREVIEW_HEIGHT * 0.9;
      for (const tap of pattern.taps) {
        expect(tap.column).toBeGreaterThanOrEqual(0);
        expect(tap.column).toBeLessThan(keys);
        expect(tap.y).toBeLessThanOrEqual(hitLineY);
        expect(tap.y).toBeGreaterThan(0);
      }
      for (const ln of pattern.longNotes) {
        expect(ln.column).toBeGreaterThanOrEqual(0);
        expect(ln.column).toBeLessThan(keys);
        expect(ln.tailY).toBeLessThan(ln.headY);
      }
      // 1K has a single column mostly claimed by the long note; real keymodes
      // (4K+) place plenty more.
      expect(pattern.taps.length).toBeGreaterThanOrEqual(keys === 1 ? 4 : 6);
    }
  });

  it("never stacks taps closer than the note height within a column", () => {
    for (const keys of [4, 7]) {
      const noteHeight = 130;
      const pattern = buildSkinPreviewPattern(keys, { noteHeight });
      const byColumn = new Map<number, number[]>();
      for (const tap of pattern.taps) {
        const list = byColumn.get(tap.column) ?? [];
        list.push(tap.y);
        byColumn.set(tap.column, list);
        // full sprite stays inside the scroll area
        expect(tap.y - noteHeight).toBeGreaterThanOrEqual(0);
      }
      for (const ys of byColumn.values()) {
        const sorted = [...ys].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i += 1) {
          expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(noteHeight);
        }
      }
    }
  });

  it("respects a raised hit line from tall receptors", () => {
    const pattern = buildSkinPreviewPattern(4, { hitLineY: 500 });
    for (const tap of pattern.taps) {
      expect(tap.y).toBeLessThanOrEqual(500);
    }
  });
});

describe("longNoteGeometry", () => {
  // Stable's hold-note layout: both caps are notes at their position lines
  // with their boxes growing away from the receptor, the body stops at the
  // head's centre and runs the tail box's full depth. ArrowMania-ish numbers:
  // 96px square caps, head line at 600, tail line at 300, downscroll.
  const downscroll = { upscroll: false, headEndY: 600, tailEndY: 300, headHeight: 96, tailHeight: 96 };

  it("runs the body from the tail box's far edge to the head's centre", () => {
    const geometry = longNoteGeometry(downscroll);
    expect(geometry.bodyTop).toBe(300 - 96);
    expect(geometry.bodyBottom).toBe(600 - 48);
  });

  it("keeps both caps' boxes on the receptor-away side of their position lines", () => {
    const geometry = longNoteGeometry(downscroll);
    expect(geometry.headBoxTop).toBe(600 - 96);
    expect(geometry.tailBoxTop).toBe(300 - 96);
    // The body overlaps into each cap's box, so the cap art covers the join...
    expect(geometry.bodyBottom).toBeGreaterThan(geometry.headBoxTop);
    expect(geometry.bodyTop).toBeLessThan(300);
    // ...and never past either box's far edge.
    expect(geometry.bodyTop).toBeGreaterThanOrEqual(geometry.tailBoxTop);
    expect(geometry.bodyBottom).toBeLessThanOrEqual(600);
  });

  it("mirrors for upscroll", () => {
    const geometry = longNoteGeometry({ upscroll: true, headEndY: 120, tailEndY: 420, headHeight: 96, tailHeight: 96 });
    expect(geometry.bodyTop).toBe(120 + 48);
    expect(geometry.bodyBottom).toBe(420 + 96);
    expect(geometry.headBoxTop).toBe(120);
    expect(geometry.tailBoxTop).toBe(420);
  });

  it("anchors a Percy body's transparent lead-in at the tail box's far edge", () => {
    // The mokou skin's 128x20000 body is blank for its first 54 rows and its
    // 128x65 tail is art for 53, authored to interlock only when the cascade
    // counts from the box's far edge. A centre stop pushed that blank lead-in
    // half a cap down the hold and opened it as a gap under the tail.
    const geometry = longNoteGeometry(downscroll);
    expect(geometry.bodyTop).toBe(geometry.tailBoxTop);
  });

  it("runs the body to the position line when the skin ships no tail art", () => {
    // A blank cap is measured as a zero-height box by the callers, so the hold
    // ends exactly at its position line. Skins that end the body art in its own
    // rounded cap and point the tail at a 1x1 transparent placeholder depend on
    // this: a box sized off that placeholder's aspect would be a lane width
    // tall, and the cascade starting at its far edge would stretch every hold
    // by that much and eat the gap to the next note.
    const geometry = longNoteGeometry({ ...downscroll, tailHeight: 0 });
    expect(geometry.bodyTop).toBe(300);
    expect(geometry.tailBoxTop).toBe(300);
    expect(geometry.bodyBottom).toBe(600 - 48);
  });

  it("mirrors the blank-cap case for upscroll", () => {
    const geometry = longNoteGeometry({ upscroll: true, headEndY: 120, tailEndY: 420, headHeight: 96, tailHeight: 0 });
    expect(geometry.bodyBottom).toBe(420);
    expect(geometry.tailBoxTop).toBe(420);
  });

  it("runs the body out instead of flipping it once the tail reaches the head's centre", () => {
    // The last half-cap of every hold played through: the tail closes on the
    // head at the receptor. Taking the absolute span drew that remainder on
    // the far side of the centre, which under a round cap surfaces as two
    // corners of body poking out below the head until the tail lands.
    const spent = longNoteGeometry({ ...downscroll, tailEndY: 580, tailHeight: 0 });
    expect(spent.bodyBottom).toBeLessThan(spent.bodyTop);
    // Still a body while the tail is above the centre.
    const alive = longNoteGeometry({ ...downscroll, tailEndY: 540, tailHeight: 0 });
    expect(alive.bodyTop).toBe(540);
    expect(alive.bodyBottom).toBe(600 - 48);
  });

  it("mirrors the spent-body case for upscroll", () => {
    const spent = longNoteGeometry({ upscroll: true, headEndY: 120, tailEndY: 140, headHeight: 96, tailHeight: 0 });
    expect(spent.bodyBottom).toBeLessThan(spent.bodyTop);
  });
});

describe("lnTailArtEdgeFraction", () => {
  // StepMania Reborn's roof cap: art begins 63 rows into its 122-row texture,
  // so the flipped downscroll cap's base lands at 48.4% of the box - just shy
  // of the centre the body stops at, which is the seam this closes. The
  // texture's top edge faces the body in both scroll directions (downscroll
  // flips the cap, upscroll leaves it upright below the body).
  it("flips the art's top edge to face the body on downscroll", () => {
    expect(lnTailArtEdgeFraction(63 / 122, false)).toBeCloseTo(1 - 63 / 122);
  });

  it("keeps the art's top edge as-is on upscroll", () => {
    expect(lnTailArtEdgeFraction(63 / 122, true)).toBeCloseTo(63 / 122);
  });

  it("leaves stable's centre stop alone for art that fills its box", () => {
    // ArrowMania's hollow roof reaches 54% down the flipped box, past the
    // centre, so the min in the renderer keeps the body stopping at 50% and
    // nothing shows through the chevron.
    expect(lnTailArtEdgeFraction(59 / 128, false)).toBeGreaterThan(0.5);
  });
});

describe("bodyTileRects", () => {
  // The tiling seam: a body tile drawn into a fractional rect half-covers the
  // pixel row at each end, and two half-covered rows composited in sequence
  // reach 75% opacity, not 100%. Whole-pixel edges are what removes it, so
  // that is what these pin down.
  const span = (tiles: ReturnType<typeof bodyTileRects>) =>
    tiles.length === 0 ? 0 : tiles[tiles.length - 1].top + tiles[tiles.length - 1].height - tiles[0].top;

  it("lands every tile edge on a whole pixel", () => {
    const tiles = bodyTileRects(100.37, 260.81, 32, 0.6719);

    expect(tiles.length).toBeGreaterThan(4);
    for (const tile of tiles) {
      expect(Number.isInteger(tile.top)).toBe(true);
      expect(Number.isInteger(tile.height)).toBe(true);
    }
  });

  it("leaves no gap or overlap between tiles", () => {
    const tiles = bodyTileRects(100.37, 260.81, 32, 0.6719);

    for (let index = 1; index < tiles.length; index += 1) {
      expect(tiles[index].top).toBe(tiles[index - 1].top + tiles[index - 1].height);
    }
  });

  it("covers the span it was given, to the pixel", () => {
    const tiles = bodyTileRects(100.37, 260.81, 32, 0.6719);

    expect(tiles[0].top).toBe(Math.round(100.37));
    expect(span(tiles)).toBe(Math.round(260.81) - Math.round(100.37));
  });

  it("trims the last tile's source rows rather than overshooting the tail", () => {
    const tiles = bodyTileRects(0, 50, 32, 1);

    expect(tiles).toHaveLength(2);
    expect(tiles[0].sourceRows).toBe(32);
    // 18 rows left of the span, so the closing tile samples only those.
    expect(tiles[1].sourceRows).toBeCloseTo(18, 5);
  });

  it("keeps a sub-pixel tile visible instead of collapsing it", () => {
    const tiles = bodyTileRects(0, 2, 32, 0.01);

    expect(tiles.every((tile) => tile.height >= 1)).toBe(true);
  });

  it("draws nothing for an empty or inverted span", () => {
    expect(bodyTileRects(200, 100, 32, 0.6)).toEqual([]);
    expect(bodyTileRects(100, 100, 32, 0.6)).toEqual([]);
    expect(bodyTileRects(100, 200, 32, 0)).toEqual([]);
  });
});
