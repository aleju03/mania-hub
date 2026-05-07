import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay mobile controls", () => {
  it("reveals canvas controls on mobile taps with separate fullscreen timing", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(routeSource).toContain("MOBILE_FULLSCREEN_BUTTON_HIDE_MS = 2000");
    expect(routeSource).toContain("FULLSCREEN_TAP_CHROME_HIDE_MS = 3000");
    expect(routeSource).toContain("handleReplayCanvasPointerDown");
    expect(routeSource).toContain("handleReplayCanvasPointerUp");
    expect(routeSource).toContain("isMobileReplayPointer(event)");
    expect(routeSource).toContain("mobileFullscreenButtonVisible");
    expect(routeSource).toContain("onPointerDown={handleReplayCanvasPointerDown}");
    expect(routeSource).toContain("onPointerUp={handleReplayCanvasPointerUp}");
  });
});
