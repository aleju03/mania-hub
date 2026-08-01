import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay overlay editing vs bottom chrome", () => {
  it("keeps the bottom chrome down while the pointer is busy with an overlay", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(routeSource).toContain("const INLINE_CHROME_REVEAL_PX = 150;");
    expect(routeSource).toContain("const FULLSCREEN_CHROME_REVEAL_PX = 190;");
    expect(routeSource).toContain(
      "const chromeBand = isCanvasFullscreen ? FULLSCREEN_CHROME_REVEAL_PX : INLINE_CHROME_REVEAL_PX;",
    );
    expect(routeSource).toContain(
      "const overlayEdit = rendererRef.current?.isOverlayEditPoint?.(event.clientX, event.clientY, chromeBand) ?? false;",
    );
    // The reveal test and the band handed to the renderer must stay the same
    // number, or the chrome can rise into an approach it just cleared.
    expect(routeSource).toContain("if (bottomDistance <= INLINE_CHROME_REVEAL_PX) revealInlineChrome();");
    expect(routeSource).toContain("if (bottomDistance <= FULLSCREEN_CHROME_REVEAL_PX || showFullscreenChrome) {");
    // Inline drawer: retract instead of summoning; fullscreen: leave the
    // chrome to its own timeout instead of refreshing it.
    expect(routeSource).toContain("if (overlayEdit) {\n        scheduleInlineChromeHide();\n        return;\n      }");
    expect(routeSource).toContain("if (overlayEdit) return;");
  });

  it("reports overlay drags, resizes, marquees and overlay hovers as edit points", () => {
    const canvasSource = fs.readFileSync(
      path.resolve(__dirname, "../components/replay/ReplayCanvas.ts"),
      "utf8",
    );

    expect(canvasSource).toContain(
      "isOverlayEditPoint(clientX: number, clientY: number, chromeBandPx = 0): boolean {",
    );
    expect(canvasSource).toContain(
      "if (this.draggingOverlay || this.resizingOverlay || this.pinchingOverlay || this.selectingOverlays) return true;",
    );
    expect(canvasSource).toContain("if (!this.canEditOverlays()) return false;");
    expect(canvasSource).toContain(
      "if (this.getOverlayCloseButtonAtPoint(x, y) != null || this.getOverlayAtPoint(x, y) != null) return true;",
    );
  });

  it("treats an overlay below the pointer inside the chrome band as an approach", () => {
    const canvasSource = fs.readFileSync(
      path.resolve(__dirname, "../components/replay/ReplayCanvas.ts"),
      "utf8",
    );

    expect(canvasSource).toContain("const bandTop = this.cssHeight - chromeBandPx * scaleY;");
    expect(canvasSource).toContain("if (bottom < y || bottom < bandTop) continue;");
    expect(canvasSource).toContain("if (x >= frame.x && x <= frame.x + frame.width) return true;");
  });
});
