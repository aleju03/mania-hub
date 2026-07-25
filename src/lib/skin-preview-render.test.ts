import { describe, expect, it } from "vitest";

import {
  bodyTileRects,
  buildSkinPreviewPattern,
  computeSkinPreviewLayout,
  mulberry32,
  SKIN_PREVIEW_HEIGHT,
  SKIN_PREVIEW_WIDTH,
} from "./skin-preview-render";

describe("computeSkinPreviewLayout", () => {
  const profile = { columnWidth: 36, columnWidths: [], columnSpacing: 0 };

  it("centers the stage and scales lanes like the game (skin units are 480ths of the height)", () => {
    const layout = computeSkinPreviewLayout(profile, 4);
    // 36-unit columns at a 720-high canvas: 36 * (720 / 480) = 54px each.
    expect(layout.laneWidths[0]).toBeCloseTo(36 * (SKIN_PREVIEW_HEIGHT / 480), 5);
    const left = layout.stageX;
    const right = SKIN_PREVIEW_WIDTH - (layout.stageX + layout.stageWidth);
    expect(Math.abs(left - right)).toBeLessThan(0.001);
    expect(layout.laneXs).toHaveLength(4);
    expect(layout.laneWidths).toHaveLength(4);
  });

  it("clamps ultra-wide stages to the canvas", () => {
    const layout = computeSkinPreviewLayout({ columnWidth: 160, columnWidths: [], columnSpacing: 0 }, 10);
    expect(layout.stageWidth).toBeLessThanOrEqual(SKIN_PREVIEW_WIDTH * 0.94 + 0.001);
    expect(layout.stageX).toBeGreaterThanOrEqual(0);
  });

  it("honours per-column widths from the skin", () => {
    const layout = computeSkinPreviewLayout({ columnWidth: 30, columnWidths: [30, 60, 30, 60], columnSpacing: 0 }, 4);
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
