import { describe, expect, it } from "vitest";
import { computeMsd, isMsdSupportedKeyCount } from "../src/dan/msd.js";

// MinaCalc's n-key pipeline (upstream's 0.74.0 rebuild, vendored 2026-08-31)
// rates 4..18K: 4/6/7 through their official per-keycount classes, everything
// else through the generic engine. Before it, 5K and 8K-18K charts had no MSD
// at all and every surface fell back to the in-house pattern profile.

function buildChart(keys: number, count = 900, gapMs = 90): string {
  const notes = Array.from({ length: count }, (_, index) => {
    const column = index % keys;
    const x = Math.floor(((column + 0.5) * 512) / keys);
    return `${x},192,${1000 + index * gapMs},1,0,0:0:0:0:`;
  }).join("\n");
  return [
    "osu file format v14",
    "",
    "[General]",
    "Mode: 3",
    "",
    "[Metadata]",
    "Title:Synthetic",
    "Artist:Test",
    "Creator:Test",
    "Version:Test",
    "",
    "[Difficulty]",
    `CircleSize:${keys}`,
    "OverallDifficulty:8",
    "HPDrainRate:8",
    "",
    "[TimingPoints]",
    "0,352.94,4,2,0,100,1,0",
    "",
    "[HitObjects]",
    notes,
  ].join("\n");
}

describe("MSD keycount support", () => {
  it("covers 4 through 18 keys and nothing narrower", () => {
    for (const keys of [4, 5, 6, 7, 8, 10, 14, 18]) {
      expect(isMsdSupportedKeyCount(keys), `${keys}K`).toBe(true);
    }
    for (const keys of [1, 2, 3, 19, 20]) {
      expect(isMsdSupportedKeyCount(keys), `${keys}K`).toBe(false);
    }
  });

  it("rates a 5K chart instead of returning null", async () => {
    const msd = await computeMsd(buildChart(5), { keyCount: 5 });
    expect(msd).not.toBeNull();
    expect(Number(msd?.values.Overall)).toBeGreaterThan(0);
    // Non-4K is pinned to the build with the n-key pipeline, whatever the
    // default version is (versions/index.js).
    expect(msd?.etternaVersion).toBe("0.74.0");
  });

  it("still refuses a keycount MinaCalc has no engine for", async () => {
    expect(await computeMsd(buildChart(3), { keyCount: 3 })).toBeNull();
  });
});
