import { describe, expect, it } from "vitest";

import { parseSkinsSearch } from "./skins";

describe("skins search params", () => {
  it("returns defaults for an empty search", () => {
    expect(parseSkinsSearch({})).toEqual({ q: "", page: 0, sort: "newest", k: 0 });
  });

  it("keeps a valid query and page", () => {
    expect(parseSkinsSearch({ q: "rainbow", page: "2" })).toEqual({ q: "rainbow", page: 2, sort: "newest", k: 0 });
  });

  it("accepts the downloads sort and rejects unknown sorts", () => {
    expect(parseSkinsSearch({ sort: "downloads" }).sort).toBe("downloads");
    expect(parseSkinsSearch({ sort: "oldest" }).sort).toBe("newest");
  });

  it("keeps a keymode filter in range and drops anything else", () => {
    expect(parseSkinsSearch({ k: "7" }).k).toBe(7);
    expect(parseSkinsSearch({ k: 10 }).k).toBe(10);
    expect(parseSkinsSearch({ k: "0" }).k).toBe(0);
    expect(parseSkinsSearch({ k: "11" }).k).toBe(0);
    expect(parseSkinsSearch({ k: "4.5" }).k).toBe(0);
    expect(parseSkinsSearch({ k: "x" }).k).toBe(0);
  });

  it("caps the query at 80 characters", () => {
    const result = parseSkinsSearch({ q: "a".repeat(120) });
    expect(result.q).toHaveLength(80);
  });

  it("clamps invalid pages to the first page", () => {
    expect(parseSkinsSearch({ page: "-3" }).page).toBe(0);
    expect(parseSkinsSearch({ page: "1.5" }).page).toBe(0);
    expect(parseSkinsSearch({ page: "x" }).page).toBe(0);
  });

  it("ignores non-string queries", () => {
    expect(parseSkinsSearch({ q: 42 }).q).toBe("");
  });
});
