import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { classifyChart, danTableCeilingFor, sunnyLowEndReroute } from "../src/dan/chart-classifier.js";
import { parseLeoBlackLnHalf, runLeoBlackMixed } from "../src/dan/leoblack-estimator.js";
import { LN_LADDER_TOP, parseLnDan } from "../src/dan/dan-estimator/ln.js";

// The low-end verdict guard (chart-classifier.ts): the estimators' calibration
// corpus bottoms out at the dan courses, so trivial charts with enough taps to
// clear the note gates came back multi-dan (sub-1* ranked Easies were landing
// in the dan map collections). Originally the leak came through Roxy ("Reform
// 4" with the raw signal pinned at the -2.5 clamp); since the 214aedd re-pin
// Roxy is high-difficulty-only and the same population routes through Azusa,
// which repeats the miss ("Reform 3 low" on the trivial shape below). Both
// candidate signatures re-route to the Sunny baseline - but only when an
// independent Sunny run agrees the chart is sub-Reform-1, because the
// structural signals also collapse on some genuinely hard charts.

const REROUTE_WARNING = /using the Sunny low-end verdict/;

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

describe("low-end verdict guard", () => {
  it("documents the low-end Azusa verdict it guards against", () => {
    // The unguarded mixed estimator routes this 2 nps chart to Azusa (Roxy is
    // high-difficulty-only since 214aedd) and calls it Reform 2+, while
    // Azusa's own Sunny reference reads sub-Reform-1. If a vendor update
    // changes this shape (hint string, debug.sunnyNumeric, routing), revisit
    // isAzusaLowEndSuspect / isRoxyFloorPinned.
    const mixed = runLeoBlackMixed(TRIVIAL_CHART);
    expect(mixed.numericDifficultyHint).toBe("azusa-rc-v1");
    expect(Number(mixed.numericDifficulty)).toBeGreaterThanOrEqual(2);
    expect(mixed.estDiff).toMatch(/^Reform /);
    // estimateSunnyNumeric's 2.85 + 1.33 * star scale: 6.84 is the 3.0-star
    // sub-Reform-1 agreement gate (this chart reads ~3.17, i.e. ~0.24 star).
    const sunnyReference = Number((mixed.debug as { sunnyNumeric?: unknown })?.sunnyNumeric);
    expect(sunnyReference).toBeLessThan(6.84);
  });

  it("re-routes trivial charts to the Sunny low-end verdict", () => {
    const classification = classifyChart(parseManiaBeatmap(TRIVIAL_CHART), TRIVIAL_CHART);
    expect(classification.warnings.some((warning) => REROUTE_WARNING.test(warning))).toBe(true);
    expect(classification.verdictText).toBe("< Intro 1 low");
    expect(classification.rc?.rawDan).toBeLessThan(0);
    expect(classification.sunnySr).not.toBeNull();
    expect(classification.sunnySr as number).toBeLessThan(1);
  });

  it("leaves on-scale charts on the mixed verdict", () => {
    const classification = classifyChart(parseManiaBeatmap(MID_CHART), MID_CHART);
    expect(classification.warnings.some((warning) => REROUTE_WARNING.test(warning))).toBe(false);
    expect(classification.verdictText).toMatch(/^Reform /);
    expect(classification.rc?.rawDan ?? 0).toBeGreaterThan(0);
  });

  it("keeps the existing Sunny fallback for charts under Roxy's note gate", () => {
    const classification = classifyChart(parseManiaBeatmap(TINY_CHART), TINY_CHART);
    expect(classification.warnings.some((warning) => REROUTE_WARNING.test(warning))).toBe(false);
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

// 4K LN verdicts come from LeoBlack's LN interval table, which covers LN 5
// through 17 (the ladder's last course); the in-house kNN is the fallback for
// what sits below that table's floor.
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

  // Slow, sparse chorded holds: unambiguous LN signal, but far too little
  // density to reach the LN table's 4.832-star floor.
  function buildEasyLnOsu(): string {
    const hitObjects: string[] = [];
    for (let row = 0; row < 120; row++) {
      const start = 1000 + row * 700;
      const end = start + 600;
      const first = (row * 3) % 4;
      const second = (first + 2) % 4;
      hitObjects.push(`${columnX(first)},192,${start},128,0,${end}:0:0:0:0:`);
      hitObjects.push(`${columnX(second)},192,${start},128,0,${end}:0:0:0:0:`);
    }
    return [
      "osu file format v14",
      "",
      "[General]",
      "Mode: 3",
      "",
      "[Metadata]",
      "Title:Synthetic Easy LN Chart",
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

  it("sources the LN half from LeoBlack's table for regular LN charts", () => {
    const text = buildLnOsu("Synthetic LN Chart");
    const classification = classifyChart(parseManiaBeatmap(text), text);
    expect(classification.ln).not.toBeNull();
    expect(classification.ln?.source).toBe("leoblack-sunny-table");
  });

  it("sources the LN half from LeoBlack's table for dan courses", () => {
    const text = buildLnOsu("Synthetic LN Dan Course");
    const classification = classifyChart(parseManiaBeatmap(text), text);
    expect(classification.ln).not.toBeNull();
    expect(classification.ln?.source).toBe("leoblack-sunny-table");
  });

  // 16 (Yokaze) and 17 (Yeehee) are real extra-level courses, which is why
  // leoblack's table names them after the packs that ship them. They label as
  // themselves rather than folding into 15.
  it.each([
    ["Hypersovae LN 16 mid/low", "16", "-"],
    ["Hypersovae LN 16 high", "16", "++"],
    ["Lnlism LN 17 mid", "17", null],
  ])("reads %s as its own level", (text, label, variant) => {
    const parsed = parseLeoBlackLnHalf(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.label).toBe(label);
    expect(parsed?.variant).toBe(variant);
    expect(parsed?.boundary).toBeNull();
  });

  // Past 17 the ladder stops measuring, so the verdict lands on the same
  // "> last tier" sentinel the other keymodes use.
  it("puts a chart past the last course on the above-17 sentinel", () => {
    const parsed = parseLeoBlackLnHalf("> Lnlism LN 17 high");
    expect(parsed?.label).toBe(String(LN_LADDER_TOP));
    expect(parsed?.rawDan).toBe(LN_LADDER_TOP + 0.5);
    expect(parsed?.boundary).toBe("above");
  });

  // What turns that sentinel into the player-side "> 17" chip: 4K LN now has a
  // ceiling like 6K/7K do, while 4K RC keeps running into the greek levels.
  it("gives 4K LN a ladder ceiling and 4K RC none", () => {
    expect(danTableCeilingFor("ln", 4)).toBe(LN_LADDER_TOP + 0.5);
    expect(danTableCeilingFor("rc", 4)).toBeNull();
  });

  // The player-side label goes through parseLnDan, which must reach 17 too or
  // a 16th/17th dan clear would show up as a 15 on the skill card.
  it("labels player-side LN dans up to the ladder top", () => {
    expect(parseLnDan(16).label).toBe("16");
    expect(parseLnDan(17).label).toBe("17");
    expect(parseLnDan(LN_LADDER_TOP + 0.5).label).toBe(String(LN_LADDER_TOP));
  });

  it("falls back to the in-house kNN below the LN table's floor", () => {
    const text = buildEasyLnOsu();
    const classification = classifyChart(parseManiaBeatmap(text), text);
    expect(classification.ln).not.toBeNull();
    // The table would read "< LN 5" here; the kNN carries references this low.
    expect(classification.ln?.source).toBe("inhouse-ln-knn");
    expect(Number(classification.ln?.label)).toBeLessThan(5);
  });
});
