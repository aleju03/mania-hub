import { describe, expect, it } from "vitest";
import {
  FOUR_KEY_JACK_DEMAND_VERSION,
  classifyFourKeyJackDemand,
  type FourKeyJackDemandInput,
} from "../src/dan/jack-demand.js";

function input(overrides: Partial<FourKeyJackDemandInput> = {}): FourKeyJackDemandInput {
  return {
    keyCount: 4,
    metrics: {
      durationMs: 120_000,
      chordRatio: 0.3,
      chordColumnOverlapRatio: 0.2,
      twoBackColumnRehitExcess: 0.1,
      jackPressure: 80,
    },
    patterns: [],
    clusters: [],
    ...overrides,
  };
}

describe("classifyFourKeyJackDemand", () => {
  it("detects dense alternating chords from repeated-finger structure", () => {
    const verdict = classifyFourKeyJackDemand(input({
      metrics: {
        durationMs: 115_000,
        chordRatio: 0.78,
        chordColumnOverlapRatio: 0.68,
        twoBackColumnRehitExcess: 0.35,
        jackPressure: 96,
      },
      patterns: [{ id: "tech", score: 1 }, { id: "jumpstream", score: 1 }],
    }));
    expect(verdict).toEqual({
      version: FOUR_KEY_JACK_DEMAND_VERSION,
      detected: true,
      reasons: ["dense_alternating_chords"],
    });
  });

  it("requires every dense-chord leg instead of promoting ordinary jumpstream", () => {
    const base = input({
      metrics: {
        durationMs: 115_000,
        chordRatio: 0.78,
        chordColumnOverlapRatio: 0.68,
        twoBackColumnRehitExcess: 0.35,
        jackPressure: 96,
      },
    });
    expect(classifyFourKeyJackDemand({ ...base, metrics: { ...base.metrics, chordRatio: 0.69 } }).detected).toBe(false);
    expect(classifyFourKeyJackDemand({ ...base, metrics: { ...base.metrics, chordColumnOverlapRatio: 0.57 } }).detected).toBe(false);
    expect(classifyFourKeyJackDemand({ ...base, metrics: { ...base.metrics, twoBackColumnRehitExcess: 0.29 } }).detected).toBe(false);
  });

  it("detects a chart LeoBlack reads as mostly jack clusters", () => {
    const verdict = classifyFourKeyJackDemand(input({
      metrics: {
        durationMs: 89_000,
        chordRatio: 0.574,
        chordColumnOverlapRatio: 0.897,
        twoBackColumnRehitExcess: 0.039,
        jackPressure: 131,
      },
      patterns: [{ id: "tech", score: 0.88 }, { id: "chordjack", score: 0.70 }],
      clusters: [
        { label: "131BPM Chordjacks", pattern: "Jacks", bpm: 131, importance: 7_500_000 },
        { label: "~97BPM Mixed Minitrills", pattern: "Stream", bpm: 97, importance: 1_300_000 },
        { label: "~92BPM Mixed Jumpstream", pattern: "Chordstream", bpm: 92, importance: 500_000 },
      ],
    }));
    expect(verdict.reasons).toEqual(["jack_cluster_dominant"]);
  });

  it("takes a quarter-jack chart when the chordjack detector and jack pressure corroborate", () => {
    // The Wafles' SHD shape: LeoBlack reads a fifth of it as minijacks and
    // another tenth as chordjacks, under the dominance bar, while the in-house
    // chordjack tag sits at 0.58, under the 0.8 the older tag override needs.
    // Neither signal carries it alone; together they do.
    const base = input({
      metrics: {
        durationMs: 237_000,
        chordRatio: 0.489,
        chordColumnOverlapRatio: 0.662,
        twoBackColumnRehitExcess: 0.29,
        jackPressure: 180,
      },
      patterns: [{ id: "tech", score: 0.94 }, { id: "chordjack", score: 0.58 }, { id: "jack", score: 0.53 }],
      clusters: [
        { label: "180BPM Jumpstream", pattern: "Chordstream", bpm: 180, importance: 6_200_000 },
        { label: "180BPM Minijacks", pattern: "Jacks", bpm: 180, importance: 2_000_000 },
        { label: "90BPM Chordjacks", pattern: "Jacks", bpm: 90, importance: 600_000 },
        { label: "360BPM Jumptrill", pattern: "Chordstream", bpm: 360, importance: 700_000 },
      ],
    });
    expect(classifyFourKeyJackDemand(base).reasons).toEqual(["jack_cluster_corroborated"]);
    // Neither corroborating signal is optional.
    const noTag: FourKeyJackDemandInput = { ...base, patterns: [{ id: "tech", score: 0.94 }, { id: "chordjack", score: 0.49 }] };
    expect(classifyFourKeyJackDemand(noTag).detected).toBe(false);
    const noPressure = { ...base, metrics: { ...base.metrics, jackPressure: 149 } };
    expect(classifyFourKeyJackDemand(noPressure).detected).toBe(false);
  });

  it("does not take a jack-clustered chart whose jacks are too fast to tap", () => {
    const verdict = classifyFourKeyJackDemand(input({
      metrics: {
        durationMs: 89_000,
        chordRatio: 0.574,
        chordColumnOverlapRatio: 0.897,
        twoBackColumnRehitExcess: 0.039,
        jackPressure: 131,
      },
      patterns: [{ id: "tech", score: 0.88 }],
      clusters: [
        { label: "300BPM Chordjacks", pattern: "Jacks", bpm: 300, importance: 7_500_000 },
        { label: "~280BPM Mixed Minitrills", pattern: "Stream", bpm: 280, importance: 1_300_000 },
      ],
    }));
    expect(verdict.detected).toBe(false);
  });

  it("does not call a 180BPM minitrill jumpstream file jack", () => {
    // A rejected third arm read jackable-speed minitrill share to catch this
    // shape. It is left out on purpose: the charts the community splits into
    // jack and tech here are inside noise of each other on every feature
    // available, so the arm cannot be tuned, only replaced by a new signal.
    const verdict = classifyFourKeyJackDemand(input({
      metrics: {
        durationMs: 236_000,
        chordRatio: 0.31,
        chordColumnOverlapRatio: 0.28,
        twoBackColumnRehitExcess: 0.36,
        jackPressure: 90,
      },
      patterns: [{ id: "tech", score: 0.566 }, { id: "jumpstream", score: 0.208 }],
      clusters: [
        { label: "180BPM Jumpstream", pattern: "Chordstream", bpm: 180, importance: 7_000_000 },
        { label: "180BPM Minitrills", pattern: "Stream", bpm: 180, importance: 6_100_000 },
      ],
    }));
    expect(verdict.detected).toBe(false);
  });

  it("detects sustained high-pressure jack marathons", () => {
    const verdict = classifyFourKeyJackDemand(input({
      metrics: {
        durationMs: 499_000,
        chordRatio: 0.482,
        chordColumnOverlapRatio: 0.568,
        twoBackColumnRehitExcess: 0.22,
        jackPressure: 181,
      },
      patterns: [
        { id: "jack", score: 0.786 },
        { id: "tech", score: 0.766 },
        { id: "speedjack", score: 0.41 },
      ],
      clusters: [
        { label: "~157BPM Mixed Jumptrill", pattern: "Chordstream", bpm: 157, importance: 7_180_000 },
        { label: "190BPM Minitrills", pattern: "Stream", bpm: 190, importance: 3_630_000 },
        { label: "360BPM Rolls", pattern: "Stream", bpm: 360, importance: 1_500_000 },
      ],
    }));
    expect(verdict.detected).toBe(true);
    expect(verdict.reasons).toEqual(["jack_marathon"]);
  });

  it("leaves a marathon whose repeats are too fast to jack in its own tile", () => {
    // The speed-pack shape: every jack signal reads higher than the marathon
    // case above, but its clusters average 277BPM, where those repeats are
    // spread across fingers instead of re-tapped.
    const verdict = classifyFourKeyJackDemand(input({
      metrics: {
        durationMs: 274_000,
        chordRatio: 0.471,
        chordColumnOverlapRatio: 0.637,
        twoBackColumnRehitExcess: 0.295,
        jackPressure: 230,
      },
      patterns: [{ id: "jack", score: 1 }, { id: "tech", score: 0.91 }],
      clusters: [
        { label: "253BPM Jumpstream", pattern: "Chordstream", bpm: 253, importance: 11_800_000 },
        { label: "~403BPM Mixed Minitrills", pattern: "Stream", bpm: 403, importance: 6_990_000 },
        { label: "~157BPM Mixed Minijacks", pattern: "Jacks", bpm: 157, importance: 4_330_000 },
      ],
    }));
    expect(verdict.detected).toBe(false);
  });

  it("never applies the 4K verdict to another keymode", () => {
    const verdict = classifyFourKeyJackDemand(input({
      keyCount: 7,
      metrics: {
        durationMs: 500_000,
        chordRatio: 1,
        chordColumnOverlapRatio: 1,
        twoBackColumnRehitExcess: 1,
        jackPressure: 230,
      },
      patterns: [{ id: "jack", score: 1 }],
      clusters: [{ label: "200BPM Minitrills", pattern: "Jacks", bpm: 200, importance: 1 }],
    }));
    expect(verdict).toEqual({ version: FOUR_KEY_JACK_DEMAND_VERSION, detected: false, reasons: [] });
  });
});
