import { describe, expect, it } from "vitest";
import { LAZER_SCORE_ID_MIN, getScoreEndpointOrder } from "./score-endpoint-order";

describe("getScoreEndpointOrder", () => {
  it("tries stable score ids through the legacy endpoint first", () => {
    expect(getScoreEndpointOrder(LAZER_SCORE_ID_MIN - 1)).toEqual(["legacy", "modern"]);
  });

  it("tries lazer score ids through the modern endpoint first", () => {
    expect(getScoreEndpointOrder(LAZER_SCORE_ID_MIN)).toEqual(["modern", "legacy"]);
  });
});
