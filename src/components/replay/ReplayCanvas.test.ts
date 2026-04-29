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

  it("counts the odd-key middle column as the right hand", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const leftCount = Math.floor(this.keyCount / 2);");
    expect(source).toContain("const rightStart = leftCount;");
  });

  it("renders the recorded replay life bar beside the playfield", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("lifeBarFrames?: ReplayLifeBarFrame[]");
    expect(source).toContain("private renderHealthBar(layout: Layout)");
    expect(source).toContain("this.renderHealthBar(layout);");
    expect(source).toContain("private getHealthAtTime(time: number)");
    expect(source).toContain("playfieldX + playfieldWidth + 13");
    expect(source).toContain("const height = Math.max(120, h * 0.46);");
    expect(source).toContain("const y = h - height;");
    expect(source).toContain("this.fillRect(x, fillY, barWidth, fillHeight");
    expect(source).toContain("private buildFallbackLifeBarFrames(events: ReplayJudgementEvent[])");
  });
});

describe("ManiaReplayRenderer skin customization", () => {
  it("accepts replay skin settings and exposes a live updater", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('import type { ReplaySkinSettings } from "../../lib/replay-skin";');
    expect(source).toContain("skinSettings?: ReplaySkinSettings");
    expect(source).toContain("private skinSettings: ReplaySkinSettings");
    expect(source).toContain("setSkinSettings(settings: ReplaySkinSettings)");
  });

  it("hides the horizontal judgment line in circle mode", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('if (this.skinSettings.style === "circles") return;');
  });

  it("draws circle receptors without the bar receptor beam or glow path", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const match = /private renderCircleReceptors\(layout: Layout\) \{([\s\S]*?)\n  \}/.exec(source);

    expect(match?.[1]).toBeTruthy();
    expect(match![1]).toContain('this.circle(');
    expect(match![1]).toContain("pressed ? 1 : 0.5");
    expect(match![1]).not.toContain("receptorBeam");
    expect(match![1]).not.toContain("flashIntensity");
  });

  it("uses a readable circle LN body width", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const bodyWidth = Math.max(14, circleDiameter * 0.72);");
  });
});
