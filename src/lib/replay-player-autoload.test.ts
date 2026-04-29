import { describe, expect, it } from "vitest";
import {
  normalizeReplayPlayerParam,
  shouldStartReplayPlayerLoad,
} from "./replay-player-autoload";

describe("replay player URL autoload", () => {
  it("normalizes empty player params away", () => {
    expect(normalizeReplayPlayerParam(undefined)).toBeNull();
    expect(normalizeReplayPlayerParam("   ")).toBeNull();
    expect(normalizeReplayPlayerParam(" Aleju03 ")).toBe("aleju03");
  });

  it("does not restart the same player load while it is already in flight", () => {
    expect(shouldStartReplayPlayerLoad({
      normalizedPlayerParam: "aleju03",
      loadedPlayerParam: null,
      loadingPlayerParam: "aleju03",
      hasScoreId: false,
    })).toBe(false);
  });

  it("starts a player load only when browse mode has an unloaded URL player", () => {
    expect(shouldStartReplayPlayerLoad({
      normalizedPlayerParam: "aleju03",
      loadedPlayerParam: null,
      loadingPlayerParam: null,
      hasScoreId: false,
    })).toBe(true);

    expect(shouldStartReplayPlayerLoad({
      normalizedPlayerParam: "aleju03",
      loadedPlayerParam: "aleju03",
      loadingPlayerParam: null,
      hasScoreId: false,
    })).toBe(false);

    expect(shouldStartReplayPlayerLoad({
      normalizedPlayerParam: "aleju03",
      loadedPlayerParam: null,
      loadingPlayerParam: null,
      hasScoreId: true,
    })).toBe(false);
  });
});
