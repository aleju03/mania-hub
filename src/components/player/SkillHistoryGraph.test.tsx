// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "../../lib/i18n";
import { SkillHistoryGraph, monotonePath } from "./SkillHistoryGraph";

const fetchSeries = vi.hoisted(() => vi.fn());
vi.mock("../../lib/live-backend", () => ({ fetchLivePlayerSkillHistorySeriesDirect: fetchSeries }));
vi.mock("../../lib/overall-method", () => ({ useOverallMethod: () => "mean" }));
vi.mock("../../store", () => ({ useNoDans: () => false }));

beforeAll(async () => {
  await loadLocaleCatalog("en");
});
afterEach(() => { cleanup(); fetchSeries.mockReset(); });

function point(recordedAt: string, version: number, overall: number) {
  return { recordedAt, version, ratings: { Overall: overall }, danRc: null };
}

function renderGraph(keyCount: number) {
  return render(<I18nProvider i18n={getI18n("en")}><SkillHistoryGraph userId={99} keyCount={keyCount} /></I18nProvider>);
}

describe("SkillHistoryGraph", () => {
  it("starts at the newest rating-scale change the player has reached", async () => {
    fetchSeries.mockResolvedValue({ points: [point("2026-09-20T12:00:00Z", 46, 20), point("2026-09-28T12:00:00Z", 47, 24.5)] });
    const view = renderGraph(7);
    await waitFor(() => expect(view.getByText("24.50")).toBeTruthy());
    // The reading from before the 5K+ rescale is left out.
    expect(view.queryByText(/since/)).toBeNull();
  });

  it("still shows a player not yet recomputed onto today's scale", async () => {
    fetchSeries.mockResolvedValue({ points: [point("2026-09-01T12:00:00Z", 38, 18), point("2026-09-14T12:00:00Z", 40, 19), point("2026-09-20T12:00:00Z", 45, 21.25)] });
    const view = renderGraph(7);
    await waitFor(() => expect(view.getByText("21.25")).toBeTruthy());
    expect(view.queryByText("No skill ratings have been recorded yet.")).toBeNull();
    // Readings from v40 on: +2.25 since the first of them.
    expect(view.getByText("+2.25")).toBeTruthy();
  });
});

describe("monotonePath", () => {
  it("passes through every reading without overshooting between them", () => {
    const pts: Array<[number, number]> = [[0, 50], [10, 50], [12, 20], [40, 20], [41, 60], [80, 58]];
    const path = monotonePath(pts);
    for (const [px, py] of pts) expect(path).toContain(`${px},${py}`);
    // Every control point stays inside the y range of its own segment.
    const segments = [...path.matchAll(/C([^C]+)/g)].map((m) => m[1].trim().split(" ").map((pair) => pair.split(",").map(Number)));
    segments.forEach(([c1, c2], i) => {
      const lo = Math.min(pts[i][1], pts[i + 1][1]);
      const hi = Math.max(pts[i][1], pts[i + 1][1]);
      for (const c of [c1, c2]) expect(c[1]).toBeGreaterThanOrEqual(lo - 1e-9), expect(c[1]).toBeLessThanOrEqual(hi + 1e-9);
    });
  });

  it("keeps the later of two readings on one pixel column", () => {
    const path = monotonePath([[0, 5], [0, 7], [10, 7]]);
    expect(path.startsWith("M0,7C")).toBe(true);
    expect(path).not.toContain(",5");
    expect(path.match(/C/g)).toHaveLength(1);
  });
});
