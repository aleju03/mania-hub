import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { estimateDan } from "./dan-estimator";
import { chooseSkillFamily } from "./dan-estimator/family-choice";
import { estimateFamilyScores } from "./dan-estimator/scoring";
import { parseManiaBeatmap, type ManiaBeatmap, type ManiaNote } from "./beatmap-parser";
import type { DanFeatureMetrics, DanSkillFamily } from "./dan-estimator/types";

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
    breakPeriods: [],
    scrollVelocities: [],
  };
}

function readFixtureBeatmap(name: string): ManiaBeatmap {
  return parseManiaBeatmap(readFileSync(new URL(`./__fixtures__/dan-classifier/${name}`, import.meta.url), "utf8"));
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

  it("extracts advanced pressure signals for sustained versus spiky patterns", () => {
    const sustainedNotes: ManiaNote[] = [];
    for (let row = 0; row < 480; row++) {
      for (const column of [0, 1, 2, 3]) {
        sustainedNotes.push({
          column,
          time: row * 125,
          endTime: row * 125,
          isHold: false,
        });
      }
    }

    const spikyNotes: ManiaNote[] = [];
    for (let row = 0; row < 160; row++) {
      spikyNotes.push({
        column: row % 4,
        time: row * 350,
        endTime: row * 350,
        isHold: false,
      });
    }
    for (let row = 0; row < 56; row++) {
      for (const column of [0, 1, 2, 3]) {
        spikyNotes.push({
          column,
          time: 60000 + row * 25,
          endTime: 60000 + row * 25,
          isHold: false,
        });
      }
    }

    const variedNotes: ManiaNote[] = [];
    const gaps = [80, 120, 55, 180, 95, 140, 65, 210];
    let time = 0;
    for (let row = 0; row < 360; row++) {
      for (const column of row % 3 === 0 ? [0, 2] : [row % 4]) {
        variedNotes.push({
          column,
          time,
          endTime: time,
          isHold: false,
        });
      }
      time += gaps[row % gaps.length];
    }

    const sustained = estimateDan(makeMap(sustainedNotes), { starRating: 6.8, totalLength: 60 });
    const spiky = estimateDan(makeMap(spikyNotes), { starRating: 6.8, totalLength: 62 });
    const varied = estimateDan(makeMap(variedNotes), { starRating: 6.8, totalLength: time / 1000 });

    expect(sustained.metrics.sustainedPressureRatio).toBeGreaterThan(spiky.metrics.sustainedPressureRatio);
    expect(spiky.metrics.strainSpikiness).toBeGreaterThan(sustained.metrics.strainSpikiness + 0.25);
    expect(varied.metrics.patternVariety).toBeGreaterThan(sustained.metrics.patternVariety + 0.3);
    expect(spiky.metrics.sustainedPressureRatio).toBeLessThan(0.5);
  });

  it("compresses charts whose pressure is mostly one short spike", () => {
    const sustainedNotes: ManiaNote[] = [];
    for (let row = 0; row < 480; row++) {
      for (const column of [0, 1, 2, 3]) {
        sustainedNotes.push({
          column,
          time: row * 125,
          endTime: row * 125,
          isHold: false,
        });
      }
    }

    const spikyNotes: ManiaNote[] = [];
    for (let row = 0; row < 160; row++) {
      spikyNotes.push({
        column: row % 4,
        time: row * 350,
        endTime: row * 350,
        isHold: false,
      });
    }
    for (let row = 0; row < 56; row++) {
      for (const column of [0, 1, 2, 3]) {
        spikyNotes.push({
          column,
          time: 60000 + row * 25,
          endTime: 60000 + row * 25,
          isHold: false,
        });
      }
    }

    const sustained = estimateDan(makeMap(sustainedNotes), { starRating: 6.8, totalLength: 60 });
    const spiky = estimateDan(makeMap(spikyNotes), { starRating: 6.8, totalLength: 62 });

    expect(spiky.metrics.strainSpikiness).toBeGreaterThan(sustained.metrics.strainSpikiness + 0.25);
    expect(spiky.rawDan).toBeLessThan(sustained.rawDan);
    expect(spiky.debug?.scoring.terms.shortSpikeCompression).toBeGreaterThan(0);
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

  it("keeps Reflec 1.1x in middle delta speed instead of low delta", () => {
    const map = readFixtureBeatmap("reflec-attang-lv25.osu");
    const estimate = estimateDan(map, {
      starRating: 5.76,
      totalLength: 142,
      rate: 1.1,
    });
    const higherRate = estimateDan(map, {
      starRating: 5.76,
      totalLength: 142,
      rate: 1.2,
    });
    const highestRate = estimateDan(map, {
      starRating: 5.76,
      totalLength: 142,
      rate: 1.3,
    });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.2);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.28);
    expect(estimate.metrics.sustainedNps10s).toBeGreaterThan(28);
    expect(estimate.debug?.scoring.terms.compactDeltaSpeedBridgeBonus).toBeGreaterThan(0);
    expect(estimate.family).toBe("stream");
    expect(estimate.displayName).toBe("delta");
    expect(higherRate.family).toBe("stream");
    expect(higherRate.rawDan).toBeGreaterThan(estimate.rawDan);
    expect(higherRate.label).toBe("delta");
    expect(highestRate.family).toBe("stream");
    expect(highestRate.rawDan).toBeGreaterThan(higherRate.rawDan);
  });

  it("keeps long fast mid-chord stamina rates ordered on NB4 Challenge 29", () => {
    const map = readFixtureBeatmap("we-luv-lama-nb4-challenge-29.osu");
    const previousRate = estimateDan(map, {
      starRating: 6.48123,
      totalLength: 321,
      rate: 1.1,
    });
    const lowerRate = estimateDan(map, {
      starRating: 6.48123,
      totalLength: 321,
      rate: 1.2,
    });
    const higherRate = estimateDan(map, {
      starRating: 6.48123,
      totalLength: 321,
      rate: 1.3,
    });

    expect(lowerRate.metrics.noteCount).toBeGreaterThan(5000);
    expect(lowerRate.metrics.chordRatio).toBeGreaterThan(0.42);
    expect(lowerRate.metrics.chordRatio).toBeLessThan(0.58);
    expect(lowerRate.metrics.fastRowRatio).toBeGreaterThan(0.8);
    expect(lowerRate.family).toBe("stamina");
    expect(lowerRate.label).toBe("gamma");
    expect(lowerRate.debug?.familyChoice.reason).toBe("long-fast-mid-chord-stamina-transition");
    expect(higherRate.family).toBe("stamina");
    expect(lowerRate.rawDan).toBeGreaterThan(previousRate.rawDan);
    expect(higherRate.rawDan).toBeGreaterThan(lowerRate.rawDan);
  });

  it("compresses long sparse dumpstreams below epsilon", () => {
    const estimate = estimateDan(readFixtureBeatmap("credens-justitiam-s.osu"), {
      starRating: 5.91,
      totalLength: 227,
    });

    expect(estimate.metrics.noteCount).toBeGreaterThan(4200);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.17);
    expect(estimate.metrics.sustainedNps10s).toBeGreaterThan(27);
    expect(estimate.debug?.scoring.terms.longSparseStreamCompression).toBeGreaterThan(0);
    expect(estimate.family).toBe("stream");
    expect(estimate.displayName).toBe("delta");
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

  it("continues technical rhythm pressure across higher rate-pack difficulties", () => {
    const makeTechRate = (gapScale: number, starRating: number) => {
      const notes: ManiaNote[] = [];
      const masks = [[0], [2], [1, 3], [0], [3], [0, 2], [1], [2, 3], [0], [1]];
      const gaps = [48, 66, 68, 86, 108, 66, 48, 68, 92, 58, 114, 66];
      let time = 0;

      for (let row = 0; row < 1900; row++) {
        time += gaps[row % gaps.length] * gapScale;
        for (const column of masks[row % masks.length]) {
          notes.push({ column, time, endTime: time, isHold: false });
        }
      }

      return estimateDan(makeMap(notes), { starRating, totalLength: 125 * gapScale });
    };

    const officialRate = makeTechRate(0.72, 5.94);
    const higherRate = makeTechRate(0.64, 6.7);

    expect(officialRate.family).toBe("tech");
    expect(higherRate.family).toBe("tech");
    expect(officialRate.rawDan).toBeGreaterThan(14);
    expect(higherRate.rawDan).toBeGreaterThan(officialRate.rawDan);
  });

  it("routes Elder Dragon Legend x1.3 sustained mid-chord speed as handstream", () => {
    const estimate = estimateDan(readFixtureBeatmap("elder-dragon-legend-dragon-slayer-x1.3.osu"), {
      starRating: 6.69,
      totalLength: 158,
    });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.35);
    expect(estimate.metrics.sustainedNps10s).toBeGreaterThan(30);
    expect(estimate.skillScores.handstream).toBeGreaterThan(estimate.skillScores.tech);
    expect(estimate.family).toBe("handstream");
    expect(estimate.displayName).toBe("delta--");
  });

  it("routes slow repetitive Lone Digger jackstream away from tech", () => {
    const map = readFixtureBeatmap("lone-digger-jack-digger.osu");
    const estimate = estimateDan(map, {
      starRating: 4.45,
      totalLength: 215,
    });
    const rateUp = estimateDan(map, {
      starRating: 4.45,
      totalLength: 215,
      rate: 1.5,
    });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.48);
    expect(estimate.metrics.jackPressure).toBeGreaterThan(115);
    expect(estimate.metrics.rowIntervalEntropy).toBeLessThan(1.3);
    expect(estimate.family).toBe("jack");
    expect(estimate.debug?.familyChoice.reason).toBe("slow-repetitive-jackstream");
    expect(estimate.label).toBe("6");
    expect(estimate.rawDan).toBeGreaterThan(6.2);
    expect(rateUp.family).toBe("jack");
    expect(rateUp.debug?.familyChoice.reason).toBe("rated-repetitive-speedjack");
    expect(rateUp.label).toBe("delta");
    expect(rateUp.rawDan).toBeGreaterThanOrEqual(13.6);
  });

  it("compresses Galaxy Collapse DT into high-end jack instead of eta tech", () => {
    const estimate = estimateDan(readFixtureBeatmap("galaxy-collapse-cataclysmic-hypernova.osu"), {
      starRating: 6.54,
      totalLength: 405,
      rate: 1.5,
    });

    expect(estimate.metrics.peakNps5s - estimate.metrics.nps5sP90).toBeGreaterThan(5);
    expect(estimate.family).toBe("jack");
    expect(estimate.debug?.familyChoice.reason).toBe("localized-high-density-jack-spike");
    expect(estimate.label).toBe("epsilon");
    expect(estimate.rawDan).toBeLessThan(15.6);
  });

  it("compresses Architecture's famous jumptrill spike below zeta", () => {
    const estimate = estimateDan(readFixtureBeatmap("architecture-mats-4k-death.osu"), {
      starRating: 8.02,
      totalLength: 245,
    });

    expect(estimate.metrics.peakNps5s - estimate.metrics.nps5sP90).toBeGreaterThan(10);
    expect(estimate.debug?.scoring.terms.localizedJumptrillSpikeCompression).toBeGreaterThan(1);
    expect(estimate.label).toBe("beta");
    expect(estimate.rawDan).toBeLessThan(12.6);
  });

  it("keeps Crescent Moon Island Kuro rates ordered around the official delta cut", () => {
    const lowerRate = estimateDan(readFixtureBeatmap("crescent-kuro-0.95.osu"), {
      starRating: 5.43444,
      totalLength: 122,
    });
    const baseRate = estimateDan(readFixtureBeatmap("crescent-kuro-1.0.osu"), {
      starRating: 5.6926,
      totalLength: 116,
    });
    const officialDelta = estimateDan(readFixtureBeatmap("crescent-kuro-1.05.osu"), {
      starRating: 5.93634,
      totalLength: 111,
    });

    expect(lowerRate.displayName).toBe("beta++");
    expect(baseRate.displayName).toBe("gamma+");
    expect(officialDelta.label).toBe("delta");
    expect(lowerRate.rawDan).toBeLessThan(baseRate.rawDan);
    expect(baseRate.rawDan).toBeLessThan(officialDelta.rawDan);
    expect(lowerRate.debug?.scoring.terms.lowerRateTechBridgeBonus).toBeGreaterThan(0);
    expect(baseRate.debug?.scoring.terms.baseRateTechCompression).toBeGreaterThan(0);
  });

  it("keeps long low-end Future Dominators stamina at 10th dan", () => {
    const estimate = estimateDan(readFixtureBeatmap("future-dominators-nb5-hard-54235.osu"), {
      starRating: 5.76,
      totalLength: 290,
    });

    expect(estimate.metrics.noteCount).toBeGreaterThan(5600);
    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.4);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.5);
    expect(estimate.family).toBe("stamina");
    expect(estimate.debug?.scoring.terms.lowEndLongMidChordStaminaFloorBonus).toBeGreaterThan(0);
    expect(estimate.label).toBe("10");
  });

  it("routes far in the blue sky 0.95 to delta chordjack instead of epsilon tech", () => {
    const estimate = estimateDan(readFixtureBeatmap("far-in-the-blue-sky-42-0.95.osu"), {
      starRating: 7.17,
      totalLength: 109,
    });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.62);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.72);
    expect(estimate.metrics.chordjackPressure).toBeGreaterThan(170);
    expect(estimate.family).toBe("chordjack");
    expect(estimate.label).toBe("delta");
    expect(estimate.rawDan).toBeLessThan(14.3);
  });

  it("keeps Eighto rates in the high-gamma to middle-delta stream range", () => {
    const map = readFixtureBeatmap("wh1teh/Jomekka-Eighto-Wh1teh-4K-k.osu");
    const lowerRate = estimateDan(map, {
      starRating: 5.53183,
      totalLength: 206,
      rate: 1.1,
    });
    const higherRate = estimateDan(map, {
      starRating: 5.53183,
      totalLength: 206,
      rate: 1.15,
    });

    expect(lowerRate.family).toBe("stream");
    expect(lowerRate.displayName).toBe("delta--");
    expect(higherRate.family).toBe("stream");
    expect(higherRate.displayName).toBe("delta");
    expect(higherRate.rawDan).toBeGreaterThan(lowerRate.rawDan);
  });

  it("keeps Lolit Speed marathon as plain alpha stamina instead of alpha+ or beta", () => {
    const estimate = estimateDan(readFixtureBeatmap("icyworld/DJ-Sharpnel-Lolit-Speed-IcyWorld-4K-Marathon.osu"), {
      starRating: 6.43949,
      totalLength: 405,
    });

    expect(estimate.metrics.noteCount).toBeGreaterThan(8000);
    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.45);
    expect(estimate.metrics.chordRatio).toBeLessThan(0.56);
    expect(estimate.metrics.jackPressure).toBeLessThan(135);
    expect(estimate.family).toBe("stamina");
    expect(estimate.displayName).toBe("alpha");
    expect(estimate.debug?.scoring.terms.longJumpstreamStaminaCompression).toBeGreaterThan(0);
    expect(estimate.debug?.scoring.terms.simpleLongJumpstreamPatternCompression).toBeGreaterThan(0);
  });

  it("tracks the Road from Gamma to Delta jack practice pack targets", () => {
    const packCases = ([
      { file: "STRONGER-0.91x-Delta-Mid", starRating: 7.10832, totalLength: 201, displayName: "delta", family: "jack" },
      { file: "Lockdown-Delta-Low", starRating: 7.08251, totalLength: 186, displayName: "delta-", family: "jack" },
      { file: "EDM-Jumpers-Cut-1.1x-Gamma-High", starRating: 6.52607, totalLength: 132, displayName: "gamma++", family: "jack" },
      { file: "Hatsuki-Yura-Onyx-Veil-0.95x-Delta-Lowmid", starRating: 7.37861, totalLength: 298, displayName: "delta", family: "chordjack" },
      { file: "Hatsuki-Yura-Snow-Veil-0.9x-Gamma-High", starRating: 6.55346, totalLength: 257, displayName: "gamma+", family: "jack" },
      { file: "Hiasobi-1.2x-Delta-Lowmid", starRating: 6.9271, totalLength: 133, displayName: "delta", family: "jack" },
      { file: "Hot-But-A-Psycho-1-3x-Delta-Mid", starRating: 6.73083, totalLength: 104, displayName: "delta", family: "jack" },
      { file: "Impossible-1.05x-Gamma-High", starRating: 7.38473, totalLength: 112, displayName: "gamma++", family: "jack" },
      { file: "J.A.C.K.E.L.L.I.T.E.-Cut-Gamma-High", starRating: 6.78578, totalLength: 136, displayName: "gamma+", family: "jack" },
      { file: "Jack-Digger-1.5x-Delta-Lowmid", starRating: 6.18453, totalLength: 143, displayName: "gamma+", family: "jack" },
      { file: "Promise-0.95x-Gamma-High", starRating: 6.46791, totalLength: 231, displayName: "gamma++", family: "chordjack" },
      { file: "Decoy-Omega-Ver.-0.85x-Delta-MidHigh", starRating: 7.35814, totalLength: 156, displayName: "delta++", family: "jack" },
      { file: "Unique-Idol-Delta-Mid", starRating: 7.12569, totalLength: 210, displayName: "delta+", family: "jack" },
    ] satisfies Array<{
      file: string;
      starRating: number;
      totalLength: number;
      displayName: string;
      family: "jack" | "chordjack";
    }>).map((packCase) => ({
      ...packCase,
      file: `gamma-delta-jack-pack/Various-Artists-Road-from-Gamma-to-Delta-practice-pack-Jack-PureDePapa-${packCase.file}-.osu`,
    }));

    for (const packCase of packCases) {
      const estimate = estimateDan(readFixtureBeatmap(packCase.file), {
        starRating: packCase.starRating,
        totalLength: packCase.totalLength,
      });

      expect(`${packCase.file}: ${estimate.displayName} ${estimate.family}`).toBe(`${packCase.file}: ${packCase.displayName} ${packCase.family}`);
    }
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

  it("routes compact Quadraphinix-like handstream away from tech", () => {
    const notes: ManiaNote[] = [];
    const masks = [[0], [1], [2, 3], [0, 1], [2], [3], [0, 2], [1, 3], [0], [1], [2, 3], [0, 1]];
    for (let row = 0; row < 1650; row++) {
      const time = row * 52;
      for (const column of masks[row % masks.length]) {
        notes.push({ column, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 6.86, totalLength: 111 });

    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.38);
    expect(estimate.metrics.jackPressure).toBeLessThan(150);
    expect(estimate.family).toBe("handstream");
    expect(estimate.rawDan).toBeLessThan(14.5);
  });

  it("compresses long sparse jack-drop files out of delta tech", () => {
    const notes: ManiaNote[] = [];
    const masks = [[0, 1], [0, 1], [2, 3], [2], [0, 3], [0], [1, 2, 3], [1], [2], [2, 3]];
    let time = 0;
    for (let row = 0; row < 3700; row++) {
      time += row % 4 === 0 ? 70 : 100;
      for (const column of masks[row % masks.length]) {
        notes.push({ column, time: Math.round(time), endTime: Math.round(time), isHold: false });
      }
      if (row % 420 === 0) time += 3500;
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 6.54, totalLength: 402 });

    expect(estimate.metrics.noteCount).toBeGreaterThan(4800);
    expect(estimate.metrics.fastRowRatio).toBeLessThan(0.38);
    expect(estimate.family).toBe("jack");
    expect(estimate.rawDan).toBeLessThan(11);
  });

  it("compresses dense base-rate stamina that SR overpromotes into epsilon", () => {
    const notes: ManiaNote[] = [];
    const masks = [[1], [0, 3], [1], [2], [1, 3], [0, 2], [1, 3], [0, 2], [1], [0, 2, 3], [1], [0, 2, 3]];
    for (let row = 0; row < 3300; row++) {
      const time = row * 52;
      for (const column of masks[row % masks.length]) {
        notes.push({ column, time, endTime: time, isHold: false });
      }
    }

    const estimate = estimateDan(makeMap(notes), { starRating: 7.37, totalLength: 253 });

    expect(estimate.metrics.sustainedNps10s).toBeGreaterThan(33);
    expect(estimate.metrics.chordRatio).toBeGreaterThan(0.56);
    expect(estimate.family).toBe("stamina");
    expect(estimate.rawDan).toBeLessThan(14.5);
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

  it("keeps dense high-chord jack rates ordered through the gamma transition", () => {
    const onePointOneMetrics: DanFeatureMetrics = {
      keyCount: 4,
      noteCount: 2531,
      holdRatio: 0.0063,
      chordRatio: 0.921,
      peakNps1s: 38,
      peakNps5s: 29,
      nps5sP50: 0,
      nps5sP90: 0,
      nps5sP95: 0,
      sustainedNps10s: 28.4,
      jackPressure: 154.6392,
      streamPressure: 4.6571,
      chordjackPressure: 252.6548,
      techPressure: 11.0369,
      rowBurstPressure: 10.3093,
      fastRowRatio: 0,
      rowIntervalEntropy: 0.9729,
      patternVariety: 2.0086,
      strainSpikiness: 1.1589,
      sustainedPressureRatio: 0.7474,
      anchorPressure: 0.1753,
      lnReleasePressure: 1.5692,
      lnDensity: 0,
      lnOverlapPressure: 0.7,
      lnChordPressure: 1,
      lnHoldDurationAvg: 194.8125,
      lnHoldDurationP90: 195,
      chordSizeChangeRate: 0.441,
      directionChangeRate: 0.6962,
      staminaPressure: 28.4,
    };
    const onePointFifteenMetrics: DanFeatureMetrics = {
      ...onePointOneMetrics,
      peakNps5s: 30.2,
      sustainedNps10s: 29.6,
      jackPressure: 161.2903,
      streamPressure: 4.7714,
      chordjackPressure: 263.5216,
      techPressure: 11.0577,
      rowBurstPressure: 10.7527,
      rowIntervalEntropy: 0,
      patternVariety: 1.4325,
      sustainedPressureRatio: 0.7789,
      anchorPressure: 0.1943,
      lnReleasePressure: 1.6065,
      lnHoldDurationAvg: 186.375,
      lnHoldDurationP90: 187,
      staminaPressure: 29.6,
    };

    const onePointOne = estimateFamilyScores(onePointOneMetrics, 6.46234, 102000);
    const onePointFifteen = estimateFamilyScores(onePointFifteenMetrics, 6.63627, 98000);

    expect(onePointOne.debug.terms.lowRateHighChordJackBonus).toBeGreaterThan(0);
    expect(onePointFifteen.debug.terms.lowRateHighChordJackBonus).toBeGreaterThan(0);
    expect(onePointFifteen.skillScores.jack).toBeGreaterThan(onePointOne.skillScores.jack);
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

  it("routes release-heavy LN hybrids through LN calibration", () => {
    const estimate = estimateDan(readFixtureBeatmap("saishuu-calamity-scarlet-mansion.osu"), {
      starRating: 8.48,
      totalLength: 252,
    });

    expect(estimate.metrics.holdRatio).toBeGreaterThan(0.28);
    expect(estimate.metrics.lnDensity).toBeGreaterThan(0.16);
    expect(estimate.metrics.lnReleasePressure).toBeGreaterThan(22);
    expect(estimate.metrics.lnChordPressure).toBeGreaterThan(0.25);
    expect(estimate.family).toBe("ln");
    expect(estimate.displayName).toBe("LN 13");
    expect(estimate.rawDan).toBeGreaterThan(13);
    expect(estimate.rawDan).toBeLessThan(13.35);
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

  it("rewards compact technical marathons without leaking into slower chord-flow files", () => {
    const compactTechMetrics: DanFeatureMetrics = {
      keyCount: 4,
      noteCount: 1460,
      holdRatio: 0,
      chordRatio: 0.2991,
      peakNps1s: 28,
      peakNps5s: 23.2,
      nps5sP50: 0,
      nps5sP90: 22,
      nps5sP95: 0,
      sustainedNps10s: 22.1,
      jackPressure: 131.5789,
      streamPressure: 6.1429,
      chordjackPressure: 95.2513,
      techPressure: 5.7472,
      rowBurstPressure: 22.2222,
      fastRowRatio: 0.7811,
      rowIntervalEntropy: 2.9326,
      patternVariety: 3.1149,
      strainSpikiness: 2.4892,
      sustainedPressureRatio: 0.7893,
      anchorPressure: 0.0635,
      lnReleasePressure: 0,
      lnDensity: 0,
      lnOverlapPressure: 0,
      lnChordPressure: 0,
      lnHoldDurationAvg: 0,
      lnHoldDurationP90: 0,
      chordSizeChangeRate: 0.2464,
      directionChangeRate: 0.7014,
      staminaPressure: 22.1,
    };
    const slowerChordFlowMetrics: DanFeatureMetrics = {
      ...compactTechMetrics,
      noteCount: 1722,
      holdRatio: 0.0314,
      chordRatio: 0.4301,
      peakNps1s: 25,
      peakNps5s: 20.2,
      nps5sP90: 16.2,
      sustainedNps10s: 16.6,
      jackPressure: 112.782,
      streamPressure: 5.5143,
      chordjackPressure: 102.88,
      techPressure: 7.5665,
      rowBurstPressure: 15.1515,
      fastRowRatio: 0.1794,
      rowIntervalEntropy: 2.0081,
      patternVariety: 3.5188,
      strainSpikiness: 3.0854,
      sustainedPressureRatio: 0.664,
      anchorPressure: 0.0363,
      lnReleasePressure: 3.3,
      lnDensity: 0.0273,
      lnOverlapPressure: 0.81,
      lnChordPressure: 0.4815,
      lnHoldDurationAvg: 281.6,
      lnHoldDurationP90: 677.3,
      chordSizeChangeRate: 0.6005,
      directionChangeRate: 0.6818,
      staminaPressure: 16.6,
    };

    const compact = estimateFamilyScores(compactTechMetrics, 5.232, 92900);
    const slower = estimateFamilyScores(slowerChordFlowMetrics, 4.475, 139300);

    expect(compact.debug.terms.compactTechnicalMarathonBonus).toBeGreaterThan(0.25);
    expect(compact.skillScores.tech).toBeGreaterThan(6.1);
    expect(slower.debug.terms.compactTechnicalMarathonBonus).toBe(0);
  });

  it("keeps high-tech compact mid-chord marathons in the tech family", () => {
    const skillScores: Record<DanSkillFamily, number> = {
      jack: 6.331,
      stream: 6.359,
      handstream: 6.472,
      stamina: 6.168,
      chordjack: 6.561,
      tech: 7.025,
      ln: 0,
      dan: 0,
    };
    const metrics: DanFeatureMetrics = {
      keyCount: 4,
      noteCount: 2308,
      holdRatio: 0,
      chordRatio: 0.5073,
      peakNps1s: 30,
      peakNps5s: 26.8,
      nps5sP50: 0,
      nps5sP90: 24.8,
      nps5sP95: 0,
      sustainedNps10s: 25.9,
      jackPressure: 147.0588,
      streamPressure: 5.9714,
      chordjackPressure: 153.8321,
      techPressure: 7.8207,
      rowBurstPressure: 19.6078,
      fastRowRatio: 0.5476,
      rowIntervalEntropy: 1.3573,
      patternVariety: 2.6389,
      strainSpikiness: 1.5139,
      sustainedPressureRatio: 0.8633,
      anchorPressure: 0.1378,
      lnReleasePressure: 0,
      lnDensity: 0,
      lnOverlapPressure: 0,
      lnChordPressure: 0,
      lnHoldDurationAvg: 0,
      lnHoldDurationP90: 0,
      chordSizeChangeRate: 0.5846,
      directionChangeRate: 0.6742,
      staminaPressure: 25.9,
    };

    const choice = chooseSkillFamily(skillScores, metrics);

    expect(choice.family).toBe("tech");
    expect(choice.debug.reason).toBe("top-score");
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
