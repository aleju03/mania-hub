import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { classifyChart, detectRateVibro, detectRiceVibro } from "../src/dan/chart-classifier.js";
import { analyzeVibroSections, conservativeVibroAccuracy, prepareVibroChart } from "../src/dan/vibro-sections.js";
import { buildVibroOsu, localizedVibroFixture, vibroCharts, vibroFixture } from "./vibro-fixtures.js";

const VIBRO_CONTROLS = [1104870, 1206131, 4871104, 918842, 5442206, 5847544, 1545542, 3948472, 3813854, 1545540];

describe("section-based vibro ratings", () => {
  it("finds both accompanied single-column runs in the reported anonymous chart", () => {
    const map = parseManiaBeatmap(vibroFixture(1545540));
    const analysis = analyzeVibroSections(map);
    expect(analysis.sections).toEqual(expect.arrayContaining([
      { startTime: 21_257, endTime: 23_696, reasons: ["isolated_jack"] },
      { startTime: 26_293, endTime: 28_811, reasons: ["isolated_jack"] },
    ]));
    expect(analysis.status).toBe("excluded");
    expect(analysis.noteShare).toBeGreaterThan(0.25);
    expect(analysis.timeShare).toBeGreaterThan(0.15);
    expect(analyzeVibroSections({ ...map, title: "unrelated", creator: "unrelated", od: 3 })).toEqual(analysis);
  });

  it("distinguishes an accompanied sustained jack from short, slow and chord-dense patterns", () => {
    const build = (hits: number, gap: number, dense = false) => {
      const notes: [number, number, number][] = Array.from({ length: 800 }, (_, row) => [1000 + row * 100, row % 4, -1]);
      for (let row = 0; row < hits; row++) {
        const time = 90_000 + row * gap;
        notes.push([time, 0, -1]);
        if (dense || row % 2 === 0) notes.push([time, 1 + row % 3, -1]);
        if (dense || row % 6 === 0) notes.push([time, 1 + (row + 1) % 3, -1]);
      }
      return parseManiaBeatmap(buildVibroOsu(notes));
    };
    const result = analyzeVibroSections(build(32, 79));
    expect(result.status).toBe("adjusted");
    expect(result.sections).toContainEqual({ startTime: 90_000, endTime: 92_449, reasons: ["isolated_jack"] });
    expect(analyzeVibroSections(build(12, 79)).status).toBe("clean");
    expect(analyzeVibroSections(build(32, 100)).status).toBe("clean");
    expect(analyzeVibroSections(build(32, 79, true)).status).toBe("clean");
    // The speed decision uses played time, including slowed and baked edits.
    expect(analyzeVibroSections(build(32, 79), 0.75).status).toBe("clean");
    expect(analyzeVibroSections(build(32, 100), 1.5).status).toBe("adjusted");
  });

  it.each(vibroCharts.filter((chart) => !VIBRO_CONTROLS.includes(chart.id)))("restores $source", ({ id }) => {
    const map = parseManiaBeatmap(vibroFixture(id));
    const result = analyzeVibroSections(map, id === 1612787 ? 1.5 : 1);
    expect(result.status).not.toBe("excluded");
    if ([2690150, 2690151, 2793589, 2793590, 2793591, 2793592, 1612787].includes(id)) {
      expect(result.status).toBe("adjusted");
      expect(result.noteShare).toBeLessThan(0.13);
    }
  });

  it.each(VIBRO_CONTROLS)("keeps sustained vibro control %s outside ordinary ratings", (id) => {
    expect(analyzeVibroSections(parseManiaBeatmap(vibroFixture(id))).status).toBe("excluded");
  });

  it("keeps slower repeated jumps eligible, including the reported jacktrill", () => {
    const map = parseManiaBeatmap(vibroFixture(4448459));
    expect(analyzeVibroSections(map).status).toBe("clean");
    expect(classifyChart(map, vibroFixture(4448459)).vibro).toBe(false);
    expect(detectRateVibro(map)).toBe(false);
    // This is a speed distinction, not an exemption for alternating hands.
    expect(analyzeVibroSections(map, 1.2).status).toBe("excluded");
    expect(analyzeVibroSections(parseManiaBeatmap(vibroFixture(4448459, 1.2))).status).toBe("excluded");
  });

  it.each([[1144551, 1.5], [5441542, 1]])("keeps the reviewed fast control %s clean at %s", (id, rate) => {
    const text = vibroFixture(id);
    const map = parseManiaBeatmap(text);
    expect(analyzeVibroSections(map, rate).status).toBe("clean");
    expect(classifyChart(map, text, { rate }).vibro).toBe(false);
    expect(detectRateVibro(map, rate)).toBe(false);
    expect(analyzeVibroSections(parseManiaBeatmap(vibroFixture(id, rate))).status).toBe("clean");
  });

  it.each([5442206, 5847544])("recognizes dense chord repetition despite changing shapes in %s", (id) => {
    const text = vibroFixture(id);
    const map = parseManiaBeatmap(text);
    const result = analyzeVibroSections(map);
    expect(result.status).toBe("excluded");
    expect(result.sections.some((section) => section.reasons.includes("dense_chord_repetition"))).toBe(true);
    expect(classifyChart(map, text).vibro).toBe(true);
    expect(detectRateVibro(map)).toBe(true);
    const rated = analyzeVibroSections(map, 1.5);
    const baked = analyzeVibroSections(parseManiaBeatmap(vibroFixture(id, 1.5)));
    expect(baked.status).toBe(rated.status);
    expect(baked.noteShare).toBeCloseTo(rated.noteShare, 3);
  });

  it("locates both reported VAPO chord passages and the third-column jack", () => {
    const result = analyzeVibroSections(parseManiaBeatmap(vibroFixture(5847544)));
    for (const time of [25_000, 72_000, 77_000]) {
      expect(result.sections.some((section) => section.startTime <= time && section.endTime >= time)).toBe(true);
    }
  });

  it.each([4706643, 5362857, 5376483])("keeps reviewed ranked DT chart %s flagged independently of play evidence", (id) => {
    const text = vibroFixture(id);
    const map = parseManiaBeatmap(text);
    expect(analyzeVibroSections(map).status).toBe("clean");
    expect(analyzeVibroSections(map, 1.5).status).toBe("excluded");
    expect(classifyChart(map, text, { rate: 1.5 }).vibro).toBe(true);
  });

  it("requires sustained fast finger reloads, not just dense changing chords", () => {
    const build = (gap: number, breakEvery = Infinity) => {
      const masks = [7, 7, 4, 14, 13, 8];
      const notes: [number, number, number][] = [];
      let time = 1000;
      for (let row = 0; row < 480; row++) {
        if (row > 0 && row % breakEvery === 0) time += 10_000;
        for (let column = 0; column < 4; column++) {
          if (masks[row % masks.length] & (1 << column)) notes.push([time, column, -1]);
        }
        time += gap;
      }
      return parseManiaBeatmap(buildVibroOsu(notes));
    };
    const fast = analyzeVibroSections(build(25));
    expect(fast.status).toBe("excluded");
    expect(fast.sections.some((section) => section.reasons.includes("dense_chord_repetition"))).toBe(true);
    expect(analyzeVibroSections(build(100)).status).toBe("clean");
    // Breaks prevent a dense 64-row window, but the individual very fast
    // repetitions are now independently eligible for short-burst detection.
    expect(analyzeVibroSections(build(25, 24)).sections.some((section) => section.reasons.includes("dense_chord_repetition"))).toBe(false);
  });

  it.each([5589167, 4704087])("removes localized rapid bursts before rating chart %s", (id) => {
    const text = vibroFixture(id);
    const map = parseManiaBeatmap(text);
    const result = analyzeVibroSections(map);
    expect(result.status).toBe("adjusted");
    expect(classifyChart(map, text).vibro).toBe(false);
    const checkpoints = id === 5589167 ? [35_600] : [35_700, 35_800, 39_250, 40_600, 42_300, 45_100, 45_500];
    for (const time of checkpoints) {
      expect(result.sections.some((section) => section.startTime <= time && section.endTime >= time
        && section.reasons.includes("rapid_jack_burst"))).toBe(true);
    }
    expect(result.noteShare).toBeLessThan(0.15);
    const prepared = prepareVibroChart(text);
    const retained = parseManiaBeatmap(prepared.osuText);
    expect(retained.notes).toHaveLength(result.remainingNotes);
    expect(retained.notes.every((note) => !result.sections.some((section) => note.time >= section.startTime && note.time <= section.endTime))).toBe(true);
    expect(analyzeVibroSections({ ...map, title: "unrelated", creator: "unrelated", od: 5 })).toEqual(result);
    for (const rate of [0.75, 1.5]) {
      const rated = analyzeVibroSections(map, rate);
      const baked = analyzeVibroSections(parseManiaBeatmap(vibroFixture(id, rate)));
      expect(baked.status).toBe(rated.status);
      // Integer-ms baked files round boundary gaps (e.g. 37/38ms at HT).
      // Identical physical timestamps must preserve exact note coverage.
      const exactBaked = analyzeVibroSections({ ...map, notes: map.notes.map((note) => ({
        ...note, time: note.time / rate, endTime: note.endTime / rate,
      })) });
      expect(exactBaked.noteShare).toBe(rated.noteShare);
    }
  });

  it("distinguishes rapid short repetitions from triples, doubles, and slower jacks", () => {
    const build = (mask: number, hits: number, gap: number) => {
      const notes: [number, number, number][] = Array.from({ length: 800 }, (_, row) => [1000 + row * 100, row % 4, -1]);
      for (let row = 0; row < hits; row++) {
        for (let column = 0; column < 4; column++) if (mask & (1 << column)) notes.push([90_000 + row * gap, column, -1]);
      }
      return parseManiaBeatmap(buildVibroOsu(notes));
    };
    for (const [mask, hits, gap] of [[1, 4, 27], [1, 9, 45], [3, 4, 37], [15, 7, 50]]) {
      expect(analyzeVibroSections(build(mask, hits, gap)).status).toBe("adjusted");
    }
    for (const [mask, hits, gap] of [[1, 3, 27], [3, 2, 20], [3, 4, 60], [1, 20, 83]]) {
      expect(analyzeVibroSections(build(mask, hits, gap)).status).toBe("clean");
    }
  });

  it.each([
    [5358361, 1, 33_450, 34_200],
    [3948472, 1, 4_600, 8_100],
    [3261945, 1, 82_500, 86_400],
    [2695088, 1, 73_500, 74_000],
    [3813854, 1, 48_200, 60_100],
    [5259004, 1, 93_750, 93_800],
    [3116797, 1.5, 34_700, 35_400],
    [3947848, 1.5, 98_500, 102_500],
    [2743517, 1.5, 39_400, 44_400],
  ])("removes the retained repetition class in %s at %s", (id, rate, first, last) => {
    const text = vibroFixture(id);
    const map = parseManiaBeatmap(text);
    const result = analyzeVibroSections(map, rate);
    for (const time of [first, last]) {
      expect(result.sections.some((section) => section.startTime <= time && section.endTime >= time)).toBe(true);
    }
    expect(analyzeVibroSections({ ...map, title: "unrelated", creator: "unrelated", od: 5 }, rate)).toEqual(result);
    const baked = analyzeVibroSections({ ...map, notes: map.notes.map((note) => ({
      ...note, time: note.time / rate, endTime: note.endTime / rate,
    })) });
    expect(baked.status).toBe(result.status);
    expect(baked.noteShare).toBe(result.noteShare);
    if (result.status === "adjusted") {
      const retained = parseManiaBeatmap(prepareVibroChart(text, rate).osuText);
      expect(retained.notes).toHaveLength(result.remainingNotes);
      expect(retained.notes.every((note) => !result.sections.some((section) => note.time >= section.startTime && note.time <= section.endTime))).toBe(true);
    }
  });

  it("finds short-chart walls, irregular fast jacks, and pairs through extra rows", () => {
    const wall = Array.from({ length: 11 }, (_, row) =>
      Array.from({ length: 4 }, (_, column) => [1000 + row * 83, column, -1] as [number, number, number])).flat();
    // A chart with fewer than 200 notes is not automatically clean.
    expect(analyzeVibroSections(parseManiaBeatmap(buildVibroOsu(wall))).status).toBe("excluded");
    const irregular: [number, number, number][] = [];
    let time = 1000;
    for (let row = 0; row < 40; row++) {
      irregular.push([time, 0, -1], [time, 1 + row % 3, -1]);
      time += row % 3 === 0 ? 80 : 40;
    }
    expect(analyzeVibroSections(parseManiaBeatmap(buildVibroOsu(irregular))).status).toBe("excluded");
    const pair: [number, number, number][] = [];
    for (let row = 0; row < 60; row++) {
      pair.push([1000 + row * 80, 0, -1], [1000 + row * 80, 1, -1]);
      if (row % 3 === 0) pair.push([1020 + row * 80, 2, -1]);
    }
    expect(analyzeVibroSections(parseManiaBeatmap(buildVibroOsu(pair))).status).toBe("excluded");
    const slower = pair.map(([time, column, hold]) => [time * 1.25, column, hold] as [number, number, number]);
    expect(analyzeVibroSections(parseManiaBeatmap(buildVibroOsu(slower))).status).toBe("clean");
  });

  it.each([95, 100])("does not turn %sms jump-jack bursts into vibro through duration alone", (gap) => {
    const notes: [number, number, number][] = [];
    for (let row = 0; row < 800; row++) {
      const mask = Math.floor(row / 4) % 2 ? 3 : 12;
      for (let column = 0; column < 4; column++) if (mask & (1 << column)) notes.push([row * gap, column, -1]);
    }
    const map = parseManiaBeatmap(buildVibroOsu(notes));
    expect(analyzeVibroSections(map).status).toBe("clean");
    expect(analyzeVibroSections(map, 1.2).status).toBe("excluded");
  });

  it("retains the localized quad-heavy adjustment in Makiba", () => {
    const result = analyzeVibroSections(parseManiaBeatmap(vibroFixture(5526453)));
    expect(result.status).toBe("adjusted");
    expect(result.sections).toEqual([{
      startTime: 116756, endTime: 128272, reasons: ["repeated_jack_stream"],
    }]);
  });

  it("does not split a long slower jack into artificial short bursts at rounding boundaries", () => {
    const notes: [number, number, number][] = [];
    let time = 1000;
    for (let row = 0; row < 800; row++) {
      notes.push([time, 0, -1], [time, 1, -1]);
      time += row % 4 === 0 ? 93 : 92;
    }
    const map = parseManiaBeatmap(buildVibroOsu(notes));
    expect(analyzeVibroSections(map).status).toBe("clean");
    expect(analyzeVibroSections(map, 1.2).status).toBe("excluded");
  });

  it("recognizes sustained jack phrases even when accents and repeated columns change", () => {
    const map = parseManiaBeatmap(vibroFixture(4871104));
    const result = analyzeVibroSections(map);
    expect(result.status).toBe("excluded");
    expect(result.noteShare).toBeGreaterThan(0.5);
    expect(result.sections.some((section) => section.reasons.includes("repeated_jack_stream"))).toBe(true);
    expect(detectRiceVibro(map)).toBe(true);
    expect(detectRateVibro(map)).toBe(true);
    // The fixture has anonymous metadata and OD8, so neither the pack's
    // title nor the real upload's OD5 dan floor can make this test pass.
    expect(map.od).toBe(8);
    expect(analyzeVibroSections({ ...map, od: 5, title: "ordinary practice", creator: "different mapper" })).toEqual(result);
    const baked = parseManiaBeatmap(vibroFixture(4871104, 1.5));
    expect(analyzeVibroSections(baked).status).toBe(analyzeVibroSections(map, 1.5).status);
    expect(analyzeVibroSections(baked).noteShare).toBeCloseTo(analyzeVibroSections(map, 1.5).noteShare, 4);
  });

  it("does not confuse a stream of doubles or changing chords with repeated jack phrases", () => {
    for (const masks of [
      [1, 1, 2, 2, 4, 4, 8, 8],
      [15, 3, 15, 12, 15, 5, 15, 10],
      [1, 1, 1, 3, 2, 2, 2, 6, 4, 4, 4, 12, 8, 8, 8, 9],
    ]) {
      const notes: [number, number, number][] = [];
      for (let row = 0; row < 800; row++) {
        for (let column = 0; column < 4; column++) if (masks[row % masks.length] & (1 << column)) notes.push([row * 90, column, -1]);
      }
      expect(analyzeVibroSections(parseManiaBeatmap(buildVibroOsu(notes))).status).toBe("clean");
    }
  });

  it.each([0.75, 1, 1.2, 1.5, 1.7])("gives baked edits and rate mods the same verdict at %s", (rate) => {
    const map = parseManiaBeatmap(vibroFixture(1612787));
    const baked = parseManiaBeatmap(vibroFixture(1612787, rate));
    const moddedResult = analyzeVibroSections(map, rate);
    const bakedResult = analyzeVibroSections(baked);
    expect(bakedResult.status).toBe(moddedResult.status);
    expect(bakedResult.noteShare).toBeCloseTo(moddedResult.noteShare, 4);
    expect(Math.abs(bakedResult.excludedDurationMs - moddedResult.excludedDurationMs)).toBeLessThan(2);
    expect(detectRiceVibro(baked)).toBe(detectRateVibro(map, rate));
  });

  it("adjusts only player verdicts while ordinary chart estimates retain every note", () => {
    const text = localizedVibroFixture();
    const map = parseManiaBeatmap(text);
    const prepared = prepareVibroChart(text);
    expect(prepared.analysis.status).toBe("adjusted");
    const filtered = parseManiaBeatmap(prepared.osuText);
    expect(filtered.notes.length).toBe(prepared.analysis.remainingNotes);
    expect(filtered.notes.at(-1)?.time).toBe(map.notes.at(-1)?.time);
    const ordinary = classifyChart(map, text);
    const verdict = classifyChart(map, text, { adjustVibro: true });
    const remainingVerdict = classifyChart(filtered, prepared.osuText);
    expect(ordinary.primary?.rawDan).toBeGreaterThan(verdict.primary!.rawDan);
    expect(ordinary.vibroAnalysis).toEqual(verdict.vibroAnalysis);
    expect(ordinary.warnings.some((warning) => warning.startsWith("Adjusted rating:"))).toBe(false);
    expect(verdict.vibro).toBe(false);
    expect(verdict.primary?.rawDan).toBe(remainingVerdict.primary?.rawDan);
    expect(verdict.warnings.some((warning) => warning.startsWith("Adjusted rating:"))).toBe(true);
    expect(prepareVibroChart(prepared.osuText).osuText).toBe(prepared.osuText);
  });

  it("does not let a long break dilute a predominant wall", () => {
    const notes: [number, number, number][] = [];
    for (let i = 0; i < 400; i++) for (let c = 0; c < 4; c++) notes.push([i * 60, c, -1]);
    notes.push([1_000_000, 1, -1]);
    expect(analyzeVibroSections(parseManiaBeatmap(buildVibroOsu(notes))).status).toBe("excluded");
  });

  it("does not hide an exploit-sized note stack inside an excluded section", () => {
    const text = localizedVibroFixture() + Array.from({ length: 8 }, () => "64,192,50010,1,0,0:0:0:0:").join("\n") + "\n";
    const map = parseManiaBeatmap(text);
    const verdict = classifyChart(map, text);
    expect(verdict.vibroAnalysis?.status).toBe("adjusted");
    expect(verdict.danEligibility.eligible).toBe(false);
  });

  it("assigns all accuracy loss to the retained notes, never inventing a cleaner clear", () => {
    expect(conservativeVibroAccuracy(0.96, 0.1)).toBeCloseTo(0.9555556);
    expect(conservativeVibroAccuracy(1, 0.2)).toBe(1);
    expect(conservativeVibroAccuracy(0.5, 0.9)).toBe(0);
    expect(conservativeVibroAccuracy(0.96, 0)).toBe(0.96);
  });
});
