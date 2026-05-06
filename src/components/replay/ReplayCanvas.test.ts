import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("ManiaReplayRenderer initialization", () => {
  it("starts Pixi only once per renderer instance", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source.match(/this\.initPromise = this\.initPixi\(\);/g)).toHaveLength(1);
  });

  it("prefers WebGL with a Canvas fallback", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).not.toContain('preference: "webgl"');
    expect(source).toContain('preference: ["webgl", "canvas"]');
  });

  it("maps the 1-40 scroll speed setting through lazer's mania time range", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const MANIA_MAX_TIME_RANGE = 11485");
    expect(source).toContain("const MANIA_REFERENCE_HEIGHT = 768");
    expect(source).toContain("const MANIA_DEFAULT_HIT_POSITION = (480 - 402) * 1.6");
    expect(source).toContain("const MANIA_HIT_TARGET_POSITION = REPLAY_SKIN_DEFAULT_HIT_POSITION");
    expect(source).toContain("(MANIA_MAX_TIME_RANGE / Math.max(1, Math.min(40, this.scrollSpeed))) * this.modRate");
    expect(source).toContain("(MANIA_REFERENCE_HEIGHT - MANIA_DEFAULT_HIT_POSITION) / MANIA_REFERENCE_HEIGHT");
  });

  it("uses the first object SV as the initial pre-note scroll multiplier", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const firstNoteTime = this.notes[0]?.time ?? Number.POSITIVE_INFINITY;");
    expect(source).toContain("const initialMultiplier = collapsed[0].time <= firstNoteTime ? collapsed[0].multiplier : 1;");
    expect(source).toContain("collapsed.unshift({ time: 0, multiplier: initialMultiplier });");
  });

  it("counts the odd-key middle column as the right hand", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const leftCount = Math.floor(this.keyCount / 2);");
    expect(source).toContain("const rightStart = leftCount;");
  });

  it("renders the recorded replay life bar beside the playfield", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("lifeBarFrames?: ReplayLifeBarFrame[]");
    expect(source).toContain("showHealthBar?: boolean");
    expect(source).toContain("private renderHealthBar(layout: Layout)");
    expect(source).toContain("if (this.showHealthBar) this.renderHealthBar(layout);");
    expect(source).toContain("private getHealthAtTime(time: number)");
    expect(source).toContain("playfieldX + playfieldWidth + 13");
    expect(source).toContain("const height = Math.max(136, h * 0.52);");
    expect(source).toContain("const y = h - height;");
    expect(source).toContain("this.fillRect(x, fillY, barWidth, fillHeight");
    expect(source).toContain("private buildFallbackLifeBarFrames(events: ReplayJudgementEvent[])");
  });

  it("can hide the replay life bar for chart previews", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../routes/maps.tsx"), "utf8");

    expect(source).toContain("showHealthBar: false");
  });

  it("uses the saved replay skin for chart previews", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../routes/maps.tsx"), "utf8");

    expect(source).toContain("readReplaySkinSettings");
    expect(source).toContain("skinSettings,");
    expect(source).toContain("renderer.setSkinSettings(skinSettings)");
  });
});

describe("ManiaReplayRenderer skin customization", () => {
  it("accepts replay skin settings and exposes a live updater", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toMatch(/import type \{[^}]*ReplaySkinKeymodeProfile[^}]*ReplaySkinSettings[^}]*\} from "\.\.\/\.\.\/lib\/replay-skin";/);
    expect(source).toContain("skinSettings?: ReplaySkinSettings");
    expect(source).toContain("private skinSettings: ReplaySkinSettings");
    expect(source).toContain("private skinProfile: ReplaySkinKeymodeProfile");
    expect(source).toContain("private updateSkinCache()");
    expect(source).toContain("setSkinSettings(settings: ReplaySkinSettings)");
  });

  it("draws the horizontal judgment line only in bar mode", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('if (this.skinSettings.style !== "bars") return;');
  });

  it("renders the bottom UR timing bar in both skin modes", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const hud = /private renderHUD\(layout: Layout\) \{([\s\S]*?)\n  private renderCombo/.exec(source);

    expect(hud?.[1]).toBeTruthy();
    expect(hud![1]).toContain('this.fillRect(urBarX, urBarY, urBarWidth, 3, "#ffffff", 0.08);');
    expect(hud![1]).not.toContain('if (this.skinSettings.style !== "circles") {');
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

  it("draws circle LN bodies rounded and at normal opacity near the top", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const circleBranch = /if \(this\.skinSettings\.style === "circles"\) \{([\s\S]*?)\n          continue;\n        \}/.exec(source);
    const helper = /private circleLnBodyWithTopFade\(([\s\S]*?)\n  private barLnBodyWithTopFade/.exec(source);

    expect(circleBranch?.[1]).toBeTruthy();
    expect(circleBranch![1]).toContain("this.circleLnBodyWithTopFade(");
    expect(circleBranch![1]).not.toContain("this.roundRectWithTopFade(");
    expect(helper?.[1]).toBeTruthy();
    expect(helper![1]).toContain("this.roundRect(x, y, w, h, w / 2, color, alpha);");
    expect(helper![1]).not.toContain("this.fillRect(");
    expect(helper![1]).not.toContain("sliceCount");
    expect(helper![1]).not.toContain("topFadeAlpha");
  });

  it("scales circle notes and receptors with the lane width", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const laneSizedDiameter = layout.laneWidth * 0.74;");
    expect(source).toContain("Math.min(layout.laneWidth - 4, Math.max(minDiameter, laneSizedDiameter))");
  });

  it("hides playfield lane dividers and lane tint for circle skins", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('const isCircleSkin = this.skinSettings.style === "circles";');
    expect(source).toContain("const showColumnDividers = !isCircleSkin;");
    expect(source).toContain("for (let col = 0; showColumnDividers && col < this.keyCount; col++)");
    expect(source).toContain("if (showColumnDividers) {");
  });

  it("hides the bare playfield bottom guide for circle skins", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("if (this.barePlayfield) {");
    expect(source).toContain('if (showColumnDividers) this.lineInto(g, playfieldX, h - 1, playfieldX + playfieldWidth, h - 1, "#ffffff", 0.1, 2);');
  });

  it("biases 5k+ wide bare preview playfields left", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const barePreviewBias = this.barePlayfield && this.keyCount >= 5 && w >= 380 ? 0.32 : 0.5;");
    expect(source).toContain("const playfieldX = (w - playfieldWidth) * barePreviewBias;");
  });

  it("draws bar LNs as one continuous body without separate caps", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const branch = /const barPercyTrim = this\.skinSettings\.percy([\s\S]*?)\n      \} else \{/.exec(source);

    expect(branch?.[1]).toBeTruthy();
    expect(branch![1]).toContain("const bodyHeadY = headEndY;");
    expect(branch![1]).toContain("const bodyTailY = tailEndY + tailDelta;");
    expect(branch![1]).toContain("const barBodyTop = Math.min(bodyHeadY, bodyTailY);");
    expect(branch![1]).toContain("const barBodyBottom = Math.max(bodyHeadY, bodyTailY);");
    expect(branch![1]).toContain("this.barLnBodyWithTopFade(x, barBodyTop, barWidth, barBodyBottom - barBodyTop, color, bodyAlpha");
    expect(source).not.toContain("bottom - noteHeight, barWidth, noteHeight");
    expect(source).not.toContain("noteHeight / 2, 2, color, headAlpha");
  });

  it("draws bar LN fade slices without rounded mini-note caps", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const helper = /private barLnBodyWithTopFade\(([\s\S]*?)\n  private circleWithTopFade/.exec(source);

    expect(helper?.[1]).toBeTruthy();
    expect(helper![1]).toContain("this.fillRect(x, sliceY, w, sliceHeight + 0.5, color, sliceAlpha);");
    expect(helper![1]).toContain("this.fillRect(x, fadeHeight, w, bottom - fadeHeight, color, alpha);");
    expect(helper![1]).not.toContain("this.roundRect(");
  });

  it("uses per-column skin colors for circle notes and LN heads", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const circleTapColor = this.circleTapColors[col];");
    expect(source).toContain("const circleLnHeadColor = this.circleLnHeadColors[col];");
    expect(source).toContain("const tailTrimDelta = this.skinSettings.percy");
  });

  it("applies the configured keymode column width to layout", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const configuredColumnWidths = this.getConfiguredColumnWidths();");
    expect(source).toContain("configuredColumnWidths.reduce((sum, width) => sum + width, 0)");
  });

  it("supports osu!mania skin.ini hud positions and imported sprites", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("this.getStagePositionY(this.skinSettings.scorePosition, layout)");
    expect(source).toContain("this.getStagePositionY(this.skinSettings.comboPosition, layout)");
    expect(source).toContain("private skinSpriteLayer = new Container();");
    expect(source).toContain("private renderHoldSkinImages(");
  });

  it("uses the configured hit position for receptors without changing scroll density", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const hitPosition = this.skinSettings.hitPosition ?? MANIA_HIT_TARGET_POSITION;");
    expect(source).toContain("const judgmentY = h * (this.skinSettings.upscroll ? hitPosition : MANIA_REFERENCE_HEIGHT - hitPosition) / MANIA_REFERENCE_HEIGHT;");
    expect(source).toContain("const scrollLength = h * (MANIA_REFERENCE_HEIGHT - MANIA_DEFAULT_HIT_POSITION) / MANIA_REFERENCE_HEIGHT;");
  });

  it("supports upscroll note positioning", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const direction = this.skinSettings.upscroll ? 1 : -1;");
    expect(source).toContain("const timeWindow = (this.skinSettings.upscroll ? h - judgmentY : judgmentY) / pixelsPerMs;");
  });
});
