import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay beatmap score progress UI", () => {
  it("polls partial beatmap scores while the full country lookup is loading", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(source).toContain("getBeatmapScoreLookupStatus");
    expect(source).toContain("getPartialBeatmapScores");
    expect(source).toContain("partialBeatmapScores");
    expect(source).toContain("beatmapScoreLookupStatus");
    expect(source).toContain("setInterval(poll, 750)");
    expect(source).toContain("players checked");
    expect(source).toContain("replays found");
    expect(source).toContain("beatmapScorePage");
    expect(source).toContain("Load more");
    expect(source).toContain("page: nextPage");
  });
});
