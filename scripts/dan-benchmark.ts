#!/usr/bin/env node
// Evaluate the local Daniel benchmark fixture manifest against the active estimator.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseManiaBeatmap } from "../src/lib/beatmap-parser.ts";
import { estimateDan } from "../src/lib/dan-estimator.ts";
import type { DanScoreContribution } from "../src/lib/dan-estimator.ts";

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

const DAN_LEVELS = new Map([
  ["alpha", 11],
  ["beta", 12],
  ["gamma", 13],
  ["delta", 14],
  ["epsilon", 15],
  ["zeta", 16],
  ["eta", 17],
]);

const BENCHMARK_DIR = path.join(process.cwd(), "datasets/dan-classifier/benchmark");

function expectedLevel(label: string): number {
  const level = label.split(/\s+/)[0].toLowerCase();
  const numeric = DAN_LEVELS.get(level);
  if (!numeric) throw new Error(`Unsupported dan label: ${label}`);
  return numeric;
}

function targetRaw(label: string): number {
  const tier = label.toLowerCase();
  const base = expectedLevel(label);
  if (tier.includes("low/mid")) return base + 0.33;
  if (tier.includes("mid/high")) return base + 0.67;
  if (tier.includes("low")) return base + 0.17;
  if (tier.includes("high")) return base + 0.83;
  return base + 0.5;
}

function topTerms(contributions: DanScoreContribution[] | undefined): string {
  return [...(contributions ?? [])]
    .filter((term) => Math.abs(term.value) >= 0.03)
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
    .slice(0, 5)
    .map((term) => `${term.id}:${term.value.toFixed(2)}`)
    .join(" ");
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(BENCHMARK_DIR, "manifest.json"), "utf8")) as BenchmarkManifest;
  const rows = [];

  for (const entry of manifest.maps) {
    const content = await readFile(path.join(BENCHMARK_DIR, entry.file), "utf8");
    const map = parseManiaBeatmap(content);
    const estimate = estimateDan(map, {
      starRating: entry.starRating ?? entry.referenceSr ?? 0,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
    });
    const actualLevel = expectedLevel(estimate.label);
    const expected = expectedLevel(entry.expected);
    const rawTarget = targetRaw(entry.expected);
    const topFamily = estimate.debug?.familyChoice.topFamily ?? estimate.family;
    rows.push({
      song: entry.song,
      expected: entry.expected,
      actual: `${estimate.displayName} ${estimate.family}`,
      levelDiff: actualLevel - expected,
      rawDiff: estimate.rawDan - rawTarget,
      raw: estimate.rawDan,
      sr: entry.starRating ?? entry.referenceSr ?? 0,
      reason: estimate.debug?.familyChoice.reason ?? "",
      topTerms: topTerms(estimate.debug?.scoring.contributions[topFamily]),
    });
  }

  rows.sort((left, right) => Math.abs(right.rawDiff) - Math.abs(left.rawDiff));
  for (const row of rows) {
    process.stdout.write([
      Math.abs(row.rawDiff) <= 1.05 ? "NEAR" : "FAR ",
      row.rawDiff.toFixed(2).padStart(6),
      (row.sr ? row.sr.toFixed(3) : "none").padStart(5),
      row.expected.padEnd(13),
      row.actual.padEnd(18),
      row.reason.padEnd(34),
      row.song,
      row.topTerms,
    ].join(" | ") + "\n");
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
