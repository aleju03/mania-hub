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

  // Rotating a phone used to swap the route between a rotate prompt and the
  // view, which unmounted both renderers and refetched both replays on the way
  // back. The orientation rules now live inside the view, on one mounted tree.
  it("never branches the route on orientation", () => {
    expect(routeSource).not.toContain("isPortraitPhone");
    expect(routeSource).not.toContain("side-by-side-rotate");
    // A fade wrapper's opacity would also trap the phone overlay under the navbar.
    expect(routeSource).toContain("<div key={`side-by-side-${sideBySide.left}-${sideBySide.right}`}>");
    expect(routeSource).toContain("const stageActive = viewerActive || Boolean(sideBySide);");
  });

  it("covers the whole screen on a phone and asks for real fullscreen", () => {
    expect(viewSource).toContain("resolveSideBySideLayout(viewport, fullscreen)");
    // Overlay vs inline is a class swap on the one persistent root.
    expect(viewSource).toContain('layout.overlay ? "fixed inset-0 z-[100] h-[100dvh] w-screen" : "relative h-[calc(100dvh-60px)]"');
    expect(viewSource).toContain("requestNativeFullscreen(container)");
    expect(viewSource).toContain("lockLandscapeOrientation()");
    // Portrait parks the loaded replays behind a prompt instead of dropping them.
    expect(viewSource).toContain("layout.rotatePrompt && (");
    expect(viewSource).toContain("if (layout.rotatePrompt) pause();");
  });

  it("keeps the height for the playfields on a short viewport", () => {
    // Every chrome block reads the same compact flag.
    expect(viewSource).toContain("const compact = layout.compact;");
    expect(viewSource).toContain("<StatsColumn stats={stats} compact={compact} />");
    expect(viewSource).toContain("{!compact && <MapFacts");
    // Rotations and the mobile browser chrome sliding away both resize the
    // canvases, and the renderers only re-measure when told to.
    expect(viewSource).toContain("new ResizeObserver(() => window.requestAnimationFrame(resizeRenderers))");
    expect(viewSource).toContain('window.addEventListener("orientationchange", onOrientationChange)');
  });

  it("leaves no compare action on the score info card", () => {
    expect(infoSource).not.toContain("onCompare");
    expect(infoSource).not.toContain("compareCandidates");
    expect(routeSource).not.toContain("ReplayCompareView");
  });
});
