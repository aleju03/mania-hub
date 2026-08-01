import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay renderer lifecycle", () => {
  it("destroys an initializing renderer when the viewer unmounts", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(routeSource).toContain("const ownedRenderer = renderer;");
    expect(routeSource).toContain("if (rendererRef.current === ownedRenderer) {");
    expect(routeSource).toContain("ownedRenderer.destroy();");
  });

  it("makes renderer destruction safe across async cancellation races", () => {
    const rendererSource = fs.readFileSync(
      path.resolve(__dirname, "../components/replay/ReplayCanvas.ts"),
      "utf8",
    );

    expect(rendererSource).toMatch(/destroy\(\) \{\s*\/\/[^]*?if \(this\.destroyed\) return;\s*this\.destroyed = true;/);
  });
});
