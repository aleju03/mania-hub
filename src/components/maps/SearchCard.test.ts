import { describe, expect, it } from "vitest";
import { stripKeymodePrefix } from "./SearchCard";

describe("stripKeymodePrefix", () => {
  it("drops a leading keymode, bracketed or not", () => {
    expect(stripKeymodePrefix("[4K] Easy")).toBe("Easy");
    expect(stripKeymodePrefix("7K Another")).toBe("Another");
    expect(stripKeymodePrefix("[10K] - Final")).toBe("Final");
    expect(stripKeymodePrefix("(4k) Hard")).toBe("Hard");
  });

  it("leaves names where the keymode is not a prefix, or is the whole name", () => {
    expect(stripKeymodePrefix("Dain's 7K Light")).toBe("Dain's 7K Light");
    expect(stripKeymodePrefix("4Keys Insane")).toBe("4Keys Insane");
    expect(stripKeymodePrefix("[4K]")).toBe("[4K]");
  });
});
