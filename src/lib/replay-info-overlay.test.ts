import { describe, expect, it } from "vitest";
import type { ManiaBeatmap } from "./beatmap-parser";
import {
  buildReplayMapInfo,
  buildReplayPlayerInfo,
  formatReplayInfoLength,
  formatReplayMapDan,
  getMapInfoBpm,
  getMapInfoLength,
  mapCardInput,
} from "./replay-info-overlay";
import type { OsuScore } from "./types";

const score = {
  beatmap: { version: "Insane", total_length: 222, bpm: 200, accuracy: 8, drain: 7 },
  beatmapset: { title: "Song", artist: "Artist", creator: "Mapper" },
} as unknown as OsuScore;

const beatmap = {
  title: "File title", artist: "File artist", version: "File diff", creator: "File mapper",
  od: 7, bpm: 150, totalLength: 90_000, notes: new Array(1234).fill(null),
} as unknown as ManiaBeatmap;

describe("buildReplayMapInfo", () => {
  it("prefers the score's metadata and applies the rate to length and BPM", () => {
    const map = buildReplayMapInfo(score, beatmap, [{ acronym: "DT" }], 5.123, 4)!;
    expect(map).toMatchObject({ title: "Song", artist: "Artist", version: "Insane", creator: "Mapper", keyCount: 4, stars: 5.123 });
    expect(map.lengthMs).toBeCloseTo(148_000);
    expect(map.bpm).toBeCloseTo(300);
    expect(map.od).toBe(8);
  });

  it("falls back to the parsed file for uploads and applies HR to OD", () => {
    const map = buildReplayMapInfo(null, beatmap, [{ acronym: "HR" }], null, 7)!;
    expect(map).toMatchObject({ title: "File title", version: "File diff", lengthMs: 90_000, bpm: 150, stars: null });
    expect(map.od).toBeCloseTo(9.8);
  });

  it("returns nothing without a title", () => {
    expect(buildReplayMapInfo(null, null, [], null, 4)).toBeNull();
  });
});

describe("buildReplayPlayerInfo", () => {
  it("uppercases the country and leaves out missing images", () => {
    expect(buildReplayPlayerInfo("name", undefined, "cr")).toEqual({ name: "name", countryCode: "CR" });
  });
});

describe("formatReplayInfoLength", () => {
  it("formats minutes and hours", () => {
    expect(formatReplayInfoLength(65_400)).toBe("1:05");
    expect(formatReplayInfoLength(3_725_000)).toBe("1:02:05");
  });
});

describe("map info card readouts", () => {
  const map = buildReplayMapInfo(score, beatmap, [], 5, 4)!;

  it("follows playback when the live options are on", () => {
    const live = { bpm: 180, timeLeftMs: 61_000, progress: 0.5 };
    expect(getMapInfoLength(mapCardInput(map, {}, live))).toEqual({ ms: 222_000, remaining: false });
    expect(getMapInfoLength(mapCardInput(map, { timeLeft: true }, live))).toEqual({ ms: 61_000, remaining: true });
    expect(getMapInfoBpm(mapCardInput(map, { liveBpm: true }, live))).toBe(180);
  });

  it("prints the dan as text, LN charts marked", () => {
    expect(formatReplayMapDan({ label: "7+", family: "stream" })).toBe("Dan:7+");
    expect(formatReplayMapDan({ label: "9", family: "ln" })).toBe("LN:9");
  });
});
