import { describe, expect, it } from "vitest";
import { BEATMAP_MIRRORS, mirrorHas, mirrorOrderFor, oszDownloadUrl } from "./beatmap-mirrors";

const primaries = BEATMAP_MIRRORS.filter((mirror) => !mirrorHas(mirror, "fallback"));
const fallbacks = BEATMAP_MIRRORS.filter((mirror) => mirrorHas(mirror, "fallback"));

describe("mirrorOrderFor", () => {
  it("returns every mirror exactly once", () => {
    const order = mirrorOrderFor(2317767);
    expect(order.map((m) => m.name).sort()).toEqual(
      [...BEATMAP_MIRRORS].map((m) => m.name).sort(),
    );
  });

  it("starts at the set's deterministic primary mirror and puts the fallbacks last", () => {
    const order = mirrorOrderFor(7);
    expect(order[0]).toBe(primaries[7 % primaries.length]);
    expect(order[primaries.length - 1]).toBe(primaries[(7 + primaries.length - 1) % primaries.length]);
    expect(order.slice(primaries.length).map((m) => m.name).sort()).toEqual(fallbacks.map((m) => m.name).sort());
  });

  it("spreads consecutive set ids across the primary mirrors", () => {
    const starts = new Set(primaries.map((_, id) => mirrorOrderFor(id)[0].name));
    expect(starts.size).toBe(primaries.length);
  });
});

describe("mirror flags", () => {
  it("never probes osu.direct from the server and resolves its redirect once for range reads", () => {
    const osuDirect = BEATMAP_MIRRORS.find((m) => m.name === "osu.direct")!;
    expect(mirrorHas(osuDirect, "skipServerProbe")).toBe(true);
    expect(mirrorHas(osuDirect, "resolveRedirectBeforeRange")).toBe(true);
  });

  it("uses hinai's streaming endpoint, never its redirect", () => {
    const hinai = BEATMAP_MIRRORS.find((m) => m.name === "hinai")!;
    expect(hinai.url("1")).not.toContain("redirect=true");
  });
});

describe("oszDownloadUrl", () => {
  it("points at the mirror-probing redirect route", () => {
    expect(oszDownloadUrl(123456)).toBe("/api/osz?beatmapsetId=123456");
  });
});
