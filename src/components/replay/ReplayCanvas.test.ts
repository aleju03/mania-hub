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

  it("renders replay input notes through the active note skin while overlay-only input is enabled", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("this.renderInputOverlayNotes(layout);");
    expect(source).toContain("private renderInputOverlayNoteSkin(");
    expect(source).toContain("this.arrowShapeWithTopFade(");
    expect(source).toContain("const rawStartY = judgmentY + getVisualDelta(seg.start) * pixelsPerMs * direction;");
    expect(source).toContain("const startY = seg.start <= this.currentTime && seg.end > this.currentTime");
    expect(source).toContain("const endY = rawEndY;");
    expect(source).toContain("Math.min(Math.max(startY, endY), judgmentY)");
    expect(source).toContain("if (this.frames.length === 0 || !this.showInputOverlay || this.inputOverlayOnly) return;");
    expect(source).toContain("if (!this.inputOverlayKeyHistory || this.frames.length === 0) return;");
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

  it("hides custom replay overlays on mobile portrait layouts", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("private isMobilePortraitLayout(layout: Layout): boolean");
    expect(source).toContain('window.matchMedia("(pointer: coarse)").matches');
    expect(source).toContain("return coarsePointer && layout.h > layout.w;");
    expect(source).toContain("if (this.isMobilePortraitLayout(layout)) return false;");
    expect(source).toContain("return this.fullscreenLayout || layout.w >= 640;");
  });

  it("uses stable sampled-frame timing without replacing replay scoring with final score headers", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).not.toContain("buildStableReplayScoringSegments");
    expect(source).not.toContain("expectedFinalJudgmentCounts");
    expect(source).not.toContain("getDisplayJudgmentCounts");
    expect(source).toContain("legacyReplayFrameRounding: options?.legacyReplayFrameRounding ?? this.ruleset.accuracyMode === \"stable\"");
    expect(source).toContain("this.ruleset.accuracyMode !== \"stable\" && options?.expectedCounts");
    expect(source).not.toContain("lateStableHoldHead");
    expect(source).toContain("const shouldLetPassLine = detached || (awaitingJudgment && note.time < this.currentTime - 10);");
    // Late-hit taps scroll below the receptors until their actual hit time;
    // timed-out taps scroll off the bottom instead of vanishing at the line.
    expect(source).not.toContain("if (note.time < this.currentTime - 10 && !headResolved) continue;");
    expect(source).toContain("const tapMissScrollsPast = !note.isHold && noteState.headJudgment === 6 && noteState.headTime > note.time;");
    expect(source).toContain("if (headResolved && !tapMissScrollsPast) continue;");
    expect(source).toContain("allowLegacyScoreReconciliation: false");
    expect(source).not.toContain("allowLegacyScoreReconciliation: this.ruleset.accuracyMode === \"stable\"");
    expect(source).toContain("return calculateReplayAccuracy(this.judgmentCounts, this.ruleset.accuracyMode);");
  });

  it("drives the pp overlay from the star-rating timeline and live judgement counts", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("this.ppModMultiplier = getManiaPpModMultiplier([...mods]);");
    // Both simulation builds (constructor and setPreviewData) refresh the timeline.
    expect(source.match(/this\.rebuildStarRatingTimeline\(\);/g)).toHaveLength(2);
    expect(source).toContain("calculateManiaStarRatingTimeline(this.notes, this.keyCount, this.modRate)");
    expect(source).toContain("this.hudCachedPp = `${Math.round(this.getPp())}pp`;");
    expect(source).toContain("counts: { perfect: c[1], great: c[2], good: c[3], ok: c[4], meh: c[5], miss: c[6] },");
    expect(source).toContain("modMultiplier: this.ppModMultiplier,");
    expect(source).toContain("this.renderPpOverlay(layout);");
    // The opt-in calculator stays available on unranked maps as a hypothetical value.
    expect(source).toContain("this.starRatingTimeline = this.hideHud || this.barePlayfield");
    expect(source).not.toContain("mapAwardsPp");
  });

  it("keeps released hold remainders dimmed and scrolling past instead of despawning at the tail judgement", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Judged holds only despawn once consumed through the tail or offscreen.
    expect(source).toContain("if (note.endTime < this.currentTime - velocityWindow * 0.6) continue;");
    expect(source).toContain("const cut = this.getHoldConsumedCutTime(note, noteState, col);");
    expect(source).toContain("if (cut == null || cut >= note.endTime - 1) continue;");
    // The remainder detaches at the release's chart time and scrolls past the
    // line instead of staying pinned at the receptors.
    expect(source).toContain("headY = judgmentY + getVisualDelta(consumedCut) * pixelsPerMs * direction;");
    // Unheld remainders dim like the client's broken/released hold bodies.
    expect(source).toContain("const bodyAlpha = dimmed ? 0.45 : 1;");
    expect(source).toContain("const headAlpha = dimmed ? 0.65 : 1;");
    // Holds held through the tail judgement are fully consumed; missed heads
    // consume nothing and keep the whole note scrolling past.
    expect(source).toContain("if (this.isColumnEffectivelyHeldAtTime(column, tailTime, 0)) return note.endTime;");
    expect(source).toContain("if (noteState.headJudgment === 6) return note.time;");
  });

  it("can hide the replay life bar for chart previews", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../routes/maps.tsx"), "utf8");

    expect(source).toContain("showHealthBar: false");
  });

  it("renders fallback combo digits in fixed slots to keep digits from pushing each other", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("this.renderTabularComboText(text, playfieldCenterX, comboY, fontSize, comboFont, state);");
    expect(source).toContain("const digitAdvance = Math.max(");
    expect(source).toContain("this.measureTextWidth(String(digit), fontSize, fontWeight, fontStyle, fontFamily)");
    expect(source).toContain("private comboTextLayer = new Container();");
    expect(source).toContain("app.stage.addChild(this.comboTextLayer);");
    expect(source).toContain("this.addComboText(char, x + advance / 2, centerY, {");
    expect(source).toContain("this.clearComboTextLayer();");
    expect(source).toContain("if (!glyphs.every((glyph): glyph is ReplaySkinImageAsset => Boolean(glyph))) return false;");
    expect(source).toContain("const tabularDigitWidths = combo.digits");
    expect(source).toContain("const cellWidth = Math.max(...sizes.map((size) => size.width), ...tabularDigitWidths);");
    expect(source).toContain("const glyphCenterX = x + cellWidth / 2;");
  });

  it("invalidates pooled text after web fonts finish loading", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("private textFontRevision = 0;");
    expect(source).toContain("this.installTextFontInvalidation();");
    expect(source).toContain("void document.fonts.ready.then(() => {");
    expect(source).toContain("this.textFontRevision++;");
    expect(source).toContain("label.__sig = undefined;");
    expect(source).toContain("label.text = \"\";");
    expect(source).toContain("const sig = `${this.textFontRevision}|");
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

  it("renders the bottom hit error bar in both skin modes", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const hud = /private renderHUD\(layout: Layout\) \{([\s\S]*?)\n  \/\/ --- osu!-style fixed HUD/.exec(source);
    const bar = /private renderHitErrorBar\(layout: Layout\) \{([\s\S]*?)\n  \}/.exec(source);

    expect(hud?.[1]).toBeTruthy();
    expect(hud![1]).toContain("this.renderHitErrorBar(layout);");
    expect(bar?.[1]).toBeTruthy();
    expect(bar![1]).toContain("drawBand(this.hitWindows.meh, colors.outer, 0.8);");
    expect(bar![1]).not.toContain('if (this.skinSettings.style !== "circles") {');
  });

  it("renders the ingame leaderboard with seek-safe overtake flashes", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("setLeaderboard(entries: ReplayLeaderboardEntry[], playerName: string)");
    expect(source).toContain("if (this.leaderboardPrevRank != null && rank < this.leaderboardPrevRank && !this.suppressOvertakeFlash)");
    expect(source).toContain('rows[playerRowIndex - 1].kind = "target";');
    // Seeks re-derive the rank from scratch; that jump must not flash.
    const recompute = /private recomputeStatsUpTo\(time: number\) \{([\s\S]*?)\n  \}/.exec(source);
    expect(recompute?.[1]).toContain("this.suppressOvertakeFlash = true;");
  });

  it("detects fails from the real life bar only and renders the fail overlay", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Detection runs before the simulated fallback life bar is built, and
    // requires inputs to stop early as well as HP ending at zero.
    expect(source.indexOf("this.failTime = this.computeFailTime();"))
      .toBeLessThan(source.indexOf("this.lifeBarFrames = this.buildFallbackLifeBarFrames(this.judgmentEvents);"));
    expect(source).toContain("if (lifeFrames[lifeFrames.length - 1].health > 0.001) return null;");
    expect(source).toContain("if (lastNoteTime > 0 && lastInputTime >= lastNoteTime - 1500) return null;");
    expect(source).toContain("private renderFailOverlay(layout: Layout)");
    expect(source).toContain("getFailTime(): number | null {");
  });

  it("draws mod icons under the score block", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("private renderModIcons(layout: Layout");
    expect(source).toContain("MOD_BADGE_COLORS[acronym]");
    // Stable fades the stack out after the map starts; lazer keeps it.
    expect(source).toContain("const fadeStart = this.firstNoteTime + 3000;");
  });

  it("simulates the ingame score counter and pins it to the real total", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("private buildScoreSimulator(realTotalScore: number | null)");
    expect(source).toContain("this.scoreSimulator?.applyJudgment(event.judgment);");
    expect(source).toContain("this.scoreSimulator?.reset();");
    expect(source).toContain("simulator.setScale(getScoreScaleToReal(simulator.value, realTotalScore));");
    expect(source).toContain("? formatStableScore(scoreValue)");
    expect(source).toContain(": formatLazerScore(scoreValue);");
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

  it("draws arrow LN bodies with the tail end rounded for either scroll direction", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const helper = /private arrowLnBodyWithTopFade\(([\s\S]*?)\n  private barLnBodyWithTopFade/.exec(source);

    expect(helper?.[1]).toBeTruthy();
    expect(source).toContain('this.skinSettings.upscroll ? "bottom" : "top"');
    expect(helper![1]).toContain(".quadraticCurveTo(x, y, x + radius, y)");
    expect(helper![1]).toContain(".quadraticCurveTo(x, bottom, x + radius, bottom)");
    expect(helper![1]).toContain(".lineTo(x + w, bottom)");
    expect(helper![1]).toContain(".lineTo(x + w, y)");
    expect(helper![1]).not.toContain("roundRect");
  });

  it("stops circle and arrow LN bodies before the release tail passes under the head cap", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("private getHoldBodyRange(headCutoffY: number, tailEndY: number, tailTrimDelta: number)");
    expect(source).toContain("return tailY > headCutoffY ? { top: headCutoffY, bottom: tailY } : null;");
    expect(source).toContain("return tailY < headCutoffY ? { top: tailY, bottom: headCutoffY } : null;");
    expect(source).toContain("const circleBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);");
    expect(source).toContain("const arrowBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);");
    expect(source).toContain("const inputCircleBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);");
    expect(source).toContain("const inputArrowBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);");
  });

  it("fades LN bodies per-pixel through Hidden/FadeIn/Cover instead of popping the whole body in", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Bodies are drawn as uniform-alpha runs, lazer's positional cover style.
    expect(source).toContain("private forEachVisibilitySegment(");
    expect(source).toContain("private lnBodySegment(");
    // Caps draw as whole pieces so they stay round inside the fade band, and
    // straight runs never overlap (translucent overlap = seam lines).
    expect(source).toContain("private lnBodyWithVisibility(");
    expect(source).toContain("this.lnBodySegment(x, w, top, top + capTop, color, alpha * capAlpha, capTop, 0);");
    // Skin-image bodies slice into sub-frame texture strips instead of one
    // scalar alpha across the whole sprite.
    expect(source).toContain("private drawSkinImageVerticalStrip(");
    expect(source).not.toContain("* this.getHiddenAlphaForVerticalSpan(bodyTop, bodyBottom, visibilityLayout)");
    // Pixi aliases orig to frame unless one is passed explicitly.
    expect(source).toContain("orig: new Rectangle(0, 0, texture.source.width, texture.source.height)");
    // Circle/arrow bodies stopped multiplying one whole-body visibility alpha.
    expect(source).not.toContain("bodyAlpha * bodyVisibilityAlpha");
  });

  it("scales circle notes and receptors with the lane width", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const laneSizedDiameter = layout.laneWidth * 0.9;");
    expect(source).toContain("Math.min(layout.laneWidth - 4, Math.max(minDiameter, laneSizedDiameter))");
  });

  it("scales skin.ini column measurements from the osu!mania stage height", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const MANIA_SKIN_STAGE_HEIGHT = 480;");
    // scaleHeight equals the real canvas height everywhere except inline
    // portrait, where it anchors to the mobile reference stage height.
    expect(source).toContain("const scaleHeight = compactPortrait ? Math.min(h, MOBILE_PORTRAIT_REFERENCE_HEIGHT) : h;");
    expect(source).toContain("const targetLayoutScale = scaleHeight / MANIA_SKIN_STAGE_HEIGHT;");
    expect(source).toContain("desiredPlayfieldWidth * targetLayoutScale");
  });

  it("shows playfield lane dividers and lane tint only for bar skins", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('const showColumnDividers = this.skinSettings.style === "bars";');
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
    // Exact shared slice edges: a + 0.5 overlap double-blends translucent
    // slices into visible seam lines across fading LN bodies.
    expect(helper![1]).toContain("this.fillRect(x, sliceY, w, sliceHeight, color, sliceAlpha);");
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
    // Scroll density derives from the default hit position and scaleHeight
    // (the real height everywhere except inline portrait), never from the
    // user's configured hit position.
    expect(source).toContain("const scrollLength = scaleHeight * (MANIA_REFERENCE_HEIGHT - MANIA_DEFAULT_HIT_POSITION) / MANIA_REFERENCE_HEIGHT;");
  });

  it("supports upscroll note positioning", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const direction = this.skinSettings.upscroll ? 1 : -1;");
    expect(source).toContain("const timeWindow = (this.skinSettings.upscroll ? h - judgmentY : judgmentY) / pixelsPerMs;");
  });
});
