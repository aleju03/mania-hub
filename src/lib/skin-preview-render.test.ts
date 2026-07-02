import { describe, expect, it } from "vitest";

import {
  buildSkinPreviewPattern,
  computeSkinPreviewLayout,
  mulberry32,
  SKIN_PREVIEW_HEIGHT,
  SKIN_PREVIEW_WIDTH,
} from "./skin-preview-render";

describe("computeSkinPreviewLayout", () => {
  const profile = { columnWidth: 36, columnWidths: [], columnSpacing: 0 };

  it("centers the stage and keeps it within the width budget", () => {
    const layout = computeSkinPreviewLayout(profile, 4);
    expect(layout.stageWidth).toBeLessThanOrEqual(SKIN_PREVIEW_WIDTH * 0.42 + 0.001);
    const left = layout.stageX;
    const right = SKIN_PREVIEW_WIDTH - (layout.stageX + layout.stageWidth);
    expect(Math.abs(left - right)).toBeLessThan(0.001);
    expect(layout.laneXs).toHaveLength(4);
    expect(layout.laneWidths).toHaveLength(4);
  });

  it("caps individual lane width for low key counts", () => {
    const layout = computeSkinPreviewLayout({ columnWidth: 400, columnWidths: [], columnSpacing: 0 }, 2);
    for (const width of layout.laneWidths) {
      expect(width).toBeLessThanOrEqual(150.001);
    }
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
      const hitLineY = SKIN_PREVIEW_HEIGHT * 0.86;
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
      expect(pattern.taps.length).toBeGreaterThan(4);
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
