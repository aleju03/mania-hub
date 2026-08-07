import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("getScore", () => {
  it("validates the modern endpoint's ruleset before trusting an id-namespace hit", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.ts"), "utf8");
    const handlerSource = source.match(/export const getScore[\s\S]*?\n {2}\}\);/)?.[0] ?? "";

    // Stable's per-mode legacy score ids overlap the unified /scores/{id}
    // namespace, so a stable .osr's embedded id can 200 there as someone
    // else's play in another ruleset. Returning that hit unchecked poisoned
    // the replay viewer (wrong accuracy, "Lazer" badge, wrong audio set).
    expect(handlerSource).toContain("getOsuScoreModeName(modernScore)");
    expect(handlerSource).not.toMatch(/return await osuFetch<OsuScore>\(`\/scores\/\$\{data\.scoreId\}`/);
  });
});
