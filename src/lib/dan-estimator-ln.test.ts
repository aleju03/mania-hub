import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "./beatmap-parser";
import { estimateDan } from "./dan-estimator";

interface LnManifestEntry {
  file: string;
  version: string;
  starRating: number;
  totalLength: number;
  lnEstimate?: string;
}

const LN_MAPS_DIR = join(process.cwd(), "datasets/dan-classifier/ln-maps");
const manifest = JSON.parse(readFileSync(join(LN_MAPS_DIR, "manifest.json"), "utf8")) as LnManifestEntry[];

function targetForEntry(entry: LnManifestEntry): string | null {
  const official = entry.version.match(/\b(\d{1,2})(?:st|nd|rd|th) Dan\b/i);
  if (official) return `LN ${Number(official[1])}`;
  if (/in the dark/i.test(entry.version)) return "LN 14";
  if (/Youmu's Dream/i.test(entry.version)) return "LN 15";

  const numeric = entry.lnEstimate?.match(/^LN\s*(\d{1,2})([+-])?$/i);
  return numeric ? `LN ${Number(numeric[1])}${numeric[2] ?? ""}` : null;
}

function estimateEntry(entry: LnManifestEntry) {
  const content = readFileSync(join(LN_MAPS_DIR, entry.file), "utf8");
  const map = parseManiaBeatmap(content);
  return estimateDan(map, {
    starRating: entry.starRating,
    totalLength: entry.totalLength,
    title: map.title,
    version: map.version,
    rate: /Youmu's Dream/i.test(entry.version) ? 1.025 : 1,
  });
}

describe("estimateDan LN calibration", () => {
  it("classifies official _underjoy 4K LN dan courses exactly", () => {
    const officialEntries = manifest.filter((entry) => /\b\d{1,2}(?:st|nd|rd|th) Dan\b/i.test(entry.version));
    expect(officialEntries).toHaveLength(15);

    for (const entry of officialEntries) {
      const estimate = estimateEntry(entry);
      expect(`${entry.file}: ${estimate.displayName} ${estimate.family}`).toBe(`${entry.file}: ${targetForEntry(entry)} ln`);
    }
  });

  it("classifies explicit LN reference singles", () => {
    const singles = manifest.filter((entry) => /in the dark|Youmu's Dream/i.test(entry.version));
    expect(singles).toHaveLength(2);

    for (const entry of singles) {
      const estimate = estimateEntry(entry);
      expect(`${entry.file}: ${estimate.displayName} ${estimate.family}`).toBe(`${entry.file}: ${targetForEntry(entry)} ln`);
    }
  });

  it("classifies Hylotl numeric LN estimates from the manifest", () => {
    const hylotlEntries = manifest.filter((entry) => targetForEntry(entry) && !/\b\d{1,2}(?:st|nd|rd|th) Dan\b|in the dark|Youmu's Dream/i.test(entry.version));
    expect(hylotlEntries.length).toBeGreaterThan(40);

    for (const entry of hylotlEntries) {
      const estimate = estimateEntry(entry);
      expect(`${entry.file}: ${estimate.displayName} ${estimate.family}`).toBe(`${entry.file}: ${targetForEntry(entry)} ln`);
    }
  });
});
