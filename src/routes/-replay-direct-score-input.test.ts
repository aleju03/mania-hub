import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay direct score input", () => {
  it("integrates score ids into the player search box", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(source).toContain('placeholder="Search player... or score ID"');
    expect(source).toContain("onSubmit={handlePlayerSearchSubmit}");
    expect(source).toContain("onQueryChange={setPlayerSearchQuery}");
    expect(source).toContain("<ScoreInputPreview");
    expect(source).toContain("Looking up score #");
    expect(source).toContain("getReplayScoreAvailability(score)");
    expect(source).toContain("Unavailable");
    expect(source).toContain("parseReplayScoreInput(query)");
  });
});
