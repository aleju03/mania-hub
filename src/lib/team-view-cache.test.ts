import { afterEach, expect, it, vi } from "vitest";
import { TeamViewCache } from "./team-view-cache";

afterEach(() => { vi.useRealTimers(); });

it("shares pending work, expires settled data and retries errors", async () => {
  vi.useFakeTimers();
  const cache = new TeamViewCache(100, 2);
  let resolve!: (value: string) => void;
  const produce = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
  const first = cache.get("one", produce);
  const second = cache.get("one", produce);
  expect(first).toBe(second);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(produce).toHaveBeenCalledOnce();
  expect(cache.get("one", produce)).toBe(first);
  resolve("value");
  await first;
  expect(cache.peek("one")).toBe("value");
  await vi.advanceTimersByTimeAsync(101);
  expect(cache.peek("one")).toBeUndefined();
  await expect(cache.get("one", async () => { throw Error("failed"); })).rejects.toThrow("failed");
  expect(await cache.get("one", async () => "retried")).toBe("retried");
});

it("enforces the byte budget and bounds pending requests", async () => {
  vi.useFakeTimers();
  const cache = new TeamViewCache(100, 2, 60);
  await cache.get("one", async () => "abc");
  await cache.get("two", async () => "abcdef");
  expect(cache.peek("one")).toBeUndefined();
  expect(cache.peek("two")).toBe("abcdef");
  await cache.get("large", async () => "x".repeat(100));
  expect(cache.peek("large")).toBeUndefined();
  void cache.get("pending1", () => new Promise(() => {}));
  void cache.get("pending2", () => new Promise(() => {}));
  await expect(cache.get("overflow", async () => "no")).rejects.toThrow("busy");
});
