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
64,192,1800,1,0,0:0:0:0:
`);

    expect(beatmap.bpm).toBe(120);
    expect(beatmap.scrollVelocities).toEqual([
      { time: 1000, multiplier: 2 },
      { time: 1500, multiplier: 0.5 },
    ]);
  });

  it("treats BPM timing changes as mania scroll multiplier changes", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[Metadata]
Title:Test
Artist:Tester
Creator:Mapper
Version:BPM

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,1,0,100,1,0
2000,250,4,1,0,100,1,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
64,192,3000,1,0,0:0:0:0:
`);

    expect(beatmap.scrollVelocities).toEqual([
      { time: 2000, multiplier: 2 },
    ]);
  });

  it("combines inherited SV with BPM scaling like osu!mania", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[Metadata]
Title:Test
Artist:Tester
Creator:Mapper
Version:BPM compensated SV

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,1,0,100,1,0
0,-66.6666666666667,4,1,0,100,0,0
2000,333.333333333333,4,1,0,100,1,0
2000,-100,4,1,0,100,0,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
64,192,6000,1,0,0:0:0:0:
`);

    expect(beatmap.scrollVelocities).toEqual([]);
  });
});
