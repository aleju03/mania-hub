import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("ManiaReplayRenderer initialization", () => {
  it("starts Pixi only once per renderer instance", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source.match(/this\.initPromise = this\.initPixi\(\);/g)).toHaveLength(1);
  });

  it("initializes the actual replay canvas without Pixi's throwaway WebGL probe", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).not.toContain("await app.init(");
    expect(source).toContain('this.canvas.getContext("webgl2", contextAttributes)');
    expect(source).toContain('this.canvas.getContext("webgl", contextAttributes)');
    expect(source).toContain("const webglRenderer = new WebGLRenderer();");
    expect(source).toContain("await webglRenderer.init({");
    // Pixi 8 accepts a WebGL2 context object only; the WebGL1 canvas still
    // gets its context made here and picked up through preferWebGLVersion.
    expect(source).toContain("context: gl,");
    expect(source).toContain("preferWebGLVersion: gl ? 2 : 1,");
    expect(source).toContain("const canvasRenderer = new CanvasRenderer();");
    expect(source).toContain('powerPreference: "default"');
    expect(source).toContain("app.renderer.context.extensions.loseContext = undefined;");
    expect(source.match(/destroyReplayPixiApplication\(/g)).toHaveLength(3);
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

  it("counts the odd-key middle column toward the hand playing it with a thumb", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const leftCount = this.keyCount % 2 === 1 && this.missThumbHand === \"left\"");
    expect(source).toContain("? Math.ceil(this.keyCount / 2)");
    expect(source).toContain(": Math.floor(this.keyCount / 2);");
    // Switching hands mid-run re-tallies what has already been scanned.
    expect(source).toContain("this.recomputeHandMisses();");
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
    // Skipped where the HUD can never render, unless something outside the
    // canvas is reading the numbers (side by side).
    expect(source).toContain("this.starRatingTimeline = (this.hideHud || this.barePlayfield) && !this.liveStats");
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
    const panelSource = fs.readFileSync(path.resolve(__dirname, "../maps/ChartPreviewPanel.tsx"), "utf8");

    // Through the shared hook, which also rebuilds the art for an applied
    // custom skin: localStorage alone holds the asset-free copy.
    expect(source).toContain("const skinSettings = useReplaySkinSettings();");
    expect(panelSource).toContain("const localSkinSettings = useReplaySkinSettings();");
    // Both stages build from the ref, never the effect's closure: rebuilding
    // an applied skin's art is async, so on a reroll it can land while the
    // renderer's dynamic import is still in flight, and a stage built from the
    // captured value would keep the asset-free copy until something else
    // changed the settings.
    expect(source).toContain("skinSettings: skinSettingsRef.current,");
    expect(source).toContain("renderer.setSkinSettings(skinSettingsRef.current);");
    expect(panelSource).toContain("skinSettings: skinSettingsRef.current,");
    expect(panelSource).toContain("renderer.setSkinSettings(skinSettingsRef.current);");
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
    // Stable uses the extracted selection-mod sprites, lazer the tinted
    // shield + glyph art shared with the site's ModBadge component.
    expect(source).toContain("/images/badges/mods/stable/");
    expect(source).toContain("MOD_BADGE_TYPE_COLORS[acronym]");
    expect(source).toContain("MOD_BADGE_FILE_NAMES[acronym]");
    // Both stacks persist for the whole play; stable's start-of-map fade-out
    // would hide the mods from anyone who seeks.
    expect(source).toContain("const alpha = isLazer ? 0.94 : 1;");
    expect(source).not.toContain("this.firstNoteTime");
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
    expect(match![1]).toContain("this.strokeCircle(");
    expect(match![1]).toContain("pressed ? 1 : 0.5");
    // Presses brighten the ring only; no interior fill, beam, or glow.
    expect(match![1]).not.toContain("this.circle(");
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

  it("cascades skin LN bodies from the tail instead of stretching one copy", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Stable's default NoteBodyStyle. Percy bodies (a 4000px tall strip whose
    // rounded cap hides behind a transparent lead-in) came out with a flat
    // tail while one copy was squashed over the whole hold.
    expect(source).toContain("private lnBodyTiles(");
    expect(source).toContain("const tileHeight = sourceHeight * (colWidth / sourceWidth);");
    expect(source).toContain("if (span > tileHeight * MAX_LN_BODY_TILES) return stretched;");
    expect(source).toContain("const MAX_LN_BODY_TILES = 8;");
    // The old whole-span stretch is gone from the skin body path.
    expect(source).not.toContain("(segmentTop - bodyTop) / bodyHeight,");
    // Tail-anchored means the tile grows upward on upscroll, mirrored.
    expect(source).toContain("top: upscroll ? bodyBottom - far : bodyTop + near,");
    expect(source).toContain("flipY: upscroll,");
    expect(source).toContain("const nearOffset = tile.flipY ? tile.bottom - segmentBottom : segmentTop - tile.top;");
    expect(source).toContain("sprite.anchor.set(0.5, flipY ? 1 : 0);");
    // Whole-pixel tile edges: partial rows at a seam composite to under full
    // opacity, which shows as a line across the body.
    expect(source).toContain("const near = Math.round(offset);");
    // A tall strip covers any hold on its own (and gets cropped at import for
    // the GPU texture limit), so repeating it would replay the art's
    // transparent lead-in partway up and cut the hold in half.
    expect(source).toContain("const LN_BODY_STRIP_ASPECT = 8;");
    expect(source).toContain("if (sourceHeight / sourceWidth >= LN_BODY_STRIP_ASPECT) {");
    expect(source).toContain("if (span - covered > 0.5) push(covered, span, Math.max(0, 1 - LN_BODY_FILLER_ROWS / sourceHeight), 1);");
  });

  it("places the stage at skin.ini ColumnStart across a centred 16:9 box", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Measuring from the canvas edge would drift the stage further left the
    // wider the window gets; the value was authored against a 16:9 screen.
    expect(source).toContain("private getPlayfieldX(");
    expect(source).toContain("const boxWidth = OSU_MANIA_SCREEN_WIDTH * layoutScale;");
    expect(source).toContain("const x = (w - boxWidth) / 2 + columnStart * layoutScale;");
    // No value, an explicit align (video/card renders) or a bare stage keeps
    // the centred playfield.
    expect(source).toContain("if (columnStart == null || this.playfieldAlign != null || this.barePlayfield) return aligned;");
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

  it("shows playfield lane dividers and lane tint only for bar skins without imported art", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('const showColumnDividers = this.skinSettings.style === "bars" && !hasImportedColumnArt;');
    expect(source).toContain("for (let col = 0; showColumnDividers && col < this.keyCount; col++)");
    expect(source).toContain("if (showColumnDividers) {");
  });

  it("hides the bare playfield bottom guide for circle skins", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("if (this.barePlayfield) {");
    expect(source).toContain('if (showColumnDividers) this.lineInto(g, playfieldX, h - 1, playfieldX + playfieldWidth, h - 1, "#ffffff", 0.1, 2);');
  });

  // The pop used to live inside renderHUD, so hiding the HUD (side by side)
  // also hid what every hit was judged as - on the one screen whose whole job
  // is comparing two sets of judgements.
  it("keeps the judgement pop on a stage with the HUD hidden", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("private renderJudgementPop(layout: Layout) {");
    expect(source).toContain("if (this.showJudgements) this.renderJudgementPop(layout);");
    expect(source).toContain("if (this.showCombo) this.renderCombo(layout);");
    // Still one implementation, drawn under the same conditions as before.
    expect(source.match(/this\.renderJudgementPop\(layout\);/g)).toHaveLength(2);
  });

  // Side by side draws the storyboard once for the screen instead of once per
  // stage; that renderer has no playfield to draw under it.
  it("stops a storyboard-only canvas after the storyboard", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("if (this.storyboardOnly) {");
    const render = source.slice(source.indexOf("this.renderStoryboard(layout);"));
    const stop = render.indexOf("if (this.storyboardOnly) {");
    const notes = render.indexOf("this.renderNotes(layout);");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(notes);
  });

  it("biases 5k+ wide bare preview playfields left", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const barePreviewBias = this.barePlayfield && this.keyCount >= 5 && w >= 380 ? 0.32 : 0.5;");
    // An explicit alignment (side by side pulls each stage toward the middle)
    // overrides the bias; everything else keeps it.
    expect(source).toContain("const aligned = (w - playfieldWidth) * (this.playfieldAlign ?? bias);");
    expect(source).toContain("const playfieldX = this.getPlayfieldX(w, playfieldWidth, layoutScale, barePreviewBias);");
  });

  it("draws bar LNs as one continuous body without separate caps", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const branch = /const barPercyTrim = this\.skinSettings\.percy([\s\S]*?)\n      \} else \{/.exec(source);

    expect(branch?.[1]).toBeTruthy();
    expect(branch![1]).toContain("const bodyHeadY = headEndY;");
    expect(branch![1]).toContain("const bodyTailY = tailEndY + tailDelta;");
    // Directional span: the trimmed tail crosses the head at the end of a
    // hold, where min/max would flip and draw the leftover past the receptor.
    expect(branch![1]).toContain("const barBodyTop = this.skinSettings.upscroll ? bodyHeadY : bodyTailY;");
    expect(branch![1]).toContain("const barBodyBottom = this.skinSettings.upscroll ? bodyTailY : bodyHeadY;");
    expect(branch![1]).toContain("if (barBodyBottom > barBodyTop) {");
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

  it("lays out an image skin's hold the way longNoteGeometry does", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const cardSource = fs.readFileSync(path.resolve(__dirname, "../../lib/skin-preview-render.ts"), "utf8");

    // Both caps' boxes grow away from the receptor. Drawing the tail from the
    // end line into the hold instead put the cap a full box lower than the
    // game does, and dragged the whole LN down with it.
    expect(source).toContain("const tailBoxTop = this.skinSettings.upscroll ? tailEndY : tailEndY - tailHeight;");
    expect(cardSource).toContain("const tailBoxTop = upscroll ? tailEndY : tailEndY - tailHeight;");
    // The cascade counts from the tail box's far edge, which is the origin a
    // Percy body's transparent lead-in is authored against. A centre stop, or
    // the "cut LN tail" trim, slides that lead-in down and opens a gap.
    expect(source).toContain("const bodyTailY = this.skinSettings.upscroll ? tailBoxTop + tailHeight : tailBoxTop;");
    expect(source).not.toContain("renderHoldSkinImages(layout, assets, colX, colWidth, top, bottom, headEndY, tailEndY, tailTrimDelta");
    // The built-in bar/circle/arrow styles keep the trim: there it is a look,
    // not a compensation for where a skin's own art sits.
    expect(source).toContain("const bodyTailY = tailEndY + tailDelta;");
    // Art that stops short of that edge clips the drawing, not the cascade.
    expect(source).toContain("const tile = clipLnBodyTile(full, clipTop, clipBottom);");
    expect(cardSource).toContain("ctx.rect(laneX, visibleTop, laneWidth, visibleBottom - visibleTop);");
    // A cap that draws nothing occupies no box. Skins point the tail at a
    // blank placeholder (1x1 transparent, or an unauthored mania-note#T)
    // because the body art ends in its own rounded cap; sizing a box off that
    // placeholder's aspect invented a lane-width-tall cap, which the cascade
    // then added to the hold's length while the centre stop sliced the body's
    // own rounded end flat.
    expect(source).toContain("const tailArtTop = tailAsset ? this.lnTailArtTop(tailAsset) : null;");
    expect(source).toContain("const tailHeight = tailAsset && tailArtTop !== null");
    expect(source).toContain("if (tailAsset && tailHeight > 0) {");
    expect(cardSource).toContain("const tailBounds = tailImage ? imageAlphaBounds(tailImage) : null;");
    expect(cardSource).toContain("const tailHeight = tailImage && tailBounds ? noteAssetHeight(tailImage) : 0;");
    expect(cardSource).toContain("if (tailImage && tailHeight > 0) {");
    // In the viewer the alpha read is async, so the reads are primed when the
    // skin profile is built: one landing mid-playback would resize every LN.
    expect(source).toContain("if (column?.lnTail) readLnTailArtTop(column.lnTail.src);");
    expect(source).toContain('const lnTailArtTopCache = new Map<string, number | null | "pending">();');
    // ?? would collapse the cached null ("scanned, blank") back into
    // "pending", and the phantom box would never go away.
    expect(source).toContain('return value === undefined ? "pending" : value;');
    expect(source).not.toContain("lnTailArtTopCache.get(asset.src) ?? ");
  });

  it("lets an image skin's hold body run out at the head's centre", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const cardSource = fs.readFileSync(path.resolve(__dirname, "../../lib/skin-preview-render.ts"), "utf8");

    // Directional span, not min/max. Every hold held through spends its body
    // in the last half-cap before the tail lands, and the absolute span
    // flipped it there: the remainder drew on the far side of the head's
    // centre, poking out around a round cap as two dark corners at the
    // receptor that grew until the tail arrived.
    expect(source).toContain("const bodyTop = this.skinSettings.upscroll ? bodyHeadY : bodyTailY;");
    expect(source).toContain("const bodyBottom = this.skinSettings.upscroll ? bodyTailY : bodyHeadY;");
    expect(source).not.toContain("Math.min(bodyHeadY, bodyTailY)");
    expect(cardSource).toContain("bodyTop: upscroll ? headSideY : tailSideY,");
    expect(cardSource).not.toContain("Math.min(headSideY, tailSideY)");
    // The flat fallback body is span-checked too, instead of being handed a
    // negative height on those frames.
    expect(source).toContain("} else if (clipBottom > clipTop) {");
  });

  it("applies the configured keymode column width to layout", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain("const configuredColumnWidths = this.getConfiguredColumnWidths();");
    expect(source).toContain("configuredColumnWidths.reduce((sum, width) => sum + width, 0)");
  });

  it("supports osu!mania skin.ini hud positions and imported sprites", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('this.getStagePositionY(this.stagePosition("scorePosition"), layout)');
    expect(source).toContain('this.getStagePositionY(this.stagePosition("comboPosition"), layout)');
    expect(source).toContain("private gameplaySkinSprites: SkinSpriteFramePool");
    expect(source).toContain("private hudSkinSprites: SkinSpriteFramePool");
    expect(source).toContain("private renderHoldSkinImages(");
  });

  it("keeps storyboard overlays below HUD geometry and skin sprites", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    const storyboardLayer = source.indexOf("app.stage.addChild(this.storyboardOverlayRoot);");
    const hudGraphics = source.indexOf("app.stage.addChild(this.hudGraphics);");
    const hudSprites = source.indexOf("app.stage.addChild(this.hudSkinSprites.layer);");
    expect(storyboardLayer).toBeGreaterThan(-1);
    expect(hudGraphics).toBeGreaterThan(storyboardLayer);
    expect(hudSprites).toBeGreaterThan(hudGraphics);
    expect(source).toContain("this.graphics = this.hudGraphics;");
    expect(source).toContain("this.activeSkinSprites = this.hudSkinSprites;");
  });

  it("uses the configured hit position for receptors without changing scroll density", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('const hitPosition = this.stagePosition("hitPosition") ?? MANIA_HIT_TARGET_POSITION;');
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

  it("layers stage furniture around the notes the way the game does", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Column light + hint go under the notes, deck + frame over them; sprite
    // order inside the pooled layer is call order, so the render sequence is
    // the layering.
    const under = source.indexOf("this.renderStageFurnitureUnder(layout);");
    const notes = source.indexOf("this.renderNotes(layout);");
    const over = source.indexOf("this.renderStageFurnitureOver(layout);");
    expect(under).toBeGreaterThan(-1);
    expect(over).toBeGreaterThan(notes);
    expect(notes).toBeGreaterThan(under);
    // Furniture only renders for bar skins, like the rest of the skin art.
    expect(source).toContain("private renderStageFurnitureUnder(layout: Layout) {\n    if (this.skinSettings.style !== \"bars\") return;");
    expect(source).toContain("private renderStageFurnitureOver(layout: Layout) {\n    if (this.skinSettings.style !== \"bars\") return;");
    // The column light bottoms out at skin.ini LightPosition, not HitPosition.
    expect(source).toContain("const lightUnits = 480 - (this.skinProfile.lightPosition ?? OSU_MANIA_DEFAULT_LIGHT_POSITION);");
    // skin.ini Colour{n} paints the static column backgrounds, alpha included.
    expect(source).toContain("const declared = this.skinProfile.columnBackgrounds[col];");
  });

  it("draws no combo counter for a keymode whose skin pushed it off the stage", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");
    const cardSource = fs.readFileSync(path.resolve(__dirname, "../../lib/skin-preview-render.ts"), "utf8");

    // ComboPosition past the bottom of the 480-unit stage is how a skin turns
    // the counter off; the game shows none, so clamping it into range and
    // pinning it to the bottom edge drew something in game never draws.
    expect(source).toContain("if (this.skinProfile.comboHidden) return;");
    expect(cardSource).toContain("if (!combo || profile.comboHidden) return;");
  });

  it("places the stage from the keymode's own hit position", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // A skin sets HitPosition per [Mania] block (the Teto edit holds 4K at 440
    // and 7K at 393) and pads its key art to land on that line, so the hit
    // line, the key area, the column light and the HUD all have to read the
    // keymode's value rather than one shared setting.
    expect(source).toContain('const hitPosition = this.stagePosition("hitPosition") ?? MANIA_HIT_TARGET_POSITION;');
    expect(source).toContain('const hitUnits = getSkinStagePositionUnits(this.stagePosition("hitPosition"));');
    expect(source).toContain('const y = this.getStagePositionY(this.stagePosition("scorePosition"), layout);');
    expect(source).toContain('const comboY = this.getStagePositionY(this.stagePosition("comboPosition"), layout);');
    expect(source).toContain("return getReplaySkinStagePosition(this.skinProfile, this.skinSettings, key);");
  });

  it("keeps preview stages transparent under a skin that declares black lanes", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Chart previews float over the page's own art with no stage behind them,
    // and most skins set Colour{n} to opaque black for their stage image.
    expect(source).toContain('if (this.skinSettings.style === "bars" && !this.barePlayfield) {');
  });

  it("renders the skinned scorebar instead of the synthetic health bar when the skin ships one", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    expect(source).toContain('if (this.skinSettings.style === "bars" && this.renderSkinHealthBar(layout, health)) return;');
    // The art mounts rotated 90° CCW and the fill crops with health, so the
    // texture never stretches.
    expect(source).toContain("private drawSkinImageRotatedCcw(");
    expect(source).toContain("sprite.rotation = -Math.PI / 2;");
    // Pooled sprites must shed rotation between draws or a scorebar frame
    // would tilt whatever note reuses its slot.
    expect(source).toContain("sprite.rotation = 0;");
  });

  it("renders imported key images stable-style and mutes built-in stage cosmetics under skin art", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Key images keep their native height in the game's 768-space and sit on
    // the bottom edge of the stage (lazer's LegacyKeyArea rule, shared with
    // the catalog preview). Stretching them to the gap under the hit line
    // smeared tall key art into a flat line.
    expect(source).toContain("const height = Math.max(1, native.height * (480 / 768) * layout.layoutScale);");
    // Standing on the stage's bottom edge, measured from the hit line rather
    // than from the canvas edge: the two only coincide while the stage's
    // vertical scale matches its horizontal one, which a preview breaks by
    // widening its lanes. Key art is padded so its visible key lands on the
    // hit position, so measuring from the canvas edge dragged the key up off
    // the line there.
    expect(source).toContain('const stageEdge = getSkinStagePositionUnits(this.stagePosition("hitPosition")) * layout.layoutScale;');
    expect(source).toContain("this.drawSkinImage(receptorAsset, x + colWidth / 2, judgmentY + stageEdge - height, colWidth, height, 0.5, 0, 1);");
    expect(source).toContain("this.drawSkinImage(receptorAsset, x + colWidth / 2, judgmentY - stageEdge, colWidth, height, 0.5, 0, 1, 0xffffff, true);");
    // skin.ini KeysUnderNotes flips the draw order, nothing else.
    expect(source).toContain("if (keysUnderNotes) this.renderReceptors(layout);");
    expect(source).toContain("if (!keysUnderNotes) this.renderReceptors(layout);");
    // The alternating tints / boundary lines / border rect are the built-in
    // bars look; a skin with real column art must not get them stacked on top.
    expect(source).toContain('const showColumnDividers = this.skinSettings.style === "bars" && !hasImportedColumnArt;');
    expect(source).toContain("this.blackPlayfield ? 1 : hasImportedColumnArt ? 0 : 0.12");
  });

  it("falls back to the default judgement set when the skin has no art for the keymode", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // A 4K-only skin on a 7K chart selects judgementSet "skin" with an empty
    // per-keymode asset map; judgements must not vanish.
    expect(source).toContain("&& Object.values(this.skinProfile.assets.judgements).some(Boolean);");
    expect(source).toContain("this.usingSkinJudgements() ? skinAssets : getReplayJudgementSetAssets(DEFAULT_REPLAY_JUDGEMENT_SET)");
  });

  it("honours skin.ini JudgementLine and stops LN bodies at the head cap centre", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // Skins that draw their own hit line (JudgementLine: 0) got a white bar
    // through art that has none.
    expect(source).toContain('if (this.skinSettings.style !== "bars" || !this.skinProfile.judgementLine) return;');
    // Cap art is widest at its centre, so a body carried to the cap's far
    // edge pokes out around a round note.
    expect(source).toContain("const bodyHeadY = this.skinSettings.upscroll ? headEndY + headHeight / 2 : headEndY - headHeight / 2;");
  });

  it("draws imported judgements and combo digits at their native skin size", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "ReplayCanvas.ts"), "utf8");

    // The fraction-of-canvas rule is for the built-in judgement sets; skin art
    // put through it drew about 1.6x bigger than the game does.
    expect(source).toContain("const native = this.usingSkinJudgements() ? this.getStageAssetNativeSize(asset) : null;");
    expect(source).toContain("const unit = (480 / 768) * layout.layoutScale * scale;");
    // Combo digits follow the same rule, times the counter's own scale from
    // lazer's MainHUDComponents.json.
    expect(source).toContain("return (480 / 768) * layout.layoutScale * this.skinProfile.comboScale;");
    expect(source).toContain("const overlap = combo.overlap * this.getComboUnitScale(layout);");
  });
});
