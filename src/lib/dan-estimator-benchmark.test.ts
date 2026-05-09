import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "./beatmap-parser";
import { estimateDan } from "./dan-estimator";

interface BenchmarkManifest {
  maps: BenchmarkEntry[];
}

interface BenchmarkEntry {
  file: string;
  song: string;
  expected: string;
  skillset: string;
  starRating?: number;
  referenceSr?: number;
}

const BENCHMARK_DIR = join(process.cwd(), "datasets/dan-classifier/benchmark");
const manifest = JSON.parse(readFileSync(join(BENCHMARK_DIR, "manifest.json"), "utf8")) as BenchmarkManifest;

const DAN_LEVELS = new Map([
  ["Alpha", 11],
  ["Beta", 12],
  ["Gamma", 13],
  ["Delta", 14],
  ["Epsilon", 15],
  ["Zeta", 16],
  ["Eta", 17],
]);

function danLevel(expected: string): number {
  const level = expected.split(/\s+/)[0];
  const numeric = DAN_LEVELS.get(level);
  if (!numeric) throw new Error(`Unsupported expected dan label: ${expected}`);
  return numeric;
}

function estimateEntry(entry: BenchmarkEntry) {
  const content = readFileSync(join(BENCHMARK_DIR, entry.file), "utf8");
  const map = parseManiaBeatmap(content);
  return estimateDan(map, {
    starRating: entry.starRating ?? entry.referenceSr ?? 0,
    totalLength: map.totalLength / 1000,
    title: map.title,
    version: map.version,
  });
}

function estimateFile(file: string, starRating: number) {
  const content = readFileSync(join(BENCHMARK_DIR, file), "utf8");
  const map = parseManiaBeatmap(content);
  return estimateDan(map, {
    starRating,
    totalLength: map.totalLength / 1000,
    title: map.title,
    version: map.version,
  });
}

describe("estimateDan Daniel benchmark calibration", () => {
  it("has expected labels for every local benchmark map", () => {
    expect(manifest.maps).toHaveLength(39);

    for (const entry of manifest.maps) {
      expect(`${entry.file} exists`).toBe(`${entry.file} exists`);
      expect(existsSync(join(BENCHMARK_DIR, entry.file))).toBe(true);
      expect(Number.isFinite(entry.referenceSr ?? entry.starRating)).toBe(true);
      expect(entry.skillset).toMatch(/^(jack|tech|speed|stamina)$/);
      expect(DAN_LEVELS.has(entry.expected.split(/\s+/)[0])).toBe(true);
    }
  });

  it("can score every local benchmark fixture without identity shortcuts", () => {
    for (const entry of manifest.maps) {
      const estimate = estimateEntry(entry);
      expect(Number.isFinite(estimate.rawDan)).toBe(true);
      expect(`${entry.song}: ${estimate.displayName} ${estimate.family}`).toMatch(/\S/);
      expect(estimate.family).not.toBe("ln");
    }
  });

  it("does not crush live osu-SR search estimates for dense benchmark charts", () => {
    const futureDominators = estimateFile("DJ Sharpnel - FUTURE DOMINATORS (IcyWorld) [NB5 Hard 54235 1.3x].osu", 7.27);
    expect(`${futureDominators.displayName} ${futureDominators.family}`).toMatch(/^delta/);

    const paradigmShift = estimateFile("Various Artists - Dan ~ REFORM ~ JackMap Pack (DDMythical) [Paradigm Shift ~ Beta ~ (Marathon)].osu", 6.46);
    expect(danLevel(paradigmShift.label[0].toUpperCase() + paradigmShift.label.slice(1))).toBeGreaterThanOrEqual(12);
  });

  it("keeps base-rate Dark Sambaland below beta on live osu SR", () => {
    const darkSambaland = estimateFile("Various Artists - Dan ~ REFORM ~ JackMap Pack (DDMythical) [Dark Sambaland ~ Alpha ~ (Marathon)].osu", 5.90945);

    expect(darkSambaland.metrics.chordRatio).toBeGreaterThan(0.8);
    expect(darkSambaland.debug?.scoring.terms.lowSrShortDenseWallCompression).toBeGreaterThan(0);
    expect(danLevel(darkSambaland.label[0].toUpperCase() + darkSambaland.label.slice(1))).toBeLessThan(12);
  });
});
