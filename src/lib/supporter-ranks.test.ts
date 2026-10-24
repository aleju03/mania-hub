import { describe, expect, it } from "vitest";

import { SUPPORTER_RANKS, SUPPORTER_RANK_MONTH_MS, supporterRank } from "./supporter-ranks";

const START = Date.UTC(2026, 9, 1);

describe("supporterRank", () => {
  it("is Amber on the first day and moves up one rank a month", () => {
    expect(supporterRank(START, START)).toMatchObject({ index: 0, months: 1, nextAt: START + SUPPORTER_RANK_MONTH_MS });
    expect(supporterRank(START, START + SUPPORTER_RANK_MONTH_MS - 1).index).toBe(0);
    expect(supporterRank(START, START + SUPPORTER_RANK_MONTH_MS).def.id).toBe("topaz");
    expect(supporterRank(START, START + 7 * SUPPORTER_RANK_MONTH_MS + 5).def.id).toBe("ruby");
  });

  it("stops at the top rank and keeps counting months", () => {
    const rank = supporterRank(START, START + 20 * SUPPORTER_RANK_MONTH_MS);
    expect(rank.index).toBe(SUPPORTER_RANKS.length - 1);
    expect(rank.months).toBe(21);
    expect(rank.nextAt).toBeNull();
  });
});
