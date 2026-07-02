import { describe, expect, it } from "vitest";
import { compareRankDeltaValues } from "./rankings";

describe("compareRankDeltaValues", () => {
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

  it("sorts losses first when looking for rank drops", () => {
    expect(namesByDeltaSort("asc")).toEqual([
      "lost big",
      "lost small",
      "neutral",
      "gained",
      "unknown",
    ]);
  });

  it("sorts gains first while keeping unknown changes last", () => {
    expect(namesByDeltaSort("desc")).toEqual([
      "gained",
      "neutral",
      "lost small",
      "lost big",
      "unknown",
    ]);
  });
});
