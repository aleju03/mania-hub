import { describe, expect, it } from "vitest";
import { SUPPORTER_AVATAR_FRAMES } from "./supporter-avatar-frames";
import { buildFramesManifest } from "./supporter-frames-manifest";

const ORIGIN = "https://mania-tracker.com";
const STILL = `https://cdn.mania-tracker.com/frames/${"a".repeat(64)}.png`;
const ROUND = `https://cdn.mania-tracker.com/frames/${"b".repeat(64)}.png`;
const VIDEO = `https://cdn.mania-tracker.com/frames/${"c".repeat(64)}.webm`;

describe("frames manifest", () => {
  const { frames } = buildFramesManifest(ORIGIN, {
    u1: { name: "a", still: STILL, video: VIDEO, round: ROUND, roundVideo: VIDEO, overhang: [0.1, 0.1, 0.1, 0.1] },
    u2: { name: "b", still: STILL, video: null, round: null, roundVideo: null, overhang: [0, 0, 0, 0] },
  });

  it("names every built-in frame with absolute files", () => {
    for (const id of SUPPORTER_AVATAR_FRAMES) {
      const entry = frames[id];
      expect(entry.box).toHaveLength(4);
      expect(entry.overhang).toHaveLength(4);
      for (const url of [entry.still, entry.round, entry.video, entry.roundVideo].filter(Boolean)) expect(url).toMatch(/^https:\/\/mania-tracker\.com\/images\/supporter-frames\//);
    }
  });

  it("gives a video only to frames that loop, and the live-drawn ones their still", () => {
    expect(frames.crown.video).toBeUndefined();
    expect(frames.wisteria).toMatchObject({ round: expect.stringContaining("wisteria-round.png"), video: expect.stringContaining("wisteria.webm") });
    expect(frames.wisteria.roundVideo).toBeUndefined();
    for (const id of ["desktop-icon", "dan-license", "trophy-shelf"]) expect(Object.keys(frames[id]).sort()).toEqual(["box", "overhang", "still"]);
  });

  it("marks square windows and avatar filters", () => {
    expect(frames["old-photo"]).toMatchObject({ square: true, avatarFilter: expect.stringContaining("sepia") });
    expect(frames.wisteria.square).toBeUndefined();
  });

  it("draws workshop frames from their art", () => {
    expect(frames.u1).toEqual({ box: expect.any(Array), overhang: [0.1, 0.1, 0.1, 0.1], still: STILL, round: ROUND, video: VIDEO, roundVideo: VIDEO });
    expect(frames.u2).toEqual({ box: expect.any(Array), overhang: [0, 0, 0, 0], still: STILL, square: true });
  });
});
