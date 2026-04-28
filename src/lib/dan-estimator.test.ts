import { describe, expect, it } from "vitest";
import { estimateDan } from "./dan-estimator";
import type { ManiaBeatmap, ManiaNote } from "./beatmap-parser";

function makeMap(notes: ManiaNote[], keyCount = 4): ManiaBeatmap {
  return {
    title: "Test",
    artist: "Tester",
    version: "4K",
    creator: "Mapper",
    keyCount,
    od: 8,
    bpm: 180,
    notes,
    totalLength: notes.at(-1)?.endTime ?? 0,
    audioFilename: "",
    previewTime: 0,
    backgroundFilename: "",
    scrollVelocities: [],
  };
}

describe("estimateDan", () => {
  it("rates a denser chart above a sparse chart", () => {
    const sparseNotes = Array.from({ length: 120 }, (_, index) => ({
      column: index % 4,
      time: index * 500,
      endTime: index * 500,
      isHold: false,
    }));
    const denseNotes = Array.from({ length: 800 }, (_, index) => ({
      column: index % 4,
      time: index * 60,
      endTime: index * 60,
      isHold: false,
    }));

    const sparse = estimateDan(makeMap(sparseNotes), { starRating: 3.2 });
    const dense = estimateDan(makeMap(denseNotes), { starRating: 7.2 });

    expect(dense.rawDan).toBeGreaterThan(sparse.rawDan);
    expect(dense.estimatedSr).toBeGreaterThan(sparse.estimatedSr);
  });

  it("refuses key counts outside the 4K calibration target", () => {
    const notes = Array.from({ length: 100 }, (_, index) => ({
      column: index % 7,
      time: index * 250,
      endTime: index * 250,
      isHold: false,
    }));

    expect(() => estimateDan(makeMap(notes, 7), { starRating: 4.5 })).toThrow("4K");
  });

  it("caps estimates at eta", () => {
    const notes = Array.from({ length: 2400 }, (_, index) => ({
      column: index % 4,
      time: index * 25,
      endTime: index * 25,
      isHold: false,
    }));

    const estimate = estimateDan(makeMap(notes), { starRating: 15 });

    expect(estimate.label).toBe("eta");
    expect(estimate.rawDan).toBeLessThanOrEqual(17);
  });

  it("keeps dense delta-star charts below eta", () => {
    const notes = Array.from({ length: 2200 }, (_, index) => ({
      column: index % 4,
      time: Math.floor(index / 4) * 120,
      endTime: Math.floor(index / 4) * 120,
      isHold: false,
    }));

    const estimate = estimateDan(makeMap(notes), { starRating: 7.3 });

    expect(estimate.rawDan).toBeLessThan(16);
  });

  it("recognizes sustained low-chord speed as early extra dan pressure", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 2050; row++) {
      const time = row * 44;
      notes.push({
        column: row % 4,
        time,
        endTime: time,
        isHold: false,
      });
      if (row % 9 === 0) {
        notes.push({
          column: (row + 2) % 4,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.35 });

    expect(estimate.label).toBe("alpha");
    expect(estimate.family).toBe("stream");
  });

  it("recognizes finalmap speed pressure from low-chord sustained density", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 2920; row++) {
      const time = row * 32;
      notes.push({
        column: row % 4,
        time,
        endTime: time,
        isHold: false,
      });
      if (row % 6 === 0) {
        notes.push({
          column: (row + 2) % 4,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 7.53 });

    expect(estimate.label).toBe("zeta");
    expect(estimate.family).toBe("stream");
  });

  it("recognizes low-SR gamma speed maps as stream instead of tech", () => {
    const notes: ManiaNote[] = [];
    const addSection = (start: number, rows: number, gap: number, pattern: "chord" | "speed") => {
      for (let row = 0; row < rows; row++) {
        const time = start + row * gap;
        const columns = pattern === "speed"
          ? row % 16 === 0 ? [row % 4, (row + 1) % 4] : [row % 4]
          : row % 4 === 0 ? [0, 2] : row % 4 === 2 ? [1, 3] : [row % 4];

        for (const column of columns) {
          notes.push({
            column,
            time,
            endTime: time,
            isHold: false,
          });
        }
      }
    };

    addSection(10000, 260, 158, "chord");
    addSection(70000, 460, 40, "speed");
    addSection(95000, 160, 158, "chord");
    addSection(120000, 460, 40, "speed");

    const estimate = estimateDan(makeMap(notes), { starRating: 5.76, totalLength: 142 });

    expect(estimate.label).toBe("gamma");
    expect(estimate.family).toBe("stream");
  });

  it("promotes gamma-star sustained low-chord speed out of beta", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 2300; row++) {
      const time = row * 38;
      notes.push({
        column: row % 4,
        time,
        endTime: time,
        isHold: false,
      });
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.7, totalLength: 118 });

    expect(estimate.metrics.chordRatio).toBeLessThan(0.02);
    expect(estimate.metrics.sustainedNps10s).toBeGreaterThan(26);
    expect(estimate.label).toBe("gamma");
    expect(estimate.family).toBe("stream");
    expect(estimate.skillScores.handstream).toBeLessThan(estimate.skillScores.stream);
  });

  it("promotes lower-rate light-chord gamma speed out of beta", () => {
    const notes: ManiaNote[] = [];
    const lastByColumn = [-Infinity, -Infinity, -Infinity, -Infinity];

    for (let row = 0; row < 2058; row++) {
      const time = row * 44;
      const noteCount = row % 10 === 0 ? 2 : 1;
      const columns = [0, 1, 2, 3]
        .sort((a, b) => lastByColumn[a] - lastByColumn[b])
        .slice(0, noteCount);

      for (const column of columns) {
        notes.push({ column, time, endTime: time, isHold: false });
        lastByColumn[column] = time;
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.44 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.09);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.16);
    expect(estimate.metrics.sustainedNps10s).toBeGreaterThan(24);
    expect(estimate.debug?.scoring.terms.lightChordGammaSpeedFloorBonus).toBeGreaterThan(0);
    expect(estimate.family).toBe("stream");
    expect(estimate.label).toBe("gamma");
  });

  it("keeps base-rate low-chord stream near gamma thresholds in beta", () => {
    const notes: ManiaNote[] = [];

    for (let row = 0; row < 2580; row++) {
      const time = row * 49;
      const column = row % 4;
      notes.push({ column, time, endTime: time, isHold: false });
      if (row % 100 < 23) {
        notes.push({ column: (column + 2) % 4, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.53, totalLength: 206 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.18);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.28);
    expect(estimate.metrics.peakNps5s).toBeGreaterThan(25.4);
    expect(estimate.metrics.peakNps5s).toBeLessThan(26);
    expect(estimate.debug?.scoring.terms.baseRateSubGammaStreamBonus).toBeGreaterThan(0);
    expect(estimate.family).toBe("stream");
    expect(estimate.displayName).toBe("beta++");
  });

  it("promotes compact moderate-chord speed into high beta", () => {
    const notes: ManiaNote[] = [];
    const lastByColumn = [-Infinity, -Infinity, -Infinity, -Infinity];

    for (let row = 0; row < 1450; row++) {
      const time = row * 47.5;
      const noteCount = row % 5 === 0 ? 2 : 1;
      const columns = [0, 1, 2, 3]
        .sort((a, b) => lastByColumn[a] - lastByColumn[b])
        .slice(0, noteCount);

      for (const column of columns) {
        notes.push({ column, time, endTime: time, isHold: false });
        lastByColumn[column] = time;
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.71 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.18);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.28);
    expect(estimate.metrics.sustainedNps10s).toBeGreaterThan(25);
    expect(estimate.debug?.scoring.terms.compactModerateChordSpeedBonus).toBeGreaterThan(0);
    expect(estimate.family).toBe("stream");
    expect(estimate.displayName).toBe("beta++");
  });

  it("recognizes delta-range speed endurance above low delta", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 3200; row++) {
      const time = row * 34;
      notes.push({
        column: row % 4,
        time,
        endTime: time,
        isHold: false,
      });
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 6.55, totalLength: 138 });

    expect(estimate.label).toBe("delta");
    expect(estimate.family).toBe("stream");
  });

  it("compresses low-chord burst streams with jack pressure out of epsilon", () => {
    const notes: ManiaNote[] = [];
    let time = 0;

    for (let row = 0; row < 3481; row++) {
      const inBurst = row >= 1400 && row < 1440;
      time += inBurst ? 20 : 41;
      const column = row % 4;
      notes.push({ column, time, endTime: time, isHold: false });
      if (row % 100 < 21) {
        notes.push({ column: (column + 2) % 4, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 7.04, totalLength: time / 1000 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.16);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.28);
    expect(estimate.metrics.peakNps1s).toBeGreaterThan(38);
    expect(estimate.debug?.scoring.terms.lowChordBurstStreamNerf).toBeGreaterThan(0);
    expect(estimate.family).toBe("stream");
    expect(estimate.label).toBe("delta");
  });

  it("compresses farm jumptrills while treating rated vibro as jack pressure", () => {
    const notes: ManiaNote[] = [];
    const masks = [[0], [1], [2], [3], [0, 2], [1, 3], [0, 2], [1, 3]];
    let time = 0;
    let row = 0;
    const addRow = (gap: number) => {
      time += gap;
      for (const column of masks[row % masks.length]) {
        const isHold = notes.length % 6 === 0;
        notes.push({ column, time, endTime: isHold ? time + 90 : time, isHold });
      }
      row++;
    };

    for (let block = 0; block < 12; block++) {
      for (let i = 0; i < 235; i++) addRow(64);
      for (let i = 0; i < 30; i++) addRow(44);
    }
    while (notes.length < 4757) addRow(64);
    notes.length = 4757;

    const map = makeMap(notes);
    const base = estimateDan(map, { starRating: 6.26, totalLength: 348, rate: 1 });
    const dt = estimateDan(map, { starRating: 6.26, totalLength: 348, rate: 1.5 });

    expect(base.metrics.chordRatio).toBeGreaterThan(0.42);
    expect(base.metrics.holdRatio).toBeGreaterThan(0.1);
    expect(base.debug?.scoring.gates.farmJumptrillGate).toBeGreaterThan(0);
    expect(base.debug?.scoring.gates.ratedVibroJumptrillGate).toBe(0);
    expect(base.rawDan).toBeLessThan(12);
    expect(dt.debug?.scoring.gates.ratedVibroJumptrillGate).toBeGreaterThan(0);
    expect(dt.family).toBe("jack");
    expect(dt.label).toBe("delta");
    expect(dt.rawDan).toBeLessThan(14.5);
  });

  it("rewards low-SR technical row bursts as tech pressure", () => {
    const notes: ManiaNote[] = [];
    const masks = [[0], [2], [1, 3], [0], [3], [0, 2], [1], [2, 3], [0], [1]];
    const gaps = [24, 42, 44, 62, 84, 42, 24, 44, 68, 34, 90, 42];
    let time = 0;

    for (let row = 0; row < 1900; row++) {
      time += gaps[row % gaps.length];
      for (const column of masks[row % masks.length]) {
        notes.push({ column, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.55, totalLength: 125 });

    expect(estimate.metrics.rowBurstPressure).toBeGreaterThan(20);
    expect(estimate.metrics.fastRowRatio).toBeGreaterThan(0.5);
    expect(estimate.metrics.rowIntervalEntropy).toBeGreaterThan(2);
    expect(estimate.debug?.scoring.terms.lowSrTechnicalRhythmBonus).toBeGreaterThan(0);
    expect(estimate.family).toBe("tech");
    expect(estimate.rawDan).toBeGreaterThan(12.5);
    expect(estimate.rawDan).toBeLessThan(14.5);
  });

  it("rewards compact chord-switch tech with anchor pressure", () => {
    const notes: ManiaNote[] = [];
    const masks = [[0], [0, 2], [1], [1, 3], [2], [3], [3, 1], [0], [0, 3], [1], [2], [1, 2], [3], [0]];
    const gaps = [53, 53, 53, 53, 53, 53, 53, 53, 53, 53, 83];
    let time = 0;

    for (let row = 0; row < 1480; row++) {
      time += gaps[row % gaps.length];
      for (const column of masks[row % masks.length]) {
        const isHold = notes.length % 15 === 0;
        notes.push({ column, time, endTime: isHold ? time + 120 : time, isHold });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.45, totalLength: 114 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.3);
    expect(estimate.metrics.chordSizeChangeRate).toBeGreaterThan(0.55);
    expect(estimate.metrics.fastRowRatio).toBeGreaterThan(0.72);
    expect(estimate.debug?.scoring.terms.compactChordSwitchTechBonus).toBeGreaterThan(0);
    expect(estimate.family).toBe("tech");
    expect(estimate.displayName).toBe("gamma-");
  });

  it("recognizes chorded technical speed as gamma-range pressure", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 1588; row++) {
      const time = row * 48;
      notes.push({
        column: row % 4,
        time,
        endTime: time,
        isHold: false,
      });
      if (row % 4 === 0) {
        notes.push({
          column: (row + 2) % 4,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.76 });

    expect(estimate.label).toBe("gamma");
    expect(estimate.family).toBe("stream");
  });

  it("routes dense chorded repetition into jack instead of tech", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 1060; row++) {
      const time = row * 82;
      const phase = row % 9;
      const columns = phase < 3
        ? [row % 4]
        : phase < 7
          ? [row % 4, (row + 2) % 4]
          : [row % 4, (row + 1) % 4, (row + 3) % 4];

      for (const column of columns) {
        notes.push({
          column,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 6.82 });

    expect(estimate.label).toBe("delta");
    expect(estimate.family).toBe("jack");
  });

  it("keeps dense chord walls below eta unless same-column pressure is eta-class", () => {
    const weakNotes: ManiaNote[] = [];
    const strongNotes: ManiaNote[] = [];
    for (let row = 0; row < 1150; row++) {
      const time = row * 85;
      const columns = row % 8 < 7 ? [0, 1, 2] : [1, 2, 3];
      for (const column of columns) {
        weakNotes.push({
          column,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }
    for (let row = 0; row < 1300; row++) {
      const time = row * 62;
      const columns = row % 8 < 7 ? [0, 1, 2] : [1, 2, 3];
      for (const column of columns) {
        strongNotes.push({
          column: (column + row) % 4,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const weak = estimateDan(makeMap(weakNotes), { starRating: 8.56 });
    const strong = estimateDan(makeMap(strongNotes), { starRating: 8.66 });

    expect(weak.label).toBe("zeta");
    expect(strong.label).toBe("eta");
    expect(weak.family).toBe("jack");
    expect(strong.family).toBe("jack");
  });

  it("routes dense chord clusters without dominant jacks into chordjack instead of tech", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 740; row++) {
      const time = row * 130;
      const phase = row % 20;
      const columns = phase < 3
        ? [phase % 4]
        : phase < 12
          ? phase % 2 === 0 ? [0, 1] : [2, 3]
          : phase < 16
            ? phase % 2 === 0 ? [0, 1, 3] : [0, 2, 3]
            : [0, 1, 2, 3];

      for (const column of columns) {
        notes.push({
          column,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 4.61 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.8);
    expect(estimate.family).toBe("chordjack");
  });

  it("keeps short dense chord-wall acc maps around tenth dan instead of alpha tech", () => {
    const notes: ManiaNote[] = [];
    const masks = [
      [0, 1, 2, 3],
      [0, 1],
      [2, 3],
      [0, 2, 3],
      [1],
      [0, 1, 3],
      [1, 2],
      [2],
      [0, 3],
      [0, 2],
      [1, 3],
    ];

    for (let row = 0; row < 732; row++) {
      const time = row * (row % 6 === 0 ? 223 : 112);
      const columns = row % 30 === 0 ? [0] : masks[row % masks.length];

      for (const column of columns) {
        notes.push({ column, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 6.02 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.75);
    expect(estimate.family).toBe("chordjack");
    expect(estimate.rawDan).toBeLessThan(10.5);
    expect(estimate.skillScores.chordjack).toBeGreaterThanOrEqual(estimate.skillScores.tech);
  });

  it("does not inflate short chordjack cuts into beta-range estimates", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 740; row++) {
      const time = row * 130;
      const phase = row % 20;
      const columns = phase < 3
        ? [phase % 4]
        : phase < 12
          ? phase % 2 === 0 ? [0, 1] : [2, 3]
          : phase < 16
            ? phase % 2 === 0 ? [0, 1, 3] : [0, 2, 3]
            : [0, 1, 2, 3];

      for (const column of columns) {
        notes.push({
          column,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.68 });

    expect(estimate.family).toBe("chordjack");
    expect(estimate.rawDan).toBeLessThan(11);
  });

  it("routes high-sustain single-double alternation into stamina instead of tech", () => {
    const notes: ManiaNote[] = [];
    const masks = [[0, 1], [2, 3], [0, 1], [2, 3], [0], [3], [1], [2]];
    for (let row = 0; row < 2200; row++) {
      const time = row * 43;
      const columns = masks[row % masks.length];

      for (const column of columns) {
        notes.push({
          column,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 8.9 });

    expect(estimate.metrics.sustainedNps10s).toBeGreaterThan(34);
    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.32);
    expect(estimate.family).toBe("stamina");
  });

  it("routes long moderate-chord endurance into stamina instead of tech", () => {
    const notes: ManiaNote[] = [];
    const masks = [[0, 1], [2], [3, 0], [1], [2, 3], [0], [1, 2], [3]];
    for (let row = 0; row < 3600; row++) {
      const time = row * 50;
      const columns = masks[row % masks.length];

      for (const column of columns) {
        notes.push({
          column,
          time,
          endTime: time,
          isHold: false,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 6.37, totalLength: 269 });

    expect(estimate.label).toBe("gamma");
    expect(estimate.family).toBe("stamina");
  });

  it("keeps long mid-chord stamina ladders from inflating into tech or delta too early", () => {
    const makeCyberLike = (rowMs: number, starRating: number) => {
      const notes: ManiaNote[] = [];
      const masks = [[0], [1, 2], [3], [0, 2], [1], [2, 3], [0, 1], [2], [3, 1], [0], [1, 3], [2]];
      for (let row = 0; row < 3340; row++) {
        const time = row * rowMs;
        for (const column of masks[row % masks.length]) {
          notes.push({ column, time, endTime: time, isHold: false });
        }
      }

      return estimateDan(makeMap(notes), { starRating });
    };

    const mid = makeCyberLike(73, 6.06);
    const fast = makeCyberLike(68, 6.49);

    expect(mid.metrics.chordRatio).toBeGreaterThan(0.42);
    expect(mid.metrics.noteCount).toBeGreaterThan(4500);
    expect(mid.family).toBe("stamina");
    expect(mid.rawDan).toBeLessThan(11);
    expect(fast.family).toBe("stamina");
    expect(fast.skillScores.handstream).toBeGreaterThan(fast.skillScores.stream);
    expect(fast.label).toBe("beta");
  });

  it("surfaces sustained mid-chord streams as handstream pressure", () => {
    const notes: ManiaNote[] = [];
    const sections: Array<[number, number]> = [
      [731, 0.41],
      [778, 0.40],
      [761, 0.46],
      [934, 0.56],
      [241, 0.15],
      [731, 0.44],
      [932, 0.55],
      [822, 0.37],
      [117, 0.52],
    ];

    sections.forEach(([noteCount, chordRatio], section) => {
      const rowCount = Math.round(noteCount / (1 + chordRatio));
      const chordRows = Math.round(rowCount * chordRatio);
      const start = section * 30000;
      const gap = 30000 / rowCount;

      for (let row = 0; row < rowCount; row++) {
        const time = start + row * gap;
        const column = (section + row) % 4;
        notes.push({ column, time, endTime: time, isHold: false });
        if (row < chordRows) {
          notes.push({ column: (column + 2) % 4, time, endTime: time, isHold: false });
        }
      }
    });

    const estimate = estimateDan(makeMap(notes), { starRating: 7.27, totalLength: 270 });

    expect(estimate.family).toBe("stamina");
    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.38);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.56);
    expect(estimate.skillScores.handstream).toBeGreaterThan(estimate.skillScores.stream);
    expect(estimate.skillScores.handstream).toBeGreaterThan(estimate.skillScores.chordjack);
    expect(estimate.skillScores.handstream).toBeGreaterThan(estimate.skillScores.tech);
  });

  it("keeps short dense jack files from being classified as tech", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 1500; row++) {
      const time = row * 62;
      const baseColumn = row % 8 < 4 ? 0 : 3;
      notes.push({ column: baseColumn, time, endTime: time, isHold: false });
      if (row % 100 < 63) {
        notes.push({ column: baseColumn === 0 ? 1 : 2, time, endTime: time, isHold: false });
      }
    }

    const deltaRate = estimateDan(makeMap(notes), { starRating: 7.34, totalLength: 93000 });
    const zetaRate = estimateDan(makeMap(notes), { starRating: 8.32, totalLength: 93000 });

    expect(deltaRate.metrics.chordRatio).toBeGreaterThan(0.54);
    expect(deltaRate.metrics.jackPressure).toBeGreaterThan(160);
    expect(deltaRate.family).toBe("jack");
    expect(deltaRate.label).toBe("delta");
    expect(zetaRate.family).toBe("jack");
    expect(zetaRate.label).toBe("zeta");
  });

  it("promotes low-SR dense wall-jacks out of numeric dan", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 1435; row++) {
      const time = row * 80;
      const columns = row % 17 === 0
        ? [row % 4]
        : row % 4 < 2 ? [0, 1] : [2, 3];

      for (const column of columns) {
        notes.push({ column, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.51 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.9);
    expect(estimate.debug?.scoring.terms.lowSrDenseWallJackBonus).toBeGreaterThan(0);
    expect(estimate.family).toBe("jack");
    expect(estimate.label).toBe("gamma");
  });

  it("compresses high-SR medium wall-jacks that read as jack, not epsilon tech", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 2200; row++) {
      const time = row * 50;
      const columns = row % 19 < 13
        ? row % 2 === 0 ? [0, 1] : [2, 3]
        : [row % 4];

      for (const column of columns) {
        notes.push({ column, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 7.03 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.62);
    expect(estimate.debug?.scoring.terms.mediumWallJackSrCompression).toBeGreaterThan(0);
    expect(estimate.family).toBe("jack");
    expect(estimate.rawDan).toBeLessThan(13.5);
  });

  it("keeps high-SR LN hybrids below zeta when hold density is high", () => {
    const notes: ManiaNote[] = [];
    for (let row = 0; row < 4568; row++) {
      const time = row * 70;
      const columns = row % 3 === 0 ? [row % 4, (row + 1) % 4] : [row % 4];

      for (const column of columns) {
        const isHold = notes.length % 11 < 4;
        notes.push({
          column,
          time,
          endTime: isHold ? time + 120 : time,
          isHold,
        });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 8.81 });

    expect(estimate.rawDan).toBeLessThan(14);
    expect(estimate.warnings.some((warning) => warning.includes("LN"))).toBe(true);
  });

  it("detects multi-section dan marathon files as dans", () => {
    const notes: ManiaNote[] = [];
    let offset = 0;
    for (let segment = 0; segment < 4; segment++) {
      for (let row = 0; row < 900; row++) {
        const time = offset + row * 90;
        notes.push({
          column: row % 4,
          time,
          endTime: time,
          isHold: false,
        });
        if (row % 3 === 0) {
          notes.push({
            column: (row + 2) % 4,
            time,
            endTime: time,
            isHold: false,
          });
        }
      }
      offset += 900 * 90 + 6000;
    }

    const estimate = estimateDan(makeMap(notes), {
      starRating: 5.91,
      title: "ALPHA Dan ~ REFORM ~ ON RATES",
      version: "[4K] ~ EXTRA-ALPHA ~ (Marathon) 1.0x",
    });

    expect(estimate.family).toBe("dan");
  });

  it("detects rate-pack dan courses without reading the dan level from metadata", () => {
    const notes: ManiaNote[] = [];
    let offset = 0;
    for (let segment = 0; segment < 4; segment++) {
      for (let row = 0; row < 1650; row++) {
        const time = offset + row * 42;
        const columns = segment % 2 === 0
          ? row % 5 === 0 ? [row % 4, (row + 2) % 4] : [row % 4]
          : row % 4 === 0 ? [0, 2] : row % 7 === 0 ? [1, 2, 3] : [row % 4];

        for (const column of columns) {
          notes.push({
            column,
            time,
            endTime: time,
            isHold: false,
          });
        }
      }
      offset += 1650 * 42 + 5200;
    }

    const estimate = estimateDan(makeMap(notes), {
      starRating: 7.27,
      totalLength: offset / 1000,
      title: "Delta Dan - w/rates",
      version: "[4K] ~ DELTA ~ (x1)",
    });

    expect(estimate.label).toBe("delta");
    expect(estimate.family).toBe("dan");
  });

  it("does not use dan-pack labels as estimate anchors", () => {
    const notes = Array.from({ length: 2200 }, (_, index) => ({
      column: index % 4,
      time: Math.floor(index / 4) * 140,
      endTime: Math.floor(index / 4) * 140,
      isHold: false,
    }));

    const estimate = estimateDan(makeMap(notes), {
      starRating: 6.1,
      title: "BETA DAN ON RATES",
      version: "4K ~ EXTRA-BETA ~ (Marathon)",
    });

    expect(estimate.label).not.toBe("beta");
  });

  it("does not treat non-dan song titles as explicit dan anchors", () => {
    const notes = Array.from({ length: 800 }, (_, index) => ({
      column: index % 4,
      time: index * 70,
      endTime: index * 70,
      isHold: false,
    }));

    const estimate = estimateDan(makeMap(notes), {
      starRating: 8.32,
      title: "Vertex BETA",
      version: "4K Emik03 SAMPLE reform ZETA x0.95",
    });

    expect(estimate.label).not.toBe("beta");
  });

  it("does not rate-adjust from reform labels in difficulty metadata", () => {
    const notes = Array.from({ length: 800 }, (_, index) => ({
      column: index % 4,
      time: index * 70,
      endTime: index * 70,
      isHold: false,
    }));

    const slowed = estimateDan(makeMap(notes), {
      starRating: 7.34,
      title: "Vertex BETA",
      version: "4K Emik03 SAMPLE reform ZETA",
      rate: 0.85,
    });
    const base = estimateDan(makeMap(notes), {
      starRating: 8.32,
      title: "Vertex BETA",
      version: "4K Emik03 SAMPLE reform ZETA",
    });

    expect(slowed.label).not.toBe("delta");
    expect(base.label).not.toBe("zeta");
  });

  it("does not read numeric or finalmaps dan-pack metadata as the estimate", () => {
    const notes = Array.from({ length: 800 }, (_, index) => ({
      column: index % 4,
      time: index * 70,
      endTime: index * 70,
      isHold: false,
    }));

    expect(estimateDan(makeMap(notes), {
      starRating: 3.26,
      title: "Dan ~ REFORM ~ 1st Pack",
      version: "[4K] ~ 1st ~ (Marathon)",
    }).label).not.toBe("1");

    expect(estimateDan(makeMap(notes), {
      starRating: 8.47,
      title: "Dan ~ REFORM ~ Finalmaps",
      version: "LV.4 - Angel Dust ~ Zeta Jack ~",
    }).label).not.toBe("zeta");
  });

  it("keeps low-chord speed charts focused on stream instead of fake chordjack", () => {
    const notes: ManiaNote[] = [];
    let time = 0;
    for (let row = 0; row < 2050; row++) {
      time += row % 11 === 0 ? 60 : 50;
      const columns = row % 10 === 0 ? [row % 4, (row + 2) % 4] : [(row * 2 + row / 3) % 4 | 0];

      for (const column of columns) {
        notes.push({ column, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 5.31 });

    expect(estimate.metrics.chordRatio).toBeLessThan(0.15);
    expect(estimate.family).toBe("stream");
    expect(estimate.skillScores.stream).toBeGreaterThan(estimate.skillScores.chordjack);
    expect(estimate.skillScores.stream).toBeGreaterThan(estimate.skillScores.tech);
  });

  it("treats long steady mid-chord streams as stream, not tech or chordjack", () => {
    const notes: ManiaNote[] = [];
    const masks = [
      [0],
      [1],
      [2, 3],
      [0],
      [1],
      [2],
      [0, 3],
      [1],
      [2],
      [0, 1, 3],
      [2],
      [0],
    ];
    for (let row = 0; row < 3550; row++) {
      const time = row * 54;
      for (const column of masks[row % masks.length]) {
        notes.push({ column, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 6.02 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.24);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.42);
    expect(estimate.family).toBe("stream");
    expect(estimate.rawDan).toBeLessThan(13);
    expect(estimate.skillScores.stream).toBeGreaterThan(estimate.skillScores.tech);
    expect(estimate.skillScores.stream).toBeGreaterThan(estimate.skillScores.chordjack);
  });
});
