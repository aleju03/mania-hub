import { describe, expect, it } from "vitest";
import type { ManiaNote } from "../src/dan/beatmap-parser.js";
import { analyzeLnStructure4K } from "../src/dan/ln-analysis/index.js";
import { buildLnTimeline4K } from "../src/dan/ln-analysis/timeline.js";
import { findLnTerms } from "../src/dan/ln-analysis/glossary.js";

const hold = (column: number, time: number, endTime: number): ManiaNote => ({ column, time, endTime, isHold: true });
const tap = (column: number, time: number): ManiaNote => ({ column, time, endTime: time, isHold: false });
const tags = (notes: ManiaNote[]) => analyzeLnStructure4K(notes).detections.map((detection) => detection.tag);

describe("lossless 4K LN timeline", () => {
  it("preserves same-time release/repress masks and carries held state across windows", () => {
    const notes = [hold(0, 0, 500), hold(0, 500, 1500), tap(1, 750)];
    const result = analyzeLnStructure4K(notes);
    expect(result.timeline.rows.find((row) => row.timeMs === 500)).toMatchObject({
      holdHeadMask: 1, holdTailMask: 1, heldBeforeMask: 1, heldAfterMask: 1, headIds: [1], tailIds: [0],
    });
    expect(result.sections.map((section) => [section.heldAtStart, section.heldAtEnd])).toEqual([[0, 1], [1, 1], [1, 0]]);
    const shuffled = buildLnTimeline4K([...notes].reverse());
    expect(shuffled.rows.map(({ tapIds, headIds, tailIds, ...row }) => row))
      .toEqual(result.timeline.rows.map(({ tapIds, headIds, tailIds, ...row }) => row));
    expect(shuffled.cacheKey).toBe(result.timeline.cacheKey);
  });

  it("keeps near-simultaneous events distinct and never invents tap releases", () => {
    const result = buildLnTimeline4K([tap(0, 0), tap(1, 0.2), hold(2, 0.3, 90.4)]);
    expect(result.rows.map((row) => row.timeMs)).toEqual([0, 0.2, 0.3, 90.4]);
    expect(result.rows[1].heldBeforeMask).toBe(0);
    expect(result.rows.filter((row) => row.holdTailMask)).toHaveLength(1);
  });

  it("diagnoses invalid and duplicate objects rather than manufacturing strain", () => {
    const result = buildLnTimeline4K([hold(0, 0, 500), hold(0, 100, 600), hold(0, 0, 500),
      hold(1, 100, 100), hold(2, 100, NaN), tap(7, 200), tap(0, 300)]);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      "same_lane_overlap", "duplicate_object", "invalid_hold_length", "invalid_time", "invalid_lane", "tap_inside_hold",
    ]));
    expect(result.objects).toHaveLength(1);
    expect(analyzeLnStructure4K([hold(0, 100, 50)]).profiles.ln_release).not.toHaveProperty("rating");
  });

  it("keys caches by endpoints, scoring settings, hand mapping and playback rate", () => {
    const base = [hold(0, 0, 500), hold(1, 0, 500)];
    const key = buildLnTimeline4K(base).cacheKey;
    expect(buildLnTimeline4K([hold(0, 0, 400), hold(1, 0, 600)]).cacheKey).not.toBe(key);
    expect(buildLnTimeline4K(base, { rate: 1.5 }).cacheKey).not.toBe(key);
    expect(buildLnTimeline4K(base, { scoring: { client: "stable" } }).cacheKey).not.toBe(key);
    expect(buildLnTimeline4K(base, { scoring: { od: 7 } }).cacheKey).not.toBe(key);
    expect(buildLnTimeline4K(base, { hands: [0, 1, 0, 1] }).cacheKey).not.toBe(key);
  });
});

describe("4K LN structural profiles", () => {
  it("distinguishes synchronous and staggered releases with identical heads", () => {
    const synchronous = analyzeLnStructure4K([hold(0, 0, 500), hold(1, 0, 500)]);
    const staggered = analyzeLnStructure4K([hold(0, 0, 400), hold(1, 0, 600)]);
    expect(synchronous.profiles.ln_release.measurements.releaseRows).toBe(1);
    expect(staggered.profiles.ln_release.measurements.releaseRows).toBe(2);
    expect(synchronous.detections.some((detection) => detection.tag === "chord_release")).toBe(true);
    expect(staggered.detections.some((detection) => detection.tag === "staggered_release")).toBe(true);
    expect(staggered.profiles.ln_release).not.toHaveProperty("rating"); // Structure, not a difficulty axis.
    expect(staggered.profiles.ln_release).not.toHaveProperty("calibration");
    expect(staggered.technical).not.toHaveProperty("rating");
    expect(staggered).not.toHaveProperty("unsupported");
  });

  it("distinguishes same-hand held-finger activity from opposite-hand activity", () => {
    const same = analyzeLnStructure4K([hold(0, 0, 1000), tap(1, 200), tap(1, 250)]);
    const opposite = analyzeLnStructure4K([hold(0, 0, 1000), tap(3, 200), tap(3, 250)]);
    expect(same.profiles.ln_coordination.measurements.sameHandActions).toBe(2);
    expect(opposite.profiles.ln_coordination.measurements.sameHandActions).toBe(0);
    expect(opposite.profiles.ln_coordination.measurements.oppositeHandActions).toBe(2);
    expect(same.detections.some((detection) => detection.tag === "hold_and_jack")).toBe(true);
  });

  it("measures repress gaps separately from equal head intervals", () => {
    const short = analyzeLnStructure4K([hold(0, 0, 50), hold(0, 200, 250)]);
    const long = analyzeLnStructure4K([hold(0, 0, 190), hold(0, 200, 390)]);
    expect(short.profiles.ln_inverse.measurements.meanRepressGapMs).toBe(150);
    expect(long.profiles.ln_inverse.measurements.meanRepressGapMs).toBe(10);
    expect(short.profiles.ln_density.measurements.medianHeadGapMs).toBe(long.profiles.ln_density.measurements.medianHeadGapMs);
  });

  it("recognizes held-wall coordination without inferring inverse", () => {
    const walls = [hold(0, 0, 1000), hold(3, 0, 1000), tap(1, 300), tap(2, 400)];
    expect(tags(walls)).toContain("held_chord_coordination");
    expect(tags(walls)).not.toContain("inverse");
    const staticWall = Array.from({ length: 4 }, (_, lane) => hold(lane, 0, 1000));
    expect(tags(staticWall)).not.toContain("inverse");
    expect(analyzeLnStructure4K(staticWall).profiles.ln_density.measurements.laneOccupancyShare).toBe(1);
  });

  it("finds shields and reverse shields despite intervening global rows", () => {
    expect(tags([tap(0, 0), tap(3, 20), hold(0, 40, 200)])).toContain("shield");
    expect(tags([hold(0, 0, 100), tap(3, 110), tap(0, 120)])).toContain("reverse_shield");
  });

  it("recognizes partial and variable-gap inverse, but not short holds with long rests", () => {
    const inverse = [hold(0, 0, 180), hold(0, 200, 350), hold(0, 400, 590), hold(0, 600, 780), tap(3, 300)];
    expect(tags(inverse)).toEqual(expect.arrayContaining(["inverse", "partial_lane_inverse", "variable_gap_inverse"]));
    expect(tags([hold(0, 0, 50), hold(0, 200, 250), hold(0, 400, 450), hold(0, 600, 650)])).not.toContain("inverse");
  });

  it("retains exposed slow releases and nesting/crossing evidence", () => {
    expect(tags([hold(0, 0, 2000)])).toContain("exposed_release");
    expect(tags([hold(0, 0, 1000), hold(1, 200, 700)])).toContain("nested_holds");
    expect(tags([hold(0, 0, 700), hold(1, 200, 1000)])).toContain("crossing_holds");
  });

  it("keeps local inverse sections across long recovery gaps and preserves nearby opposition", () => {
    const first = [hold(0, 0, 180), hold(0, 200, 380), hold(0, 400, 580)];
    const second = first.map((note) => ({ ...note, time: note.time + 10000, endTime: note.endTime + 10000 }));
    const analysis = analyzeLnStructure4K([...first, ...second]);
    expect(analysis.detections.filter((detection) => detection.tag === "inverse")).toHaveLength(2);
    expect(analysis.profiles.ln_inverse.coverage.timeShare).toBeLessThan(0.2);
    expect(analysis.stamina.recoveryMs.some((gap) => gap > 9000)).toBe(true);
    expect(tags([hold(0, 0, 100), tap(1, 103)])).toContain("near_press_release_opposition");
    expect(analyzeLnStructure4K([hold(0, 0, 100), tap(1, 103)]).timeline.rows.map((row) => row.timeMs)).toEqual([0, 100, 103]);
  });

  it("has no LN detections or interaction work on pure rice", () => {
    const result = analyzeLnStructure4K([tap(0, 0), tap(1, 100), tap(2, 200), tap(3, 300)]);
    expect(result.detections).toEqual([]);
    expect(Object.values(result.profiles).every((profile) => profile.coverage.objects === 0 && !("rating" in profile))).toBe(true);
    expect(result.sections.every((section) => Object.values(section.workload).every((value) => value === 0))).toBe(true);
  });

  it("preserves measurements under mirror, timestamp shifts and equivalent rates", () => {
    const notes = [hold(0, 1000, 1800), hold(1, 1200, 1600), tap(2, 1300), hold(0, 1900, 2500), hold(0, 2550, 3100)];
    const base = analyzeLnStructure4K(notes);
    const mirror = analyzeLnStructure4K(notes.map((note) => ({ ...note, column: 3 - note.column })));
    const shifted = analyzeLnStructure4K(notes.map((note) => ({ ...note, time: note.time + 5000, endTime: note.endTime + 5000 })));
    const scaled = analyzeLnStructure4K(notes.map((note) => ({ ...note, time: note.time * 1.5, endTime: note.endTime * 1.5 })), { rate: 1.5 });
    for (const other of [mirror, shifted, scaled]) {
      expect(other.profiles).toEqual(base.profiles);
      expect(other.stamina).toEqual(base.stamina);
      expect(other.technical.tags.sort()).toEqual(base.technical.tags.sort());
    }
  });

  it("keeps ambiguous community aliases distinct from detector confidence", () => {
    expect(findLnTerms("walls").map((term) => term.id)).toEqual(["inverse", "held_chord_coordination"]);
    expect(findLnTerms("half-inverse").map((term) => term.id)).toEqual(["variable_gap_inverse", "partial_lane_inverse"]);
    expect(findLnTerms("Inverse Shield").map((term) => term.id)).toEqual(["inverse_shield"]);
    expect(findLnTerms("Inverse Shield")[0].context).toContain("not a reverse-shield alias");
  });
});
