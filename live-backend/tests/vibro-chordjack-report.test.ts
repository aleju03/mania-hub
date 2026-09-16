import { describe, expect, it } from "vitest";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { analyzeVibroSections, prepareVibroChart } from "../src/dan/vibro-sections.js";
import { buildVibroOsu, chordjackReportFixture } from "./vibro-fixtures.js";

describe("reported chordjack and mixed-vibro geometry", () => {
  it.each(["varied_pair", "quad_omissions"])("restores %s while retaining its localized walls", (name) => {
    const text = chordjackReportFixture(name);
    const map = parseManiaBeatmap(text);
    const result = analyzeVibroSections(map);
    expect(result.status).toBe("adjusted");
    expect(result.noteShare).toBeLessThan(0.1);
    expect(result.sections.every((s) => s.reasons.every((r) => r === "repeated_wall"))).toBe(true);
    expect(parseManiaBeatmap(prepareVibroChart(text).osuText).notes.length).toBeGreaterThan(map.notes.length * 0.9);
    expect(analyzeVibroSections(map, 1.5).status).toBe("excluded");
    expect(analyzeVibroSections({ ...map, title: "different", artist: "different", creator: "different", version: "different" })).toEqual(result);
    expect(analyzeVibroSections({ ...map, notes: map.notes.map((n) => ({ ...n, column: 3 - n.column })) })).toEqual(result);
  });

  it("removes the previously credited mixed-vibro chart, including its accompanied jacks", () => {
    const result = analyzeVibroSections(parseManiaBeatmap(chordjackReportFixture("mixed_vibro")));
    expect(result.status).toBe("excluded");
    expect(result.noteShare).toBeGreaterThan(0.25);
    for (const time of [58_000, 60_000, 62_000, 63_500]) {
      expect(result.sections.some((s) => s.startTime <= time && s.endTime >= time && s.reasons.includes("isolated_jack"))).toBe(true);
    }
  });

  it.each(["longjack_control", "chordjack_control"])("does not punish %s for an isolated busy finger", (name) => {
    expect(analyzeVibroSections(parseManiaBeatmap(chordjackReportFixture(name))).status).toBe("clean");
  });

  it.each([
    ["split_exploit", 1.17, "excluded"],
    ["split_exploit_2", 1.55, "excluded"],
    ["roll_exploit", 1.06, "excluded"],
    ["trill_exploit", 1.05, "adjusted"],
  ] as const)("retains the detection of %s at %sx", (name, rate, status) => {
    expect(analyzeVibroSections(parseManiaBeatmap(chordjackReportFixture(name)), rate).status).toBe(status);
  });

  it.each(["varied_pair", "quad_omissions", "mixed_vibro"])("agrees on baked and modded rates for %s", (name) => {
    const map = parseManiaBeatmap(chordjackReportFixture(name));
    for (const rate of [0.75, 1.2, 1.5]) {
      const baked = { ...map, notes: map.notes.map((n) => ({ ...n, time: n.time / rate, endTime: n.endTime / rate })) };
      const a = analyzeVibroSections(map, rate), b = analyzeVibroSections(baked);
      expect(b.status).toBe(a.status);
      expect(b.noteShare).toBe(a.noteShare);
    }
  });

  it("requires nearby independent wall evidence and a change of locked finger for slower jacks", () => {
    const build = (wall: boolean, differentFinger: boolean, distant = false) => {
      const notes: [number, number, number][] = Array.from({ length: 800 }, (_, i) => [1000 + i * 100, i % 4, -1]);
      if (wall) for (let i = 0; i < 20; i++) for (let c = 0; c < 4; c++) notes.push([90_000 + i * 96, c, -1]);
      const from = distant ? 120_000 : 93_000;
      for (let group = 0; group < 2; group++) for (let i = 0; i < 32; i++) {
        const time = from + (group * 32 + i) * 96;
        notes.push([time, differentFinger ? group : 0, -1]);
        if (i % 3 === 0) notes.push([time, 3, -1]);
      }
      return parseManiaBeatmap(buildVibroOsu(notes.sort((a, b) => a[0] - b[0])));
    };
    const isolated = (map: ReturnType<typeof build>) => analyzeVibroSections(map).sections
      .filter((s) => s.reasons.includes("isolated_jack"));
    expect(isolated(build(true, true)).length).toBeGreaterThan(0);
    expect(isolated(build(false, true))).toHaveLength(0);
    expect(isolated(build(true, false))).toHaveLength(0);
    expect(isolated(build(true, true, true))).toHaveLength(0);
    const map = build(true, true);
    const padded = { ...map, notes: [...map.notes, ...Array.from({ length: 1000 }, (_, i) => ({
      time: 200_000 + i * 250, endTime: 200_000 + i * 250, column: i % 4, isHold: false,
    }))] };
    expect(isolated(padded)).toEqual(isolated(map));
  });
});
