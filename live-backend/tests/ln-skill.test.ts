import { describe, expect, it } from "vitest";
import { analyzeLnSkill, LN_SKILL_KEY_COUNTS } from "../src/dan/ln-skill.js";
import type { ManiaNote } from "../src/dan/beatmap-parser.js";

const hold = (column: number, time: number, duration: number): ManiaNote => ({ column, time, endTime: time + duration, isHold: duration > 0 });
const chart = (notes: ManiaNote[], od = 8) => ({ notes, keyCount: 4, od });
const stream = (gap = 200, duration = 140, count = 600) => Array.from({ length: count }, (_, i) => hold(i % 4, i * gap, duration));

describe("independent 4K LN skill", () => {
  it("prices near-window hold chains while retaining the rice publication gate", () => {
    const notes = Array.from({ length: 100 }, (_, i) => hold(0, i * 114, 57));
    const result = analyzeLnSkill(chart(notes, 8.5))!;
    expect(result.eligible).toBe(true);
    expect(result.rating).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("calibration");
    const rice = Array.from({ length: 150 }, (_, i) => hold(1 + i % 3, i * 76, 0));
    expect(analyzeLnSkill(chart([...notes, ...rice], 8.5))!.eligible).toBe(false);
    expect(analyzeLnSkill(chart(notes, 0))!.rating).toBe(0);
  });

  it("rates rice and tap-covered holds at zero", () => {
    expect(analyzeLnSkill(chart(stream(100, 0)))!.rating).toBe(0);
    expect(analyzeLnSkill(chart(stream(100, 40)))!.rating).toBe(0);
    expect(analyzeLnSkill(chart(stream(67.5, 67.5), 7.5), { rate: 1 })!.rating).toBeGreaterThan(0);
    expect(analyzeLnSkill(chart(stream(67.5, 67.5), 7.5), { rate: 1.5 })!.rating).toBe(0);
  });

  it("does not award LN difficulty for an unrelated hard rice section", () => {
    const notes = stream();
    const rice = Array.from({ length: 2000 }, (_, i) => hold(i % 4, 200_000 + i * 20, 0));
    expect(analyzeLnSkill(chart([...notes, ...rice]))!.rating).toBeCloseTo(analyzeLnSkill(chart(notes))!.rating!, 8);
  });

  it("does not award release or recovery strain to dense tap-covered overlapping holds", () => {
    const notes = Array.from({ length: 400 }, (_, i) => hold(i % 4, Math.round(i * 21.67), 43));
    for (const rate of [0.75, 1, 1.5]) {
      expect(analyzeLnSkill(chart(notes, 0), { rate })).toMatchObject({ rating: 0, eligible: false, effectiveHolds: 0 });
    }
    // Real LN work elsewhere must not make these free tails acquire strain.
    const genuine = stream(200, 140, 100).map(n => ({ ...n, time: n.time + 30_000, endTime: n.endTime + 30_000 }));
    const asTaps = notes.map(n => hold(n.column, n.time, 0));
    expect(analyzeLnSkill(chart([...notes, ...genuine], 0))!.rating)
      .toBeCloseTo(analyzeLnSkill(chart([...asTaps, ...genuine], 0))!.rating!, 8);
  });

  it("measures held-finger coordination rather than head density alone", () => {
    const isolated: ManiaNote[] = [], coordinated: ManiaNote[] = [];
    for (let i = 0; i < 200; i += 1) {
      const time = i * 600;
      isolated.push(hold(0, time, 300), hold(1, time + 400, 0));
      coordinated.push(hold(0, time, 300), hold(1, time + 150, 0));
    }
    expect(analyzeLnSkill(chart(coordinated))!.rating).toBeGreaterThan(analyzeLnSkill(chart(isolated))!.rating!);
  });

  it("distinguishes staggered releases from release chords on identical heads", () => {
    const together: ManiaNote[] = [], staggered: ManiaNote[] = [];
    for (let i = 0; i < 200; i += 1) {
      const time = i * 600;
      together.push(hold(0, time, 300), hold(1, time, 300));
      staggered.push(hold(0, time, 250), hold(1, time, 350));
    }
    expect(analyzeLnSkill(chart(staggered))!.rating).toBeGreaterThan(analyzeLnSkill(chart(together))!.rating!);
  });

  it("increases for faster non-free releases and higher score goals", () => {
    const map = chart(stream(350, 250));
    expect(analyzeLnSkill(map, { rate: 1.5 })!.rating).toBeGreaterThan(analyzeLnSkill(map)!.rating!);
    const values = [0.8, 0.9, 0.93, 0.965, 0.99].map(scoreGoal => analyzeLnSkill(map, { scoreGoal })!.rating!);
    expect(values.every((value, i) => i === 0 || value > values[i - 1])).toBe(true);
    expect(analyzeLnSkill(map, { scoreGoal: 0.5 })!.rating).toBeLessThan(analyzeLnSkill(map, { scoreGoal: 0.8 })!.rating!);
    expect(analyzeLnSkill(map, { scoreGoal: 0 })!.rating).toBe(0);
  });

  it("is invariant to time offsets/mirroring and diagnoses duplicate objects", () => {
    const notes = stream();
    const rating = analyzeLnSkill(chart(notes))!.rating!;
    expect(analyzeLnSkill(chart(notes.map(n => ({ ...n, time: n.time - 3000, endTime: n.endTime - 3000 }))))!.rating).toBeCloseTo(rating, 8);
    expect(analyzeLnSkill(chart(notes.map(n => ({ ...n, time: n.time + 137, endTime: n.endTime + 137 }))))!.rating).toBeCloseTo(rating, 8);
    expect(analyzeLnSkill(chart(notes.map(n => ({ ...n, column: 3 - n.column })).reverse()))!.rating).toBeCloseTo(rating, 8);
    const duplicate = analyzeLnSkill(chart([...notes, ...notes]))!;
    expect(duplicate.rating).toBeNull();
    expect(duplicate.structure!.diagnostics.some((item) => item.code === "duplicate_object")).toBe(true);
    for (const keyCount of [1, 2, 3, ...Array.from({ length: 14 }, (_, i) => i + 5), 19, 7.5, NaN]) expect(analyzeLnSkill({ ...chart(notes), keyCount })).toBeNull();
  });

  it("preserves the v1 4K calculation", () => {
    expect(analyzeLnSkill(chart(stream()))!.rating).toBeCloseTo(11.883534397502766, 10);
  });
});

describe.each([...LN_SKILL_KEY_COUNTS])("independent %iK LN skill", keyCount => {
  const map = (notes: ManiaNote[]) => ({ notes, keyCount, od: 8 });

  it("rates all columns, including the rightmost columns, and preserves mirrors", () => {
    const notes = Array.from({ length: 400 }, (_, i) => hold(keyCount - 2 + i % 2, i * 200, 300));
    const result = analyzeLnSkill(map(notes))!;
    expect(result).toMatchObject({ keyCount, effectiveHolds: 400, eligible: true });
    expect(result.rating).toBeGreaterThan(0);
    expect(analyzeLnSkill(map(notes.map(note => ({ ...note, column: keyCount - 1 - note.column }))))!.rating).toBeCloseTo(result.rating!, 8);
    expect(analyzeLnSkill(map(notes), { rate: 1.5 })!.rating).toBeGreaterThan(result.rating!);
  });

  it("gives no credit to free holds at a custom rate, or to pure rice", () => {
    const notes = Array.from({ length: 400 }, (_, i) => hold(i % keyCount, i * 100, 67));
    expect(analyzeLnSkill(map(notes), { rate: 1 })!.eligible).toBe(true);
    expect(analyzeLnSkill(map(notes), { rate: 1.37 })).toMatchObject({ rating: 0, eligible: false, effectiveHolds: 0 });
    expect(analyzeLnSkill(map(notes.map(note => hold(note.column, note.time, 0))))).toMatchObject({ rating: 0, eligible: false });
  });

  it("does not count an odd center twice or make isolated work harder by adding empty columns", () => {
    const middle = Math.floor(keyCount / 2);
    const notes = Array.from({ length: 200 }, (_, i) => hold(middle, i * 500, 250));
    const reference = chart(notes.map(note => ({ ...note, column: 1 })));
    expect(analyzeLnSkill(map(notes))!.strain).toBeCloseTo(analyzeLnSkill(reference)!.strain, 8);
  });
});
