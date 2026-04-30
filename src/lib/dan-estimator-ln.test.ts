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

function targetRawForEntry(entry: LnManifestEntry): number | null {
  const target = targetForEntry(entry);
  const match = target?.match(/^LN\s*(\d{1,2})([+-])?$/i);
  if (!match) return null;
  return Number(match[1]) + (match[2] === "+" ? 0.25 : match[2] === "-" ? -0.25 : 0);
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
  it("classifies official _underjoy 4K LN dan courses as LN without metadata identity lookup", () => {
    const officialEntries = manifest.filter((entry) => /\b\d{1,2}(?:st|nd|rd|th) Dan\b/i.test(entry.version));
    expect(officialEntries).toHaveLength(15);
    const estimates = officialEntries.map((entry) => estimateEntry(entry));

    for (const [index, estimate] of estimates.entries()) {
      expect(`${officialEntries[index].file}: ${estimate.displayName} ${estimate.family}`).toMatch(/\.osu: LN \d{1,2}[+-]? ln$/);
      expect(estimate.debug?.familyChoice.reason).not.toBe("known-ln-reference");
    }

    expect(estimates[0].rawDan).toBeLessThan(estimates[9].rawDan);
    expect(estimates[9].rawDan).toBeLessThan(estimates[14].rawDan);
  });

  it("classifies explicit LN reference singles", () => {
    const singles = manifest.filter((entry) => /in the dark|Youmu's Dream/i.test(entry.version));
    expect(singles).toHaveLength(2);

    for (const entry of singles) {
      const estimate = estimateEntry(entry);
      expect(estimate.debug?.familyChoice.reason).not.toBe("known-ln-reference");
      expect(`${entry.file}: ${estimate.displayName} ${estimate.family}`).toBe(`${entry.file}: ${targetForEntry(entry)} ln`);
    }
  });

  it("keeps Hylotl numeric LN estimates near the manifest calibration", () => {
    const hylotlEntries = manifest.filter((entry) => targetForEntry(entry) && !/\b\d{1,2}(?:st|nd|rd|th) Dan\b|in the dark|Youmu's Dream/i.test(entry.version));
    expect(hylotlEntries.length).toBeGreaterThan(40);
    const diffs: number[] = [];

    for (const entry of hylotlEntries) {
      const targetRaw = targetRawForEntry(entry);
      expect(targetRaw).not.toBeNull();
      const estimate = estimateEntry(entry);
      expect(`${entry.file}: ${estimate.displayName} ${estimate.family}`).toMatch(/\.osu: LN \d{1,2}[+-]? ln$/);
      diffs.push(Math.abs(estimate.rawDan - targetRaw!));
    }

    expect(diffs.filter((diff) => diff <= 1.25).length).toBeGreaterThanOrEqual(40);
    expect(Math.max(...diffs)).toBeLessThanOrEqual(3.25);
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

        const targetRaw = targetRawForEntry(entry);
        expect(targetRaw).not.toBeNull();
        expect(`${entry.file} component ${index + 1}: ${estimate.displayName} ${estimate.family}`).toMatch(/\.osu component \d+: LN \d{1,2}[+-]? ln$/);
        expect(Math.abs(estimate.rawDan - targetRaw!)).toBeLessThanOrEqual(0.5);
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
    expect(estimate.debug?.familyChoice.reason).toBe("ln-reference-neighbor");
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

  it("estimates duplicate LN charts from pressure instead of metadata identity", () => {
    const content = readFileSync(join(LN_REFERENCE_FIXTURES_DIR, "Laur-Exitium-Vandalism.osu"), "utf8");
    const map = parseManiaBeatmap(content);
    const estimate = estimateDan(map, {
      starRating: 7.28,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
      rate: 1,
    });

    expect(estimate.debug?.familyChoice.reason).toBe("ln-reference-neighbor");
    expect(`${estimate.displayName} ${estimate.family}`).toBe("LN 14 ln");
  });

  it("keeps rated LN estimates monotonic on high-end reference-like charts", () => {
    const content = readFileSync(join(LN_REFERENCE_FIXTURES_DIR, "Laur-Exitium-Vandalism.osu"), "utf8");
    const map = parseManiaBeatmap(content);
    const rates = [1, 1.05, 1.1, 1.15, 1.2];
    const estimates = rates.map((rate) => estimateDan(map, {
      starRating: 7.28,
      totalLength: map.totalLength / 1000,
      title: map.title,
      version: map.version,
      rate,
    }));

    for (let index = 1; index < estimates.length; index++) {
      expect(estimates[index].rawDan).toBeGreaterThanOrEqual(estimates[index - 1].rawDan);
      expect(estimates[index].debug?.familyChoice.reason).toBe(estimates[0].debug?.familyChoice.reason);
    }
    expect(estimates[2].displayName).toBe("LN 15");
    expect(estimates[3].displayName).toBe("LN 15");
  });
});
