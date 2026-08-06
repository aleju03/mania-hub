import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LivePlayerProfileSnapshot } from "../lib/live-backend";

const fetchLivePlayerProfileSnapshotDirect = vi.fn<
  (username: string) => Promise<LivePlayerProfileSnapshot | null>
>();

vi.mock("../lib/live-backend", async () => {
  const actual = await vi.importActual<typeof import("../lib/live-backend")>("../lib/live-backend");
  return {
    ...actual,
    fetchLivePlayerProfileSnapshotDirect: (username: string) =>
      fetchLivePlayerProfileSnapshotDirect(username),
  };
});

const { loadPlayerSnapshotCached, resetPlayerSnapshotCachesForTests } = await import(
  "./player/$username"
);

const MINUTE = 60_000;

function snapshot(userFetchedAt: string, pp: number): LivePlayerProfileSnapshot {
  return {
    user: {
      id: 4_242,
      username: "tester",
      statistics: { pp },
    },
    bestScores: [],
    fetchedAt: userFetchedAt,
    userFetchedAt,
    isStale: false,
  } as unknown as LivePlayerProfileSnapshot;
}

// Every stored profile the backend serves has user metadata older than the
// 10-minute freshness mark most of the time (13,335 of 13,373 rows on prod when
// this was written), so the stale branch is the ordinary path, not the edge.
function staleSnapshot(pp = 5_000): LivePlayerProfileSnapshot {
  return snapshot(new Date(Date.now() - 2 * 60 * MINUTE).toISOString(), pp);
}

describe("player snapshot client cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPlayerSnapshotCachesForTests();
    fetchLivePlayerProfileSnapshotDirect.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a re-entry from cache instead of refetching the snapshot", async () => {
    fetchLivePlayerProfileSnapshotDirect.mockResolvedValue(staleSnapshot());

    await loadPlayerSnapshotCached("tester");
    expect(fetchLivePlayerProfileSnapshotDirect).toHaveBeenCalledTimes(1);

    // Leaving and coming back a couple of seconds later is the reported bug:
    // with the old one-second TTL for stale metadata this refetched every time.
    vi.setSystemTime(Date.now() + 2_000);
    const second = await loadPlayerSnapshotCached("tester");

    expect(fetchLivePlayerProfileSnapshotDirect).toHaveBeenCalledTimes(1);
    expect(second?.user.id).toBe(4_242);
  });

  it("paints the expired entry immediately and revalidates underneath", async () => {
    fetchLivePlayerProfileSnapshotDirect.mockResolvedValue(staleSnapshot(5_000));
    await loadPlayerSnapshotCached("tester");

    // Past the shortened TTL but well inside the stale-while-revalidate window.
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    fetchLivePlayerProfileSnapshotDirect.mockResolvedValue(staleSnapshot(6_000));

    const onRevalidated = vi.fn();
    const served = await loadPlayerSnapshotCached("tester", { onRevalidated });

    // The visitor sees the old numbers with no skeleton...
    expect(served?.user.statistics?.pp).toBe(5_000);
    // ...and the newer ones arrive without a second page load.
    await vi.runAllTimersAsync();
    expect(onRevalidated).toHaveBeenCalledTimes(1);
    expect(onRevalidated.mock.calls[0][0].user.statistics?.pp).toBe(6_000);
    expect(fetchLivePlayerProfileSnapshotDirect).toHaveBeenCalledTimes(2);
  });

  it("waits for fresh data once the cached entry is too old to paint", async () => {
    fetchLivePlayerProfileSnapshotDirect.mockResolvedValue(staleSnapshot(5_000));
    await loadPlayerSnapshotCached("tester");

    vi.setSystemTime(Date.now() + 90 * MINUTE);
    fetchLivePlayerProfileSnapshotDirect.mockResolvedValue(staleSnapshot(7_000));

    const served = await loadPlayerSnapshotCached("tester");

    expect(served?.user.statistics?.pp).toBe(7_000);
    expect(fetchLivePlayerProfileSnapshotDirect).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached entry when a refresh with fresh metadata lands", async () => {
    fetchLivePlayerProfileSnapshotDirect.mockResolvedValue(snapshot(new Date().toISOString(), 5_000));
    await loadPlayerSnapshotCached("tester");

    // Fresh metadata caches for the full five minutes, so a minute later there
    // is still nothing to refetch and nothing to revalidate.
    vi.setSystemTime(Date.now() + MINUTE);
    const onRevalidated = vi.fn();
    await loadPlayerSnapshotCached("tester", { onRevalidated });

    await vi.runAllTimersAsync();
    expect(fetchLivePlayerProfileSnapshotDirect).toHaveBeenCalledTimes(1);
    expect(onRevalidated).not.toHaveBeenCalled();
  });

  it("still bypasses the cache for the metadata retry ladder", async () => {
    fetchLivePlayerProfileSnapshotDirect.mockResolvedValue(staleSnapshot());
    await loadPlayerSnapshotCached("tester");

    await loadPlayerSnapshotCached("tester", { bypassDataCache: true });

    expect(fetchLivePlayerProfileSnapshotDirect).toHaveBeenCalledTimes(2);
  });
});
