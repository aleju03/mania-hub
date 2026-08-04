// @vitest-environment node
// Companion to farm-helper-snapshot-cache.test.ts, run WITHOUT a window.
//
// One Node process serves every SSR request, so a module-level cache that
// stored anything on the server would hand one visitor another visitor's
// board. This file exists to make that regression impossible to land quietly.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchSnapshot = vi.fn();

vi.mock("./live-backend", () => ({
  fetchLiveFarmHelperSnapshot: (...args: unknown[]) => fetchSnapshot(...args),
}));

const {
  loadFarmHelperSnapshot,
  peekFarmHelperSnapshot,
  prefetchFarmHelperSnapshot,
} = await import("./farm-helper-snapshot-cache");

const REQUEST = { subjectKey: "Shiny", keyMode: "any", view: "gain", limit: 200 } as const;

beforeEach(() => {
  fetchSnapshot.mockReset();
  fetchSnapshot.mockImplementation(async () => ({ status: "ready", userId: 1, username: "Shiny", recs: [] }));
});

describe("farm helper client snapshot cache on the server", () => {
  it("has no window to cache in", () => {
    expect(typeof window).toBe("undefined");
  });

  it("never stores a snapshot", async () => {
    await loadFarmHelperSnapshot(REQUEST);
    expect(peekFarmHelperSnapshot(REQUEST)).toBeNull();

    // Still fetches (the caller asked for data), just refetches every time
    // rather than sharing one visitor's response with the next.
    await loadFarmHelperSnapshot(REQUEST);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not prefetch", () => {
    prefetchFarmHelperSnapshot(REQUEST);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});
