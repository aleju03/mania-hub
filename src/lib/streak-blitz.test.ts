// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { normalizeBlitzStreakPool } from "./streak-blitz";

describe("normalizeBlitzStreakPool", () => {
  // The validator used to recognise only "anyone" and collapse everything else
  // to "top". Top 500 is the default mode (StreakGame.tsx), so every run from
  // it was filed onto the Top 1000 board and the Top 500 board stayed empty --
  // 0 rows in pack_streak_bests for that pool on prod.
  it("keeps top500 instead of collapsing it onto the top-1000 board", () => {
    expect(normalizeBlitzStreakPool("top500")).toBe("top500");
  });

  it("keeps the other two pools distinct", () => {
    expect(normalizeBlitzStreakPool("anyone")).toBe("anyone");
    expect(normalizeBlitzStreakPool("top")).toBe("top");
  });

  it("falls back to top for anything unrecognised", () => {
    for (const value of [undefined, null, "", "TOP500", "nonsense", 500, {}]) {
      expect(normalizeBlitzStreakPool(value)).toBe("top");
    }
  });
});
