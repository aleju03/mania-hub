// @vitest-environment node
/* Rasterizing an OG card is the most expensive work the frontend server does,
   and the R2 cache key for the player cards is the username itself. So what may
   become a key has to be the shape of a real osu! username - otherwise every
   junk string is a guaranteed cache miss, an osu! lookup and a render. */
import { describe, expect, it } from "vitest";
import { OgRenderGate } from "../lib/og-render";
import { maniacardCacheKey, maniacardLookStamp, ogUsernameKey, pulledCardLookKeySegment } from "./api/og";

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

describe("pull OG cache key", () => {
  it("leaves ordinary cards on the keys already in R2 and moves a supporter's with their look", () => {
    expect(pulledCardLookKeySegment({ card: {} })).toBe("");
    expect(pulledCardLookKeySegment({ card: { supporterLook: null } })).toBe("");
    const holo = pulledCardLookKeySegment({ card: { supporterLook: { motif: "none", foil: "holo" } } });
    const ice = pulledCardLookKeySegment({ card: { supporterLook: { motif: "none", foil: "cracked-ice" } } });
    expect(holo).toBe(":sl-none-holo");
    expect(ice).toBe(":sl-none-cracked-ice");
    // the retired preset doodles read as no art, on the same key as "none"
    expect(pulledCardLookKeySegment({ card: { supporterLook: { motif: "stars", foil: "holo" } } })).toBe(":sl-none-holo");
    const hash = "a".repeat(64);
    const custom = { motif: "custom", foil: "holo", url: `https://cdn.mania-tracker.com/supporter-motifs/${hash}.webp`, scale: 1.5, opacity: 0.9 };
    expect(pulledCardLookKeySegment({ card: { supporterLook: custom } })).toBe(`:sl-custom.${hash.slice(0, 16)}.1.5.0.9-holo`);
    expect(pulledCardLookKeySegment({ team: {}, card: { supporterLook: { motif: "none", foil: "holo" } } })).toBe("");
  });
});

describe("maniacard cache key", () => {
  it("keeps the keys unstamped and pp-stamped cards already have", () => {
    expect(maniacardCacheKey("peppy", null, null, 7)).toBe("maniacard:peppy:v7");
    expect(maniacardCacheKey("peppy", 1234, null, 7)).toBe("maniacard:peppy:pp1234:v7");
  });

  it("moves with a supporter's look stamp", () => {
    expect(maniacardCacheKey("peppy", 1234, "0123456789", 7)).toBe("maniacard:peppy:pp1234:sl-0123456789:v7");
    expect(maniacardCacheKey("peppy", null, "0123456789", 7)).toBe("maniacard:peppy:sl-0123456789:v7");
  });

  it("takes only a stamp the backend could have made", () => {
    expect(maniacardLookStamp("0123456789")).toBe("0123456789");
    for (const value of [null, "", "01234567", "0123456789a", "ABCDEF0123", "holo:../x"]) expect(maniacardLookStamp(value)).toBeNull();
  });
});
