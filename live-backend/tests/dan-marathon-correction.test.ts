import { afterEach, describe, expect, it, vi } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import {
  MARATHON_CORRECTION_MIN_DURATION_S,
  chartNoteSpanSeconds,
  classifyChart,
  isMarathonCorrectionCandidate,
} from "../src/dan/chart-classifier.js";
import { computeMarathonCorrection } from "../vendor/leoblack/estimator/marathonCorrection.js";

import * as leo from "../src/dan/leoblack-estimator.js";
import * as msd from "../src/dan/msd.js";
import { classifyChartWithCompanella } from "../src/dan/companella.js";

afterEach(() => vi.restoreAllMocks());

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

  it("injects the correction before Mixed routing, without changing short charts", () => {
    const map = parseManiaBeatmap(MARATHON_TEXT);
    const mixed = vi.spyOn(leo, "runLeoBlackMixed");
    const before = classifyChart(map, MARATHON_TEXT);
    const after = classifyChart(map, MARATHON_TEXT, { marathonMsdValues: BALANCED_MSD });
    expect(mixed).toHaveBeenLastCalledWith(MARATHON_TEXT, {
      speedRate: 1,
      marathonCorrection: { durationS: chartNoteSpanSeconds(map), ettValues: BALANCED_MSD },
    });
    expect(after.rc?.rawDan).not.toBe(before.rc?.rawDan);
    const short = parseManiaBeatmap(SHORT_TEXT);
    expect(classifyChart(short, SHORT_TEXT, { marathonMsdValues: BALANCED_MSD }).primary)
      .toEqual(classifyChart(short, SHORT_TEXT).primary);
    expect(classifyChart(map, MARATHON_TEXT, { marathonMsdValues: JACK_HEAVY_MSD }).primary)
      .toEqual(before.primary);
  });

  it("keeps the duration gate strict and independent of playback rate", async () => {
    const exact = parseManiaBeatmap(buildChart(3001, 100));
    expect(chartNoteSpanSeconds(exact)).toBe(300);
    expect(isMarathonCorrectionCandidate(exact)).toBe(false);
    const map = parseManiaBeatmap(MARATHON_TEXT);
    const mixed = vi.spyOn(leo, "runLeoBlackMixed");
    const compute = vi.spyOn(msd, "computeMsd").mockResolvedValue({ etternaVersion: "test", values: BALANCED_MSD });
    await classifyChartWithCompanella(map, MARATHON_TEXT, { rate: 2 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledWith(MARATHON_TEXT, { rate: 2, keyCount: 4 });
    expect(mixed.mock.calls.every(([, options]) => options?.marathonCorrection?.durationS === chartNoteSpanSeconds(map)))
      .toBe(true);
  });

  it("reuses supplied MSD and applies Companella after the corrected star is available", async () => {
    const map = parseManiaBeatmap(MARATHON_TEXT);
    const compute = vi.spyOn(msd, "computeMsd");
    const result = await classifyChartWithCompanella(map, MARATHON_TEXT, {}, { msdValues: BALANCED_MSD });
    expect(compute).not.toHaveBeenCalled();
    expect(result.companellaPending).toBe(false);
    expect(result.primary).not.toBeNull();
  });

  it("does not retry a missing marathon MSD result for Companella", async () => {
    const map = parseManiaBeatmap(MARATHON_TEXT);
    const compute = vi.spyOn(msd, "computeMsd").mockResolvedValue(null);
    const result = await classifyChartWithCompanella(map, MARATHON_TEXT);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.primary).toEqual(classifyChart(map, MARATHON_TEXT).primary);
  });
});
