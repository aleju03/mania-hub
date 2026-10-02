import { describe, expect, it } from "vitest";
import { estimateResponseBytes, ResponseMemoryCache } from "./response-memory-cache";

describe("ResponseMemoryCache", () => {
  it("evicts by retained bytes and preserves recently used answers", () => {
    const cache = new ResponseMemoryCache({ maxEntries: 10, maxBytes: 600, maxEntryBytes: 400 });
    cache.set("a", "x".repeat(100), 100, 0);
    cache.set("b", "y".repeat(100), 100, 0);
    expect(cache.get("a", 1).hit).toBe(true);
    cache.set("c", "z".repeat(100), 100, 2);
    expect(cache.get("b", 3).hit).toBe(false);
    expect(cache.get("a", 3).hit).toBe(true);
    expect(cache.get("c", 3).hit).toBe(true);
    expect(cache.stats()).toMatchObject({ entries: 2, evictions: 1 });
    expect(cache.stats().estimatedBytes).toBeLessThanOrEqual(600);
  });

  it("rejects an oversized replacement without retaining the old answer", () => {
    const cache = new ResponseMemoryCache({ maxEntries: 10, maxBytes: 1000, maxEntryBytes: 400 });
    cache.set("a", "old", 100, 0);
    cache.set("a", "x".repeat(1000), 100, 0);
    expect(cache.get("a", 1)).toEqual({ hit: false });
    expect(cache.stats()).toMatchObject({ entries: 0, estimatedBytes: 0, rejected: 1 });
  });

  it("accounts for replacements, deletes, entry-count eviction, and clear", () => {
    const cache = new ResponseMemoryCache({ maxEntries: 2, maxBytes: 10_000, maxEntryBytes: 2000 });
    cache.set("a", "large".repeat(100), 100, 0);
    cache.set("a", null, 100, 0);
    cache.set("b", false, 100, 0);
    cache.set("c", 0, 100, 0);
    expect(cache.get("a", 1)).toEqual({ hit: false });
    expect(cache.get("b", 1)).toEqual({ hit: true, value: false });
    expect(cache.get("c", 1)).toEqual({ hit: true, value: 0 });
    cache.delete("b");
    cache.delete("b");
    expect(cache.stats()).toMatchObject({ entries: 1, estimatedBytes: 82 });
    cache.clear();
    expect(cache.stats()).toMatchObject({ entries: 0, estimatedBytes: 0 });
  });

  it("caps artifact lifetime without extending it on a hit and prunes idle entries", () => {
    const cache = new ResponseMemoryCache({ maxEntries: 10, maxBytes: 1000, maxEntryBytes: 400, maxAgeMs: 20 });
    cache.set("long", null, 30 * 86_400_000, 0);
    cache.set("short", 1, 5, 0);
    expect(cache.get("long", 19)).toEqual({ hit: true, value: null });
    cache.prune(20);
    expect(cache.stats()).toMatchObject({ entries: 0, estimatedBytes: 0 });
    expect(cache.get("long", 20)).toEqual({ hit: false });
  });

  it("invalidates entries when a caller writes a zero TTL", () => {
    const cache = new ResponseMemoryCache({ maxEntries: 10, maxBytes: 1000, maxEntryBytes: 400 });
    cache.set("a", 1, 100, 0);
    cache.set("a", null, 0, 1);
    expect(cache.get("a", 2)).toEqual({ hit: false });
  });
});

describe("response size estimation", () => {
  it("counts the retained buffer behind a small view and shared references once", () => {
    const buffer = new ArrayBuffer(4096);
    const view = new Uint8Array(buffer, 0, 1);
    expect(estimateResponseBytes(view, Infinity)).toBeGreaterThanOrEqual(4096);
    expect(estimateResponseBytes([view, view], Infinity)).toBeLessThan(8192);
  });

  it("handles cycles and refuses opaque or excessively deep values", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(Number.isFinite(estimateResponseBytes(cycle, 1000))).toBe(true);
    expect(estimateResponseBytes(new Map([["large", "x".repeat(1000)]]), 1000)).toBe(Infinity);
    expect(estimateResponseBytes(() => "closure", 1000)).toBe(Infinity);
    let deep: unknown = null;
    for (let i = 0; i < 100; i++) deep = { deep };
    expect(estimateResponseBytes(deep, 100_000)).toBe(Infinity);
  });
});
