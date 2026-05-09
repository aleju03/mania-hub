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
    expect(source).toContain("showDevOskImport = import.meta.env.DEV");
    expect(source).toContain("Import .osk");
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

  it("exposes input overlay-only and color controls", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const controlsSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayControls.tsx"), "utf8");

    expect(routeSource).toContain("setInputOverlayOptions");
    expect(controlsSource).toContain("Input overlay color");
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
