import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "./beatmap-parser";

describe("parseManiaBeatmap", () => {
  it("parses inherited timing points as mania scroll velocities", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[General]
AudioFilename: audio.mp3
PreviewTime: 1000

[Metadata]
Title:Test
Artist:Tester
Creator:Mapper
Version:SV

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,1,0,100,1,0
1000,-50,4,1,0,100,0,0
1500,-200,4,1,0,100,0,0

[HitObjects]
64,192,1200,1,0,0:0:0:0:
`);

    expect(beatmap.bpm).toBe(120);
    expect(beatmap.scrollVelocities).toEqual([
      { time: 1000, multiplier: 2 },
      { time: 1500, multiplier: 0.5 },
    ]);
  });
});
