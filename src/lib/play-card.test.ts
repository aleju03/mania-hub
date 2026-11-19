import { describe, expect, it } from "vitest";

import { playCardGradeFile, readPlayCard, signPlayCard } from "./play-card";

function signed(data: unknown, key = "secret"): [string, string] {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return [payload, signPlayCard(payload, key)];
}

const play = {
  k: "play", u: 7, n: "Some_Player", s: 60, bg: "course.jpg", t: "Some song", d: "Some difficulty", a: 99.01, g: "s", c: 1687, pp: 302,
  h: [4970, 1564, 118, 12, 3, 16], m: ["dt", "MR", "<b>"], st: 5.46, msd: 25.07, sk: "Stamina", e: ["9-", "dan", 4], app: "Hashi",
};

describe("readPlayCard", () => {
  it("reads the backend's play", () => {
    const [payload, signature] = signed(play);
    expect(readPlayCard(payload, signature, "secret")).toMatchObject({
      kind: "play", userId: 7, username: "Some_Player", beatmapsetId: 60, background: "course.jpg", title: "Some song", accuracy: 99.01,
      grade: "S", combo: 1687, pp: 302, hits: [4970, 1564, 118, 12, 3, 16], mods: ["dt", "mr"], emblem: { label: "9-", family: "dan", keyCount: 4 },
      app: "Hashi", failedAt: null, tier: null,
    });
  });

  it("draws nothing another key signed, or nobody did", () => {
    const [payload, signature] = signed(play);
    expect(readPlayCard(payload, signature, "other")).toBeNull();
    expect(readPlayCard(payload, null, "secret")).toBeNull();
    expect(readPlayCard(payload, signature, undefined)).toBeNull();
    const [edited] = signed({ ...play, n: "Someone else" });
    expect(readPlayCard(edited, signature, "secret")).toBeNull();
  });

  it("reads a dan clear with its bar, and a play that only claims to be one as a play", () => {
    const [payload, signature] = signed({ ...play, k: "dan", tier: "near", bar: 96, prev: 94.1, lv: ["4K", "8th dan"], fail: undefined });
    expect(readPlayCard(payload, signature, "secret")).toMatchObject({ kind: "dan", tier: "near", bar: 96, previous: 94.1, level: ["4K", "8th dan"] });
    const [untiered, untieredSignature] = signed({ ...play, k: "dan" });
    expect(readPlayCard(untiered, untieredSignature, "secret")?.kind).toBe("play");
  });

  it("drops a background that leaves the archive and fills short judgement lists", () => {
    const [payload, signature] = signed({ ...play, bg: "../secret.jpg", h: [10, 2], fail: 43 });
    expect(readPlayCard(payload, signature, "secret")).toMatchObject({ background: null, hits: [10, 2, 0, 0, 0, 0], failedAt: 43 });
  });
});

describe("playCardGradeFile", () => {
  it("names the site's grade art", () => {
    expect(playCardGradeFile("XH")).toBe("GradeSmall-SS-Silver");
    expect(playCardGradeFile("S")).toBe("GradeSmall-S");
    expect(playCardGradeFile("?")).toBe("GradeSmall-F");
  });
});
