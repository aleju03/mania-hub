import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/discord/util.js";

describe("mapWithConcurrency", () => {
  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);
    await mapWithConcurrency(items, 5, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => { calls += 1; });
    expect(calls).toBe(0);
    await mapWithConcurrency([1, 2], 10, async () => { calls += 1; });
    expect(calls).toBe(2);
  });
});
