import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeScorePayload } from "./validators";

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

describe("cache-only score lookups", () => {
  it("passes cacheOnly through only when it is exactly true", () => {
    expect(normalizeScorePayload({ scoreId: 123, cacheOnly: true })).toEqual({ scoreId: 123, mode: "mania", cacheOnly: true });
    expect(normalizeScorePayload({ scoreId: 123, cacheOnly: "true" })).toEqual({ scoreId: 123, mode: "mania" });
    expect(normalizeScorePayload({ scoreId: 123 })).toEqual({ scoreId: 123, mode: "mania" });
  });

  it("keeps the /replay server render off the osu! API", () => {
    // Anyone can request /replay with a fresh score id; a server render that
    // fetched uncached scores let crawlers spend the shared osu! budget.
    const route = fs.readFileSync(path.resolve(__dirname, "../../routes/replay.tsx"), "utf8");
    const loader = route.match(/loader: async \(\{ deps \}\)[\s\S]*?\n {2}\},\n {2}head:/)?.[0] ?? "";
    expect(loader).toContain('cacheOnly: typeof document === "undefined"');

    const handler = fs.readFileSync(path.resolve(__dirname, "replay.ts"), "utf8")
      .match(/export const getScore[\s\S]*?\n {2}\}\);/)?.[0] ?? "";
    expect(handler.match(/cacheOnly,/g)).toHaveLength(2);
  });
});
