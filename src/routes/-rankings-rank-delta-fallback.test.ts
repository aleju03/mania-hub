import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = fs.readFileSync(path.resolve(__dirname, "rankings.tsx"), "utf8");

/** The `if (liveBackendEnabled) { ... }` block inside loadRankDeltas. */
function readLiveBackendBranch(): string {
  const start = routeSource.indexOf("if (liveBackendEnabled) {");
  expect(start).toBeGreaterThan(-1);
  const end = routeSource.indexOf("\n      }", routeSource.indexOf("} finally {", start));
  expect(end).toBeGreaterThan(start);
  return routeSource.slice(start, end);
}

describe("rankings rank-delta loading", () => {
  // osu! only exposes rank_history on the single-user endpoint, so covering a
  // 50-row page from osu! costs 50 calls, in the interactive limiter lane that
  // skips the shared spacing gate. Untracked countries paid that on every view
  // and helped pin the budget at 84/min against a 55 target (2026-08-06).
  it("never falls back to the osu! rank_history path when the live backend is enabled", () => {
    const branch = readLiveBackendBranch();

    expect(branch).toContain("fetchLiveRankDeltas");
    expect(branch).not.toContain("loadRankHistoryFallback");
    expect(branch).not.toContain("getUsersRankHistory");
  });

  it("still marks deltas ready so missing ones render as '-' instead of a stuck skeleton", () => {
    const branch = readLiveBackendBranch();

    // Both the success and the failure path run this finally; without it the
    // rank cells sit in <Skeleton> forever for any country with no snapshots.
    expect(branch).toContain("setRankDeltasReady(true)");
    expect(branch).toContain("} finally {");
  });

  it("keeps the dash as the rendered empty state for a missing delta", () => {
    // GlobalRankCell and CRRankCell both render a muted dash when the delta is
    // absent, which is what an untracked country now shows for the whole column.
    expect(routeSource).toContain('<span className="text-[11px] text-osu-f1">-</span>');
    expect(routeSource).toContain('<div className="text-center text-[11px] text-osu-f1">-</div>');
  });
});
