import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay skin settings UI", () => {
  it("loads persisted settings, exposes a gear button, and renders the skin modal controls", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(source).toContain("readReplaySkinSettings");
    expect(source).toContain("writeReplaySkinSettings");
    expect(source).toContain("rendererRef.current?.setSkinSettings");
    expect(source).toContain('aria-label="Replay skin settings"');
    expect(source).toContain("Replay skin");
    expect(source).toContain("Tap notes");
    expect(source).toContain("LN head");
    expect(source).toContain("LN body");
    expect(source).toContain("Percy");
  });

  it("only highlights the gear button while the skin modal is open", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(source).toMatch(/skinSettingsOpen\s*\?\s*"bg-osu-pink text-white"/);
    expect(source).not.toContain('skinSettingsOpen || skinSettings.style === "circles"');
  });

  it("does not resume an ended replay when the tab becomes visible again", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(source).toContain("if (audio.ended || !renderer?.isPlaying || renderer.time >= renderer.duration)");
    expect(source).toContain("const handleEnded = () =>");
    expect(source).toContain('audio.addEventListener("ended", handleEnded);');
    expect(source).toContain('audio.removeEventListener("ended", handleEnded);');
  });
});
