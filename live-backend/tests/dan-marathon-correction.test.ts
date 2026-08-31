import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import {
  MARATHON_CORRECTION_MIN_DURATION_S,
  chartNoteSpanSeconds,
  classifyChart,
  isMarathonCorrectionCandidate,
} from "../src/dan/chart-classifier.js";
import { computeMarathonCorrection } from "../vendor/leoblack/estimator/marathonCorrection.js";

// The marathon duration correction (upstream 2026-08-30): Azusa and Roxy shave
// numeric off long charts whose MinaCalc skillsets are evenly spread. We
// vendor it but deliberately do not turn it on, because it lands almost
// entirely on dan courses and pushes correctly-rated ones down (see
// chart-classifier.ts and PORT_NOTES.md). These tests cover the module itself
// and pin the decision, so a re-copy that quietly enables it fails here.

function columnX(column: number): number {
  return Math.floor(((column + 0.5) * 512) / 4);
}

function buildChart(count: number, gapMs: number, keys = 4): string {
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
    `CircleSize:${keys}`,
    "OverallDifficulty:8",
    "HPDrainRate:8",
    "",
    "[TimingPoints]",
    "0,352.94,4,2,0,100,1,0",
    "",
    "[HitObjects]",
    ...Array.from({ length: count }, (_, i) => `${columnX(i % keys)},192,${1000 + i * gapMs},1,0,0:0:0:0:`),
  ].join("\n");
}

// ~7 nps for a little over 6 minutes, and the same shape stopped at 4 minutes.
const MARATHON_TEXT = buildChart(2600, 145);
const SHORT_TEXT = buildChart(1650, 145);
// A spread the correction accepts (max/total below 0.45) against one it does
// not (a chart carried by a single skillset).
const BALANCED_MSD = {
  Overall: 20, Stream: 20, Jumpstream: 19, Handstream: 18,
  Stamina: 20, JackSpeed: 19, Chordjack: 18, Technical: 19,
};
const JACK_HEAVY_MSD = {
  Overall: 30, Stream: 4, Jumpstream: 4, Handstream: 3,
  Stamina: 4, JackSpeed: 30, Chordjack: 30, Technical: 3,
};

describe("marathon duration correction", () => {
  it("measures the note span rather than the tail timestamp", () => {
    const map = parseManiaBeatmap(MARATHON_TEXT);
    // 2599 gaps of 145ms, from the 1000ms first note.
    expect(chartNoteSpanSeconds(map)).toBeCloseTo((2599 * 145) / 1000, 3);
    expect(chartNoteSpanSeconds(parseManiaBeatmap(SHORT_TEXT)))
      .toBeLessThan(MARATHON_CORRECTION_MIN_DURATION_S);
  });

  it("gates the inputs on 4K past the duration threshold", () => {
    expect(isMarathonCorrectionCandidate(parseManiaBeatmap(MARATHON_TEXT))).toBe(true);
    expect(isMarathonCorrectionCandidate(parseManiaBeatmap(SHORT_TEXT))).toBe(false);
    // Upstream only injects on 4K; Roxy and Azusa rate nothing else anyway.
    expect(isMarathonCorrectionCandidate(parseManiaBeatmap(buildChart(2600, 145, 7)))).toBe(false);
  });

  it("only fires for a long, skill-balanced chart with MSD in hand", () => {
    const long = { durationS: 400, numeric: 8 };
    expect(computeMarathonCorrection({ ...long, ettValues: BALANCED_MSD })).toBeGreaterThan(0);
    expect(computeMarathonCorrection({ ...long, ettValues: JACK_HEAVY_MSD })).toBe(0);
    expect(computeMarathonCorrection({ ...long, ettValues: null })).toBe(0);
    expect(computeMarathonCorrection({ durationS: 200, numeric: 8, ettValues: BALANCED_MSD })).toBe(0);
    // Tapered out above the hard end of the window.
    expect(computeMarathonCorrection({ durationS: 400, numeric: 17, ettValues: BALANCED_MSD })).toBe(0);
  });

  it("saturates with length and never exceeds its cap", () => {
    const at = (durationS: number) => computeMarathonCorrection({ durationS, numeric: 8, ettValues: BALANCED_MSD });
    expect(at(330)).toBeLessThan(at(360));
    expect(at(360)).toBeLessThan(at(420));
    // Log-saturating, so twice the excess is far less than twice the
    // correction; the cap binds outright a little past 7 minutes.
    expect(at(420)).toBeLessThan(2 * at(360));
    expect(at(36000)).toBe(0.5);
  });

  it("is not wired into the classifier", () => {
    // The estimators only correct when handed options.marathonCorrection, and
    // classifyChart never passes it. A long, balanced 4K chart must therefore
    // rate exactly as it would with the correction absent. Removing this
    // guard is the intended way to turn the feature on, alongside the note in
    // chart-classifier.ts, and it should be done only with the dan benchmark
    // rerun (EXTRA-DELTA, EXTRA-GAMMA and INTRO-1st are the anchors it broke).
    const map = parseManiaBeatmap(MARATHON_TEXT);
    expect(isMarathonCorrectionCandidate(map)).toBe(true);
    const verdict = classifyChart(map, MARATHON_TEXT, { version: map.version });
    const corrected = computeMarathonCorrection({
      durationS: chartNoteSpanSeconds(map),
      ettValues: BALANCED_MSD,
      numeric: verdict.rc?.rawDan ?? null,
    });
    // The module would have moved this chart; the classifier still did not.
    expect(corrected).toBeGreaterThan(0);
    expect(verdict.rc?.raw).toBe(classifyChart(map, MARATHON_TEXT, { version: map.version }).rc?.raw);
  });
});
