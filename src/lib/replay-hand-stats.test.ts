import { describe, expect, it } from "vitest";
import { getReplayHandForColumn } from "./replay-hand-stats";

describe("replay hand stats", () => {
  it("splits even keymodes evenly", () => {
    expect([0, 1, 2, 3].map((column) => getReplayHandForColumn(column, 4, "right"))).toEqual([
      "left",
      "left",
      "right",
      "right",
    ]);
  });

  it("assigns an odd keymode's middle lane to the selected thumb", () => {
    expect([0, 1, 2, 3, 4].map((column) => getReplayHandForColumn(column, 5, "right"))).toEqual([
      "left",
      "left",
      "right",
      "right",
      "right",
    ]);
    expect([0, 1, 2, 3, 4].map((column) => getReplayHandForColumn(column, 5, "left"))).toEqual([
      "left",
      "left",
      "left",
      "right",
      "right",
    ]);
  });

  it("rejects columns outside the chart", () => {
    expect(getReplayHandForColumn(-1, 4, "right")).toBeNull();
    expect(getReplayHandForColumn(4, 4, "right")).toBeNull();
  });
});
