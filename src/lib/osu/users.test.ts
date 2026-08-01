import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("user score lists", () => {
  it("does not send legacy_only for first places", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "users.ts"), "utf8");
    const helperSource = source.match(/function fetchUserScoresFromOsu[\s\S]*?^}/m)?.[0] ?? "";

    // osu! honours legacy_only on /scores/firsts, so keeping it would hide every
    // lazer-native #1 (those carry no legacy_score_id) and render the tab empty.
    expect(helperSource).toContain('type === "firsts" ? params : getScoreRequestParams(params)');
    expect(helperSource).not.toMatch(/legacy_only:/);
  });
});
