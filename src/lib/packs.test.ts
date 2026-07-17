import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveGlobalRankingEntry } from "./live-backend";
import type { LeanRankingEntry, OsuScore } from "./types";
import {
  DEEP_COUNTRY_POOL,
  DEEP_MAX_RANK,
  DEEP_MIN_RANK,
  drawDeepPackEntry,
  drawPackPlayersFromPool,
  fetchPackPlayerScores,
  isDeepRank,
  liveEntryToPackPlayer,
  MAX_PACK_RANK,
  PACK_SIZE,
  PACK_SLOT_BANDS,
  PACK_TYPES,
  packSlotBandsForCount,
  packTypeById,
  pickDeepCountry,
  pickPackEntries,
  pickUnownedPoolEntry,
  POOL_SLICE_MIN_PLAYERS,
  poolSliceSize,
  rankIndexInPage,
  rankToPage,
  RANKINGS_PAGE_SIZE,
  rollPackRanks,
  rollUniformPositions,
  sortIntoRevealOrder,
  toPackPlayer,
} from "./packs";
import {
  fetchLivePlayerCachedProfileSnapshotDirect,
  fetchLivePlayerProfileSnapshotDirect,
  isLiveBackendConfigured,
} from "./live-backend";
import { getUserScoresBestWindow } from "./osu";

vi.mock("./live-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live-backend")>()),
  isLiveBackendConfigured: vi.fn(() => true),
  fetchLivePlayerCachedProfileSnapshotDirect: vi.fn(),
  fetchLivePlayerProfileSnapshotDirect: vi.fn(),
}));

vi.mock("./osu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./osu")>()),
  getUserScoresBestWindow: vi.fn(),
}));

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeEntry(rank: number, userId = rank): LeanRankingEntry {
  return {
    user: {
      id: userId,
      username: `player${userId}`,
      avatar_url: `https://a.ppy.sh/${userId}`,
      cover_url: "",
      country_code: "CR",
      is_online: false,
    },
    hit_accuracy: 98,
    play_count: 1000,
    pp: 20000 - rank,
    global_rank: rank,
    ranked_score: 0,
    grade_counts: { ss: 0, ssh: 0, s: 0, sh: 0, a: 0 },
  };
}

function makePage(pageNumber: number): LeanRankingEntry[] {
  const firstRank = (pageNumber - 1) * RANKINGS_PAGE_SIZE + 1;
  return Array.from({ length: RANKINGS_PAGE_SIZE }, (_, index) => makeEntry(firstRank + index));
}

describe("rollPackRanks", () => {
  it("returns one rank per slot, inside that slot's bands", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const ranks = rollPackRanks(mulberry32(seed));
      expect(ranks).toHaveLength(PACK_SIZE);
      ranks.forEach((rank, slot) => {
        const bands = PACK_SLOT_BANDS[slot];
        const inSomeBand = bands.some((band) => rank >= band.minRank && rank <= band.maxRank);
        expect(inSomeBand).toBe(true);
        expect(rank).toBeGreaterThanOrEqual(1);
        expect(rank).toBeLessThanOrEqual(DEEP_MAX_RANK);
      });
    }
  });

  it("can roll a top-3 hit in the last slot", () => {
    const sawTop3 = Array.from({ length: 4000 }, (_, seed) => rollPackRanks(mulberry32(seed + 1)))
      .some((ranks) => ranks[PACK_SIZE - 1] <= 3);
    expect(sawTop3).toBe(true);
  });

  it("rolls deep ranks for the first slot and never for the hit slot", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const ranks = rollPackRanks(mulberry32(seed));
      expect(isDeepRank(ranks[0])).toBe(true);
      expect(isDeepRank(ranks[PACK_SIZE - 1])).toBe(false);
    }
  });

  it("sizes slot bands to the pack's card count, keeping one hit slot", () => {
    expect(packSlotBandsForCount(PACK_SIZE)).toBe(PACK_SLOT_BANDS);
    for (const count of [3, 7, 10]) {
      const bands = packSlotBandsForCount(count);
      expect(bands).toHaveLength(count);
      // The hit slot's bands stay at the end regardless of size.
      expect(bands[count - 1]).toBe(PACK_SLOT_BANDS[PACK_SLOT_BANDS.length - 1]);
      const ranks = rollPackRanks(mulberry32(17), count);
      expect(ranks).toHaveLength(count);
      expect(isDeepRank(ranks[count - 1])).toBe(false);
    }
  });
});

describe("deep draws", () => {
  it("flags ranks past the global page cap as deep", () => {
    expect(isDeepRank(MAX_PACK_RANK)).toBe(false);
    expect(isDeepRank(DEEP_MIN_RANK)).toBe(true);
  });

  it("picks countries from the pool with sane page windows", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const window = pickDeepCountry(mulberry32(seed));
      expect(DEEP_COUNTRY_POOL).toContain(window);
      expect(window.minPage).toBeGreaterThanOrEqual(1);
      expect(window.maxPage).toBeLessThanOrEqual(200);
      expect(window.maxPage).toBeGreaterThan(window.minPage);
    }
  });

  it("returns an unused in-band player and marks it used", async () => {
    const used = new Set<number>([20_000]);
    const fetcher = async () => [
      makeEntry(9_000), // too shallow for the deep band
      makeEntry(20_000), // already in the pack
      makeEntry(30_000),
      makeEntry(60_000), // past the band
    ];
    const entry = await drawDeepPackEntry(mulberry32(3), used, fetcher);
    expect(entry?.global_rank).toBe(30_000);
    expect(used.has(30_000)).toBe(true);
  });

  it("retries on fetch errors and gives up after its attempts", async () => {
    let calls = 0;
    const failing = async (): Promise<LeanRankingEntry[]> => {
      calls += 1;
      throw new Error("osu! down");
    };
    const entry = await drawDeepPackEntry(mulberry32(5), new Set(), failing, 3);
    expect(entry).toBeNull();
    expect(calls).toBe(3);
  });

  it("returns null when every candidate is out of band", async () => {
    const fetcher = async () => [makeEntry(500), makeEntry(900_000)];
    const entry = await drawDeepPackEntry(mulberry32(9), new Set(), fetcher);
    expect(entry).toBeNull();
  });
});

describe("rank page math", () => {
  it("maps ranks to rankings pages and row indices", () => {
    expect(rankToPage(1)).toBe(1);
    expect(rankIndexInPage(1)).toBe(0);
    expect(rankToPage(50)).toBe(1);
    expect(rankIndexInPage(50)).toBe(49);
    expect(rankToPage(51)).toBe(2);
    expect(rankIndexInPage(51)).toBe(0);
    expect(rankToPage(MAX_PACK_RANK)).toBe(200);
  });
});

describe("pickPackEntries", () => {
  it("picks the exact row for each rolled rank", () => {
    const pages = new Map([[1, makePage(1)], [3, makePage(3)]]);
    const entries = pickPackEntries([2, 105, 150], pages, mulberry32(7));
    expect(entries.map((entry) => entry.global_rank)).toEqual([2, 105, 150]);
  });

  it("never returns the same player twice", () => {
    const pages = new Map([[1, makePage(1)]]);
    const entries = pickPackEntries([5, 5, 5, 5, 5], pages, mulberry32(11));
    expect(entries).toHaveLength(5);
    const ids = entries.map((entry) => entry.user.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toContain(5);
  });

  it("falls back to other fetched pages when a page is empty", () => {
    const pages = new Map<number, LeanRankingEntry[]>([[1, []], [2, makePage(2)]]);
    const entries = pickPackEntries([10, 60], pages, mulberry32(3));
    expect(entries).toHaveLength(2);
    entries.forEach((entry) => expect(rankToPage(entry.global_rank)).toBe(2));
  });

  it("returns fewer entries instead of failing when the pool runs dry", () => {
    const tinyPage = [makeEntry(1), makeEntry(2)];
    const entries = pickPackEntries([1, 2, 3], new Map([[1, tinyPage]]), mulberry32(5));
    expect(entries).toHaveLength(2);
  });

  it("skips players already claimed by deep draws", () => {
    const used = new Set<number>([2]);
    const entries = pickPackEntries([2], new Map([[1, makePage(1)]]), mulberry32(13), used);
    expect(entries).toHaveLength(1);
    expect(entries[0].user.id).not.toBe(2);
  });
});

function makePoolEntry(position: number): LiveGlobalRankingEntry {
  return {
    rank: position,
    user: {
      id: 100_000 + position,
      username: `tracked${position}`,
      avatar_url: `https://a.ppy.sh/${100_000 + position}`,
      cover_url: "",
      country_code: "CR",
    },
    pp: 20_000 - position,
    global_rank: position * 3, // tracked pools are sparse in global-rank space
    country_rank: position,
    hit_accuracy: 97,
    play_count: 5000,
    ranked_score: 0,
    grade_counts: null,
    global_change: null,
    country_change: null,
  };
}

function makePoolFetcher(total: number) {
  const calls: number[] = [];
  const fetchPage = async (page: number) => {
    calls.push(page);
    const first = (page - 1) * RANKINGS_PAGE_SIZE + 1;
    const count = Math.max(0, Math.min(RANKINGS_PAGE_SIZE, total - first + 1));
    return {
      ranking: Array.from({ length: count }, (_, index) => makePoolEntry(first + index)),
      total,
    };
  };
  return { fetchPage, calls };
}

describe("tracked pool draws", () => {
  it("rolls uniform positions inside the pool for any size", () => {
    for (const total of [120, 850, 5853, 60_000]) {
      for (let seed = 1; seed <= 50; seed += 1) {
        for (const position of rollUniformPositions(total, PACK_SIZE, mulberry32(seed))) {
          expect(position).toBeGreaterThanOrEqual(1);
          expect(position).toBeLessThanOrEqual(total);
        }
      }
    }
  });

  it("can roll both ends of the pool", () => {
    const total = 5853;
    const positions = Array.from({ length: 400 }, (_, seed) =>
      rollUniformPositions(total, PACK_SIZE, mulberry32(seed + 1)),
    ).flat();
    expect(positions.some((position) => position <= total * 0.1)).toBe(true);
    expect(positions.some((position) => position >= total * 0.9)).toBe(true);
  });

  it("draws a full pack of distinct tracked players, weakest first", async () => {
    const { fetchPage, calls } = makePoolFetcher(5853);
    const { players, poolTotal } = await drawPackPlayersFromPool(mulberry32(21), fetchPage);
    expect(poolTotal).toBe(5853);
    expect(players).toHaveLength(PACK_SIZE);
    expect(new Set(players.map((player) => player.user.id)).size).toBe(PACK_SIZE);
    for (let index = 1; index < players.length; index += 1) {
      expect(players[index - 1].globalRank).toBeGreaterThanOrEqual(players[index].globalRank);
    }
    // Page 1 is fetched once for the pool size and reused, never refetched.
    expect(calls.filter((page) => page === 1)).toHaveLength(1);
  });

  it("draws bigger packs when the type asks for more cards", async () => {
    for (const count of [7, 10]) {
      const { fetchPage } = makePoolFetcher(5853);
      const { players } = await drawPackPlayersFromPool(mulberry32(33), fetchPage, { count });
      expect(players).toHaveLength(count);
      expect(new Set(players.map((player) => player.user.id)).size).toBe(count);
      for (let index = 1; index < players.length; index += 1) {
        expect(players[index - 1].globalRank).toBeGreaterThanOrEqual(players[index].globalRank);
      }
    }
  });

  it("draws sliced packs from the pool's top slice only", async () => {
    const total = 5853;
    const topSlice = poolSliceSize(total, 0.1);
    expect(topSlice).toBe(Math.round(total * 0.1));
    // Tiny pools widen the slice to a sane floor instead of repeating 5 players.
    expect(poolSliceSize(120, 0.1)).toBe(POOL_SLICE_MIN_PLAYERS);
    expect(poolSliceSize(120, 1)).toBe(120);
    for (let seed = 1; seed <= 30; seed += 1) {
      const { fetchPage } = makePoolFetcher(total);
      const { players } = await drawPackPlayersFromPool(mulberry32(seed), fetchPage, { topFraction: 0.1 });
      expect(players).toHaveLength(PACK_SIZE);
      for (const player of players) {
        // makePoolEntry ids encode the pool position. Collision fallbacks
        // stay within the slice's fetched pages, so the bound is the last
        // page's edge, not the exact slice size.
        expect(player.user.id - 100_000).toBeLessThanOrEqual(rankToPage(topSlice) * RANKINGS_PAGE_SIZE);
      }
    }
  });

  it("refuses tiny pools so a misconfigured backend cannot produce junk packs", async () => {
    const { fetchPage } = makePoolFetcher(40);
    await expect(drawPackPlayersFromPool(mulberry32(2), fetchPage)).rejects.toThrow();
  });

  it("maps live entries onto pack players, falling back to pool position", () => {
    const entry = makePoolEntry(7);
    expect(liveEntryToPackPlayer(entry).globalRank).toBe(21);
    const unranked = { ...entry, global_rank: null };
    expect(liveEntryToPackPlayer(unranked).globalRank).toBe(7);
  });
});

describe("shard pack duplicate protection", () => {
  const poolIdFor = (position: number) => 100_000 + position;

  it("picks an unowned, unused player inside the draw slice", () => {
    const page = Array.from({ length: 50 }, (_, index) => makePoolEntry(index + 1));
    const owned = new Set(Array.from({ length: 48 }, (_, index) => poolIdFor(index + 1)));
    // Positions 49 and 50 are unowned, but 50 sits outside a 49-wide slice
    // and 49 is already in the pack: nothing qualifies.
    expect(pickUnownedPoolEntry([page], 49, owned, new Set([poolIdFor(49)]), mulberry32(1))).toBeNull();
    const pick = pickUnownedPoolEntry([page], 50, owned, new Set([poolIdFor(49)]), mulberry32(1));
    expect(pick?.user.id).toBe(poolIdFor(50));
  });

  it("returns null when the whole slice is owned", () => {
    const page = Array.from({ length: 50 }, (_, index) => makePoolEntry(index + 1));
    const owned = new Set(page.map((entry) => entry.user.id));
    expect(pickUnownedPoolEntry([page], 50, owned, new Set(), mulberry32(1))).toBeNull();
  });

  it("fills every slot with unowned cards when the pool has enough missing cards", async () => {
    const total = 300;
    // Only the last row of each page is unowned (2% of the pool), so most
    // seeds draw owned players and exercise the full-slice scan path.
    const owned = new Set(
      Array.from({ length: total }, (_, index) => index + 1)
        .filter((position) => position % RANKINGS_PAGE_SIZE !== 0)
        .map(poolIdFor),
    );
    for (let seed = 1; seed <= 40; seed += 1) {
      const { fetchPage } = makePoolFetcher(total);
      const { players } = await drawPackPlayersFromPool(mulberry32(seed), fetchPage, {
        ownedUserIds: owned,
      });
      expect(players).toHaveLength(PACK_SIZE);
      expect(new Set(players.map((player) => player.user.id)).size).toBe(PACK_SIZE);
      expect(players.every((player) => !owned.has(player.user.id))).toBe(true);
    }
  });

  it("keeps only unavoidable repeats when the slice is almost complete", async () => {
    const total = 300;
    const missing = new Set([7, 150, 299].map(poolIdFor));
    const owned = new Set(
      Array.from({ length: total }, (_, index) => poolIdFor(index + 1))
        .filter((userId) => !missing.has(userId)),
    );
    const { fetchPage } = makePoolFetcher(total);
    const { players } = await drawPackPlayersFromPool(mulberry32(17), fetchPage, {
      ownedUserIds: owned,
    });
    expect(players).toHaveLength(PACK_SIZE);
    expect(new Set(players.map((player) => player.user.id)).size).toBe(PACK_SIZE);
    const unowned = players.filter((player) => !owned.has(player.user.id)).map((player) => player.user.id);
    expect(new Set(unowned)).toEqual(missing);
    expect(players.filter((player) => owned.has(player.user.id))).toHaveLength(PACK_SIZE - missing.size);
  });

  it("leaves a draw untouched when the collection is empty", async () => {
    const total = 300;
    const owned = new Set<number>();
    const { fetchPage, calls } = makePoolFetcher(total);
    const { players } = await drawPackPlayersFromPool(mulberry32(9), fetchPage, {
      ownedUserIds: owned,
    });
    expect(players.every((player) => !owned.has(player.user.id))).toBe(true);
    // No replacement fetches happen: the pages fetched match a guarantee-free draw.
    const { fetchPage: plainFetch, calls: plainCalls } = makePoolFetcher(total);
    const { players: plainPlayers } = await drawPackPlayersFromPool(mulberry32(9), plainFetch);
    expect(calls).toEqual(plainCalls);
    expect(players.map((player) => player.user.id)).toEqual(plainPlayers.map((player) => player.user.id));
  });
});

describe("pack type lineup", () => {
  it("defines a sane lineup: one charge pack, shard packs with valid slices", () => {
    const chargePacks = PACK_TYPES.filter((type) => type.cost.kind === "charge");
    expect(chargePacks.map((type) => type.id)).toEqual(["standard"]);
    for (const type of PACK_TYPES) {
      expect(type.topFraction).toBeGreaterThan(0);
      expect(type.topFraction).toBeLessThanOrEqual(1);
      if (type.cost.kind === "shards") expect(type.cost.amount).toBeGreaterThan(0);
      expect(packTypeById(type.id)).toBe(type);
    }
    // Tighter slices cost more shards.
    const shardPacks = PACK_TYPES.filter(
      (type): type is typeof type & { cost: { kind: "shards"; amount: number } } => type.cost.kind === "shards",
    );
    const sorted = [...shardPacks].sort((a, b) => a.cost.amount - b.cost.amount);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index].topFraction).toBeLessThanOrEqual(sorted[index - 1].topFraction);
    }
    // Every shard pack protects against duplicates; Standard stays random.
    for (const type of shardPacks) expect(type.guaranteesNew).toBe(true);
    expect(packTypeById("standard").guaranteesNew).toBeUndefined();
  });
});

describe("reveal order", () => {
  it("sorts weakest rank first so the hit comes last", () => {
    const players = [makeEntry(40), makeEntry(9000), makeEntry(700)].map(toPackPlayer);
    const ordered = sortIntoRevealOrder(players);
    expect(ordered.map((player) => player.globalRank)).toEqual([9000, 700, 40]);
  });
});

describe("fetchPackPlayerScores", () => {
  const cachedFetch = vi.mocked(fetchLivePlayerCachedProfileSnapshotDirect);
  const directFetch = vi.mocked(fetchLivePlayerProfileSnapshotDirect);
  const osuWindowFetch = vi.mocked(getUserScoresBestWindow);

  function snapshotWith(scores: OsuScore[]) {
    return { bestScores: scores } as Awaited<ReturnType<typeof fetchLivePlayerProfileSnapshotDirect>>;
  }

  const scores = [{ id: 1, pp: 100 } as OsuScore];

  beforeEach(() => {
    vi.mocked(isLiveBackendConfigured).mockReturnValue(true);
    cachedFetch.mockReset();
    directFetch.mockReset();
    osuWindowFetch.mockReset();
  });

  it("serves stored best scores from the cached snapshot without touching the blocking endpoint", async () => {
    cachedFetch.mockResolvedValue(snapshotWith(scores));
    await expect(fetchPackPlayerScores(101)).resolves.toEqual(scores);
    expect(directFetch).not.toHaveBeenCalled();
    expect(osuWindowFetch).not.toHaveBeenCalled();
  });

  it("falls back to the blocking snapshot when nothing is cached", async () => {
    cachedFetch.mockResolvedValue(null);
    directFetch.mockResolvedValue(snapshotWith(scores));
    await expect(fetchPackPlayerScores(101)).resolves.toEqual(scores);
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(osuWindowFetch).not.toHaveBeenCalled();
  });

  it("treats an empty cached best-score list as cold instead of minting a blank card", async () => {
    cachedFetch.mockResolvedValue(snapshotWith([]));
    directFetch.mockResolvedValue(snapshotWith(scores));
    await expect(fetchPackPlayerScores(101)).resolves.toEqual(scores);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it("degrades to the direct osu! window when the backend errors end to end", async () => {
    cachedFetch.mockRejectedValue(new Error("backend down"));
    directFetch.mockRejectedValue(new Error("backend down"));
    osuWindowFetch.mockResolvedValue(scores);
    await expect(fetchPackPlayerScores(101)).resolves.toEqual(scores);
    expect(osuWindowFetch).toHaveBeenCalledWith({ data: { userId: 101, totalLimit: 200, parallel: true } });
  });
});
