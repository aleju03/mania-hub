import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay miss markers", () => {
  it("marks replay misses on the seek bar", () => {
    const rendererSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayCanvas.ts"), "utf8");
    const controlsSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayControls.tsx"), "utf8");
    const typesSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-types.ts"), "utf8");

    expect(typesSource).toContain("getMissTimes?: () => number[]");
    expect(rendererSource).toContain("getMissTimes(): number[]");
    expect(rendererSource).toContain("event.judgment === 6");
    expect(controlsSource).toContain("<ReplayMissMarkers missTimes={missTimes} duration={duration} heatmap={heatmap} />");
    expect(controlsSource).toContain("getHeatmapLineTopPercent");
    expect(controlsSource).toContain("top: `${top}%`");
    expect(controlsSource).toContain("group-hover:opacity-90");
    expect(controlsSource).toContain("bottom-full z-20 h-7");
    expect(controlsSource).toContain("bg-osu-red-light");
    expect(controlsSource).not.toContain("drop-shadow-[0_0_4px_rgba(255,68,68,0.8)]");
  });
});
