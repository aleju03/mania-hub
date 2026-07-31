import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import {
  ACC_MODEL_VERSION,
  buildAccSamples,
  evaluateAccHoldout,
  fitAccModelFromSamples,
  predictPlayerAccuracy,
  predictPlayerChoke,
  readPlayerAccModel,
  resolvePlayCustomAccuracy,
  type AccChartDifficulty,
  type AccModelPlay,
  type AccSample,
} from "../src/features/player-acc-model.js";

// Deterministic noise so the fit tests never flake.
function noise(seed: number, scale: number): number {
  return Math.sin(seed * 12.9898 + 78.233) * scale;
}

function syntheticSamples(options: {
  keyCount?: number;
  count?: number;
  a?: number;
  bn?: number;
  bp?: number;
  noiseScale?: number;
  family?: string | null;
  gapMin?: number;
  gapMax?: number;
  missShare?: (gap: number) => number | null;
}): AccSample[] {
  const {
    keyCount = 4,
    count = 400,
    a = -3.0,
    bn = 0.1,
    bp = 0.2,
    noiseScale = 0.1,
    family = "stamina",
    gapMin = -8,
    gapMax = 4,
    missShare = () => null,
  } = options;
  const rating = 25;
  const samples: AccSample[] = [];
  for (let i = 0; i < count; i++) {
    const gap = gapMin + ((gapMax - gapMin) * i) / Math.max(1, count - 1);
    const mu = a + bn * Math.min(gap, 0) + bp * Math.max(gap, 0) + noise(i, noiseScale);
    samples.push({
      identity: `official:${i + 1}`,
      keyCount,
      chartOverall: rating + gap,
      gap,
      acc: 1 - Math.exp(mu),
      weight: 1,
      family,
      missShare: missShare(gap),
    });
  }
  return samples;
}

const MODES_4K = [{ keyCount: 4, rating: 25 }];

describe("fitAccModelFromSamples", () => {
  it("recovers a known accuracy curve from dense synthetic data", () => {
    const truth = { a: -3.0, bn: 0.1, bp: 0.2 };
    const samples = syntheticSamples({ ...truth, count: 600, noiseScale: 0.08 });
    const model = fitAccModelFromSamples(samples, MODES_4K);
    expect(model).not.toBeNull();
    const mode = model!.modes["4"];
    // Dense evidence should override the prior almost entirely.
    expect(mode.a).toBeCloseTo(truth.a, 1);
    expect(mode.bn).toBeCloseTo(truth.bn, 1);
    expect(mode.bp).toBeCloseTo(truth.bp, 1);
    expect(mode.transfer).toBeUndefined();
    // Median predictions track the generating curve across the gap range.
    for (const gap of [-6, -3, 0, 2, 4]) {
      const prediction = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 25 + gap, family: "stamina" });
      expect(prediction).not.toBeNull();
      const trueAcc = 1 - Math.exp(truth.a + truth.bn * Math.min(gap, 0) + truth.bp * Math.max(gap, 0));
      expect(Math.abs(prediction!.accMedian - trueAcc)).toBeLessThan(0.01);
    }
  });

  it("shrinks a sparse keymode toward the prior instead of trusting a wild fit", () => {
    // Five plays whose raw intercept would claim ~99.9% accuracy everywhere.
    const sparse: AccSample[] = Array.from({ length: 5 }, (_, i) => ({
      identity: `official:${i + 1}`,
      keyCount: 7,
      chartOverall: 20 + i * 0.1,
      gap: i * 0.1,
      acc: 0.999,
      weight: 1,
      family: null,
      missShare: null,
    }));
    const model = fitAccModelFromSamples(sparse, [{ keyCount: 7, rating: 20 }]);
    const mode = model!.modes["7"];
    expect(mode.transfer).toBe(true);
    // Posterior intercept sits much closer to the prior (-2.8) than the raw
    // evidence (ln 0.001 = -6.9): with weight 5 vs pseudo-count 25 the fit
    // can move it at most ~1/6 of the way.
    expect(mode.a).toBeGreaterThan(-4.0);
    const prediction = predictPlayerAccuracy(model, { keyCount: 7, chartOverall: 20 });
    expect(prediction!.accMedian).toBeLessThan(0.985);
    expect(prediction!.confidence).toBeLessThan(0.3);
  });

  it("seeds a sparse keymode's prior from the donor keymode", () => {
    // Strong 4K evidence with an unusually high error rate (weak accuracy
    // player), plus two thin 7K plays.
    const donorSamples = syntheticSamples({ a: -2.0, bn: 0.05, bp: 0.1, count: 400, noiseScale: 0.05 });
    const sparse: AccSample[] = Array.from({ length: 2 }, (_, i) => ({
      identity: `recent:${i}`,
      keyCount: 7,
      chartOverall: 18 + i,
      gap: i - 1,
      acc: 0.94,
      weight: 1,
      family: null,
      missShare: null,
    }));
    const model = fitAccModelFromSamples([...donorSamples, ...sparse], [
      { keyCount: 4, rating: 25 },
      { keyCount: 7, rating: 19 },
    ]);
    const mode7 = model!.modes["7"];
    expect(mode7.transfer).toBe(true);
    // The 7K prior leaned toward the donor's weak-accuracy curve, so its
    // intercept lands between the global prior (-2.8) and the donor (~-2.0).
    expect(mode7.a).toBeGreaterThan(-2.8);
  });

  it("serves prior-only modes when ratings exist but no sample joined", () => {
    const model = fitAccModelFromSamples([], [{ keyCount: 4, rating: 22 }]);
    expect(model).not.toBeNull();
    const prediction = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 22 });
    expect(prediction).not.toBeNull();
    expect(prediction!.confidence).toBeLessThan(0.1);
    expect(prediction!.accMedian).toBeGreaterThan(0.9);
  });
});

describe("predictPlayerAccuracy", () => {
  it("serves a never-played family from the keymode curve at reduced confidence, never null", () => {
    const samples = syntheticSamples({ family: "stamina", count: 300 });
    const model = fitAccModelFromSamples(samples, MODES_4K);
    const known = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 25, family: "stamina" });
    const unknown = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 25, family: "chordjack" });
    expect(unknown).not.toBeNull();
    expect(unknown!.familyPlays).toBe(0);
    expect(unknown!.confidence).toBeLessThan(known!.confidence);
    // The keymode curve still anchors the median: no family, same gap.
    expect(Math.abs(unknown!.accMedian - known!.accMedian)).toBeLessThan(0.03);
  });

  it("serves a never-played keymode from the donor at low confidence", () => {
    const samples = syntheticSamples({ keyCount: 4, count: 300 });
    const model = fitAccModelFromSamples(samples, MODES_4K);
    const prediction = predictPlayerAccuracy(model, { keyCount: 7, chartOverall: 24 });
    expect(prediction).not.toBeNull();
    expect(prediction!.source).toBe("donor");
    const own = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 24, family: null });
    expect(prediction!.confidence).toBeLessThan(own!.confidence);
  });

  it("lowers the conservative percentile as confidence drops", () => {
    const dense = fitAccModelFromSamples(syntheticSamples({ count: 600 }), MODES_4K);
    const thin = fitAccModelFromSamples(syntheticSamples({ count: 8 }), MODES_4K);
    const denseP = predictPlayerAccuracy(dense, { keyCount: 4, chartOverall: 25, family: "stamina" })!;
    const thinP = predictPlayerAccuracy(thin, { keyCount: 4, chartOverall: 25, family: "stamina" })!;
    expect(denseP.accConservative).toBeLessThanOrEqual(denseP.accMedian);
    expect(thinP.accConservative).toBeLessThanOrEqual(thinP.accMedian);
    expect(thinP.confidence).toBeLessThan(denseP.confidence);
    // Lower confidence means a bigger haircut from median to conservative.
    expect(thinP.accMedian - thinP.accConservative).toBeGreaterThan(denseP.accMedian - denseP.accConservative);
    // And the ordering median <= p85 always holds.
    expect(denseP.accP85).toBeGreaterThanOrEqual(denseP.accMedian);
    expect(thinP.accP85).toBeGreaterThanOrEqual(thinP.accMedian);
  });

  it("loses confidence when extrapolating past the observed gap range", () => {
    const model = fitAccModelFromSamples(syntheticSamples({ gapMin: -4, gapMax: 1, count: 300 }), MODES_4K);
    const inside = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 25 })!;
    const outside = predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 25 + 8 })!;
    expect(outside.confidence).toBeLessThan(inside.confidence);
    expect(outside.accMedian).toBeLessThan(inside.accMedian);
  });

  it("returns null only for an empty model or invalid input", () => {
    expect(predictPlayerAccuracy(null, { keyCount: 4, chartOverall: 25 })).toBeNull();
    const model = fitAccModelFromSamples(syntheticSamples({}), MODES_4K);
    expect(predictPlayerAccuracy(model, { keyCount: 4, chartOverall: 0 })).toBeNull();
  });
});

describe("predictPlayerChoke", () => {
  it("interpolates missShare and choke rate over the gap bins", () => {
    const samples = syntheticSamples({
      count: 600,
      // Choke grows with gap: none far below level, heavy far above.
      missShare: (gap) => Math.max(0, Math.min(0.1, 0.02 + gap * 0.01)),
    });
    const model = fitAccModelFromSamples(samples, MODES_4K);
    const easy = predictPlayerChoke(model, { keyCount: 4, chartOverall: 25 - 6 })!;
    const hard = predictPlayerChoke(model, { keyCount: 4, chartOverall: 25 + 3 })!;
    expect(hard.missShare).toBeGreaterThan(easy.missShare);
    expect(hard.chokeRate).toBeGreaterThan(easy.chokeRate);
  });

  it("returns null when no missShare evidence exists", () => {
    const model = fitAccModelFromSamples(syntheticSamples({}), MODES_4K);
    expect(predictPlayerChoke(model, { keyCount: 4, chartOverall: 25 })).toBeNull();
  });
});

describe("evaluateAccHoldout", () => {
  it("computes holdout MAE and beats the player-mean baseline on gap-dependent data", () => {
    const samples = syntheticSamples({ count: 800, noiseScale: 0.1, gapMin: -10, gapMax: 5 });
    const result = evaluateAccHoldout(samples, MODES_4K);
    expect(result).not.toBeNull();
    expect(result!.n).toBeGreaterThan(100);
    expect(result!.mae).toBeGreaterThan(0);
    // Accuracy varies ~5 points across the gap range here, so a curve must
    // beat a flat player mean.
    expect(result!.mae).toBeLessThan(result!.naiveMae);
  });

  it("returns null when a split would be empty", () => {
    expect(evaluateAccHoldout([], MODES_4K)).toBeNull();
  });
});

describe("resolvePlayCustomAccuracy", () => {
  it("prefers the stored custom accuracy", () => {
    expect(resolvePlayCustomAccuracy({ customAccuracy: 0.973, accuracy: 0.99, stableAccuracy: 0.98, goal: 0.96 })).toBe(0.973);
  });

  it("estimates from stable accuracy and goal when the field is missing", () => {
    const estimated = resolvePlayCustomAccuracy({ accuracy: 0.985, stableAccuracy: 0.98, goal: 0.96 });
    expect(estimated).not.toBeNull();
    // customAcc = 0.9375 * stable + 0.0625 * maxShare, so it must sit between
    // the two extremes of the unknown MAX share.
    expect(estimated!).toBeGreaterThanOrEqual(0.9375 * 0.98);
    expect(estimated!).toBeLessThanOrEqual(0.9375 * 0.98 + 0.0625);
  });

  it("returns null without any accuracy evidence", () => {
    expect(resolvePlayCustomAccuracy({ goal: 0.95 })).toBeNull();
  });
});

describe("buildAccSamples", () => {
  const basePlay: AccModelPlay = {
    identity: "official:1",
    beatmapId: 100,
    keyCount: 4,
    rate: 1,
    goal: 0.95,
    patterns: [],
    customAccuracy: 0.97,
    missShare: 0.001,
    endedAt: new Date().toISOString(),
  };

  it("joins plays with chart difficulty at the played rate", () => {
    const chartData = new Map<number, AccChartDifficulty>([
      [100, { overall: 24, dtOverall: 32, family: "jumpstream" }],
    ]);
    const ratings = new Map([[4, 25]]);
    const normal = buildAccSamples([basePlay], ratings, chartData);
    expect(normal).toHaveLength(1);
    expect(normal[0].gap).toBeCloseTo(-1, 5);
    expect(normal[0].family).toBe("jumpstream");
    const dt = buildAccSamples([{ ...basePlay, rate: 1.5 }], ratings, chartData);
    expect(dt[0].gap).toBeCloseTo(7, 5);
    const ht = buildAccSamples([{ ...basePlay, rate: 0.75 }], ratings, chartData);
    expect(ht[0].gap).toBeCloseTo(24 * 0.75 - 25, 5);
  });

  it("skips plays without chart-side difficulty or rating", () => {
    const chartData = new Map<number, AccChartDifficulty>([
      [100, { overall: null, dtOverall: null, family: null }],
    ]);
    expect(buildAccSamples([basePlay], new Map([[4, 25]]), chartData)).toHaveLength(0);
    expect(buildAccSamples([basePlay], new Map(), new Map([[100, { overall: 24, dtOverall: null, family: null }]]))).toHaveLength(0);
  });

  it("falls back to the play's pattern tags for the family", () => {
    const chartData = new Map<number, AccChartDifficulty>([
      [100, { overall: 24, dtOverall: null, family: null }],
    ]);
    const samples = buildAccSamples(
      [{ ...basePlay, patterns: ["lngeneral", "ln", "tech"] }],
      new Map([[4, 25]]),
      chartData,
    );
    expect(samples[0].family).toBe("ln");
  });
});

describe("readPlayerAccModel", () => {
  it("round-trips a persisted model through the migrated schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mania-live-acc-model-"));
    try {
      const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
      await migrate(db);
      const model = fitAccModelFromSamples(syntheticSamples({ count: 50 }), MODES_4K);
      await exec(
        db,
        `insert into player_skill_ratings (user_id, analysis_version, status, acc_model_json, updated_at)
         values (?, ?, 'ready', ?, ?)`,
        [4171323, 15, JSON.stringify(model), new Date().toISOString()],
      );
      const read = await readPlayerAccModel(db, 4171323);
      expect(read).not.toBeNull();
      expect(read!.v).toBe(ACC_MODEL_VERSION);
      expect(read!.modes["4"].rating).toBe(25);
      expect(await readPlayerAccModel(db, 999)).toBeNull();
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
