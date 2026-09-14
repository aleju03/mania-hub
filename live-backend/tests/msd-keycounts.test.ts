import { describe, expect, it } from "vitest";
import { computeMsd, isMsdSupportedKeyCount } from "../src/dan/msd.js";
import { LN_SKILL_VERSION } from "../src/dan/ln-skill.js";

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
  it("publishes independent 4K LN values at custom rates", async () => {
    const keyCount = 4;
    const rice = buildChart(keyCount, 400, 120);
    const held = rice.replace(/(\d+),192,(\d+),1,0,0:0:0:0:/g,
      (_match, x, time) => `${x},192,${time},128,0,${Number(time) + 250}:0:0:0:0:`);
    const result = await computeMsd(held, { keyCount, rate: 1.37 });
    expect(result?.lnSkill).toMatchObject({ version: LN_SKILL_VERSION, keyCount, rate: 1.37, eligible: true });
    expect(result!.values.LN).toBeGreaterThan(0);
    expect(result!.values.LN).not.toBe(result!.values.Overall);
    const plain = await computeMsd(rice, { keyCount, rate: 1.37 });
    expect(plain?.values.LN).toBe(0);
    const lowHold = held.split("\n").map((line, index) => index % 4 === 0 ? line
      : line.replace(/,128,0,\d+:/, ",1,0,")).join("\n");
    const mixed = await computeMsd(lowHold, { keyCount, rate: 1.37 });
    expect(mixed?.lnSkill?.rating).toBeGreaterThan(0);
    expect(mixed?.values.LN).toBe(0);
  });

  it.each(Array.from({ length: 14 }, (_, i) => i + 5))("preserves %iK MSD without adding independent LN", async keyCount => {
    const rice = buildChart(keyCount, 400, 120);
    const held = rice.replace(/(\d+),192,(\d+),1,0,0:0:0:0:/g,
      (_match, x, time) => `${x},192,${time},128,0,${Number(time) + 250}:0:0:0:0:`);
    const result = await computeMsd(held, { keyCount, rate: 1.37 });
    const legacy = await computeMsd(held, { keyCount, rate: 1.37, includeLnSkill: false });
    expect(result?.values.Overall).toBeGreaterThan(0);
    expect(result).toEqual(legacy);
    expect(result?.lnSkill).toBeUndefined();
    expect(result?.values.LN).toBeUndefined();
    // Also check callers that infer the mode from the file.
    expect((await computeMsd(held, { rate: 1.37 }))?.lnSkill).toBeUndefined();
  });

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
