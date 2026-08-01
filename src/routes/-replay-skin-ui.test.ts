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
    expect(controlsSource).toContain('aria-label="Replay settings"');
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
    expect(source).toContain("Community skin");
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

  it("keeps the .osk import feature admin/dev gated on every surface", () => {
    // Unfinished parser (key-area sizing, oversized LN bodies, lazer HUD
    // scale): the public must not see the import UI, and viewers must not get
    // another player's skin applied, until it ships properly.
    const files = [
      "replay.tsx",
      "../components/replay/ReplaySkinSettingsModal.tsx",
      "../components/settings/SettingsPanel.tsx",
      "skins_.$id.tsx",
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(__dirname, file), "utf8");
      expect(source, file).toContain("canUseReplaySkinImport");
    }

    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    expect(routeSource).toContain("if (!canUseSkinImport || !ownerUserId || !readReplayOwnerSkinEnabled()) return;");
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
