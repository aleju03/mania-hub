import { describe, expect, it } from "vitest";
import { LAZER_SCORE_ID_MIN, getOsuScoreModeName, getScoreEndpointOrder } from "./score-endpoint-order";

describe("getScoreEndpointOrder", () => {
  it("tries stable score ids through the legacy endpoint first", () => {
    expect(getScoreEndpointOrder(LAZER_SCORE_ID_MIN - 1)).toEqual(["legacy", "modern"]);
  });

  it("tries lazer score ids through the modern endpoint first", () => {
    expect(getScoreEndpointOrder(LAZER_SCORE_ID_MIN)).toEqual(["modern", "legacy"]);
  });
});

describe("getOsuScoreModeName", () => {
  it("reads the legacy response's mode string", () => {
    expect(getOsuScoreModeName({ mode: "osu", mode_int: 0 })).toBe("osu");
    expect(getOsuScoreModeName({ mode: "mania" })).toBe("mania");
  });

  it("maps solo_score ruleset ids and legacy mode_int", () => {
    expect(getOsuScoreModeName({ ruleset_id: 3 })).toBe("mania");
    expect(getOsuScoreModeName({ mode_int: 2 })).toBe("fruits");
  });

  it("returns null when the response carries no ruleset signal", () => {
    expect(getOsuScoreModeName({})).toBeNull();
    expect(getOsuScoreModeName({ mode: "", ruleset_id: 99 })).toBeNull();
  });
});
