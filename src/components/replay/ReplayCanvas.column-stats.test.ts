import { describe, expect, it, vi } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import type { ReplayJudgementEvent } from "#replay-judge/mania-replay-judgement";

type Hit = { column: number; judgment: number; offsetMs: number };

function event({ column, judgment, offsetMs }: Hit, index: number): ReplayJudgementEvent {
  return { column, judgment, offsetMs, time: index * 100, noteIndex: index, part: "note" } as ReplayJudgementEvent;
}

// The real stats pass without a GPU canvas: advanceStats walks the same event
// list the simulator produces.
function statsRenderer(keyCount: number, hits: Hit[]) {
  const renderer = Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    keyCount,
    ruleset: { accuracyMode: "stable" },
    judgmentEvents: hits.map(event),
    comboEvents: [],
    statsScanIndex: 0,
    comboScanIndex: 0,
    currentTime: 0,
    combo: 0,
    maxComboSoFar: 0,
    judgmentCounts: [0, 0, 0, 0, 0, 0, 0],
    leftHandJudgmentCounts: [0, 0, 0, 0, 0, 0, 0],
    rightHandJudgmentCounts: [0, 0, 0, 0, 0, 0, 0],
    leftHandMisses: 0,
    rightHandMisses: 0,
    missThumbHand: "right",
    recentHitOffsets: [],
    recentHitTimes: [],
    urSum: 0,
    urSumSq: 0,
    totalHits: 0,
    totalHitOffsetSum: 0,
    totalHitOffsetSumSq: 0,
    earlyHits: 0,
    lateHits: 0,
    lastJudgment: 0,
    lastJudgmentTime: 0,
  }) as {
    columnJudgmentCounts: number[][];
    hudCachedColumnAccuracy: string[];
    hudCachedColumnAccuracyValues: number[];
    hudCachedColumnUr: string[];
    hudCachedColumnUrValues: (number | null)[];
    resetColumnStats(): void;
    advanceStats(upToTime?: number): void;
    updateColumnStatSnapshot(): void;
    getColumnUr(column: number): number | null;
  };
  renderer.resetColumnStats();
  return renderer;
}

type OverlayBox = { x: number; y: number; width: number; height: number };
type DrawnText = [string, number, number, { fontSize: number; fill: string; anchorX?: number }];
type Style = "meters" | "circles" | "leaderboard" | "plain";

function columnStatsRenderer(keyCount: number, style: Style, metric: "accuracy" | "ur" = "accuracy") {
  const graphics = Object.fromEntries(
    ["circle", "roundRect", "stroke", "fill", "save", "setTransform", "restore"].map((name) => [name, vi.fn().mockReturnThis()]),
  );
  return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    keyCount,
    overlaySettings: { columnStats: { style, metric } },
    hudCachedColumnAccuracy: Array.from({ length: keyCount }, (_, col) => (99 - col / 10).toFixed(1)),
    hudCachedColumnAccuracyValues: Array.from({ length: keyCount }, (_, col) => 99 - col / 10),
    hudCachedColumnUr: Array.from({ length: keyCount }, (_, col) => String(60 + col)),
    hudCachedColumnUrValues: Array.from({ length: keyCount }, (_, col) => 60 + col),
    getOverlayScale: () => 1,
    measureTextWidth: (text: string, size: number) => text.length * size * 0.6,
    getOverlayFrame: vi.fn((_layout, _id, width: number, height: number) => ({ x: 40, y: 80, width, height })),
    addText: vi.fn(),
    fillRect: vi.fn(),
    circle: vi.fn(),
    graphics,
  }) as {
    overlaySettings: { columnStats: { style: Style; metric: string } };
    hudCachedColumnUr: string[];
    hudCachedColumnUrValues: (number | null)[];
    renderColumnStatsOverlay(layout: unknown): void;
    getOverlayFrame: { mock: { results: { value: OverlayBox }[] } };
    addText: { mock: { calls: DrawnText[] } };
    fillRect: { mock: { calls: [number, number, number, number, string, number][] } };
    circle: { mock: { calls: [number, number, number, string, number][] } };
    graphics: Record<string, { mock: { calls: unknown[][] } }>;
  };
}

describe("per-column stats", () => {
  it("splits accuracy and unstable rate by column", () => {
    const renderer = statsRenderer(4, [
      { column: 0, judgment: 1, offsetMs: 2 },
      { column: 0, judgment: 1, offsetMs: -2 },
      { column: 0, judgment: 1, offsetMs: 2 },
      { column: 1, judgment: 4, offsetMs: 40 },
      { column: 1, judgment: 6, offsetMs: 0 },
      { column: 2, judgment: 1, offsetMs: 5 },
    ]);
    renderer.advanceStats(10_000);
    renderer.updateColumnStatSnapshot();

    expect(renderer.columnJudgmentCounts[0][1]).toBe(3);
    expect(renderer.columnJudgmentCounts[1]).toEqual([0, 0, 0, 0, 1, 0, 1]);
    expect(renderer.hudCachedColumnAccuracy[0]).toBe("100.0");
    // A 100 and a miss out of two notes on stable: (100 + 0) / 600.
    expect(renderer.hudCachedColumnAccuracyValues[1]).toBeCloseTo(100 / 6);
    // Offsets 2, -2, 2 have a standard deviation of sqrt(32/9) ms.
    expect(renderer.getColumnUr(0)).toBeCloseTo(Math.sqrt(32 / 9) * 10);
    expect(renderer.hudCachedColumnUr[0]).toBe(String(Math.round(Math.sqrt(32 / 9) * 10)));
  });

  it("reads a column with fewer than two hits as no data, not as a steady one", () => {
    const renderer = statsRenderer(4, [
      { column: 2, judgment: 1, offsetMs: 5 },
      { column: 1, judgment: 6, offsetMs: 0 },
    ]);
    renderer.advanceStats(10_000);
    renderer.updateColumnStatSnapshot();

    // One hit (no spread), a miss only, and a column that never had a note.
    expect(renderer.getColumnUr(2)).toBeNull();
    expect(renderer.hudCachedColumnUr).toEqual(["-", "-", "-", "-"]);
    expect(renderer.hudCachedColumnUrValues).toEqual([null, null, null, null]);
    expect(renderer.hudCachedColumnAccuracy[3]).toBe("100.0");
  });

  it("rebuilds the columns on a seek and forces the HUD snapshot with them", () => {
    const renderer = statsRenderer(4, [
      { column: 0, judgment: 1, offsetMs: 2 },
      { column: 0, judgment: 1, offsetMs: -2 },
      { column: 3, judgment: 6, offsetMs: 0 },
    ]);
    const render = vi.fn();
    Object.assign(renderer, {
      totalDuration: 10_000,
      lazerLeaderboardFrameTime: 0,
      initialCombo: 0,
      render,
      resetHiddenCoverage: vi.fn(),
      resetAudioClockSmoothing: vi.fn(),
      resetHitsoundCursors: vi.fn(),
    });

    (renderer as unknown as { seek(time: number): void }).seek(5_000);

    expect(renderer.columnJudgmentCounts[0][1]).toBe(2);
    expect(renderer.columnJudgmentCounts[3][6]).toBe(1);
    // Forced: the throttled snapshot would leave a paused stage showing the
    // zeroes the rebuild just wrote.
    expect(render.mock.calls).toEqual([[true]]);
  });

  it("keeps a cell per column inside the frame, in order, with its meter", () => {
    const renderer = columnStatsRenderer(7, "meters");
    renderer.renderColumnStatsOverlay({});
    const frame = renderer.getOverlayFrame.mock.results[0].value;

    const values = renderer.addText.mock.calls.filter(([text]) => text.includes("."));
    const labels = renderer.addText.mock.calls.filter(([text]) => !text.includes("."));
    expect(values).toHaveLength(7);
    expect(labels.map(([text]) => text)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    for (const [, x, y] of renderer.addText.mock.calls) {
      expect(x).toBeGreaterThanOrEqual(frame.x);
      expect(x).toBeLessThanOrEqual(frame.x + frame.width);
      expect(y).toBeGreaterThanOrEqual(frame.y);
      expect(y).toBeLessThanOrEqual(frame.y + frame.height);
    }
    // Each column centre sits left of the next one's.
    const centres = values.map(([, x]) => x);
    expect([...centres].sort((a, b) => a - b)).toEqual(centres);
    // One track plus one fill per column, none wider than its cell.
    expect(renderer.fillRect.mock.calls).toHaveLength(14);
    const cellWidth = renderer.fillRect.mock.calls[0][2];
    for (const [x, , width] of renderer.fillRect.mock.calls) {
      expect(width).toBeLessThanOrEqual(cellWidth + 0.001);
      expect(x + cellWidth).toBeLessThanOrEqual(frame.x + frame.width + 0.001);
    }
  });

  it("draws the unstable rate reading and leaves a dataless column with an empty meter", () => {
    const renderer = columnStatsRenderer(4, "meters", "ur");
    renderer.hudCachedColumnUr[3] = "-";
    renderer.hudCachedColumnUrValues[3] = null;
    renderer.renderColumnStatsOverlay({});

    expect(renderer.addText.mock.calls.map(([text]) => text)).toEqual(
      ["60", "1", "61", "2", "62", "3", "-", "4"],
    );
    // Three tracks with a fill on top, and the dataless column's track alone.
    expect(renderer.fillRect.mock.calls).toHaveLength(7);
  });

  it("colours every shape by the reading rather than by the lane", () => {
    // Three readings, three bands of the shared ramp.
    const readings = ["99.0", "96.0", "92.0"];
    const colorsFor = (style: Style) => {
      const renderer = columnStatsRenderer(3, style);
      Object.assign(renderer, {
        hudCachedColumnAccuracy: readings,
        hudCachedColumnAccuracyValues: readings.map(Number),
      });
      renderer.renderColumnStatsOverlay({});
      const drawn = style === "meters"
        ? renderer.fillRect.mock.calls.filter(([, , , , , alpha]) => alpha === 0.95).map(([, , , , color]) => color)
        : style === "plain"
          ? renderer.addText.mock.calls.filter(([text]) => text.includes(".")).map(([, , , options]) => options.fill)
          : renderer.graphics.stroke.mock.calls
            .map((call) => (call[0] as { color: number }))
            .filter((stroke) => stroke.color !== 0xffffff)
            .map((stroke) => `#${stroke.color.toString(16).padStart(6, "0")}`);
      return drawn;
    };

    for (const style of ["meters", "plain", "circles", "leaderboard"] as Style[]) {
      const colors = colorsFor(style);
      expect(new Set(colors).size, style).toBe(3);
      expect(colors[0], style).toBe("#b3f5ff");
      expect(colors[2], style).toBe("#ff8a22");
    }
  });

  it("draws a circle per column in the hit circle style and a sheared panel in the leaderboard style", () => {
    const circles = columnStatsRenderer(4, "circles");
    circles.renderColumnStatsOverlay({});
    // Body plus tint per column, and one value and one column number each.
    expect(circles.circle.mock.calls).toHaveLength(8);
    expect(circles.addText.mock.calls).toHaveLength(8);
    const frame = circles.getOverlayFrame.mock.results[0].value;
    for (const [x, y, radius] of circles.circle.mock.calls) {
      expect(x - radius).toBeGreaterThanOrEqual(frame.x - 0.001);
      expect(y + radius).toBeLessThanOrEqual(frame.y + frame.height + 0.001);
    }

    const board = columnStatsRenderer(4, "leaderboard");
    board.renderColumnStatsOverlay({});
    expect(board.graphics.setTransform.mock.calls).toHaveLength(4);
    expect(board.graphics.restore.mock.calls).toHaveLength(4);
    // The shear, not an upright box.
    expect(board.graphics.setTransform.mock.calls[0][2]).toBeLessThan(0);
  });
});
