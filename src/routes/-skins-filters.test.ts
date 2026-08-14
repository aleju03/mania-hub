import { describe, expect, it } from "vitest";

import { parseSkinsSearch } from "./skins";

const DEFAULTS = {
  q: "",
  page: 0,
  sort: "newest",
  k: 0,
  special: false,
  mine: false,
  cover: false,
  stage: false,
  shots: false,
  lazer: false,
  stable: false,
  shape: "",
  res: "",
};

describe("skins search params", () => {
  it("returns defaults for an empty search", () => {
    expect(parseSkinsSearch({})).toEqual(DEFAULTS);
  });

  it("keeps a valid query and page", () => {
    expect(parseSkinsSearch({ q: "rainbow", page: "2" })).toEqual({ ...DEFAULTS, q: "rainbow", page: 2 });
  });

  it("reads the uploader filter from either the boolean or its URL form", () => {
    expect(parseSkinsSearch({ mine: true }).mine).toBe(true);
    expect(parseSkinsSearch({ mine: "true" }).mine).toBe(true);
    expect(parseSkinsSearch({ mine: "1" }).mine).toBe(true);
    expect(parseSkinsSearch({ mine: "0" }).mine).toBe(false);
    expect(parseSkinsSearch({ mine: "aleju03" }).mine).toBe(false);
  });

  it("accepts both directions of every sort and rejects unknown ones", () => {
    for (const sort of ["oldest", "downloads", "downloads-asc", "size", "size-asc"]) {
      expect(parseSkinsSearch({ sort }).sort).toBe(sort);
    }
    expect(parseSkinsSearch({ sort: "newest-asc" }).sort).toBe("newest");
    expect(parseSkinsSearch({ sort: "size-desc" }).sort).toBe("newest");
  });

  it("keeps a keymode filter in range and drops anything else", () => {
    expect(parseSkinsSearch({ k: "7" }).k).toBe(7);
    expect(parseSkinsSearch({ k: 10 }).k).toBe(10);
    expect(parseSkinsSearch({ k: "0" }).k).toBe(0);
    expect(parseSkinsSearch({ k: "11" }).k).toBe(0);
    expect(parseSkinsSearch({ k: "4.5" }).k).toBe(0);
    expect(parseSkinsSearch({ k: "x" }).k).toBe(0);
  });

  it("keeps the 7K+1 refinement only on an 8K filter", () => {
    expect(parseSkinsSearch({ k: "8", special: true }).special).toBe(true);
    expect(parseSkinsSearch({ k: "8", special: "1" }).special).toBe(true);
    expect(parseSkinsSearch({ k: "8" }).special).toBe(false);
    // Off 8K the refinement means nothing and is dropped.
    expect(parseSkinsSearch({ k: "7", special: true }).special).toBe(false);
    expect(parseSkinsSearch({ special: true }).special).toBe(false);
  });

  it("reads each trait checkbox in its boolean and URL forms", () => {
    for (const flag of ["cover", "stage", "shots", "lazer", "stable"] as const) {
      expect(parseSkinsSearch({ [flag]: true })[flag]).toBe(true);
      expect(parseSkinsSearch({ [flag]: "1" })[flag]).toBe(true);
      expect(parseSkinsSearch({ [flag]: "no" })[flag]).toBe(false);
      expect(parseSkinsSearch({})[flag]).toBe(false);
    }
  });

  it("normalizes conflicting client flags to any", () => {
    expect(parseSkinsSearch({ stable: "1", lazer: "1" })).toMatchObject({ stable: false, lazer: false });
  });

  it("keeps a known note shape and drops anything else", () => {
    for (const shape of ["circle", "arrow", "bar", "other"]) {
      expect(parseSkinsSearch({ shape }).shape).toBe(shape);
    }
    expect(parseSkinsSearch({ shape: "star" }).shape).toBe("");
    expect(parseSkinsSearch({ shape: 4 }).shape).toBe("");
  });

  it("normalizes the resolution filter and drops what it cannot read", () => {
    expect(parseSkinsSearch({ res: "1920x1080" }).res).toBe("1920x1080");
    expect(parseSkinsSearch({ res: "2560 × 1440" }).res).toBe("2560x1440");
    expect(parseSkinsSearch({ res: "1080p" }).res).toBe("");
    expect(parseSkinsSearch({ res: 1080 }).res).toBe("");
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
