// @vitest-environment jsdom
// The cache is browser-only by design (a module-level map filled during SSR
// would leak one visitor's board to another), so it needs a window to do
// anything at all - see the isBrowser guards it is asserted against below.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSnapshot = vi.fn();

vi.mock("./live-backend", () => ({
  fetchLiveFarmHelperSnapshot: (...args: unknown[]) => fetchSnapshot(...args),
}));

const {
  clearFarmHelperSnapshotCache,
  invalidateFarmHelperSubject,
  loadFarmHelperSnapshot,
  peekFarmHelperSnapshot,
  prefetchFarmHelperSnapshot,
} = await import("./farm-helper-snapshot-cache");

const REQUEST = { subjectKey: "Shiny", keyMode: "any", view: "gain", limit: 200 } as const;

function snapshotFor(username: string) {
  return { status: "ready", userId: 1, username, recs: [] };
}

beforeEach(() => {
  clearFarmHelperSnapshotCache();
  fetchSnapshot.mockReset();
  fetchSnapshot.mockImplementation(async (userKey: string) => snapshotFor(userKey));
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("farm helper client snapshot cache", () => {
  it("issues one request per request key for concurrent callers", async () => {
    const results = await Promise.all([
      loadFarmHelperSnapshot(REQUEST),
      loadFarmHelperSnapshot(REQUEST),
      loadFarmHelperSnapshot(REQUEST),
    ]);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toBe(results[0]);
  });

  it("serves a repeat load from cache without refetching", async () => {
    await loadFarmHelperSnapshot(REQUEST);
    await loadFarmHelperSnapshot(REQUEST);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps keymode, view and limit apart", async () => {
    await loadFarmHelperSnapshot(REQUEST);
    await loadFarmHelperSnapshot({ ...REQUEST, keyMode: "4k" });
    await loadFarmHelperSnapshot({ ...REQUEST, view: "popular" });
    await loadFarmHelperSnapshot({ ...REQUEST, limit: 50 });
    expect(fetchSnapshot).toHaveBeenCalledTimes(4);
  });

  it("treats subject keys case- and whitespace-insensitively", async () => {
    await loadFarmHelperSnapshot(REQUEST);
    await loadFarmHelperSnapshot({ ...REQUEST, subjectKey: "  shiny " });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("peeks only settled, still-fresh entries", async () => {
    expect(peekFarmHelperSnapshot(REQUEST)).toBeNull();

    let resolve: ((value: unknown) => void) | undefined;
    fetchSnapshot.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = loadFarmHelperSnapshot(REQUEST);
    // In flight: nothing to paint synchronously yet.
    expect(peekFarmHelperSnapshot(REQUEST)).toBeNull();
    resolve?.(snapshotFor("Shiny"));
    await pending;
    expect(peekFarmHelperSnapshot(REQUEST)).not.toBeNull();
  });

  it("expires entries after the endpoint's cache window", async () => {
    await loadFarmHelperSnapshot(REQUEST);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61_000;
      expect(peekFarmHelperSnapshot(REQUEST)).toBeNull();
      await loadFarmHelperSnapshot(REQUEST);
    } finally {
      Date.now = realNow;
    }
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("never retains a failed request", async () => {
    fetchSnapshot.mockRejectedValueOnce(new Error("boom"));
    await expect(loadFarmHelperSnapshot(REQUEST)).rejects.toThrow("boom");
    expect(peekFarmHelperSnapshot(REQUEST)).toBeNull();

    await loadFarmHelperSnapshot(REQUEST);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("fans one failure out to every concurrent caller", async () => {
    fetchSnapshot.mockRejectedValueOnce(new Error("boom"));
    const settled = await Promise.allSettled([
      loadFarmHelperSnapshot(REQUEST),
      loadFarmHelperSnapshot(REQUEST),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("drops every view of a subject on feedback invalidation, leaving others alone", async () => {
    await loadFarmHelperSnapshot(REQUEST);
    await loadFarmHelperSnapshot({ ...REQUEST, view: "popular" });
    await loadFarmHelperSnapshot({ ...REQUEST, subjectKey: "Someone" });

    invalidateFarmHelperSubject("Shiny");

    expect(peekFarmHelperSnapshot(REQUEST)).toBeNull();
    expect(peekFarmHelperSnapshot({ ...REQUEST, view: "popular" })).toBeNull();
    expect(peekFarmHelperSnapshot({ ...REQUEST, subjectKey: "Someone" })).not.toBeNull();
  });

  it("does not serve a pre-mark entry to a request carrying a newer epoch", async () => {
    await loadFarmHelperSnapshot(REQUEST);
    await loadFarmHelperSnapshot({ ...REQUEST, fresh: 1234 });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    // And the epoch is passed through to the fetcher as the cache buster.
    expect(fetchSnapshot).toHaveBeenLastCalledWith("Shiny", expect.objectContaining({ fresh: 1234 }));
  });

  it("prefetch warms the cache and is a no-op once warm", async () => {
    prefetchFarmHelperSnapshot(REQUEST);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    // A real load right after a prefetch reuses it: one request per key even
    // when hover intent and the click both fire.
    await loadFarmHelperSnapshot(REQUEST);
    prefetchFarmHelperSnapshot(REQUEST);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("swallows prefetch failures", async () => {
    fetchSnapshot.mockRejectedValueOnce(new Error("boom"));
    expect(() => prefetchFarmHelperSnapshot(REQUEST)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peekFarmHelperSnapshot(REQUEST)).toBeNull();
  });

  it("bounds how many snapshots it retains", async () => {
    for (let i = 0; i < 30; i++) {
      await loadFarmHelperSnapshot({ ...REQUEST, subjectKey: `player${i}` });
    }
    // The oldest entries were evicted; the newest are still there.
    expect(peekFarmHelperSnapshot({ ...REQUEST, subjectKey: "player0" })).toBeNull();
    expect(peekFarmHelperSnapshot({ ...REQUEST, subjectKey: "player29" })).not.toBeNull();
  });
});
