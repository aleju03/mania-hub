import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay beatmap score progress UI", () => {
  it("polls partial beatmap scores while the full country lookup is loading", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");

    expect(routeSource).toContain("getBeatmapScoreLookupStatus");
    expect(routeSource).toContain("getPartialBeatmapScores");
    expect(routeSource).toContain("partialBeatmapScores");
    expect(routeSource).toContain("beatmapScoreLookupStatus");
    expect(routeSource).toContain("startProgressPoll(poll)");
    expect(browseSource).toContain("players checked");
    expect(browseSource).toContain("replays found");
    expect(routeSource).toContain("beatmapScorePage");
    expect(browseSource).toContain("Load more");
    expect(routeSource).toContain("page: nextPage");
  });
});
