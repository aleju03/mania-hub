import { describe, expect, it } from "vitest";
import { BEATMAP_MIRRORS, mirrorOrderFor, oszDownloadUrl } from "./beatmap-mirrors";

describe("mirrorOrderFor", () => {
  it("returns every mirror exactly once", () => {
    const order = mirrorOrderFor(2317767);
    expect(order.map((m) => m.name).sort()).toEqual(
      [...BEATMAP_MIRRORS].map((m) => m.name).sort(),
    );
  });

  it("starts at the set's deterministic mirror and wraps around", () => {
    const start = 7 % BEATMAP_MIRRORS.length;
    const order = mirrorOrderFor(7);
    expect(order[0]).toBe(BEATMAP_MIRRORS[start]);
    expect(order[order.length - 1]).toBe(
      BEATMAP_MIRRORS[(start + BEATMAP_MIRRORS.length - 1) % BEATMAP_MIRRORS.length],
    );
  });

  it("spreads consecutive set ids across different mirrors", () => {
    const starts = new Set(
      [0, 1, 2, 3, 4].map((id) => mirrorOrderFor(id)[0].name),
    );
    expect(starts.size).toBe(BEATMAP_MIRRORS.length);
  });
});

describe("oszDownloadUrl", () => {
  it("points at the mirror-probing redirect route", () => {
    expect(oszDownloadUrl(123456)).toBe("/api/osz?beatmapsetId=123456");
  });
});
