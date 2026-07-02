import { describe, expect, it } from "vitest";
import { compareRankDeltaValues } from "../src/features/global-rankings.js";

describe("global rankings delta sort", () => {
  const namesByDeltaSort = (dir: "asc" | "desc") => {
    const rows = [
      { name: "unknown", change: null },
      { name: "gained", change: 12 },
      { name: "lost small", change: -3 },
      { name: "neutral", change: 0 },
      { name: "lost big", change: -25 },
    ] as const;

    return [...rows]
      .sort((a, b) => compareRankDeltaValues(a.change, b.change, dir))
      .map((row) => row.name);
  };

  it("sorts losses before neutral and unknown values in ascending mode", () => {
    expect(namesByDeltaSort("asc")).toEqual([
      "lost big",
      "lost small",
      "neutral",
      "gained",
      "unknown",
    ]);
  });

  it("sorts gains first while unknown values stay last in descending mode", () => {
    expect(namesByDeltaSort("desc")).toEqual([
      "gained",
      "neutral",
      "lost small",
      "lost big",
      "unknown",
    ]);
  });
});
