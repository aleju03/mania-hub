import { describe, expect, it } from "vitest";
import {
  RANDOM_DRAW_EXCLUDE_SETS_MAX,
  RANDOM_DRAW_EXCLUDE_USERS_MAX,
  RANDOM_DRAW_HIDE_USERS_MAX,
  buildRandomDrawFilters,
  buildRandomDrawParams,
  buildRandomDrawQuery,
} from "./maps-random-draw-params";

const NO_FILTERS = {
  rStatus: "",
  rKey: "",
  rPattern: "",
  rStars: 0,
  rStarsMax: 0,
  rWeight: "favourites" as const,
};

function query(overrides: Partial<Parameters<typeof buildRandomDrawFilters>[0]>, count = 8): URLSearchParams {
  const filters = buildRandomDrawFilters({ ...NO_FILTERS, ...overrides });
  return new URLSearchParams(buildRandomDrawQuery("GLOBAL", buildRandomDrawParams(filters, { count })));
}

describe("buildRandomDrawFilters", () => {
  it("expands umbrella pattern tags on the include side", () => {
    const filters = buildRandomDrawFilters({ ...NO_FILTERS, rPattern: "stream" });
    expect(filters.patterns).toEqual(["stream", "jumpstream", "chordstream", "handstream", "dumpstream"]);
    expect(filters.patternsExclude).toEqual([]);
  });

  it("routes the `-` prefix to the exclude side and expands it too", () => {
    const filters = buildRandomDrawFilters({ ...NO_FILTERS, rPattern: "ln,-jack" });
    expect(filters.patterns).toEqual(["ln"]);
    expect(filters.patternsExclude).toEqual(["jack", "chordjack", "longjack", "speedjack", "minijack"]);
  });

  it("dedupes overlapping umbrellas", () => {
    const filters = buildRandomDrawFilters({ ...NO_FILTERS, rPattern: "jack,chordjack" });
    expect(filters.patterns).toEqual(["jack", "chordjack", "longjack", "speedjack", "minijack"]);
  });

  it("splits status and key selections into include/exclude lists", () => {
    const filters = buildRandomDrawFilters({
      ...NO_FILTERS,
      rStatus: "ranked,-graveyard",
      rKey: "-other,7k",
    });
    expect(filters.status).toEqual(["ranked"]);
    expect(filters.statusExclude).toEqual(["graveyard"]);
    expect(filters.keys).toEqual(["7k"]);
    expect(filters.keysExclude).toEqual(["other"]);
  });

  it("ignores tokens outside the allowed vocabulary", () => {
    const filters = buildRandomDrawFilters({ ...NO_FILTERS, rStatus: "ranked,qualified", rPattern: "vibro" });
    expect(filters.status).toEqual(["ranked"]);
    expect(filters.patterns).toEqual([]);
  });

  it("maps the star range and treats 0 as unset", () => {
    expect(buildRandomDrawFilters({ ...NO_FILTERS, rStars: 4.5, rStarsMax: 7 })).toMatchObject({
      starMin: 4.5,
      starMax: 7,
    });
    expect(buildRandomDrawFilters({ ...NO_FILTERS, rStars: 0, rStarsMax: 6 })).toMatchObject({
      starMin: 0,
      starMax: 6,
    });
  });

  it("falls back to the favourites weighting for anything but `players`", () => {
    expect(buildRandomDrawFilters({ ...NO_FILTERS, rWeight: "players" }).weight).toBe("players");
    expect(buildRandomDrawFilters(NO_FILTERS).weight).toBe("favourites");
  });

  it("caps and cleans the hidden-user list", () => {
    const hiddenUserIds = [0, -3, Number.NaN, ...Array.from({ length: 150 }, (_, i) => i + 1)];
    const filters = buildRandomDrawFilters({ ...NO_FILTERS, hiddenUserIds });
    expect(filters.hideUsers).toHaveLength(RANDOM_DRAW_HIDE_USERS_MAX);
    expect(filters.hideUsers[0]).toBe(1);
  });
});

describe("buildRandomDrawParams", () => {
  it("caps the recency exclusions at the server's limits", () => {
    const filters = buildRandomDrawFilters(NO_FILTERS);
    const params = buildRandomDrawParams(filters, {
      count: 8,
      excludeUsers: Array.from({ length: 20 }, (_, i) => i + 1),
      excludeSets: Array.from({ length: 40 }, (_, i) => i + 1),
    });
    expect(params.excludeUsers).toHaveLength(RANDOM_DRAW_EXCLUDE_USERS_MAX);
    expect(params.excludeSets).toHaveLength(RANDOM_DRAW_EXCLUDE_SETS_MAX);
  });

  it("dedupes ids so a queued set that is also recent costs one slot", () => {
    const filters = buildRandomDrawFilters(NO_FILTERS);
    const params = buildRandomDrawParams(filters, { count: 0, excludeSets: [10, 10, 11] });
    expect(params.excludeSets).toEqual([10, 11]);
    expect(params.count).toBe(0);
  });
});

describe("buildRandomDrawQuery", () => {
  it("omits every empty list and zero range", () => {
    const params = query({});
    expect([...params.keys()].sort()).toEqual(["count", "country", "weight"]);
    expect(params.get("country")).toBe("GLOBAL");
    expect(params.get("count")).toBe("8");
    expect(params.get("weight")).toBe("favourites");
  });

  it("serializes active filters as CSV", () => {
    const params = query({ rStatus: "ranked,-graveyard", rKey: "4k", rPattern: "stream", rStars: 4, rStarsMax: 6 });
    expect(params.get("status")).toBe("ranked");
    expect(params.get("statusExclude")).toBe("graveyard");
    expect(params.get("keys")).toBe("4k");
    expect(params.get("keysExclude")).toBeNull();
    expect(params.get("patterns")).toBe("stream,jumpstream,chordstream,handstream,dumpstream");
    expect(params.get("starMin")).toBe("4");
    expect(params.get("starMax")).toBe("6");
  });

  it("keeps a counts-only request minimal", () => {
    const params = query({}, 0);
    expect(params.get("count")).toBe("0");
    expect(params.get("excludeSets")).toBeNull();
    expect(params.get("hideUsers")).toBeNull();
  });

  it("sends hidden users so they are excluded from the counts too", () => {
    const params = query({ hiddenUserIds: [7, 9] });
    expect(params.get("hideUsers")).toBe("7,9");
  });
});
