import { describe, expect, it } from "vitest";
import { analyzeLnStructure4K, summarizeLnStructure4K } from "../src/dan/ln-analysis/index.js";
import { beatLengthLookup, buildLnSearchEvidence, LN_SEARCH_EVIDENCE_VERSION, LN_SHIELD_MIN_HOLDS } from "../src/dan/ln-analysis/search-evidence.js";
import { readLnSearchPatternIds } from "../src/dan/ln-analysis/search-patterns.js";
import { buildLnTimeline4K } from "../src/dan/ln-analysis/timeline.js";
import type { ManiaNote } from "../src/dan/beatmap-parser.js";

const tap = (column: number, time: number): ManiaNote => ({ column, time, endTime: time, isHold: false });
const hold = (column: number, time: number, duration = 300): ManiaNote => ({ column, time, endTime: time + duration, isHold: true });
// A tap then a hold in the same column `gap` ms later (a shield at a quarter beat of 180 BPM when gap is 83).
const shield = (time: number, gap = 83, duration = 300): ManiaNote[] => [tap(0, time), hold(0, time + gap, duration)];
// A hold then a tap `gap` ms after its release in the same column.
const reverse = (time: number, gap = 83): ManiaNote[] => [hold(1, time, 300), tap(1, time + 300 + gap)];
const summarize = (notes: ManiaNote[], limit = 128) => summarizeLnStructure4K(analyzeLnStructure4K(notes, { scoring: { od: 8 } }), limit);
const ids = (notes: ManiaNote[], eligible = true) => readLnSearchPatternIds(summarize(notes), 4, eligible);
const many = (count: number, build: (i: number) => ManiaNote[]) => Array.from({ length: count }, (_, i) => build(i)).flat();

describe("LN browsing evidence", () => {
  it("tags shields when enough of the chart's holds carry a tap a quarter beat before them", () => {
    const notes = many(24, (i) => shield(i * 1000));
    expect(ids(notes)).toEqual(["lnshield"]);
    expect(summarize(notes).searchEvidence).toEqual({ version: LN_SEARCH_EVIDENCE_VERSION, tags: { shield: { holds: 24, share: 1 } } });
  });
  it("tags reverse shields from a tap a quarter beat after the release", () => {
    expect(ids(many(24, (i) => reverse(i * 1000)))).toEqual(["lnreverseshield"]);
    // A tap after a release is ordinary LN texture: 10% of the holds is not enough.
    const filler = many(216, (i) => [hold(3, i * 400, 200)]);
    expect(ids([...many(24, (i) => reverse(i * 1000)), ...filler])).toEqual([]);
  });
  it("ignores half-beat tap/hold alternation, the ordinary LN chart texture", () => {
    expect(ids(many(40, (i) => shield(i * 1000, 167)))).toEqual([]);
    expect(ids(many(40, (i) => reverse(i * 1000, 167)))).toEqual([]);
  });
  it("needs a share of the chart, not a handful of pairs among many holds", () => {
    const filler = many(1000, (i) => [hold(2 + (i % 2), i * 400, 200)]);
    expect(ids([...many(LN_SHIELD_MIN_HOLDS, (i) => shield(i * 1000)), ...filler])).toEqual([]);
    expect(ids([...many(LN_SHIELD_MIN_HOLDS - 1, (i) => shield(i * 1000))])).toEqual([]);
    expect(ids([...many(40, (i) => shield(i * 1000)), ...filler])).toEqual(["lnshield"]);
  });
  it("requires LN eligibility and a 4K nomod structure", () => {
    const notes = many(24, (i) => shield(i * 1000));
    expect(ids(notes, false)).toEqual([]);
    expect(readLnSearchPatternIds(summarize(notes), 7, true)).toEqual([]);
    expect(readLnSearchPatternIds({ ...summarize(notes), playbackRate: 1.5 }, 4, true)).toEqual([]);
    expect(readLnSearchPatternIds({ ...summarize(notes), searchEvidence: undefined }, 4, true)).toEqual([]);
  });
  it("uses complete evidence even when the preview contains no examples", () => {
    const summary = summarize(many(24, (i) => shield(i * 1000)), 0);
    expect(summary.detections).toEqual([]);
    expect(readLnSearchPatternIds(summary, 4, true)).toContain("lnshield");
  });
  it("measures the snap against the chart's timing points", () => {
    // 120 BPM: a 125 ms gap is a quarter beat, so it shields; at the 180 BPM default it is too slow.
    const notes = many(24, (i) => shield(i * 1000, 125));
    const timeline = buildLnTimeline4K(notes, { scoring: { od: 8 } });
    expect(buildLnSearchEvidence(timeline).tags).toEqual({});
    expect(buildLnSearchEvidence(timeline, beatLengthLookup({ bpm: 120 })).tags.shield).toMatchObject({ holds: 24 });
    const points = beatLengthLookup({ timingPoints: [{ time: 0, beatLength: 500 }, { time: 12000, beatLength: 250 }], bpm: 120 }, 1, timeline.originMs);
    expect(buildLnSearchEvidence(timeline, points).tags.shield).toBeUndefined();
    expect(beatLengthLookup({ timingPoints: [{ time: 0, beatLength: 500 }] }, 1.5)(0)).toBeCloseTo(500 / 1.5);
  });
});
