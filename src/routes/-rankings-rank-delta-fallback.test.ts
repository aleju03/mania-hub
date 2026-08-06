import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = fs.readFileSync(path.resolve(__dirname, "rankings.tsx"), "utf8");

describe("rankings rank-delta loading", () => {
  // osu! only exposes rank_history on the single-user endpoint, so covering a
  // 50-row page from osu! costs 50 calls, in the interactive limiter lane that
  // skips the shared spacing gate. Untracked countries paid that on every view
  // and helped pin the budget at 84/min against a 55 target (2026-08-06).
  it("loads deltas from the live backend and never from the osu! rank_history path", () => {
    expect(routeSource).toContain("fetchLiveRankDeltas");
    expect(routeSource).not.toContain("getUsersRankHistory");
    expect(routeSource).not.toContain("getGlobalRankChange");
    expect(routeSource).not.toContain("rankHistories[");
  });

  it("marks deltas ready on both paths so missing ones render as '-' instead of a stuck skeleton", () => {
    const start = routeSource.indexOf("const loadRankDeltas = async () => {");
    expect(start).toBeGreaterThan(-1);
    const body = routeSource.slice(start, routeSource.indexOf("void loadRankDeltas()", start));

    // Success and failure both run this finally; without it the rank cells sit
    // in <Skeleton> forever for any country with no snapshots.
    expect(body).toContain("} finally {");
    expect(body).toContain("setRankDeltasReady(true)");
  });

  it("tells a missing delta apart from a real zero on hover", () => {
    // Both render the same dash, so the title is the only thing carrying the
    // difference between "no snapshot yet" and "did not move".
    expect(routeSource).toContain('const NO_DELTA_TITLE = "No rank data from 7 days ago yet"');
    expect(routeSource).toContain('const NO_CHANGE_TITLE = "No change in the last 7 days"');

    for (const cell of ["GlobalRankCell", "CRRankCell", "RankDeltaLabel"]) {
      const start = routeSource.indexOf(`function ${cell}(`);
      expect(start, `${cell} should still exist`).toBeGreaterThan(-1);
      const body = routeSource.slice(start, routeSource.indexOf("\n}", start));
      expect(body, `${cell} should title its empty state`).toContain("NO_DELTA_TITLE");
      expect(body, `${cell} should title its zero state`).toContain("NO_CHANGE_TITLE");
    }
  });
});
