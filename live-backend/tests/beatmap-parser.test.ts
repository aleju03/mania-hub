import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";

describe("parseManiaBeatmap", () => {
  it("normalizes fractional key counts without fractional note columns", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[Difficulty]
CircleSize:6.8

[HitObjects]
511,192,1000,1,0,0:0:0:0:
`);

    expect(beatmap.keyCount).toBe(7);
    expect(beatmap.notes[0].column).toBe(6);
  });
});
