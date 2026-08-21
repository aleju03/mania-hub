import { describe, expect, it } from "vitest";
import { formatOrdinal } from "#/lib/format";

describe("formatOrdinal", () => {
  it("suffixes the common cases", () => {
    expect([1, 2, 3, 4, 21, 22, 23, 100, 101].map((n) => formatOrdinal(n))).toEqual([
      "1st", "2nd", "3rd", "4th", "21st", "22nd", "23rd", "100th", "101st",
    ]);
  });
  it("handles the teens exception", () => {
    expect([11, 12, 13, 111, 112, 113].map((n) => formatOrdinal(n))).toEqual([
      "11th", "12th", "13th", "111th", "112th", "113th",
    ]);
  });
  it("groups thousands", () => {
    expect(formatOrdinal(1234)).toBe("1,234th");
  });
});
