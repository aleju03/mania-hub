import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "./beatmap-parser";
import { classifyChart, sunnyLowEndReroute } from "./chart-classifier";
import { runLeoBlackMixed } from "./leoblack-estimator";

// The Roxy floor-pin guard (chart-classifier.ts): Roxy's calibration corpus
// bottoms out at the dan courses, so trivial charts with enough taps to clear
// its note gate came back "Reform 4" (sub-1* ranked Easies were landing in the
// 4-6 dan map collections). Charts whose raw signal is pinned at the -2.5
// clamp re-route to the Sunny baseline - but only when Sunny independently
// agrees the chart is sub-Reform-1, because Roxy's structural curve also
// collapses on some genuinely hard charts that the meta model rescues.

const PINNED_WARNING = /pinned at its scale floor/;

function columnX(column: number): number {
  return Math.floor(((column + 0.5) * 512) / 4);
}

function buildOsu(hitObjects: string[]): string {
  return [
    "osu file format v14",
    "",
    "[General]",
    "Mode: 3",
    "",
    "[Metadata]",
    "Title:Synthetic",
    "Artist:Test",
    "Creator:Test",
    "Version:Test",
    "",
    "[Difficulty]",
    "CircleSize:4",
    "OverallDifficulty:8",
    "HPDrainRate:8",
    "",
    "[TimingPoints]",
    "0,352.94,4,2,0,100,1,0",
    "",
    "[HitObjects]",
    ...hitObjects,
  ].join("\n");
}

function buildTaps(count: number, gapMs: number, columns = 2): string {
  return buildOsu(
    Array.from({ length: count }, (_, i) => `${columnX(i % columns)},192,${1000 + i * gapMs},1,0,0:0:0:0:`),
  );
}

// ~2 nps alternating singles for 65s: the shape of a ranked Easy diff. Enough
// taps to clear Roxy's 80-note gate, far too sparse for any dan.
const TRIVIAL_CHART = buildTaps(130, 500);
// Sustained ~8.7 nps rolls: comfortably on Roxy's calibrated scale.
const MID_CHART = buildTaps(780, 115, 4);
// Under Roxy's note gate: the mixed router falls back to Sunny on its own.
const TINY_CHART = buildTaps(40, 500);
// ~13 nps rolls for 2.5min: Sunny rates this Reform 2 (star ~3.6), above the
// sub-Reform-1 agreement gate.
const DENSE_CHART = buildTaps(2000, 75, 4);

describe("roxy floor-pin guard", () => {
  it("documents the pinned Roxy verdict it guards against", () => {
    // The unguarded mixed estimator calls this 2 nps chart Reform 4 while its
    // own raw signal sits at the clamp. If a vendor update changes this shape
    // (hint string, clamp value), revisit isRoxyFloorPinned.
    const mixed = runLeoBlackMixed(TRIVIAL_CHART);
    expect(mixed.numericDifficultyHint).toBe("roxy-meta-ridge-v3");
    expect(Number(mixed.rawNumericDifficulty)).toBeLessThanOrEqual(-2.45);
    expect(mixed.estDiff).toMatch(/^Reform 4/);
  });

  it("re-routes pinned charts to the Sunny low-end verdict", () => {
    const classification = classifyChart(parseManiaBeatmap(TRIVIAL_CHART), TRIVIAL_CHART);
    expect(classification.warnings.some((warning) => PINNED_WARNING.test(warning))).toBe(true);
    expect(classification.verdictText).toBe("< Intro 1 low");
    expect(classification.rc?.rawDan).toBeLessThan(0);
    expect(classification.sunnySr).not.toBeNull();
    expect(classification.sunnySr as number).toBeLessThan(1);
  });

  it("leaves on-scale charts on the Roxy verdict", () => {
    const classification = classifyChart(parseManiaBeatmap(MID_CHART), MID_CHART);
    expect(classification.warnings.some((warning) => PINNED_WARNING.test(warning))).toBe(false);
    expect(classification.verdictText).toMatch(/^Reform /);
    expect(classification.rc?.rawDan ?? 0).toBeGreaterThan(0);
  });

  it("keeps the existing Sunny fallback for charts under Roxy's note gate", () => {
    const classification = classifyChart(parseManiaBeatmap(TINY_CHART), TINY_CHART);
    expect(classification.warnings.some((warning) => PINNED_WARNING.test(warning))).toBe(false);
    expect(classification.verdictText).toBe("< Intro 1 low");
    expect(classification.rc?.rawDan).toBeLessThan(0);
  });

  it("does not re-route pinned charts that Sunny rates on-scale", () => {
    // Roxy's structural curve also collapses on some genuinely hard charts
    // (raw pinned while the meta verdict is right); the guard must keep the
    // meta verdict when Sunny disagrees that the chart is trivial. Fabricate
    // the pinned half - organically collapsed hard charts need prod files.
    const pinnedMixed = {
      ...runLeoBlackMixed(DENSE_CHART),
      numericDifficultyHint: "roxy-meta-ridge-v3",
      rawNumericDifficulty: -2.5,
    };
    expect(sunnyLowEndReroute(pinnedMixed, DENSE_CHART, 1)).toBeNull();
    // Same pinned half over a trivial chart re-routes.
    expect(sunnyLowEndReroute(pinnedMixed, TRIVIAL_CHART, 1)).not.toBeNull();
  });
});

// 4K LN verdicts come from the in-house kNN (LeoBlack's LN table is only the
// fallback); its reference set includes the curated benchmark corpus so both
// pack singles and segmented courses resolve through it.
describe("4K LN verdict routing", () => {
  function buildLnOsu(title: string): string {
    // Four ~50s segments of dense chorded holds separated by 3s gaps: enough
    // duration, segment count, and notes per segment to read as a dan course
    // when the title says so, and unambiguous LN signal either way.
    const hitObjects: string[] = [];
    let time = 1000;
    for (let segment = 0; segment < 4; segment++) {
      const rows = Math.floor(50_000 / 150);
      for (let row = 0; row < rows; row++) {
        const start = time + row * 150;
        const end = start + 320;
        const first = (row * 7) % 4;
        const second = (first + 1 + (row % 3)) % 4;
        hitObjects.push(`${columnX(first)},192,${start},128,0,${end}:0:0:0:0:`);
        hitObjects.push(`${columnX(second)},192,${start},128,0,${end}:0:0:0:0:`);
      }
      time += 50_000 + 3_000;
    }
    return [
      "osu file format v14",
      "",
      "[General]",
      "Mode: 3",
      "",
      "[Metadata]",
      `Title:${title}`,
      "Artist:Test",
      "Creator:Test",
      "Version:Test",
      "",
      "[Difficulty]",
      "CircleSize:4",
      "OverallDifficulty:8",
      "HPDrainRate:8",
      "",
      "[TimingPoints]",
      "0,352.94,4,2,0,100,1,0",
      "",
      "[HitObjects]",
      ...hitObjects,
    ].join("\n");
  }

  it("sources the LN half from the in-house kNN for regular LN charts", () => {
    const text = buildLnOsu("Synthetic LN Chart");
    const classification = classifyChart(parseManiaBeatmap(text), text);
    expect(classification.ln).not.toBeNull();
    expect(classification.ln?.source).toBe("inhouse-ln-knn");
  });

  it("sources the LN half from the in-house kNN for dan courses", () => {
    const text = buildLnOsu("Synthetic LN Dan Course");
    const classification = classifyChart(parseManiaBeatmap(text), text);
    expect(classification.ln).not.toBeNull();
    expect(classification.ln?.source).toBe("inhouse-ln-knn");
  });
});
