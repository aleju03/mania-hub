import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay direct score input", () => {
  it("integrates score ids into the player search box", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");

    expect(browseSource).toContain('placeholder="Search player... or score ID"');
    expect(routeSource).toContain("onPlayerSearchSubmit={handlePlayerSearchSubmit}");
    expect(routeSource).toContain("onPlayerQueryChange={setPlayerSearchQuery}");
    expect(browseSource).toContain("<ScoreInputPreview");
    expect(browseSource).toContain("Looking up score #");
    expect(browseSource).toContain("getReplayScoreAvailability(score)");
    expect(browseSource).toContain("Unavailable");
    expect(routeSource).toContain('setPlayerSearchQuery("");');
    expect(routeSource).toContain("setScorePreview(null);");
    expect(routeSource).toContain("parseReplayScoreInput(query)");
  });

  it("keeps long replay loads explainable", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(routeSource).toContain("getReplayLoadingCopy");
    expect(routeSource).toContain("Checking score details");
    expect(routeSource).toContain("Downloading replay and beatmap");
    expect(routeSource).toContain("Still waiting on osu! replay data");
    expect(routeSource).toContain("loadReplay(scoreId, loaderData.score)");
  });
});
