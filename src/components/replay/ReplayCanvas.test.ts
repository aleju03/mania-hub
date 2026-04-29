import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("ManiaReplayRenderer initialization", () => {
  it("starts Pixi only once per renderer instance", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source.match(/this\.initPromise = this\.initPixi\(\);/g)).toHaveLength(1);
  });

  it("does not force the replay canvas onto WebGL only", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).not.toContain('preference: "webgl"');
    expect(source).toContain('preference: ["canvas", "webgl"]');
  });
});
