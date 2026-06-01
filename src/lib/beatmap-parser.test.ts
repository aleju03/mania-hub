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

  it("resets inherited scroll speed on BPM-only timing changes", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[Metadata]
Title:Test
Artist:Tester
Creator:Mapper
Version:BPM reset

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,1,0,100,1,0
1000,1000,4,1,0,100,1,0
1000,-50,4,1,0,100,0,0
2000,500,4,1,0,100,1,0

[HitObjects]
64,192,500,1,0,0:0:0:0:
64,192,2500,1,0,0:0:0:0:
`);

    expect(beatmap.scrollVelocities).toEqual([]);
  });

  it("parses explicit break periods from events", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[Events]
0,0,"bg.jpg",0,0
2,1234,5678

[Difficulty]
CircleSize:4

[HitObjects]
64,192,1000,1,0,0:0:0:0:
`);

    expect(beatmap.backgroundFilename).toBe("bg.jpg");
    expect(beatmap.breakPeriods).toEqual([{ startTime: 1234, endTime: 5678 }]);
  });

  it("applies key-count overrides for converted replay charts", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[General]
Mode:0

[Metadata]
Title:Convert
Artist:Tester
Creator:Mapper
Version:Default 7K

[Difficulty]
CircleSize:6.5

[HitObjects]
0,192,1000,1,0,0:0:0:0:
511,192,1500,1,0,0:0:0:0:
`, { keyCount: 4 });

    expect(beatmap.keyCount).toBe(4);
    expect(beatmap.notes.map((note) => note.column)).toEqual([0, 3]);
  });

  it("normalizes fractional key counts without fractional note columns", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[Difficulty]
CircleSize:3.3

[HitObjects]
511,192,1000,1,0,0:0:0:0:
`);

    expect(beatmap.keyCount).toBe(4);
    expect(beatmap.notes[0].column).toBe(3);
  });
});
