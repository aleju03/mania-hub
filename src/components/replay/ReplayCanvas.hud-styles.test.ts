import { describe, expect, it, vi } from "vitest";
import { ManiaReplayRenderer } from "./ReplayCanvas";
import type { ReplayHitErrorStyle, ReplayJudgementLayout } from "../../lib/replay-overlays";

type RoundRect = [number, number, number, number, number, string, number];
type DrawnText = [string, number, number, { fontSize: number; fill: string; anchorX?: number }];

const LAYOUT = {
  w: 1280, h: 720, playfieldX: 500, playfieldWidth: 280,
  judgmentY: 620, receptorHeight: 40,
} as unknown as Parameters<ManiaReplayRenderer["render"]>[0];

// The bar and the judgement counts both draw straight from cached HUD state,
// so a prototype stub with the same fields renders without a GPU canvas.
function hudRenderer(overlaySettings: Record<string, unknown>, offsets: number[]) {
  const graphics = Object.fromEntries(
    ["poly", "fill", "stroke", "roundRect", "circle"].map((name) => [name, vi.fn().mockReturnThis()]),
  );
  return Object.assign(Object.create(ManiaReplayRenderer.prototype), {
    overlaySettings,
    // Authored against this very stage, so every layout scale resolves to 1
    // and the drawn sizes are the raw constants.
    overlayReferenceLayout: {
      width: 1280, height: 720, playfieldX: 500, playfieldWidth: 280, hudScale: 1, spacingScale: 1,
    },
    ruleset: { accuracyMode: "stable" },
    skinSettings: { style: "bars" },
    hitWindows: { great: 16, ok: 64, meh: 151 },
    recentHitOffsets: offsets,
    recentHitTimes: offsets.map(() => 0),
    currentTime: 0,
    urSum: offsets.reduce((sum, offset) => sum + offset, 0),
    hudCachedJudgmentCounts: ["0", "1204", "318", "27", "9", "2", "4"],
    hudCachedUr: "71",
    getOverlayScale: () => 1,
    getOverlayPlacement: (id: string) => overlaySettings[id],
    measureTextWidth: (text: string, size: number) => text.length * size * 0.6,
    shouldRenderCustomOverlays: () => true,
    getOverlayFrame: vi.fn((_layout, _id, width: number, height: number) => ({ x: 40, y: 80, width, height })),
    addText: vi.fn(),
    fillRect: vi.fn(),
    circle: vi.fn(),
    roundRect: vi.fn(),
    graphics,
  }) as {
    roundRect: ReturnType<typeof vi.fn>;
    addText: ReturnType<typeof vi.fn>;
    getOverlayFrame: ReturnType<typeof vi.fn>;
    renderHitErrorBar(layout: unknown): void;
    renderJudgementOverlay(layout: unknown): void;
  };
}

function hitErrorRenderer(style: ReplayHitErrorStyle, offsets: number[]) {
  return hudRenderer({ hitError: { enabled: true, x: 0.4, y: 0.8, scale: 1, style } }, offsets);
}

function judgementRenderer(style: ReplayJudgementLayout) {
  return hudRenderer({ judgements: { enabled: true, x: 0.9, y: 0.2, scale: 1, style } }, []);
}

// Bands span the whole window they stand for; ticks are the 2px marks.
const bandsOf = (renderer: { roundRect: ReturnType<typeof vi.fn> }) =>
  (renderer.roundRect.mock.calls as RoundRect[]).filter((call) => call[2] > 10);
const ticksOf = (renderer: { roundRect: ReturnType<typeof vi.fn> }) =>
  (renderer.roundRect.mock.calls as RoundRect[]).filter((call) => call[2] === 2);

describe("hit error bar styles", () => {
  it("draws the three hit windows and white ticks by default", () => {
    const renderer = hitErrorRenderer("bands", [-5, 40, -90]);
    renderer.renderHitErrorBar(LAYOUT);

    expect(bandsOf(renderer).map((call) => call[5])).toEqual(["#e8a733", "#85cc26", "#46b8e8"]);
    expect(ticksOf(renderer).slice(0, 3).map((call) => call[5])).toEqual(["#ffffff", "#ffffff", "#ffffff"]);
  });

  it("drops the bands and colors each tick by its window on hits only", () => {
    const renderer = hitErrorRenderer("ticks", [-5, 40, -90]);
    renderer.renderHitErrorBar(LAYOUT);

    expect(bandsOf(renderer)).toHaveLength(0);
    expect(ticksOf(renderer).slice(0, 3).map((call) => call[5])).toEqual(["#46b8e8", "#85cc26", "#e8a733"]);
  });

  it("keeps the same box either way, so switching styles never moves the bar", () => {
    const bands = hitErrorRenderer("bands", [10]);
    const ticks = hitErrorRenderer("ticks", [10]);
    bands.renderHitErrorBar(LAYOUT);
    ticks.renderHitErrorBar(LAYOUT);

    expect(ticks.getOverlayFrame.mock.calls[0].slice(2)).toEqual(bands.getOverlayFrame.mock.calls[0].slice(2));
  });

  it("still marks the center and the rolling average without the bands", () => {
    const renderer = hitErrorRenderer("ticks", [10, 20]) as unknown as {
      fillRect: ReturnType<typeof vi.fn>;
      graphics: { poly: ReturnType<typeof vi.fn> };
      renderHitErrorBar(layout: unknown): void;
    };
    renderer.renderHitErrorBar(LAYOUT);

    expect(renderer.fillRect.mock.calls.some((call) => call[4] === "#ffffff")).toBe(true);
    expect(renderer.graphics.poly).toHaveBeenCalled();
  });
});

describe("judgement overlay layouts", () => {
  it("stacks label and value rows in one column when vertical", () => {
    const renderer = judgementRenderer("vertical");
    renderer.renderJudgementOverlay(LAYOUT);

    const labels = (renderer.addText.mock.calls as DrawnText[]).filter((call) => call[3].anchorX !== 1);
    expect(labels.map((call) => call[0])).toEqual(["MAX", "300", "200", "100", "50", "MISS", "UR"]);
    // One x for every label, rising y.
    expect(new Set(labels.map((call) => call[1])).size).toBe(1);
    expect(labels.map((call) => call[2])).toEqual([...labels.map((call) => call[2])].sort((a, b) => a - b));
  });

  it("runs the cells left to right over two rows when horizontal", () => {
    const renderer = judgementRenderer("horizontal");
    renderer.renderJudgementOverlay(LAYOUT);

    const calls = renderer.addText.mock.calls as DrawnText[];
    const labels = calls.filter((_, index) => index % 2 === 0);
    const values = calls.filter((_, index) => index % 2 === 1);
    expect(labels.map((call) => call[0])).toEqual(["MAX", "300", "200", "100", "50", "MISS", "UR"]);
    expect(values.map((call) => call[0])).toEqual(["1204", "318", "27", "9", "2", "4", "71"]);
    // Cells advance in x, labels share one row and values share the next.
    expect(labels.map((call) => call[1])).toEqual([...labels.map((call) => call[1])].sort((a, b) => a - b));
    expect(new Set(labels.map((call) => call[2])).size).toBe(1);
    expect(new Set(values.map((call) => call[2])).size).toBe(1);
    expect(values[0][2]).toBeGreaterThan(labels[0][2]);
    expect(labels.every((call, index) => call[1] === values[index][1])).toBe(true);
  });

  it("is wider than tall horizontally and taller than wide vertically", () => {
    const vertical = judgementRenderer("vertical");
    const horizontal = judgementRenderer("horizontal");
    vertical.renderJudgementOverlay(LAYOUT);
    horizontal.renderJudgementOverlay(LAYOUT);

    const [, , verticalWidth, verticalHeight] = vertical.getOverlayFrame.mock.calls[0];
    const [, , horizontalWidth, horizontalHeight] = horizontal.getOverlayFrame.mock.calls[0];
    expect(verticalHeight).toBeGreaterThan(verticalWidth);
    expect(horizontalWidth).toBeGreaterThan(horizontalHeight);
  });

  it("sizes horizontal cells off a fixed digit span, so rising counts never resize it", () => {
    const renderer = judgementRenderer("horizontal");
    renderer.renderJudgementOverlay(LAYOUT);
    const width = renderer.getOverlayFrame.mock.calls[0][2];

    const grown = judgementRenderer("horizontal");
    (grown as unknown as { hudCachedJudgmentCounts: string[] }).hudCachedJudgmentCounts =
      ["0", "9999", "9999", "9999", "9999", "9999", "9999"];
    grown.renderJudgementOverlay(LAYOUT);

    expect(grown.getOverlayFrame.mock.calls[0][2]).toBe(width);
  });
});
