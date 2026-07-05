import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { detectRiceVibro } from "../src/dan/chart-classifier.js";

// Synthetic charts for the rice-vibro detector. Thresholds were calibrated on
// the real corpus (see chart-classifier.ts); these tests pin the behaviour at
// the shapes that motivated each tier.

const COLUMN_X: Record<number, number[]> = {
  4: [64, 192, 320, 448],
  7: [36, 109, 182, 256, 329, 402, 475],
};

interface Note {
  column: number;
  time: number;
}

function buildOsuFile(notes: Note[], keyCount = 4): string {
  const xs = COLUMN_X[keyCount];
  const objects = notes.map((note) => `${xs[note.column]},192,${note.time},1,0,0:0:0:0:`);
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Rice Vibro Test
Artist: Test
Creator: Mapper
Version: ${keyCount}K

[Difficulty]
CircleSize:${keyCount}
OverallDifficulty:8

[TimingPoints]
0,352.94,4,2,0,100,1,0

[HitObjects]
${objects.join("\n")}
`;
}

/** Sparse background notes so charts clear the minimum-size floor. */
function filler(count: number, startTime: number, gapMs: number, column = 3): Note[] {
  return Array.from({ length: count }, (_, index) => ({ column, time: startTime + index * gapMs }));
}

describe("detectRiceVibro", () => {
  it("flags sustained single-column hammering (tier 1)", () => {
    // 400 hits in one column at 90ms (~11/s), the classic fast vibro shape.
    const notes = [
      ...Array.from({ length: 400 }, (_, index) => ({ column: 0, time: 1000 + index * 90 })),
      ...filler(60, 1000, 400, 2),
    ];
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(true);
  });

  it("leaves legit speedjack bursts alone (short runs)", () => {
    // Thirty 12-note bursts at 90ms with 500ms breathers: hard, but jackable.
    const notes: Note[] = [];
    for (let burst = 0; burst < 30; burst++) {
      const start = 1000 + burst * (12 * 90 + 500);
      for (let index = 0; index < 12; index++) notes.push({ column: burst % 4, time: start + index * 90 });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(false);
  });

  it("flags 4K quad walls hammered at ~96ms (tier 2)", () => {
    // 120 consecutive quad rows at 96ms: too slow for tier 1, but a chord wall
    // no one jacks legitimately.
    const notes: Note[] = [];
    for (let row = 0; row < 120; row++) {
      const time = 1000 + row * 96;
      for (let column = 0; column < 4; column++) notes.push({ column, time });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(true);
  });

  it("leaves dense alternating jumpstream alone at the same row speed", () => {
    // [01][23][01]... at 96ms rows: per-column gaps are 192ms, rows are pairs.
    const notes: Note[] = [];
    for (let row = 0; row < 240; row++) {
      const time = 1000 + row * 96;
      const pair = row % 2 === 0 ? [0, 1] : [2, 3];
      for (const column of pair) notes.push({ column, time });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(false);
  });

  it("keeps the quad-wall tier 4K-scoped", () => {
    // The same wall shape in 7K: 4-note chords are everyday density there.
    const notes: Note[] = [];
    for (let row = 0; row < 120; row++) {
      const time = 1000 + row * 96;
      for (let column = 0; column < 4; column++) notes.push({ column, time });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes, 7)))).toBe(false);
  });

  it("ignores tiny charts", () => {
    const notes = Array.from({ length: 100 }, (_, index) => ({ column: 0, time: 1000 + index * 90 }));
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(false);
  });
});
