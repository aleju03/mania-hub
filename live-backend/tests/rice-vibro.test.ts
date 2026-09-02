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

/** An unremarkable chart body: 20 rows/s with 200ms+ column gaps, so every
 * per-column tier stays quiet and only the burst under test can trip one. */
function ordinary(keyCount = 4): Note[] {
  const notes: Note[] = [];
  for (let row = 0; row < 1200; row++) {
    notes.push({ column: row % keyCount, time: 1000 + row * 50 });
  }
  return notes;
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
    // Six 12-note bursts at 90ms inside an otherwise streamy chart: hard
    // moments, but the file is not soaked in them (burst gaps stay a small
    // fraction of all column gaps, the shape real speedjack files measure).
    const notes: Note[] = [];
    for (let burst = 0; burst < 6; burst++) {
      const start = 1000 + burst * 20_000;
      for (let index = 0; index < 12; index++) notes.push({ column: burst % 4, time: start + index * 90 });
    }
    for (let column = 0; column < 4; column++) notes.push(...filler(250, 2500, 450, column));
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(false);
  });

  it("flags charts soaked in medium-length bursts (tier 3)", () => {
    // Thirty 12-note bursts at 90ms with 500ms breathers and little else:
    // each run is too short for tier 1, but a chart that is nothing but
    // 11/s same-column bursts plays as vibro (the "4k Vibro Pack" shape).
    const notes: Note[] = [];
    for (let burst = 0; burst < 30; burst++) {
      const start = 1000 + burst * (12 * 90 + 500);
      for (let index = 0; index < 12; index++) notes.push({ column: burst % 4, time: start + index * 90 });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(true);
  });

  it("flags 1/16 rolls only once the rate makes them a shake (tier 6)", () => {
    // 163BPM 1/16 four-column rolls in 9-note chunks with a 1/8 break between
    // them (the "Dr. Jakads" shape): 92ms per finger at 1.0x, a fast roll;
    // 61ms per finger at 1.5x, vibro. Runs never reach tier 1, there are no
    // chords, and the breaks keep the row rate under tier 4.
    // Roll lengths vary like the real file's (3-9 notes per finger), so the
    // 8+ runs stay a small share and the burst tier does not fire first.
    const notes: Note[] = [];
    let time = 1000;
    const lengths = [12, 16, 20, 24, 28, 28, 32, 32, 36];
    for (let chunk = 0; chunk < 90; chunk++) {
      const length = lengths[chunk % lengths.length];
      for (let index = 0; index < length; index++) notes.push({ column: index % 4, time: Math.round(time + index * 23) });
      time += length * 23 + 184;
    }
    const map = parseManiaBeatmap(buildOsuFile(notes));
    expect(detectRiceVibro(map)).toBe(false);
    expect(detectRiceVibro(map, 1.5)).toBe(true);
    // A 240BPM 1/4 jack file puts the same share of column gaps under 65ms
    // but its rows are 62ms apart: jacks, not a roll, and not vibro here
    // (tier 1 still owns sustained hammering).
    const jacks: Note[] = [];
    for (let burst = 0; burst < 120; burst++) {
      for (let index = 0; index < 4; index++) jacks.push({ column: burst % 4, time: 1000 + burst * 500 + index * 62 });
      jacks.push({ column: (burst + 2) % 4, time: 1000 + burst * 500 + 310 });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(jacks)))).toBe(false);
    // 7K keeps its 1.5x rolls: ranked 7K carries this per-finger interval.
    const wide = parseManiaBeatmap(buildOsuFile(notes.map((note) => ({ ...note, column: note.column + 1 })), 7));
    expect(detectRiceVibro(wide, 1.5)).toBe(false);
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
    // Rotating 4-note chords at 96ms rows in 7K: everyday chordjack density
    // there. Rotation keeps per-column runs short, the way real 7K charts
    // spread chords across the wider field.
    const notes: Note[] = [];
    for (let row = 0; row < 120; row++) {
      const time = 1000 + row * 96;
      for (let offset = 0; offset < 4; offset++) notes.push({ column: (row + offset) % 7, time });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes, 7)))).toBe(false);
  });

  it("flags cross-column spam no per-column tier can see (tier 4)", () => {
    // The "Hello (BPM) 2023" ending: alternating [01][23] pairs every 14ms,
    // ~71 rows/s, closing an otherwise ordinary chart. Per-column runs are
    // short and the fast gaps are a tenth of the file, so tiers 1-3 all read
    // it as clean.
    const notes: Note[] = [...ordinary()];
    for (let row = 0; row < 71; row++) {
      const time = 200_000 + row * 14;
      for (const column of row % 2 === 0 ? [0, 1] : [2, 3]) notes.push({ column, time });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(true);
  });

  it("leaves the legit row-density ceiling alone", () => {
    // A one-second 55 rows/s burst, the fastest peak any ranked or loved
    // chart in the corpus reaches (4K "CLICK"). The tier has to clear it.
    const notes: Note[] = [...ordinary()];
    for (let row = 0; row < 55; row++) {
      notes.push({ column: row % 4, time: 200_000 + Math.round(row * (1000 / 55)) });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(false);
  });

  it("counts rows, not notes, so wide chordjams stay clean", () => {
    // 7K "This Future" peaks at 91 notes/s, but they are 13 full 7-note
    // chords at 84ms: one action each, and a real chart.
    const notes: Note[] = [...ordinary(7)];
    for (let row = 0; row < 13; row++) {
      const time = 200_000 + row * 84;
      for (let column = 0; column < 7; column++) notes.push({ column, time });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes, 7)))).toBe(false);
  });

  it("reads the row rate in real time, not chart time, under a rate", () => {
    // 45 rows/s held for two chart-seconds: under the line at 1.0x, and at
    // 1.5x the same stretch delivers 67 rows inside a real second.
    const notes: Note[] = [...ordinary()];
    for (let row = 0; row < 90; row++) {
      notes.push({ column: row % 4, time: 200_000 + Math.round(row * (1000 / 45)) });
    }
    const map = parseManiaBeatmap(buildOsuFile(notes));
    expect(detectRiceVibro(map)).toBe(false);
    expect(detectRiceVibro(map, 1.5)).toBe(true);
  });

  it("flags fast chord jacks that alternate chord sizes (tier 5)", () => {
    // The "Buddah Attachments [280BPM CJ]" shape: 3-note chords every 54ms,
    // rotating which column sits out. No column ever holds 24 fast gaps in a
    // row (tier 1) and there are no quad pairs (tier 2), but every adjacent
    // row is a chord you would have to jack at 280BPM.
    const notes: Note[] = [...ordinary()];
    for (let row = 0; row < 400; row++) {
      const time = 200_000 + row * 54;
      for (let column = 0; column < 4; column++) {
        if (column !== row % 4) notes.push({ column, time });
      }
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(true);
  });

  it("leaves chord jacks at human speed alone", () => {
    // The same shape at 78ms rows, a ~192BPM chord jack, which people play.
    const notes: Note[] = [...ordinary()];
    for (let row = 0; row < 400; row++) {
      const time = 200_000 + row * 78;
      for (let column = 0; column < 4; column++) {
        if (column !== row % 4) notes.push({ column, time });
      }
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(false);
  });

  it("scales the chord size with the keymode", () => {
    // 3-note chords at 54ms are a wall in 4K and ordinary density in 7K, so
    // the 7K bar is a 6-note chord and this stays clean.
    const notes: Note[] = [...ordinary(7)];
    for (let row = 0; row < 400; row++) {
      const time = 200_000 + row * 54;
      for (let offset = 0; offset < 3; offset++) notes.push({ column: (row * 3 + offset) % 7, time });
    }
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes, 7)))).toBe(false);
  });

  it("reads the chord-jack gap in real time under a rate", () => {
    // 100ms chord rows are clean at 1.0x and inside the window at 1.5x.
    const notes: Note[] = [...ordinary()];
    for (let row = 0; row < 400; row++) {
      const time = 200_000 + row * 100;
      for (let column = 0; column < 4; column++) {
        if (column !== row % 4) notes.push({ column, time });
      }
    }
    const map = parseManiaBeatmap(buildOsuFile(notes));
    expect(detectRiceVibro(map)).toBe(false);
    expect(detectRiceVibro(map, 1.5)).toBe(true);
  });

  it("ignores tiny charts", () => {
    const notes = Array.from({ length: 100 }, (_, index) => ({ column: 0, time: 1000 + index * 90 }));
    expect(detectRiceVibro(parseManiaBeatmap(buildOsuFile(notes)))).toBe(false);
  });
});
