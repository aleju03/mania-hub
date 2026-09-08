import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Cached note structures from the community report and sustained-vibro
// controls. Names/ids document provenance only; the detector never reads them.
export const vibroCharts = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/vibro-charts.json.gz", import.meta.url))).toString("utf8")) as Array<{
  id: number; source: string; notes: [number, number, number][];
}>;

export function vibroFixture(id: number, bakedRate = 1): string {
  const chart = vibroCharts.find((chart) => chart.id === id)!;
  return buildVibroOsu(chart.notes.map(([time, column, hold]) => [Math.round(time / bakedRate), column,
    hold < 0 ? -1 : Math.round((time + hold) / bakedRate) - Math.round(time / bakedRate)]));
}

export function buildVibroOsu(notes: [number, number, number][]): string {
  return `osu file format v14
[General]
Mode:3
[Metadata]
Title:Anonymous regression chart
Artist:Test
Creator:Test
Version:Test
[Difficulty]
CircleSize:4
OverallDifficulty:8
[TimingPoints]
0,400,4,2,0,100,1,0
[HitObjects]
${notes.map(([time, column, hold]) => `${64 + 128 * column},192,${time},${hold < 0 ? 1 : 128},0,${hold < 0 ? "0:0:0:0:" : `${time + hold}:0:0:0:0:`}`).join("\n")}
`;
}

/** Ordinary material interrupted by a short quad wall. */
export function localizedVibroFixture(): string {
  const notes: [number, number, number][] = [];
  for (let row = 0; row < 1200; row++) {
    const time = 1000 + row * 100;
    if (time < 50_000 || time > 54_000) notes.push([time, row % 4, -1]);
  }
  for (let row = 0; row < 40; row++) {
    for (let column = 0; column < 4; column++) notes.push([50_010 + row * 60, column, -1]);
  }
  return buildVibroOsu(notes.sort((a, b) => a[0] - b[0]));
}
