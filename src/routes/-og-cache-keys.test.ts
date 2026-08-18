// @vitest-environment node
/* Rasterizing an OG card is the most expensive work the frontend server does,
   and the R2 cache key for the player cards is the username itself. So what may
   become a key has to be the shape of a real osu! username - otherwise every
   junk string is a guaranteed cache miss, an osu! lookup and a render. */
import { describe, expect, it } from "vitest";
import { OgRenderGate } from "../lib/og-render";
import { ogUsernameKey } from "./api/og";

describe("ogUsernameKey", () => {
  it("accepts real osu! usernames and folds case and padding into one key", () => {
    expect(ogUsernameKey("peppy")).toBe("peppy");
    expect(ogUsernameKey("  Peppy ")).toBe("peppy");
    expect(ogUsernameKey("[Cup] Fan-1_2")).toBe("[cup] fan-1_2");
    // A bare user id is a valid key too: the osu! lookup retries a numeric key
    // as an id, so /player/2927048 has a card like any name does.
    expect(ogUsernameKey("2927048")).toBe("2927048");
  });

  it("refuses anything no osu! account could be called", () => {
    for (const value of [
      "",
      "   ",
      null,
      undefined,
      "a".repeat(16),
      "name?cachebust=1",
      "name/../../etc",
      "naïve",
      "<script>",
    ]) {
      expect(ogUsernameKey(value), String(value)).toBeNull();
    }
  });
});

describe("OG render concurrency", () => {
  it("never exceeds the hard cap while a cold fallback waits", async () => {
    const gate = new OgRenderGate(2);
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const run = (id: number) => gate.run(async () => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return id;
    });

    const first = run(1);
    const second = run(2);
    const coldFallback = run(3);
    await Promise.resolve();

    expect(started).toEqual([1, 2]);
    expect(gate.activeCount).toBe(2);

    releases.shift()?.();
    await first;
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    expect(gate.activeCount).toBe(2);

    releases.shift()?.();
    releases.shift()?.();
    await Promise.all([second, coldFallback]);
    expect(gate.activeCount).toBe(0);
  });
});
