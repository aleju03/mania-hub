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

  it("maps the 1-40 scroll speed setting through lazer's mania time range", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const MANIA_MAX_TIME_RANGE = 11485");
    expect(source).toContain("const MANIA_REFERENCE_HEIGHT = 768");
    expect(source).toContain("const MANIA_DEFAULT_HIT_POSITION = (480 - 402) * 1.6");
    expect(source).toContain("const MANIA_HIT_TARGET_POSITION = 110");
    expect(source).toContain("(MANIA_MAX_TIME_RANGE / Math.max(1, Math.min(40, this.scrollSpeed))) * this.modRate");
    expect(source).toContain("(MANIA_REFERENCE_HEIGHT - MANIA_DEFAULT_HIT_POSITION) / MANIA_REFERENCE_HEIGHT");
  });
});
