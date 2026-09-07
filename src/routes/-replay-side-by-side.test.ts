import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
const viewSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySideBySideView.tsx"), "utf8");
const pickerSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySideBySidePicker.tsx"), "utf8");
const searchSource = fs.readFileSync(path.resolve(__dirname, "../lib/player-search.ts"), "utf8");
const infoSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayInfo.tsx"), "utf8");

describe("side by side tab", () => {
  it("sits between By Player and Upload and renders the picker", () => {
    // The strip renders BROWSE_TABS in order, so the order is the layout.
    const block = browseSource.slice(browseSource.indexOf("const BROWSE_TABS"));
    const labels = Array.from(block.slice(0, block.indexOf("];")).matchAll(/label: msg`([^`]+)`/g), (m) => m[1]);
    expect(labels).toEqual(["By Player", "Side by Side", "Upload"]);
    expect(browseSource).toContain('{ mode: "side-by-side", label: msg`Side by Side` }');
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
    // Bare is not silent: what each hit was judged as still pops over the notes.
    expect(viewSource).toContain("showJudgements: true,");
    expect(viewSource).toContain("liveStats: true,");
    expect(viewSource).toContain("fullHeightLayout: true,");
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

  // Chasing it the other way round - a wall clock with the audio seeked back
  // onto it every 200ms - is what made the track stutter: writing currentTime
  // mid-playback IS an audible seek, and the seek's own latency puts the drift
  // straight back over the threshold, so the corrections never stop.
  it("runs both playfields off the audio clock, like the single viewer", () => {
    expect(viewSource).toContain("if (audio && audioMasterRef.current) return audio.currentTime * 1000;");
    expect(viewSource).toContain("time: audio.currentTime * 1000,");
    expect(viewSource).toContain("stalled: audio.paused || audio.seeking || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,");
    // No drift-correction loop, and no seek on resume or on a speed change.
    expect(viewSource).not.toContain("const drift =");
    expect(viewSource).not.toContain("audio.currentTime = clock.anchorTime / 1000");
    // A refused play(), a failed file or a finished track must hand the
    // timeline back instead of freezing both stages on a clock that won't tick.
    expect(viewSource).toContain("void audio.play().catch(() => releaseAudioClock());");
    expect(viewSource).toContain("onEnded={handleAudioEnded}");
  });

  // Three ways the master clock could have stranded the pair, all found in
  // review: a chart outliving its mp3 (play() on an ended element rewinds it to
  // zero, dragging both playfields to the start), an interruption nobody asked
  // for (a call, a media key, a backgrounded tab) holding them on one frame
  // forever, and the shorter run's frame loop never restarting after a seek
  // back inside it.
  it("never hands the clock to a spent, interrupted or ended track", () => {
    expect(viewSource).toContain("if (timeMs >= endMs - AUDIO_TAIL_GUARD_MS) {");
    expect(viewSource).toContain("releaseAudioClock(timeMs);");
    expect(viewSource).toContain("if (now - audioStalledSinceRef.current > AUDIO_STALL_GIVE_UP_MS) releaseAudioClock();");
    expect(viewSource).toContain("if (audio.paused && !audio.seeking && !audio.ended");
    expect(viewSource).toContain("if (clock.playing) renderer.play();");
  });

  // Two framed panels pushed to opposite edges of the screen, over a blurred
  // cover: the runs were as far apart as the layout could put them, and the
  // map itself was a smear.
  it("puts both runs on the map's own background, leaning into the middle", () => {
    // The real archive background, with the set cover as the fallback.
    expect(viewSource).toContain("/api/background?beatmapsetId=");
    expect(viewSource).toContain("&filename=${encodeURIComponent(backgroundFilename)}");
    expect(viewSource).toContain("onError={() => setCoverFallback(true)}");
    expect(viewSource).not.toContain("blur-xl");
    // The stages carry no frame of their own.
    expect(viewSource).not.toContain("ring-osu-pink/40");
    expect(viewSource).toContain('<div className="relative min-h-0 overflow-hidden">');
    // ...and each playfield sits toward the stats column rather than centred
    // in its half.
    expect(viewSource).toContain("const SIDE_PLAYFIELD_ALIGN = [0.88, 0.12] as const;");
    expect(viewSource).toContain("playfieldAlign: SIDE_PLAYFIELD_ALIGN[index],");
  });

  // The dim was fixed at whatever the single viewer had been left on, and a
  // map's storyboard never ran here at all.
  it("watches at a dim you can set, with the map's storyboard behind both runs", () => {
    // Both settings persist, and both are shared with the single viewer.
    expect(viewSource).toContain("writeReplayBackgroundDim(backgroundDim);");
    expect(viewSource).toContain("writeReplayStoryboardEnabled(storyboardEnabled);");
    expect(viewSource).toContain('<VisualSettings');
    expect(viewSource).toContain("onSetDim={setBackgroundDim}");
    expect(viewSource).toContain("onToggleStoryboard={() => setStoryboardEnabled((on) => !on)}");
    // One storyboard for the screen, not one per stage: it is authored for a
    // screen, and a copy squeezed into each half is centred on neither run.
    expect(viewSource).toContain("storyboardOnly: true,");
    expect(viewSource.match(/storyboardOnly: true,/g)).toHaveLength(1);
    expect(viewSource).toContain("renderer.setStoryboard?.(storyboardData.data);");
    // It follows the same clock as the stages, and the transport drives it too.
    expect(viewSource).toContain("renderer.setExternalClock(readSharedClock);");
    expect(viewSource).toContain("for (const renderer of allRenderers()) renderer.play();");
    expect(viewSource).toContain("for (const renderer of allRenderers()) renderer.pause();");
    // A live storyboard paints its own backdrop, background and dim.
    expect(viewSource).toContain("{backgroundUrl && !storyboardActive && (");
    expect(viewSource).toContain("{!storyboardActive && <div className=\"absolute inset-0 bg-black\"");
  });

  // Over a bright map the middle column and the scores were unreadable.
  it("scrims the chrome instead of leaving it on the raw map", () => {
    expect(viewSource).toContain("bg-gradient-to-b from-black/85 via-black/60 to-transparent");
    expect(viewSource).toContain("bg-gradient-to-t from-black/85 via-black/60 to-transparent");
    // The stats scrim is a sibling of the numbers: masking the element that
    // holds them would fade the outermost digits away with its edges.
    expect(viewSource).toContain("[mask-image:linear-gradient(to_right,transparent,black_24%,black_76%,transparent)]");
    // "Accuracy" no longer fits beside two percentages this size.
    expect(viewSource).toContain("{ label: msg`Acc`, format: (s) => `${s.accuracy.toFixed(2)}%`");
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

  // Filling a side used to mean leaving to find a score URL. Best scores cover
  // old plays and the tracker adds ordinary runs whenever a replay exists.
  it("fills a side from a player's stored replay-ready plays, without a score link", () => {
    expect(pickerSource).toContain("fetchLivePlayerCachedProfileSnapshotDirect(String(userId))");
    expect(pickerSource).toContain("fetchLivePlayerReplayScoresDirect(userId, { limit: PLAYER_REPLAY_SCORES_PAGE_SIZE })");
    expect(pickerSource).toContain("scores: mergePlayerRuns(tracked.items, snapshot?.bestScores ?? [])");
    expect(pickerSource).toContain("My plays");
    expect(pickerSource).not.toContain("My top plays");
  });

  // Browsing must not spend the osu! API budget: only committing to a run does,
  // and only because the projection can't know the rate a run was played at.
  it("browses entirely off stored data, with getScore the only osu! call", () => {
    const osuImport = /import \{([^}]*)\} from "#\/lib\/osu";/.exec(pickerSource);
    expect(osuImport?.[1].trim()).toBe("getScore");
    expect(pickerSource).toContain('searchPlayers(trimmedQuery, { fallbackToOsu: false })');
    expect(pickerSource).toContain('fetchLiveMapsPlayersSnapshot("GLOBAL", "farmed", beatmapId');
    // The nav and the By Player box reach any osu! account, so they keep the
    // API as a last resort; the picker cannot use a player it holds no data on.
    expect(searchSource).toContain("if (options.fallbackToOsu === false) return [];");
    expect(searchSource).toContain("const stored = await fetchLiveUserSearch(trimmed, limit);");
  });

  // One box, whose meaning follows from what is in it: a second control per
  // way in is what made this screen a wall of inputs.
  it("drives every way in from the one search box", () => {
    const inputs = pickerSource.match(/<input\b/g) ?? [];
    expect(inputs).toHaveLength(1);
    expect(pickerSource).toContain("const queryScoreId = parseReplayScoreInput(query);");
    expect(pickerSource).toContain("t`Search a player, or paste a score link...`");
    expect(pickerSource).toContain("t`Filter ${player.username}'s runs...`");
    // Picking a row fills whichever card is active, so the cards are the target
    // selector rather than each carrying their own form.
    expect(pickerSource).toContain("next[activeSlot] = score;");
    expect(pickerSource).toContain("slotIndex={activeSlot}");
  });

  it("shows who we know has played the map once a side is filled", () => {
    expect(pickerSource).toContain("fetchMapBoardRuns(anchorBeatmapId, player.username)");
    // A board row has no mod settings, so it is resolved before it is trusted:
    // the pair rules compare rates, and a row can't answer that.
    expect(pickerSource).toContain("onClick={() => onPickById(run.scoreId)}");
    expect(pickerSource).toContain("getSideBySideCandidateIssue(score, anchor)");
    expect(pickerSource).toContain('key={anchorBeatmapId ?? "no-map"}');
  });

  it("leaves no compare action on the score info card", () => {
    expect(infoSource).not.toContain("onCompare");
    expect(infoSource).not.toContain("compareCandidates");
    expect(routeSource).not.toContain("ReplayCompareView");
  });
});
