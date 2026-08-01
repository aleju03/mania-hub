import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
const viewSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySideBySideView.tsx"), "utf8");
const infoSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayInfo.tsx"), "utf8");

describe("side by side tab", () => {
  it("sits between By Player and Upload and renders the picker", () => {
    // The strip renders BROWSE_TABS in order, so the order is the layout.
    const block = browseSource.slice(browseSource.indexOf("const BROWSE_TABS"));
    const labels = Array.from(block.slice(0, block.indexOf("];")).matchAll(/label: "([^"]+)"/g), (m) => m[1]);
    expect(labels).toEqual(["By Player", "Side by Side", "Upload"]);
    expect(browseSource).toContain('{ mode: "side-by-side", label: "Side by Side" }');
    expect(browseSource).toContain("<ReplaySideBySidePicker");
  });

  it("opens the comparison from the picker through compareA/compareB", () => {
    expect(routeSource).toContain("search: { compareA: leftScoreId, compareB: rightScoreId }");
    expect(routeSource).toContain("<ReplaySideBySideView");
    expect(routeSource).toContain('navigate({ to: "/replay", search: { tab: "side-by-side" } })');
  });

  it("still honours the old ?scoreId=A&compareId=B links", () => {
    expect(routeSource).toContain("const legacyCompareId = Number(s.compareId) || undefined;");
    expect(routeSource).toContain("const compareA = Number(s.compareA) || (legacyCompareId ? scoreId : undefined);");
    // Comparing clears scoreId, so the single-replay viewer never loads behind it.
    expect(routeSource).toContain("scoreId: comparing ? undefined : scoreId,");
  });

  it("runs both playfields bare, with the stats read off the renderers", () => {
    expect(viewSource).toContain("hideHud: true,");
    expect(viewSource).toContain("showCombo: true,");
    expect(viewSource).toContain("liveStats: true,");
    expect(viewSource).toContain("renderer.getLiveStats?.()");
    // One clock for both sides is the whole premise.
    expect(viewSource).toContain("renderer.setExternalClock(");
  });

  it("leaves no compare action on the score info card", () => {
    expect(infoSource).not.toContain("onCompare");
    expect(infoSource).not.toContain("compareCandidates");
    expect(routeSource).not.toContain("ReplayCompareView");
  });
});
