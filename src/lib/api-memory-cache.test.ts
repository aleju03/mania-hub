import { afterEach, expect, it, vi } from "vitest";
import {
  fetchWithCacheLock, getCachedEntry, getServerResponseCacheStats,
  invalidatePersistentCache, setCache,
} from "./api";
import { ResponseMemoryCache } from "./response-memory-cache";

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("isolates artifact budgets and expires idle artifacts without shortening ordinary response TTLs", async () => {
  vi.useFakeTimers();
  const ttl = 30 * 86_400_000;
  const artifactKeys = ["replay-parsed:v4:1:mania:4", "uploaded-replay-packed:v1:test", "beatmap-file:v1:1"];
  for (const key of artifactKeys) setCache(key, { payload: key }, ttl);
  setCache("ordinary-response", { ok: true }, ttl);
  expect(getServerResponseCacheStats()).toMatchObject({ artifacts: { entries: 3 }, responses: { entries: 1 } });

  // No cache lookups during the lifetime: the background sweep frees idle data.
  const prune = vi.spyOn(ResponseMemoryCache.prototype, "prune");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(prune).toHaveBeenCalled();
  expect(getServerResponseCacheStats()).toMatchObject({ artifacts: { entries: 0 }, responses: { entries: 1 } });
  for (const key of artifactKeys) expect(getCachedEntry(key)).toEqual({ hit: false });
  expect(getCachedEntry("ordinary-response")).toEqual({ hit: true, value: { ok: true } });

  // An over-budget response is still delivered to its caller; only retention
  // is refused. Concurrent same-key readers continue to share the build.
  const oversized = "x".repeat(2 * 1024 * 1024);
  const produce = vi.fn(async () => oversized);
  expect(await Promise.all([
    fetchWithCacheLock("oversized-response", ttl, produce),
    fetchWithCacheLock("oversized-response", ttl, produce),
  ])).toEqual([oversized, oversized]);
  expect(produce).toHaveBeenCalledTimes(1);
  expect(getCachedEntry("oversized-response")).toEqual({ hit: false });
  expect(getServerResponseCacheStats().responses.rejected).toBe(1);

  await invalidatePersistentCache("ordinary-response");
  expect(getCachedEntry("ordinary-response")).toEqual({ hit: false });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(vi.getTimerCount()).toBe(0);
});
