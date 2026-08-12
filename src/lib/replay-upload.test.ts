import { describe, expect, it, vi } from "vitest";

const { readLazerReplayMods } = vi.hoisted(() => ({ readLazerReplayMods: vi.fn() }));
vi.mock("./replay-lazer-score", () => ({ readLazerReplayMods }));

import { extractReplayScoreIdFromFilename, readUploadedReplayMods, scoreMatchesUploadedReplay, stableModBitmaskToMods } from "./replay-upload";

describe("replay upload helpers", () => {
  it("maps the mania-relevant stable mod bits", () => {
    const acronyms = (mask: number) => stableModBitmaskToMods(mask).map((mod) => mod.acronym);
    // A Mirror-only replay: dropping this bit renders the chart unmirrored while
    // the replay's presses stay mirrored, so every column is wrong.
    expect(acronyms(1 << 30)).toEqual(["MR"]);
    expect(acronyms(1 << 20)).toEqual(["FI"]);
    expect(acronyms(1 << 21)).toEqual(["RD"]);
    expect(acronyms(1 << 29)).toEqual(["SV2"]);
    // KeyCoop stays unmapped - "CO" means Cover to the viewer.
    expect(acronyms(1 << 25)).toEqual([]);
    expect(acronyms((1 << 15) | (1 << 30))).toEqual(["4K", "MR"]);
  });


  // Regression for uploadId 5UjidMiPv4-vOCoph4o9: a lazer play at DT 1.1x with
  // DA. The header bitfield says 64 (plain DT), so reading it alone ran the
  // chart at 1.5x and lost DA entirely.
  it("prefers a lazer replay's own mod list over the legacy bitfield", async () => {
    const lazerMods = [
      { acronym: "DT", settings: { speed_change: 1.1 } },
      { acronym: "DA", settings: { overall_difficulty: 9 } },
    ];
    readLazerReplayMods.mockResolvedValueOnce(lazerMods);

    expect(await readUploadedReplayMods(new ArrayBuffer(0), 1 << 6)).toEqual(lazerMods);
  });

  it("falls back to the bitfield for a stable replay, which carries no mod list", async () => {
    readLazerReplayMods.mockResolvedValueOnce(null);

    expect(await readUploadedReplayMods(new ArrayBuffer(0), (1 << 6) | (1 << 3))).toEqual([
      { acronym: "HD" },
      { acronym: "DT" },
    ]);
  });

  it("extracts the score id from lazer exported replay filenames", () => {
    expect(extractReplayScoreIdFromFilename("solo-replay-mania_4001513_6708716952.osr")).toBe(6708716952);
  });

  it("ignores filenames without a usable score id", () => {
    expect(extractReplayScoreIdFromFilename("replay.osr")).toBeNull();
    expect(extractReplayScoreIdFromFilename(null)).toBeNull();
  });
});

// Regression for uploadId Gpn-Zq6fCPZspZmy6yMt: a stable .osr on a graveyard
// 7K chart embedded legacy score id 2391860323, which /scores/{id} resolved
// to an unrelated osu!standard play. The viewer then showed that play's 78%
// accuracy, a "Lazer" client badge, and streamed audio from the wrong
// beatmapset (making every seek land at the end of the replay).
describe("scoreMatchesUploadedReplay", () => {
  const replayHash = "cc3ba9b1afd63595d24e96e45aae5b62";

  it("accepts a score on the exact map revision the replay names", () => {
    const score = { beatmap: { id: 2943617, checksum: replayHash } };
    expect(scoreMatchesUploadedReplay(score, replayHash, null)).toBe(true);
  });

  it("accepts a score on the looked-up beatmap even when the map has a newer revision", () => {
    const score = { beatmap: { id: 2943617, checksum: "0000aaaa0000aaaa0000aaaa0000aaaa" } };
    expect(scoreMatchesUploadedReplay(score, replayHash, 2943617)).toBe(true);
  });

  it("rejects an id-collision score from another map", () => {
    const score = { beatmap: { id: 3610213, checksum: "5343ed734966efd33f64a7e633352bcf" } };
    expect(scoreMatchesUploadedReplay(score, replayHash, 2943617)).toBe(false);
    expect(scoreMatchesUploadedReplay(score, replayHash, null)).toBe(false);
  });

  it("rejects missing scores and scores without a beatmap", () => {
    expect(scoreMatchesUploadedReplay(null, replayHash, 2943617)).toBe(false);
    expect(scoreMatchesUploadedReplay({}, replayHash, 2943617)).toBe(false);
    expect(scoreMatchesUploadedReplay({ beatmap: null }, replayHash, 2943617)).toBe(false);
  });

  it("never matches on an absent checksum or beatmap id", () => {
    expect(scoreMatchesUploadedReplay({ beatmap: { id: 1 } }, "", null)).toBe(false);
    expect(scoreMatchesUploadedReplay({ beatmap: {} }, null, null)).toBe(false);
  });
});
