import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  attachViewerRanks,
  normalizeAnalyticsViewerSort,
  sortRankedViewers,
  type RankedAnalyticsViewerRow,
} from "../src/features/analytics-viewer-ranks.js";
import type { AnalyticsViewerRow } from "../src/features/analytics.js";

// The signed-in roster and the pp figures live in two separate databases, so
// this is the seam where "who browsed the site" meets "how good they are".

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-viewer-ranks-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

async function addUser(userId: number, pp: number | null, globalRank: number | null) {
  await exec(
    db,
    "insert into users (user_id, username, avatar_url, country_code, pp, global_rank, updated_at) values (?, ?, '', 'CR', ?, ?, '2026-08-03T00:00:00Z')",
    [userId, `player${userId}`, pp, globalRank],
  );
}

function viewer(viewerId: number, lastSeen: number): AnalyticsViewerRow {
  return {
    viewerId,
    username: `player${viewerId}`,
    firstSeen: lastSeen - 86_400_000,
    lastSeen,
    events: 10,
    country: "CR",
  };
}

function ranked(
  viewerId: number,
  pp: number | null,
  globalRank: number | null,
  lastSeen = 1_000,
): RankedAnalyticsViewerRow {
  return { ...viewer(viewerId, lastSeen), pp, globalRank };
}

describe("attachViewerRanks", () => {
  it("reads pp and rank out of the main database for the roster", async () => {
    await addUser(1, 16_712.3, 409);
    await addUser(2, 9_001.5, 2_048);
    const rows = await attachViewerRanks(db, [viewer(1, 200), viewer(2, 100)]);
    expect(rows.map((row) => [row.viewerId, row.pp, row.globalRank])).toEqual([
      [1, 16_712.3, 409],
      [2, 9_001.5, 2_048],
    ]);
  });

  it("leaves a player the backend never ingested unranked rather than at zero", async () => {
    const [row] = await attachViewerRanks(db, [viewer(77, 500)]);
    expect(row.pp).toBeNull();
    expect(row.globalRank).toBeNull();
  });

  it("keeps a null pp on an ingested player null, so it sorts as unknown", async () => {
    await addUser(5, null, null);
    const [row] = await attachViewerRanks(db, [viewer(5, 500)]);
    expect(row.pp).toBeNull();
    expect(row.globalRank).toBeNull();
  });

  it("preserves the roster order it was handed", async () => {
    await addUser(3, 100, 5);
    const rows = await attachViewerRanks(db, [viewer(9, 300), viewer(3, 200), viewer(4, 100)]);
    expect(rows.map((row) => row.viewerId)).toEqual([9, 3, 4]);
  });

  it("does not query for an empty roster", async () => {
    expect(await attachViewerRanks(db, [])).toEqual([]);
  });
});

describe("sortRankedViewers", () => {
  const rows = [
    ranked(1, 9_000, 900, 500),
    ranked(2, 21_000, 46, 100),
    ranked(3, null, null, 400),
    ranked(4, 16_000, 139, 300),
  ];

  it("puts the highest pp first", () => {
    expect(sortRankedViewers(rows, "pp").map((row) => row.viewerId)).toEqual([2, 4, 1, 3]);
  });

  it("puts the best rank first, counting the other way", () => {
    expect(sortRankedViewers(rows, "rank").map((row) => row.viewerId)).toEqual([2, 4, 1, 3]);
  });

  it("sorts unranked players last rather than first, in both directions", () => {
    const unranked = [ranked(1, null, null, 100), ranked(2, 500, 5_000, 50)];
    expect(sortRankedViewers(unranked, "pp").map((row) => row.viewerId)).toEqual([2, 1]);
    expect(sortRankedViewers(unranked, "rank").map((row) => row.viewerId)).toEqual([2, 1]);
  });

  it("breaks ties on last seen, so equal players hold a stable order", () => {
    const tied = [ranked(1, 5_000, 100, 100), ranked(2, 5_000, 100, 900)];
    expect(sortRankedViewers(tied, "pp").map((row) => row.viewerId)).toEqual([2, 1]);
    const bothUnranked = [ranked(1, null, null, 100), ranked(2, null, null, 900)];
    expect(sortRankedViewers(bothUnranked, "pp").map((row) => row.viewerId)).toEqual([2, 1]);
  });

  it("falls back to newest activity first", () => {
    expect(sortRankedViewers(rows, "recent").map((row) => row.viewerId)).toEqual([1, 3, 4, 2]);
  });

  it("leaves the caller's array alone", () => {
    const original = [...rows];
    sortRankedViewers(rows, "pp");
    expect(rows).toEqual(original);
  });
});

describe("normalizeAnalyticsViewerSort", () => {
  it("takes the sorts the card offers", () => {
    expect(normalizeAnalyticsViewerSort("pp")).toBe("pp");
    expect(normalizeAnalyticsViewerSort("rank")).toBe("rank");
    expect(normalizeAnalyticsViewerSort("RECENT")).toBe("recent");
  });

  it("falls back to recent for anything else", () => {
    expect(normalizeAnalyticsViewerSort("events")).toBe("recent");
    expect(normalizeAnalyticsViewerSort(null)).toBe("recent");
    expect(normalizeAnalyticsViewerSort(7)).toBe("recent");
  });
});
