import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay skin settings UI", () => {
  it("loads persisted settings and exposes a gear button for the skin modal", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const controlsSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayControls.tsx"), "utf8");

    expect(routeSource).toContain("readReplaySkinSettings");
    expect(routeSource).toContain("writeReplaySkinSettings");
    expect(routeSource).toContain("rendererRef.current?.setSkinSettings");
    expect(routeSource).toContain("ReplaySkinSettingsModal");
    expect(controlsSource).toContain("aria-label={t`Replay settings`}");
  });

  it("persists applied community skins as a dehydrated pointer, never data URLs", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const modalSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // Multi-MB data-URL settings blow the localStorage quota; the focus
    // re-read then reverted the apply. The pointer + asset-free split is what
    // prevents that regression.
    expect(modalSource).toContain("replaySkinSettingsEmbedAssets");
    expect(routeSource).toContain("writeAppliedCommunityReplaySkin");
    expect(routeSource).toContain("readAppliedCommunityReplaySkin");
    expect(routeSource).toContain("appliedCommunityReplaySkinKey");
    expect(routeSource).toContain("writeReplaySkinSettings(community.assetFree)");
    expect(routeSource).toContain("hydrateAppliedCommunitySkin");
    // Reopening the modal re-selects the applied community skin's preset and
    // keeps the community actions usable without a session archive.
    expect(modalSource).toContain("readAppliedCommunityReplaySkin");
    expect(modalSource).toContain("communitySkinContext");
  });

  it("renders the skin modal controls in the replay component folder", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    expect(source).toContain("Replay settings");
    expect(source).toContain("Style");
    expect(source).toContain("Layout");
    expect(source).toContain("Note color");
    expect(source).toContain("LN Head color");
    expect(source).toContain("LN Body color");
    expect(source).toContain("Outline color");
    expect(source).toContain("Outline width");
    expect(source).toContain("Cut LN tail");
    expect(source).toContain("Keymode");
    expect(source).toContain("Skin preset");
    expect(source).toContain("New preset");
    expect(source).toContain("Share code");
    // Skins come from the community catalog now: the Style tab browses and
    // imports published skins (visuals + staged hitsounds), so the local
    // sounds-only .osk import is gone. The Audio tab keeps the status row
    // (preview + remove) for whichever skin's sounds are active.
    expect(source).toContain("Custom skin");
    expect(source).toContain("Browse skins");
    expect(source).toContain("Set as my replay skin");
    expect(source).toContain("importReplaySkinFromOsk");
    // Loaded community skins live in Skin preset under the skin's name; the
    // preset stores the dehydrated payload and rehydrates on selection.
    expect(source).toContain("upsertCommunityPreset");
    expect(source).toContain("applyCommunityPreset");
    expect(source).toContain("dehydrateReplaySkinSettings");
    expect(source).toContain("rehydrateOwnerReplaySkinSettings");
    expect(source).not.toContain("importReplaySkinSoundsFromOsk");
    expect(source).not.toContain("Import .osk");
    expect(source).toContain("Skin hitsounds");
    expect(source).not.toContain("Overwrite preset");
    expect(source).not.toContain("Current draft");
    expect(source).toContain("Note height");
    expect(source).toContain("ScorePosition");
    expect(source).toContain("ComboPosition");
    expect(source).toContain("Note shape");
    expect(source).toContain("Per-column colors");
    expect(source).toContain("Column width");
    expect(source).toContain("Hit position");
    expect(source).toContain("ReplaySkinPreview");
    expect(source).toContain("ReplaySkinColorPanel");
    expect(source).toContain('setOverrideKind(previewMode === "ln" && showLnHeadColorControls ? "lnHead" : "tap")');
    expect(source).toContain("Apply");
    expect(source).toContain("Cancel");
    expect(source).toContain("Reset");
  });

  it("persists an applied skin from the settings page the same way as the replay page", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/settings/SettingsPanel.tsx"), "utf8");

    // This copy of the apply flow wrote the decoded settings straight to
    // localStorage and never wrote the pointer, so the quota rejected it and
    // reopening the editor came back on "Default" with the skin gone.
    expect(source).toContain("writeAppliedCommunityReplaySkin");
    expect(source).toContain("writeReplaySkinSettings(community.assetFree)");
    expect(source).toContain("replaySkinSettingsWithoutAssets");
    // And the decoded copy comes back from the pointer on mount.
    expect(source).toContain("loadAppliedCommunityReplaySkinSettings");
  });

  it("reuses the last known replay-skin state when the settings drawer remounts", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/settings/SettingsPanel.tsx"), "utf8");

    // Closing the drawer unmounts this panel. A synchronous cache peek keeps a
    // known null from becoming an empty loading row on every subsequent open.
    expect(source).toContain("const rememberedMyReplaySkin = viewerId ? peekMyReplaySkinMemory(viewerId) : undefined;");
    expect(source).toContain("() => viewerId != null && rememberedMyReplaySkin !== undefined");
    // Stale values stay visible while the normal cached fetch revalidates.
    expect(source).toContain("setMyReplaySkinLoaded(remembered !== undefined);");
    expect(source).toContain("void fetchMyReplaySkinCached(viewerId)");
  });

  it("steps the built-in style controls aside once a skin brings its own art", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // Note shape, the colour switches and the LN trim all act on the built-in
    // shapes, which an imported skin replaces outright.
    expect(source).toContain("const keymodeHasSkinArt = ");
    expect(source).toContain("{keymodeHasSkinArt ? null : (");
    // And the card shows the skin instead of stand-ins: key area at the game's
    // scale, the skin's own judgement art and combo digits, and the hit line
    // only when skin.ini asks for one.
    expect(source).toContain("getPreviewKeyAreaHeight");
    expect(source).toContain("getSkinJudgementPreviewAsset");
    expect(source).toContain("getSkinComboPreviewGlyphs");
    expect(source).toContain('settings.style === "bars" && profile.judgementLine');
    // LN bodies cascade from the tail at natural aspect, like the stage and
    // the catalog preview; a stretched copy flattened the art's cap away.
    expect(source).toContain("getPreviewLnBodyTileHeight");
    expect(source).toContain('backgroundRepeat: "repeat-y"');
    expect(source).toContain('backgroundPosition: "top center"');
  });

  it("brings the .osk back when the editor reopens on an applied skin", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // Without the archive the Assets tab is hidden and "Set as my replay skin"
    // is dead, even though the preset and the art are right there.
    expect(source).toContain("const communityPresetSkin = selectedPreset?.community?.skin ?? null;");
    // Id-compared, not presence-checked: a leftover archive from a different
    // skin must be replaced, not kept, or presets and publishes pair skin B's
    // settings with skin A's pointer.
    expect(source).toContain("current?.skin.id === communityPresetSkin.id ? current : { skin: communityPresetSkin, archive }");
    expect(source).not.toContain("current ?? { skin: communityPresetSkin, archive }");
  });

  it("exposes ColumnStart in the layout tab and moves the preview with it", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    expect(source).toContain("label={t`Column start`}");
    // Stored null while centred, so the reset goes back to centred rather than
    // to some skin's imported value.
    expect(source).toContain("function getCenteredColumnStart(");
    expect(source).toContain("onResetToDefault={() => updateProfile({ columnStart: null })}");
    // The card is far narrower than a 16:9 screen at this note size, so it
    // places the stage proportionally instead of in raw skin units.
    expect(source).toContain("const columnStartRange = Math.max(1, OSU_MANIA_SCREEN_WIDTH - getStageUnitWidth(profile, keyCount));");
  });

  it("pushes the player's-skin preference to a running replay without a refresh", () => {
    const prefs = fs.readFileSync(path.resolve(__dirname, "../lib/replay-preferences.ts"), "utf8");
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    // The settings drawer opens over the stage, and "storage" never fires in
    // the tab that wrote the value.
    expect(prefs).toContain('export const REPLAY_OWNER_SKIN_CHANGE_EVENT = "mania-hub:replay-owner-skin-change";');
    expect(prefs).toContain("window.dispatchEvent(new CustomEvent(REPLAY_OWNER_SKIN_CHANGE_EVENT, { detail: enabled }));");
    expect(routeSource).toContain("window.addEventListener(REPLAY_OWNER_SKIN_CHANGE_EVENT, sync);");
    expect(routeSource).toContain("if (!ownerUserId || !ownerSkinPreferred) {");
    expect(routeSource).toContain("}, [ownerUserId, ownerSkinPreferred, releaseOwnerSkinHold, replay.keyCount]);");
  });

  it("drops the built-in combo font picker when the skin ships digits", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // The stage draws the skin's own digits there, so the picker and its
    // sample would only misrepresent it.
    expect(source).toContain("const keymodeHasComboArt = Boolean(profile.assets.combo?.digits.some(Boolean));");
    expect(source).toContain("{keymodeHasComboArt ? null : (");
  });

  it("rebuilds a stripped draft instead of editing and saving a skin without its art", () => {
    const modalSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");
    const ownerSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-owner-skin.ts"), "utf8");

    // The page that owns the settings rebuilds the art asynchronously, so an
    // editor opened first (or after a failed rebuild) holds the asset-free
    // copy while its preset name still names the skin.
    expect(modalSource).toContain("const draftMissingSkinArt = Boolean(communityPresetSkin) && !replaySkinSettingsEmbedAssets(draft);");
    expect(modalSource).toContain("const rebuilt = await rehydrateOwnerReplaySkinSettings(communityPresetPayload, archive);");
    // And Apply must not write that draft over the payload that still has the
    // asset paths, or the preset rebuilds as flat shapes from then on. Both
    // that rule and the "stored copy comes from the payload, never the draft"
    // one live in resolveCommunityPresetSave, unit-tested in
    // replay-owner-skin.test.ts.
    expect(modalSource).toContain("resolveCommunityPresetSave(normalized, selectedPreset.community.payload)");
    // A failed rebuild must not stick in the memo either.
    expect(ownerSource).toContain("if (!settings && appliedFullSettings === entry) appliedFullSettings = null;");
  });

  it("ends an LN body at its head's centre in the card, like the stage", () => {
    const modalSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");
    const canvasSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayCanvas.ts"), "utf8");

    // Stable runs a hold to the middle of its head cap, never to the cap's far
    // edge: cap art is widest at its centre, so a body carried past it pokes
    // out below a round note. The card ran both its skin-art and circle
    // branches to the head's anchor instead.
    expect(canvasSource).toContain("const bodyHeadY = this.skinSettings.upscroll ? headEndY + headHeight / 2 : headEndY - headHeight / 2;");
    expect(canvasSource).toContain("const circleBodyRange = this.getHoldBodyRange(headCenterY, tailEndY, tailTrimDelta);");
    expect(modalSource).toContain("const bodyHeadY = settings.upscroll ? lnHeadY + headHeight / 2 : lnHeadY - headHeight / 2;");
    expect(modalSource).toContain("const bodyTop = Math.min(lnHeadCenterY, lnTailEnd);");
  });

  it("keeps the editor's skin and the published one in separate sections", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // One card held both, so the buttons under "Your replay skin: X" read as
    // acting on the skin named at the top of the card instead.
    expect(source).toContain("{t`Custom skin`}</div>");
    expect(source).toContain("{t`My replay skin`}</div>");
    expect(source).toContain("{myReplaySkinRecord ? myReplaySkinRecord.skin.name : t`None set`}");
    expect(source).toContain("src={myReplaySkinRecord.skin.previewUrl}");
  });

  it("only offers Load when the published skin differs from the draft", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // The button pulls the server-side copy down, which is the only route to
    // it in a browser that never loaded it, and the way back from local edits.
    // With the draft already holding it, it did nothing visible.
    expect(source).toContain("const draftMatchesMyReplaySkin = Boolean(myReplaySkinRecord)");
    // By identity: every edit rebuilds the draft object, while comparing the
    // stored payloads called a skin "changed" the moment the format gained a
    // field, which left the button live in the one case it does nothing.
    expect(source).toContain("&& myReplaySkinDraftRef.current === draft;");
    expect(source).toContain("myReplaySkinDraftRef.current = adoptImportedSettings(");
    expect(source).toContain("myReplaySkinDraftRef.current = draft;");
    expect(source).toContain("disabled={communityBusy != null || draftMatchesMyReplaySkin}");
    // Named for its direction, next to a button that pushes the other way:
    // plain "Load" read as acting on the preset above rather than on the skin
    // named beside it.
    expect(source).toContain('"Load into editor"');
    expect(source).toContain("`The editor already holds ${myReplaySkinRecord.skin.name}`");
    // Publishing the unchanged draft is just as redundant as loading it, so
    // both directions share the same disabled state.
    expect(source).toContain("disabled={!communitySkinContext || communityBusy != null || draftMatchesMyReplaySkin}");
    expect(source).toContain("draftMatchesMyReplaySkin\n                                    ? t`Already set`");
  });

  it("makes viewer-local and public replay-skin saves explicit", () => {
    const modalSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");
    const panelSource = fs.readFileSync(path.resolve(__dirname, "../components/settings/SettingsPanel.tsx"), "utf8");
    const ownerModalSource = fs.readFileSync(path.resolve(__dirname, "../components/settings/OwnerReplaySkinCustomizeModal.tsx"), "utf8");

    expect(panelSource).toContain("Viewer editor");
    expect(panelSource).toContain("This does not change the replay skin other people see on your plays.");
    expect(modalSource).toContain('saveScope?: "viewer" | "owner";');
    expect(modalSource).toContain("saveScope === \"owner\" ? t`Save for everyone` : t`Apply for me`");
    // The publish action lives in the persistent footer, so a Layout edit can
    // be saved publicly without returning to the Style tab.
    expect(modalSource).toContain('saveScope === "viewer" && viewerId && communitySkinContext');
    expect(modalSource).toContain("t`Saved for everyone`");
    expect(ownerModalSource).toContain('saveScope="owner"');
  });

  it("points a click in the preview at the asset row it came from", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // Stage art is unrecognisable by filename, so the only way to find "the
    // black bar across the top" was to clear rows until it went.
    expect(source).toContain("const identifyAsset = (target: AssetPickerTarget) => {");
    expect(source).toContain('setActiveTab("assets");');
    expect(source).toContain('const row = modalRef.current?.querySelector(`[data-asset-row="${highlightedAssetId}"]`);');
    expect(source).toContain('row?.scrollIntoView({ block: "center", behavior: "smooth" });');
    expect(source).toContain("onIdentifyAsset={activeAssetArchive ? identifyAsset : undefined}");
    // Which means the card has to draw the stage's own furniture, and each
    // element has to take the pointer back from the lane drag-select.
    expect(source).toContain("const stageArt = (() => {");
    expect(source).toContain('className: "pointer-events-auto cursor-pointer",');
    expect(source).toContain("onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),");
  });

  it("edits a keymode's own stage positions when the skin declares them", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    expect(source).toContain("const stagePositionValue = (key: ReplaySkinStagePositionKey) => getReplaySkinStagePosition(profile, draft, key);");
    // Per keymode where the skin set one, settings-wide otherwise, so the
    // built-in skins keep a single hit position across every keymode.
    expect(source).toContain("if (profile[key] != null) updateProfile({ [key]: value } as Partial<ReplaySkinKeymodeProfile>);");
    expect(source).toContain("else update({ [key]: value } as Partial<ReplaySkinSettings>);");
  });

  it("returns to the built-in skin when the Default preset slot is picked", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // The slot only relabelled itself before: the art stayed in the draft, the
    // preview kept drawing it, and Apply wrote the same skin back through the
    // pointer, so the editor reopened on the skin the user just left.
    expect(source).toContain("if (!loadedCatalogSkin && !replaySkinSettingsEmbedAssets(draft)) return;");
    expect(source).toContain("setLoadedCatalogSkin(null);");
    expect(source).toContain("setDraft(DEFAULT_REPLAY_SKIN_SETTINGS);");
  });

  it("keeps decoded community presets warm when switching through Default", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // Switching away remembers the full data-URL settings object, its open
    // archive and sounds. Switching back takes this branch before any zip
    // extraction or per-asset rehydration work.
    expect(source).toContain("const hydratedPresetCacheRef = useRef(new Map<string, HydratedCommunityPreset>());");
    expect(source).toContain("rememberHydratedPreset(");
    expect(source).toContain("let cached = hydratedPresetCacheRef.current.get(preset.id) ?? null;");
    expect(source).toContain("if (cached?.sounds) {");
    expect(source).toContain("readCachedReplaySkin(communityPresetCacheKey(preset))");
    // A first import also retains the exact archive whose asset cache the
    // importer populated, instead of unzipping into a fresh empty archive.
    expect(source).toContain("archive,");
    expect(source).not.toContain("const archive = await openOskArchive(file);");
  });

  it("filters the in-editor skin catalog by keymode", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    expect(source).toContain("const CATALOG_KEYMODE_FILTERS = [0, 4, 5, 6, 7, 8, 9, 10];");
    expect(source).toContain("fetchSkinsListDirect({ q: query.trim(), page: 0, k: keymode })");
    expect(source).toContain("}, [query, keymode]);");
  });

  it("drops the note shape and LN tail controls from settings under a custom skin", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/settings/SettingsPanel.tsx"), "utf8");

    // Skin art only draws under the Bars style and carries its own LN caps, so
    // both controls act on shapes the stage no longer draws. The editor's Style
    // tab already hides them; the quick panel was the inconsistent one.
    expect(source).toContain("setHasCustomSkinArt(readAppliedCommunityReplaySkin() != null || replaySkinSettingsEmbedAssets(skinSettings));");
    expect(source).toContain("{hasCustomSkinArt ? null : (");
    expect(source).toContain("<PanelGroup label={hasCustomSkinArt ? t`Direction` : t`Direction & long notes`}>");
  });

  it("drops the HUD tab once the skin draws both its judgements and its combo", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplaySkinSettingsModal.tsx"), "utf8");

    // Nothing left on the tab would change the stage.
    expect(source).toContain("const keymodeHasJudgementArt = Object.values(profile.assets.judgements).some(Boolean);");
    expect(source).toContain("const showHudTab = !keymodeHasComboArt || !keymodeHasJudgementArt;");
    expect(source).toContain("...(showHudTab ? ([[\"hud\", t`HUD`]] as const) : []),");
    // A stored "hud" tab must not strand the modal on a tab it no longer draws.
    expect(source).toContain('if (activeTab === "hud" && !showHudTab) setActiveTab("style");');
    // Judgement size still moves the stage, so it survives on Layout next to
    // the position it shares a section with in game.
    expect(source).toContain("{showHudTab ? null : (");
    expect(source).toContain("label={t`Judgement size`}");
  });

  it("paints the stage with the player's skin already on, and caches the decode", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const ownerSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-owner-skin.ts"), "utf8");
    const idbSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-idb.ts"), "utf8");
    const soundsSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-skin-sounds.ts"), "utf8");

    // The stage used to paint the viewer's own skin for the second or so the
    // .osk spent downloading and decoding, then swap.
    expect(routeSource).toContain("const OWNER_SKIN_HOLD_MAX_MS = 2000;");
    expect(routeSource).toContain("const [ownerSkinHold, setOwnerSkinHold] = useState(() => ownerUserId != null);");
    expect(routeSource).toContain("const skinStageHold = ownerSkinHold || (appliedSkinHold && !ownerSkinApplied);");
    expect(routeSource).toContain("${skinStageHold ? \"invisible\" : \"\"}");
    // Released once and never re-held: a skin arriving late must not blank a
    // stage that is already up.
    expect(routeSource).toContain("const releaseOwnerSkinHold = useCallback(() => setOwnerSkinHold(false), []);");
    expect(routeSource).toContain("if (ownerSkinReadyToRevealRef.current) releaseOwnerSkinHold();");
    // And the decoded result keeps, so later replays by that player skip the
    // download and the decode entirely.
    expect(routeSource).toContain("loadOwnerReplaySkinCached(record, undefined, replay.keyCount)");
    expect(ownerSource).toContain("export async function loadOwnerReplaySkinCached(");
    expect(ownerSource).toContain("readCachedReplaySkin(key)");
    expect(ownerSource).toContain("writeCachedReplaySkin(key,");
    // One database, one version, both stores in the same upgrade: opening it
    // at two versions from two modules fails the lower one outright.
    expect(idbSource).toContain("const DB_VERSION = 2;");
    expect(idbSource).toContain('export const REPLAY_OWNER_SKINS_STORE = "owner-skins";');
    expect(soundsSource).toContain('import { REPLAY_SKIN_SOUNDS_STORE, withReplayStore } from "./replay-idb";');
    expect(soundsSource).not.toContain("window.indexedDB.open");
  });

  it("restores the viewer's cached skin before revealing the replay stage", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    // The regular settings entry intentionally contains no imported images.
    // The decoded IndexedDB copy must win before the canvas can expose those
    // fallback bars, including when React runs the mount effect twice in dev.
    expect(routeSource).toContain("loadAppliedReplaySkinSettings()");
    expect(routeSource).not.toContain("loadAppliedCommunityReplaySkinSettings(applied)");
    expect(routeSource).toContain("const [appliedSkinHold, setAppliedSkinHold] = useState(hasInitialAppliedSkin);");
    expect(routeSource).toContain("if (hydratingAppliedRef.current?.key === key) return hydratingAppliedRef.current.promise;");
    expect(routeSource).toContain("if (rendererRef.current) releaseAppliedSkinHold();");
    expect(routeSource).toContain("if (appliedSkinHydratedRef.current) releaseAppliedSkinHold();");
    expect(routeSource).toContain("${skinStageHold ? \"invisible\" : \"\"}");
  });

  it("gives preview stages the viewer's applied skin, art included", () => {
    const hookSource = fs.readFileSync(path.resolve(__dirname, "../lib/use-replay-skin-settings.ts"), "utf8");
    const ownerSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-owner-skin.ts"), "utf8");

    // Reading localStorage alone gives previews the asset-free copy, so a
    // custom skin showed up as flat bars there while the replay page had art.
    expect(hookSource).toContain("export function useReplaySkinSettings()");
    expect(hookSource).toContain("loadAppliedReplaySkinSettings()");
    expect(hookSource).toContain("return applied ?? stored;");
    // Memoized per pointer so several stages on one page decode once.
    expect(ownerSource).toContain("export function loadAppliedReplaySkinSettings()");
    expect(ownerSource).toContain("if (appliedFullSettings?.key !== key) {");
  });

  it("draws the skin's own pause screen when it ships one", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const skinSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-skin.ts"), "utf8");
    const importSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-skin-import.ts"), "utf8");
    const ownerSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-owner-skin.ts"), "utf8");

    // Global filenames, no [Mania] key, like the scorebar art.
    expect(importSource).toContain('pauseContinue: await resolveStage(undefined, "pause-continue"),');
    expect(importSource).toContain('pauseOverlay: await resolveStage(undefined, "pause-overlay"),');
    expect(skinSource).toContain("pauseOverlay: normalizeImageAsset(raw.pauseOverlay),");
    // And they survive the dehydrate/rehydrate round trip like every other
    // stage asset, or a shared skin would lose its pause screen.
    expect(ownerSource).toContain('"pauseContinue",');
    // Half a set would draw a half-finished menu; the built-in one stands in.
    expect(routeSource).toContain("if (!stage.pauseContinue || !stage.pauseRetry || !stage.pauseBack) return null;");
    expect(routeSource).toContain("function skinPauseButtonHeightPercent(");
    expect(routeSource).toContain("style={{ height: `${skinPauseButtonHeightPercent(asset)}%` }}");
  });

  it("ships the .osk import feature to everyone", () => {
    // Released: no surface may re-add an admin gate around the import UI or
    // around applying the player's skin on the viewer side.
    const files = [
      "replay.tsx",
      "../components/replay/ReplaySkinSettingsModal.tsx",
      "../components/settings/SettingsPanel.tsx",
      "skins_.$id.tsx",
      "../lib/replay-owner-skin.ts",
      "../lib/use-replay-skin-settings.ts",
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(__dirname, file), "utf8");
      expect(source, file).not.toContain("canUseReplaySkinImport");
      expect(source, file).not.toContain("canUseSkinImport");
    }

    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    expect(routeSource).toContain("if (!ownerUserId || !ownerSkinPreferred) {");
  });

  it("exposes input overlay-only and color controls", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const controlsSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayControls.tsx"), "utf8");

    expect(routeSource).toContain("setInputOverlayOptions");
    expect(controlsSource).toContain("Color");
    expect(controlsSource).toContain("inputOverlayOnly");
  });

  it("only highlights the gear button while the skin modal is open", () => {
    const controlsSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayControls.tsx"), "utf8");

    expect(controlsSource).toMatch(/skinSettingsOpen\s*\?\s*"bg-osu-pink text-white"/);
    expect(controlsSource).not.toContain('skinSettingsOpen || skinSettings.style === "circles"');
  });

  it("does not resume an ended replay when the tab becomes visible again", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(source).toContain("if (audio.ended || !renderer?.isPlaying || renderer.time >= renderer.duration)");
    expect(source).toContain("const handleEnded = () =>");
    expect(source).toContain('audio.addEventListener("ended", handleEnded);');
    expect(source).toContain('audio.removeEventListener("ended", handleEnded);');
  });
});
