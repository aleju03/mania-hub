import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseManiaBeatmap, type ManiaBeatmap } from "./beatmap-parser";
import { estimateDan } from "./dan-estimator";

interface LnManifestEntry {
  file: string;
  version: string;
  starRating: number;
  totalLength: number;
  lnEstimate?: string;
}

const LN_MAPS_DIR = join(process.cwd(), "datasets/dan-classifier/ln-maps");
const LN_DETECTION_FIXTURES_DIR = join(process.cwd(), "src/lib/__fixtures__/dan-classifier/ln-detection");
const LN_REFERENCE_FIXTURES_DIR = join(process.cwd(), "src/lib/__fixtures__/dan-classifier/ln-references");
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

function sliceMap(map: ManiaBeatmap, start: number, end: number): ManiaBeatmap {
  const notes = map.notes
    .filter((note) => note.time >= start && note.time < end)
    .map((note) => ({
      ...note,
      time: note.time - start,
      endTime: Math.max(note.time, note.endTime) - start,
    }));
  return {
    ...map,
    notes,
    totalLength: Math.max(0, end - start),
    version: `${map.version} component ${start}-${end}`,
  };
}

function breakRanges(content: string): Array<[number, number]> {
  return [...content.matchAll(/^2,(\d+),(\d+)/gm)].map((match) => [Number(match[1]), Number(match[2])]);
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

  it("detects LN-heavy charts even when metadata does not say LN", () => {
    const content = readFileSync(join(LN_DETECTION_FIXTURES_DIR, "Laur-SEV-26-Deranged-Desire-feat-Auros.osu"), "utf8");
    const map = parseManiaBeatmap(content);
    const estimate = estimateDan(map, {
      starRating: 8.81,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
      rate: 1,
    });

    expect(estimate.metrics.holdRatio).toBeGreaterThan(0.3);
    expect(estimate.metrics.lnDensity).toBeGreaterThan(0.15);
    expect(estimate.family).toBe("ln");
    expect(estimate.displayName).toMatch(/^LN \d{1,2}/);
  });

  it("maps official LN dan course components to their course level", () => {
    const officialEntries = manifest.filter((entry) => /\b\d{1,2}(?:st|nd|rd|th) Dan\b/i.test(entry.version));

    for (const entry of officialEntries) {
      const target = targetForEntry(entry);
      const content = readFileSync(join(LN_MAPS_DIR, entry.file), "utf8");
      const map = parseManiaBeatmap(content);
      const breaks = breakRanges(content);
      const starts = [map.notes[0]?.time ?? 0, ...breaks.map(([, end]) => end + 900)];
      const ends = [...breaks.map(([start]) => start), map.totalLength];

      for (let index = 0; index < starts.length; index++) {
        const component = sliceMap(map, starts[index], ends[index]);
        if (component.totalLength < 30000) continue;
        const estimate = estimateDan(component, {
          starRating: entry.starRating,
          totalLength: component.totalLength / 1000,
          title: component.title,
          version: component.version,
          rate: 1,
        });

        expect(`${entry.file} component ${index + 1}: ${estimate.displayName} ${estimate.family}`).toBe(`${entry.file} component ${index + 1}: ${target} ln`);
      }
    }
  });

  it("classifies standalone official-course charts by reference pressure instead of raw fallback pressure", () => {
    const content = readFileSync(join(LN_REFERENCE_FIXTURES_DIR, "Hommarju-Rock-It-aLNother.osu"), "utf8");
    const map = parseManiaBeatmap(content);
    const estimate = estimateDan(map, {
      starRating: 5.42,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
      rate: 1,
    });

    expect(estimate.metrics.holdRatio).toBeGreaterThan(0.45);
    expect(estimate.debug?.familyChoice.reason).toBe("official-ln-reference-chart");
    expect(`${estimate.displayName} ${estimate.family}`).toBe("LN 7 ln");
  });

  it("keeps long standalone LN charts near their closest official component pressure", () => {
    const content = readFileSync(join(LN_REFERENCE_FIXTURES_DIR, "Nekomata-Master-Element-of-SPADA-Element-of-LN.osu"), "utf8");
    const map = parseManiaBeatmap(content);
    const base = estimateDan(map, {
      starRating: 7.44,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
      rate: 1,
    });
    const rateUp = estimateDan(map, {
      starRating: 7.44,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
      rate: 1.1,
    });

    expect(base.metrics.holdRatio).toBeGreaterThan(0.7);
    expect(base.debug?.familyChoice.reason).toBe("ln-reference-neighbor");
    expect(`${base.displayName} ${base.family}`).toBe("LN 10 ln");
    expect(rateUp.debug?.familyChoice.reason).toBe("ln-reference-neighbor");
    expect(`${rateUp.displayName} ${rateUp.family}`).toBe("LN 10 ln");
  });
});
