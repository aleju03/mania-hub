import { describe, expect, it } from "vitest";
import {
  aggregateShape,
  computeShapeWeights,
  parseUserShape,
  shapeSimilarity,
  type ChartShape,
  type UserShape,
} from "../src/features/farm-helper-shape.js";

function patChart(pat: number[]): ChartShape {
  return { pat, msd: null };
}

// A pattern vector heavy on the last axis (ln) vs one heavy on the first (jack).
const LN_VEC = [0, 0, 0, 0, 0, 0, 0, 1];
const JACK_VEC = [1, 0, 0, 0, 0, 0, 0, 0];

describe("aggregateShape", () => {
  it("returns null until at least SHAPE_MIN_CHARTS charts carry a pattern vector", () => {
    const few = Array.from({ length: 9 }, () => ({ shape: patChart(LN_VEC), weight: 1 }));
    expect(aggregateShape(few)).toBeNull();
    const enough = Array.from({ length: 10 }, () => ({ shape: patChart(LN_VEC), weight: 1 }));
    const shape = aggregateShape(enough);
    expect(shape?.pat).toEqual(LN_VEC);
    expect(shape?.n).toBe(10);
  });

  it("weight-averages pattern vectors", () => {
    const entries = [
      ...Array.from({ length: 8 }, () => ({ shape: patChart(LN_VEC), weight: 3 })),
      ...Array.from({ length: 2 }, () => ({ shape: patChart(JACK_VEC), weight: 3 })),
    ];
    const shape = aggregateShape(entries);
    // 8 LN + 2 jack at equal weight -> ln axis 0.8, jack axis 0.2.
    expect(shape?.pat?.[7]).toBeCloseTo(0.8, 6);
    expect(shape?.pat?.[0]).toBeCloseTo(0.2, 6);
  });

  it("keeps pat and msd coverage independent", () => {
    const entries = Array.from({ length: 10 }, () => ({ shape: { pat: LN_VEC, msd: null } as ChartShape, weight: 1 }));
    const shape = aggregateShape(entries);
    expect(shape?.pat).not.toBeNull();
    expect(shape?.msd).toBeNull();
  });
});

describe("shapeSimilarity", () => {
  const ln: UserShape = { pat: LN_VEC, msd: null, n: 10 };
  const jack: UserShape = { pat: JACK_VEC, msd: null, n: 10 };

  it("is 1 for identical shapes and 0 for orthogonal ones", () => {
    expect(shapeSimilarity(ln, ln)).toBeCloseTo(1, 6);
    expect(shapeSimilarity(ln, jack)).toBeCloseTo(0, 6);
  });

  it("returns null when a side has a zero (directionless) vector", () => {
    const zero: UserShape = { pat: [0, 0, 0, 0, 0, 0, 0, 0], msd: null, n: 10 };
    expect(shapeSimilarity(ln, zero)).toBeNull();
  });

  it("averages pat and msd cosines when both are present, else uses whichever exists", () => {
    const a: UserShape = { pat: LN_VEC, msd: [1, 0, 0, 0, 0, 0, 0], n: 10 };
    const b: UserShape = { pat: JACK_VEC, msd: [1, 0, 0, 0, 0, 0, 0], n: 10 };
    // cosPat = 0, cosMsd = 1 -> average 0.5.
    expect(shapeSimilarity(a, b)).toBeCloseTo(0.5, 6);
    // Only pat comparable -> cosPat only.
    expect(shapeSimilarity(ln, { pat: JACK_VEC, msd: null, n: 10 })).toBeCloseTo(0, 6);
    // Neither comparable -> null.
    expect(shapeSimilarity({ pat: null, msd: null, n: 0 }, ln)).toBeNull();
  });
});

describe("computeShapeWeights", () => {
  const subject: UserShape = { pat: LN_VEC, msd: null, n: 10 };
  const lnPeer: UserShape = { pat: LN_VEC, msd: null, n: 10 };
  const jackPeer: UserShape = { pat: JACK_VEC, msd: null, n: 10 };

  it("maps similarity into [floor, floor+span] and up-weights like-shaped peers", () => {
    const shapes = new Map<number, UserShape>([[1, lnPeer], [2, jackPeer]]);
    const weights = computeShapeWeights(subject, shapes, [1, 2]);
    expect(weights.get(1)).toBeCloseTo(1.0, 6); // sim 1 -> 0.3 + 0.7
    expect(weights.get(2)).toBeCloseTo(0.3, 6); // sim 0 -> floor
  });

  it("gives shapeless peers the cohort-average (bias-aware neutral), not the floor", () => {
    const shapes = new Map<number, UserShape>([[1, lnPeer], [2, jackPeer]]);
    const weights = computeShapeWeights(subject, shapes, [1, 2, 3]);
    const neutral = (weights.get(1)! + weights.get(2)!) / 2;
    expect(weights.get(3)).toBeCloseTo(neutral, 6);
  });
});

describe("parseUserShape", () => {
  it("round-trips a stored profile and rejects malformed vectors", () => {
    const stored = JSON.stringify({ pat: LN_VEC, msd: null, n: 12 });
    expect(parseUserShape(stored)).toEqual({ pat: LN_VEC, msd: null, n: 12 });
    expect(parseUserShape(null)).toBeNull();
    expect(parseUserShape(JSON.stringify({ pat: [1, 2, 3], msd: null, n: 5 }))).toBeNull();
    expect(parseUserShape(JSON.stringify({ pat: null, msd: null, n: 0 }))).toBeNull();
  });
});
