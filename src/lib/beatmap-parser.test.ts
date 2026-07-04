import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "./beatmap-parser";

describe("parseManiaBeatmap", () => {
  it("parses inherited timing points as mania scroll velocities", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[General]
AudioFilename: audio.mp3
PreviewTime: 1000
Mode: 3

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

[General]
Mode: 3

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

  it("keeps stable replay scroll-speed BPM on the gameplay base timing", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[General]
Mode: 3

[Metadata]
Title:Test
Artist:Tester
Creator:Mapper
Version:Stable scroll base BPM

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,729.92700729927,4,1,0,100,1,0
1000,279.06976744186,4,1,0,100,1,0

[HitObjects]
64,192,500,1,0,0:0:0:0:
64,192,2000,1,0,0:0:0:0:
64,192,6000,1,0,0:0:0:0:
`);

    expect(beatmap.bpm).toBe(82);
    expect(beatmap.stableScrollBpm).toBe(215);
  });

  it("combines inherited SV with BPM scaling like osu!mania", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[General]
Mode: 3

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

[General]
Mode: 3

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

  it("ignores green-line SVs for std converts but keeps BPM scroll changes", () => {
    const convert = parseManiaBeatmap(`
osu file format v14

[General]
Mode: 0

[Metadata]
Title:Test
Artist:Tester
Creator:Mapper
Version:Convert SV

[Difficulty]
CircleSize:4
OverallDifficulty:8

[TimingPoints]
0,500,4,1,0,100,1,0
1000,-50,4,1,0,100,0,0
1500,-200,4,1,0,100,0,0
3000,250,4,1,0,100,1,0

[HitObjects]
64,192,1200,1,0,0:0:0:0:
64,192,1800,1,0,0:0:0:0:
64,192,3500,1,0,0:0:0:0:
`);

    expect(convert.isConvert).toBe(true);
    // Green lines (SV 2 at 1000, SV 0.5 at 1500) are ignored; only the red-line
    // BPM change at 3000 (120 -> 240 BPM) moves the scroll speed.
    expect(convert.scrollVelocities).toEqual([
      { time: 3000, multiplier: 2 },
    ]);
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

  it("resolves note hitsound samples from object fields and timing points", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[General]
Mode: 3
SampleSet: Soft

[Difficulty]
CircleSize:4

[TimingPoints]
0,500,4,2,0,70,1,0
2000,-100,4,3,2,45,0,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
192,192,1000,5,7,1:2:3:80:
320,192,2500,1,0,0:0:0:0:
448,192,2500,128,0,3000:0:0:0:0:
64,192,3500,1,2,0:0:0:0:go.wav
`);

    const [plain, custom, inherited, hold, keysound] = beatmap.notes;

    // Object left everything unspecified: timing point at 0 supplies soft bank, volume 70.
    expect(plain.sample).toEqual({
      bank: "soft",
      additionBank: "soft",
      index: 0,
      volume: 70,
      additions: 0,
      normalIsLayered: false,
      filename: undefined,
    });

    // Object specifies banks/index/volume and has whistle+finish additions with the normal flag set.
    expect(custom.sample).toEqual({
      bank: "normal",
      additionBank: "soft",
      index: 3,
      volume: 80,
      additions: 6,
      normalIsLayered: false,
      filename: undefined,
    });

    // Inherited (green) timing point at 2000 changes bank to drum, index 2, volume 45.
    expect(inherited.sample).toEqual({
      bank: "drum",
      additionBank: "drum",
      index: 2,
      volume: 45,
      additions: 0,
      normalIsLayered: false,
      filename: undefined,
    });

    // Hold note: extras start with endTime; sample resolves at the END time's control point.
    expect(hold.endTime).toBe(3000);
    expect(hold.sample?.bank).toBe("drum");
    expect(hold.sample?.volume).toBe(45);

    // Keysound filename is carried; whistle-only bitmask marks the hitnormal as layered.
    expect(keysound.sample?.filename).toBe("go.wav");
    expect(keysound.sample?.additions).toBe(2);
    expect(keysound.sample?.normalIsLayered).toBe(true);
  });

  it("keeps samples attached to notes after time sorting", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[General]
Mode: 3

[Difficulty]
CircleSize:4

[TimingPoints]
0,500,4,1,0,100,1,0

[HitObjects]
64,192,2000,1,8,0:0:0:0:
192,192,1000,1,4,0:0:0:0:
`);

    expect(beatmap.notes[0].time).toBe(1000);
    expect(beatmap.notes[0].sample?.additions).toBe(4);
    expect(beatmap.notes[1].time).toBe(2000);
    expect(beatmap.notes[1].sample?.additions).toBe(8);
  });

  it("normalizes fractional key counts without fractional note columns", () => {
    const beatmap = parseManiaBeatmap(`
osu file format v14

[General]
Mode: 3

[Difficulty]
CircleSize:3.3

[HitObjects]
511,192,1000,1,0,0:0:0:0:
`);

    expect(beatmap.keyCount).toBe(4);
    expect(beatmap.notes[0].column).toBe(3);
  });
});
