import { gunzipSync, gzipSync } from "node:zlib";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { computeOnMapsSnapshotThread } from "../http/maps-snapshot-thread.js";
import type { JobQueue } from "../jobs/queue.js";
import { errorContext, logWarn } from "../logger.js";
import { getRegion } from "../regions.js";
import { readFarmHelperKeyStatsForUsers } from "./farm-helper-key-stats.js";

const SNAPSHOT_TARGET_TOLERANCE_MS = 36 * 60 * 60 * 1000;
const GLOBAL_RANKINGS_MAX_PAGE_SIZE = 50;

type GradeCounts = {
  ss: number;
  ssh: number;
  s: number;
  sh: number;
  a: number;
};

export interface GlobalRankingEntry {
  rank: number;
  user: {
    id: number;
    username: string;
    avatar_url: string;
    cover_url: string;
    country_code: string;
  };
  pp: number;
  global_rank: number | null;
  country_rank: number | null;
  hit_accuracy: number | null;
  play_count: number | null;
  ranked_score: number | null;
  grade_counts: GradeCounts | null;
  global_change: number | null;
  country_change: number | null;
}

export interface GlobalRankingsSnapshot {
  ranking: GlobalRankingEntry[];
  total: number;
  page: number;
  pageSize: number;
  fetchedAt: number;
}

export type GlobalRankingsSort = "rank" | "player" | "7d" | "cr7d" | "accuracy" | "playcount" | "pp" | "ss" | "s" | "a";
export type GlobalRankingsSortDirection = "asc" | "desc";

export type PackPoolKeymode = 4 | 7;

export interface GlobalRankingsQuery {
  page?: number;
  pageSize?: number;
  sort?: GlobalRankingsSort;
  dir?: GlobalRankingsSortDirection;
  /* "packs" serves the card-pack draw pool: the ranked board with tracked,
     unranked manual/score roster members merged in by pp. Leaderboard reads
     omit them and stay ranked-only. */
  pool?: "packs";
  /* With pool "packs", narrows the pool to players whose main keymode this is
     (see readMainKeymodes). Players whose keymode is unknown are in neither
     keymode pool. Ignored off the packs pool. */
  keys?: PackPoolKeymode;
}

export async function getCountryRankingsSnapshot(
  db: Db,
  country: string,
  query: GlobalRankingsQuery = {},
): Promise<GlobalRankingsSnapshot> {
  const normalizedCountry = country.trim().toUpperCase();
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  const pageSize = Math.max(1, Math.min(GLOBAL_RANKINGS_MAX_PAGE_SIZE, Math.floor(query.pageSize ?? 50) || 50));
  const offset = (page - 1) * pageSize;
  const total = Number((await exec(
    db,
    `select count(*) as total
     from country_rosters ro
     join users u on u.user_id = ro.user_id
     where upper(ro.country) = ?
       and ro.is_tracked = 1
       and ro.rank is not null`,
    [normalizedCountry],
  )).rows[0]?.total ?? 0);
  const rows = (await exec(
    db,
    `select
       u.user_id,
       u.username,
       u.avatar_url,
       u.country_code,
       u.pp,
       u.global_rank,
       ro.rank as country_rank,
       u.profile_json
     from country_rosters ro
     join users u on u.user_id = ro.user_id
     where upper(ro.country) = ?
       and ro.is_tracked = 1
       and ro.rank is not null
     order by ro.rank asc
     limit ? offset ?`,
    [normalizedCountry, pageSize, offset],
  )).rows;

  const deltas = await readGlobalRankingDeltas(db, rows.map((row) => Number(row.user_id)));
  const ranking: GlobalRankingEntry[] = rows.map((row, index) => {
    const countryRank = readPositiveInteger(row.country_rank) ?? offset + index + 1;
    return {
      ...buildGlobalRankingEntry(row, countryRank),
      global_change: deltas.get(Number(row.user_id))?.globalChange ?? null,
      country_change: deltas.get(Number(row.user_id))?.countryChange ?? null,
    };
  });

  return {
    ranking,
    total,
    page,
    pageSize,
    fetchedAt: Date.now(),
  };
}

// Building the global board reads and JSON-parses profile_json for every
// tracked player (several seconds of synchronous work that blocks the event
// loop), so it must not run per request: pack shuffles fire several page
// fetches at once and would freeze SSE for every connected browser. The built
// board is cached per Db instance (WeakMap so test databases stay isolated)
// and revalidated in the background; an expired board keeps answering
// instantly while the rebuild runs.
const GLOBAL_BOARD_CACHE_TTL_MS = 60 * 1000;

interface GlobalBoardCache {
  entries: GlobalRankingEntry[];
  builtAt: number;
}

interface GlobalBoardMemory {
  board: GlobalBoardCache;
  // When we last looked for a fresher board (not the board's age): the packed
  // row is multi-MB, so it must not be re-read and re-parsed on every request
  // while the worker hasn't produced a newer build yet.
  checkedAt: number;
}

const globalBoardCacheByDb = new WeakMap<Db, GlobalBoardMemory>();
const globalBoardBuildByDb = new WeakMap<Db, Promise<GlobalBoardCache>>();

// The worker packs the built board into live_meta on a timer; the serving
// process then answers every page from one small sequential read instead of
// scanning the roster itself. The local build below survives as a fallback
// for the all-in-one role and for a worker outage.
const GLOBAL_BOARD_PACK_KEY = "global_board_pack";
const GLOBAL_BOARD_PACK_STALE_MS = 5 * 60 * 1000;

export async function packGlobalBoard(db: Db): Promise<number> {
  const board = await buildGlobalBoard(db);
  // Gzipped (~8x smaller): the serving process re-reads this row once a
  // minute, and a small row keeps that read cheap even on a cold page cache.
  const value = JSON.stringify({ gzip: gzipSync(Buffer.from(JSON.stringify(board), "utf8")).toString("base64") });
  await exec(
    db,
    `insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)`,
    [GLOBAL_BOARD_PACK_KEY, value, new Date().toISOString()],
  );
  return board.entries.length;
}

async function readPackedGlobalBoard(db: Db): Promise<GlobalBoardCache | null> {
  const row = (await exec(db, `select value_json from live_meta where key = ?`, [GLOBAL_BOARD_PACK_KEY])).rows[0];
  if (!row) return null;
  const wrapper = parseJson<{ gzip?: unknown }>(row.value_json, {});
  const raw = typeof wrapper.gzip === "string"
    ? gunzipSync(Buffer.from(wrapper.gzip, "base64")).toString("utf8")
    : String(row.value_json ?? "");
  const parsed = parseJson<{ builtAt?: unknown; entries?: unknown }>(raw, {});
  if (!Number.isFinite(parsed.builtAt) || !Array.isArray(parsed.entries)) return null;
  return { entries: parsed.entries as GlobalRankingEntry[], builtAt: Number(parsed.builtAt) };
}

// Batch sizing for the build: the board spans thousands of players and libsql
// runs synchronously on the event loop, so the heavy steps (profile_json
// transfer + JSON.parse, delta joins) run in small batches with a yield
// between each. The build takes slightly longer wall-clock but never stalls
// SSE or concurrent requests.
const BOARD_BUILD_PROFILE_BATCH = 400;
const BOARD_BUILD_DELTA_BATCH = 1000;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function buildGlobalBoard(db: Db): Promise<GlobalBoardCache> {
  // Light pass: everything except profile_json, so the ordered scan transfers
  // kilobytes instead of the tens of MB of profile blobs.
  const lightRows = (await exec(
    db,
    `select
       u.user_id,
       u.username,
       u.avatar_url,
       u.country_code,
       u.pp,
       u.global_rank,
       coalesce(
         min(case when upper(ro.country) = upper(coalesce(u.country_code, '')) then ro.rank end),
         u.country_rank
       ) as country_rank
     from country_rosters ro
     join users u on u.user_id = ro.user_id
     where ro.is_tracked = 1 and ro.rank is not null and u.pp is not null
     group by u.user_id
     order by u.pp desc, u.global_rank asc`,
  )).rows;

  const entries: GlobalRankingEntry[] = [];
  for (let i = 0; i < lightRows.length; i += BOARD_BUILD_PROFILE_BATCH) {
    const batch = lightRows.slice(i, i + BOARD_BUILD_PROFILE_BATCH);
    const ids = batch.map((row) => Number(row.user_id));
    const profileRows = (await exec(
      db,
      `select user_id, profile_json from users where user_id in (${ids.map(() => "?").join(",")})`,
      ids,
    )).rows;
    const profileJsonById = new Map(profileRows.map((row) => [Number(row.user_id), row.profile_json]));
    batch.forEach((row, offset) => {
      entries.push({
        ...buildGlobalRankingEntry({
          user_id: row.user_id,
          username: row.username,
          avatar_url: row.avatar_url,
          country_code: row.country_code,
          pp: row.pp,
          global_rank: row.global_rank,
          country_rank: row.country_rank,
          profile_json: profileJsonById.get(Number(row.user_id)) ?? null,
        }, i + offset + 1),
        global_change: null,
        country_change: null,
      });
    });
    await yieldEventLoop();
  }

  for (let i = 0; i < entries.length; i += BOARD_BUILD_DELTA_BATCH) {
    const batch = entries.slice(i, i + BOARD_BUILD_DELTA_BATCH);
    const deltas = await readGlobalRankingDeltas(db, batch.map((entry) => entry.user.id));
    for (const entry of batch) {
      const delta = deltas.get(entry.user.id);
      entry.global_change = delta?.globalChange ?? null;
      entry.country_change = delta?.countryChange ?? null;
    }
    await yieldEventLoop();
  }

  return { entries, builtAt: Date.now() };
}

async function refreshGlobalBoard(db: Db): Promise<GlobalBoardCache> {
  const memory = globalBoardCacheByDb.get(db);
  try {
    const packed = await readPackedGlobalBoard(db);
    if (packed && Date.now() - packed.builtAt < GLOBAL_BOARD_PACK_STALE_MS) {
      const board = memory && memory.board.builtAt >= packed.builtAt ? memory.board : packed;
      globalBoardCacheByDb.set(db, { board, checkedAt: Date.now() });
      return board;
    }
  } catch (error) {
    logWarn("global_board_pack_read_failed", errorContext(error));
  }

  // No usable packed board (worker down, first boot, all-in-one role without
  // the pack yet): build locally.
  try {
    const built = await buildGlobalBoard(db);
    globalBoardCacheByDb.set(db, { board: built, checkedAt: Date.now() });
    return built;
  } catch (error) {
    // Keep serving the previous board through a failed refresh; only the very
    // first load has nothing to fall back to.
    logWarn("global_board_rebuild_failed", errorContext(error));
    const stale = globalBoardCacheByDb.get(db);
    if (stale) return stale.board;
    throw error;
  }
}

async function getGlobalBoard(db: Db): Promise<GlobalBoardCache> {
  const memory = globalBoardCacheByDb.get(db);
  if (memory && Date.now() - memory.checkedAt < GLOBAL_BOARD_CACHE_TTL_MS) return memory.board;

  let refresh = globalBoardBuildByDb.get(db);
  if (!refresh) {
    refresh = refreshGlobalBoard(db).finally(() => {
      globalBoardBuildByDb.delete(db);
    });
    globalBoardBuildByDb.set(db, refresh);
  }
  if (memory) {
    // Serve the stale board immediately: the refresh (pack read or local
    // build) must never sit in the request path. Failures log inside.
    refresh.catch(() => {});
    return memory.board;
  }
  return refresh;
}

// Manual opt-ins and score-discovered roster members carry rank null, which
// keeps them off every ranking surface (see isRankedRosterMember). They are
// still genuinely tracked players, so the pack pool includes both sources:
// the ranked board with unranked tracked members merged in by pp and pool
// positions renumbered. Only `pool=packs` requests see this merged board;
// leaderboards keep serving the ranked-only build above.
const PACK_POOL_CACHE_TTL_MS = 60 * 1000;

interface PackPoolMemory {
  board: GlobalBoardCache;
  /* builtAt of the ranked board this merge was computed from; a fresher board
     invalidates the merge regardless of the TTL. */
  boardBuiltAt: number;
  checkedAt: number;
}

const packPoolCacheByDb = new WeakMap<Db, PackPoolMemory>();
const packPoolBuildByDb = new WeakMap<Db, Promise<GlobalBoardCache>>();

/* Manual opt-in and score-discovered members who never made a ranked roster
   slot anywhere. The ranked-slot exclusion keeps a player who is unranked in
   one country but ranked in another from appearing twice.

   pp has to be above zero, not merely present. Opting in is self-serve, so an
   account with no ranked mania play at all can put itself on this list, and pp
   is the cheapest proof it has one: with no plays there is nothing for
   computeManiaSkills to weigh, it returns null, and the card mints as the
   renderer's empty state - a blank face that still deals, still takes a serial
   and still sits in every collection that drew it. Zero also cannot be placed
   in the merge or drawn into a slice honestly. (The opt-in's enrich_user fills
   real pp within minutes, so a genuine player waits, rather than being kept
   out.)

   Roster-driven on purpose: driving from users would run the ranked-slot check
   once per pp-carrying user instead of once per unranked member. The check
   itself rides idx_country_rosters_user (user_id, is_tracked, rank); before
   that index existed each one was a full roster scan, and the ~5k
   score-discovered members turned the rebuild into a 5s main-thread freeze
   every minute. In production this runs on the maps snapshot worker thread
   (see buildPackPoolBoard); the worker entry calls it directly. */
export async function readUnrankedPoolEntries(db: Db): Promise<GlobalRankingEntry[]> {
  const rows = (await exec(
    db,
    `select
       u.user_id,
       u.username,
       u.avatar_url,
       u.country_code,
       u.pp,
       u.global_rank,
       u.country_rank,
       u.profile_json
     from (
       select distinct m.user_id
       from country_rosters m
       where m.is_tracked = 1 and m.source in ('manual', 'score') and m.rank is null
     ) unranked
     join users u on u.user_id = unranked.user_id
     where u.pp > 0
       and coalesce(u.is_active, 1) = 1
       and not exists (
         select 1 from country_rosters ranked
         where ranked.user_id = unranked.user_id and ranked.is_tracked = 1 and ranked.rank is not null
       )
     order by u.pp desc`,
  )).rows;
  return rows.map((row) => ({
    ...buildGlobalRankingEntry(row, 0),
    global_change: null,
    country_change: null,
  }));
}

export function mergePackPoolEntries(
  board: GlobalRankingEntry[],
  unranked: GlobalRankingEntry[],
): GlobalRankingEntry[] {
  if (unranked.length === 0) return board;
  const merged = [...board, ...unranked].sort(
    (a, b) =>
      b.pp - a.pp ||
      (a.global_rank ?? Number.MAX_SAFE_INTEGER) - (b.global_rank ?? Number.MAX_SAFE_INTEGER),
  );
  // Clone every entry whose pool position moved; untouched entries stay shared
  // with the ranked board cache (both sides are read-only, the serve path
  // clones before mutating).
  return merged.map((entry, index) => (entry.rank === index + 1 ? entry : { ...entry, rank: index + 1 }));
}

async function buildPackPoolBoard(db: Db, board: GlobalBoardCache): Promise<GlobalBoardCache> {
  try {
    // Off the event loop when a thread runs here; inline otherwise (tests,
    // source-mode dev, the headless worker).
    const unranked = (await computeOnMapsSnapshotThread<GlobalRankingEntry[]>(db, { kind: "pack-pool-unranked" }))
      ?? (await readUnrankedPoolEntries(db));
    const pool: GlobalBoardCache = { entries: mergePackPoolEntries(board.entries, unranked), builtAt: board.builtAt };
    packPoolCacheByDb.set(db, { board: pool, boardBuiltAt: board.builtAt, checkedAt: Date.now() });
    return pool;
  } catch (error) {
    // The pack pool must never be less available than the board itself: a
    // failed unranked-members read serves the ranked board alone (uncached, so
    // the next request retries the merge).
    logWarn("pack_pool_unranked_read_failed", errorContext(error));
    return board;
  }
}

async function getPackPoolBoard(db: Db): Promise<GlobalBoardCache> {
  const board = await getGlobalBoard(db);
  const memory = packPoolCacheByDb.get(db);
  if (memory && memory.boardBuiltAt === board.builtAt && Date.now() - memory.checkedAt < PACK_POOL_CACHE_TTL_MS) {
    return memory.board;
  }
  // Pack opens fetch several pool pages at once; share one merge across them.
  let build = packPoolBuildByDb.get(db);
  if (!build) {
    build = buildPackPoolBoard(db, board).finally(() => {
      packPoolBuildByDb.delete(db);
    });
    packPoolBuildByDb.set(db, build);
  }
  return build;
}

/* Membership view of the pack pool, for collection progress: who is currently
   pullable, and how many players that is. Same merged board the draws page
   through, so the numbers agree with what a pack can actually deal. */
export async function getPackPoolMembership(db: Db): Promise<{ userIds: Set<number>; total: number }> {
  const board = await getPackPoolBoard(db);
  return { userIds: new Set(board.entries.map((entry) => entry.user.id)), total: board.entries.length };
}

/* The pool roster itself, for the collection's "missing" list: the same
   merged entries the membership set is built from, in pool order. Shared with
   the pool cache, so callers read and never mutate. */
export async function getPackPoolRoster(db: Db): Promise<readonly GlobalRankingEntry[]> {
  return (await getPackPoolBoard(db)).entries;
}

/* The pool as the server-side pack deal reads it (features/pack-draw.ts):
   the same merged entries every other pool read shares, optionally narrowed
   to one main keymode. Shared cache rows - callers read and never mutate. */
export async function getPackPoolEntries(db: Db, keys?: PackPoolKeymode): Promise<readonly GlobalRankingEntry[]> {
  return (keys ? await getPackKeymodeBoard(db, keys) : await getPackPoolBoard(db)).entries;
}

// The keymode packs ("main 4K players only") are the pack pool narrowed to one
// main keymode and renumbered. Unlike the manual-member merge above, a failed
// build must NOT degrade to the unfiltered pool: a 4K pack dealing a 7K main
// breaks the pack's one promise, so errors propagate and the draw fails.
const PACK_KEYMODE_CACHE_TTL_MS = 5 * 60 * 1000;

const packKeymodeCacheByDb = new WeakMap<Db, Map<PackPoolKeymode, PackPoolMemory>>();
const packKeymodeBuildByDb = new WeakMap<Db, Map<PackPoolKeymode, Promise<GlobalBoardCache>>>();

/* Main keymode per player: the higher variant pp (users.pp_4k / pp_7k, from
   osu! profile variants) when the two differ, else the higher per-keymode
   farmed weighted pp (farm_helper_user_key_stats) for players whose profiles
   were never variant-enriched. A player with no signal in either source is
   deliberately absent from the map: better to leave them out of both keymode
   pools than to guess. */
async function readMainKeymodes(db: Db, userIds: number[]): Promise<Map<number, PackPoolKeymode>> {
  const variants = new Map<number, { pp4: number; pp7: number }>();
  for (let i = 0; i < userIds.length; i += 900) {
    const chunk = userIds.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const rows = (await exec(
      db,
      `select user_id, pp_4k, pp_7k from users
       where user_id in (${chunk.map(() => "?").join(",")})
         and (pp_4k is not null or pp_7k is not null)`,
      chunk,
    )).rows;
    for (const row of rows) {
      variants.set(Number(row.user_id), { pp4: Number(row.pp_4k) || 0, pp7: Number(row.pp_7k) || 0 });
    }
  }
  const farmed4 = await readFarmHelperKeyStatsForUsers(db, 4, userIds);
  const farmed7 = await readFarmHelperKeyStatsForUsers(db, 7, userIds);

  const mains = new Map<number, PackPoolKeymode>();
  for (const userId of userIds) {
    const variant = variants.get(userId);
    if (variant && variant.pp4 !== variant.pp7) {
      mains.set(userId, variant.pp4 > variant.pp7 ? 4 : 7);
      continue;
    }
    const weighted4 = farmed4.get(userId)?.weightedPp ?? 0;
    const weighted7 = farmed7.get(userId)?.weightedPp ?? 0;
    if (weighted4 !== weighted7) mains.set(userId, weighted4 > weighted7 ? 4 : 7);
  }
  return mains;
}

async function buildPackKeymodeBoard(db: Db, pool: GlobalBoardCache, keys: PackPoolKeymode): Promise<GlobalBoardCache> {
  const mains = await readMainKeymodes(db, pool.entries.map((entry) => entry.user.id));
  // Renumbered like the manual merge: draws roll uniform positions in
  // [1, total], so pool positions must be dense within the filtered board.
  const entries = pool.entries
    .filter((entry) => mains.get(entry.user.id) === keys)
    .map((entry, index) => (entry.rank === index + 1 ? entry : { ...entry, rank: index + 1 }));
  return { entries, builtAt: pool.builtAt };
}

async function getPackKeymodeBoard(db: Db, keys: PackPoolKeymode): Promise<GlobalBoardCache> {
  const pool = await getPackPoolBoard(db);
  const cached = packKeymodeCacheByDb.get(db)?.get(keys);
  if (cached && cached.boardBuiltAt === pool.builtAt && Date.now() - cached.checkedAt < PACK_KEYMODE_CACHE_TTL_MS) {
    return cached.board;
  }
  let builds = packKeymodeBuildByDb.get(db);
  if (!builds) packKeymodeBuildByDb.set(db, (builds = new Map()));
  let build = builds.get(keys);
  if (!build) {
    build = buildPackKeymodeBoard(db, pool, keys)
      .then((board) => {
        let caches = packKeymodeCacheByDb.get(db);
        if (!caches) packKeymodeCacheByDb.set(db, (caches = new Map()));
        caches.set(keys, { board, boardBuiltAt: pool.builtAt, checkedAt: Date.now() });
        return board;
      })
      .finally(() => {
        builds?.delete(keys);
      });
    builds.set(keys, build);
  }
  return build;
}

// The Global leaderboard is the union of every tracked country's roster, ranked
// by mania pp. Because the warmed rosters span the top mania countries, this is
// effectively the real global mania top-N (limited to players we track).
export async function getGlobalRankingsSnapshot(db: Db, query: GlobalRankingsQuery = {}): Promise<GlobalRankingsSnapshot> {
  const board = query.pool === "packs"
    ? query.keys
      ? await getPackKeymodeBoard(db, query.keys)
      : await getPackPoolBoard(db)
    : await getGlobalBoard(db);
  return pageBoardSnapshot(board, query);
}

function pageBoardSnapshot(board: GlobalBoardCache, query: GlobalRankingsQuery): GlobalRankingsSnapshot {
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  const pageSize = Math.max(1, Math.min(GLOBAL_RANKINGS_MAX_PAGE_SIZE, Math.floor(query.pageSize ?? 50) || 50));
  const sort = query.sort ?? "rank";
  const dir = query.dir ?? "desc";
  const sortedEntries = sortGlobalRankingEntries(board.entries, sort, dir);
  const start = (page - 1) * pageSize;
  // Clones, not the cached rows: accent enrichment mutates response objects in
  // place and must not write into the shared board.
  const ranking = sortedEntries.slice(start, start + pageSize).map((entry) => ({ ...entry, user: { ...entry.user } }));

  return {
    ranking,
    total: board.entries.length,
    page,
    pageSize,
    fetchedAt: board.builtAt,
  };
}

// A region leaderboard is the cached global board narrowed to the region's
// member countries and renumbered — a pure read-time view, like the pack
// keymode boards above. No projection, job, or snapshot row of its own.
const REGION_BOARD_CACHE_TTL_MS = 5 * 60 * 1000;

const regionBoardCacheByDb = new WeakMap<Db, Map<string, PackPoolMemory>>();

async function getRegionBoard(db: Db, regionCode: string): Promise<GlobalBoardCache> {
  const board = await getGlobalBoard(db);
  const cached = regionBoardCacheByDb.get(db)?.get(regionCode);
  if (cached && cached.boardBuiltAt === board.builtAt && Date.now() - cached.checkedAt < REGION_BOARD_CACHE_TTL_MS) {
    return cached.board;
  }
  const members = new Set(getRegion(regionCode)?.countries ?? []);
  const entries = board.entries
    .filter((entry) => members.has(entry.user.country_code?.trim().toUpperCase() ?? ""))
    .map((entry, index) => (entry.rank === index + 1 ? entry : { ...entry, rank: index + 1 }));
  const regionBoard: GlobalBoardCache = { entries, builtAt: board.builtAt };
  let caches = regionBoardCacheByDb.get(db);
  if (!caches) regionBoardCacheByDb.set(db, (caches = new Map()));
  caches.set(regionCode, { board: regionBoard, boardBuiltAt: board.builtAt, checkedAt: Date.now() });
  return regionBoard;
}

export async function getRegionRankingsSnapshot(db: Db, regionCode: string, query: GlobalRankingsQuery = {}): Promise<GlobalRankingsSnapshot> {
  return pageBoardSnapshot(await getRegionBoard(db, regionCode), query);
}

// A country whose roster refresh was queued recently is skipped: with the
// board cached, every page of the same board would otherwise re-enqueue the
// identical repairs on each request (queue writes that stall under
// contention), and the refresh job itself takes minutes to land anyway.
const STAT_REPAIR_THROTTLE_MS = 5 * 60 * 1000;
const statRepairEnqueuedAt = new Map<string, number>();

export async function enqueueGlobalRankingStatRepairs(queue: JobQueue, entries: GlobalRankingEntry[]): Promise<string[]> {
  const now = Date.now();
  const countries = [...new Set(
    entries
      .filter(hasIncompleteStats)
      .map((entry) => entry.user.country_code.trim().toUpperCase())
      .filter((country) => /^[A-Z]{2}$/.test(country)),
  )].filter((country) => now - (statRepairEnqueuedAt.get(country) ?? 0) >= STAT_REPAIR_THROTTLE_MS);

  for (const country of countries) {
    statRepairEnqueuedAt.set(country, now);
    await queue.enqueue("refresh_country_roster", `roster:${country}`, { country }, { priority: 85, replaceDone: true });
  }

  return countries;
}

function sortGlobalRankingEntries(
  entries: GlobalRankingEntry[],
  sort: GlobalRankingsSort,
  dir: GlobalRankingsSortDirection,
): GlobalRankingEntry[] {
  if (sort === "rank" || sort === "pp") {
    return dir === "desc" ? entries : [...entries].reverse();
  }

  return [...entries].sort((a, b) => {
    switch (sort) {
      case "player":
        return dir === "asc"
          ? a.user.username.localeCompare(b.user.username)
          : b.user.username.localeCompare(a.user.username);
      case "7d":
        return compareRankDeltaValues(a.global_change, b.global_change, dir) || a.rank - b.rank;
      case "cr7d":
        return compareRankDeltaValues(a.country_change, b.country_change, dir) || a.rank - b.rank;
      case "accuracy":
        return compareAccuracy(a, b, dir);
      case "playcount":
        return compareNullableMetric(a, b, (entry) => entry.play_count, dir);
      case "ss":
        return compareNullableMetric(a, b, (entry) => gradeCountTotal(entry.grade_counts, ["ss", "ssh"]), dir);
      case "s":
        return compareNullableMetric(a, b, (entry) => gradeCountTotal(entry.grade_counts, ["s", "sh"]), dir);
      case "a":
        return compareNullableMetric(a, b, (entry) => gradeCountTotal(entry.grade_counts, ["a"]), dir);
      default:
        return a.rank - b.rank;
    }
  });
}

export function compareRankDeltaValues(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: GlobalRankingsSortDirection,
): number {
  const aValue = typeof a === "number" && Number.isFinite(a) ? a : null;
  const bValue = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (aValue !== null && bValue === null) return -1;
  if (aValue === null && bValue !== null) return 1;
  if (aValue === null || bValue === null) return 0;

  return dir === "desc" ? bValue - aValue : aValue - bValue;
}

function hasIncompleteStats(entry: GlobalRankingEntry): boolean {
  return entry.hit_accuracy == null ||
    entry.play_count == null ||
    entry.ranked_score == null ||
    entry.grade_counts == null;
}

function compareAccuracy(
  a: Pick<GlobalRankingEntry, "hit_accuracy" | "rank">,
  b: Pick<GlobalRankingEntry, "hit_accuracy" | "rank">,
  dir: GlobalRankingsSortDirection,
): number {
  const aHasAccuracy = hasKnownAccuracy(a.hit_accuracy);
  const bHasAccuracy = hasKnownAccuracy(b.hit_accuracy);
  if (aHasAccuracy !== bHasAccuracy) return aHasAccuracy ? -1 : 1;
  if (!aHasAccuracy || !bHasAccuracy) return a.rank - b.rank;

  const aAccuracy = a.hit_accuracy ?? 0;
  const bAccuracy = b.hit_accuracy ?? 0;
  const diff = dir === "desc"
    ? bAccuracy - aAccuracy
    : aAccuracy - bAccuracy;
  return diff || a.rank - b.rank;
}

function compareNullableMetric<T extends Pick<GlobalRankingEntry, "rank">>(
  a: T,
  b: T,
  getValue: (entry: T) => number | null,
  dir: GlobalRankingsSortDirection,
): number {
  const aValue = getValue(a);
  const bValue = getValue(b);
  const aKnown = aValue != null && Number.isFinite(aValue);
  const bKnown = bValue != null && Number.isFinite(bValue);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (!aKnown || !bKnown) return a.rank - b.rank;

  const diff = dir === "desc" ? bValue - aValue : aValue - bValue;
  return diff || a.rank - b.rank;
}

function hasKnownAccuracy(value: number | null): boolean {
  return value != null && Number.isFinite(value) && value > 0;
}

function gradeCountTotal(counts: GradeCounts | null, keys: Array<keyof GradeCounts>): number | null {
  if (!counts) return null;
  return keys.reduce((sum, key) => sum + counts[key], 0);
}

function buildGlobalRankingEntry(row: Record<string, unknown>, rank: number): Omit<GlobalRankingEntry, "global_change" | "country_change"> {
  const profile = parseJson<Record<string, unknown>>(row.profile_json, {});
  const stats = readRecord(profile.statistics);
  const cover = readRecord(profile.cover);
  const coverUrl = typeof cover?.url === "string"
    ? cover.url
    : typeof profile.cover_url === "string"
      ? profile.cover_url
      : "";
  return {
    rank,
    user: {
      id: readInteger(row.user_id) ?? 0,
      username: String(row.username ?? ""),
      avatar_url: String(row.avatar_url ?? ""),
      cover_url: coverUrl,
      country_code: String(row.country_code ?? ""),
    },
    pp: readNumber(row.pp) ?? readNumber(stats?.pp) ?? 0,
    global_rank: readPositiveInteger(row.global_rank) ?? readPositiveInteger(stats?.global_rank),
    country_rank: readPositiveInteger(row.country_rank) ?? readPositiveInteger(stats?.country_rank),
    hit_accuracy: readNumber(stats?.hit_accuracy),
    play_count: readNonNegativeInteger(stats?.play_count),
    ranked_score: readNonNegativeInteger(stats?.ranked_score),
    grade_counts: readGradeCounts(stats?.grade_counts),
  };
}

async function readGlobalRankingDeltas(
  db: Db,
  userIds: number[],
  windowDays = 7,
): Promise<Map<number, { globalChange: number | null; countryChange: number | null }>> {
  const uniqueUserIds = [...new Set(userIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (uniqueUserIds.length === 0) return new Map();

  const target = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const targetAt = new Date(target).toISOString();
  const oldestAllowedAt = new Date(target - SNAPSHOT_TARGET_TOLERANCE_MS).toISOString();
  const placeholders = uniqueUserIds.map(() => "?").join(",");
  const rows = (await exec(
    db,
    `select
       old.user_id,
       old.country_rank as old_country_rank,
       old.global_rank as old_global_rank,
       coalesce(current_roster.rank, current.country_rank) as current_country_rank,
       current.global_rank as current_global_rank
     from country_rank_snapshots old
     join users snapshot_user
       on snapshot_user.user_id = old.user_id
      and upper(coalesce(snapshot_user.country_code, '')) = upper(old.country)
     join (
       select old_pick.user_id, max(old_pick.captured_at) as captured_at
       from country_rank_snapshots old_pick
       join users pick_user
         on pick_user.user_id = old_pick.user_id
        and upper(coalesce(pick_user.country_code, '')) = upper(old_pick.country)
       where old_pick.user_id in (${placeholders})
         and old_pick.captured_at <= ?
         and old_pick.captured_at >= ?
       group by old_pick.user_id
     ) picked on picked.user_id = old.user_id and picked.captured_at = old.captured_at
     left join users current on current.user_id = old.user_id
     left join country_rosters current_roster
       on current_roster.country = old.country
      and current_roster.user_id = old.user_id
      and current_roster.is_tracked = 1
      and current_roster.rank is not null
     where old.user_id in (${placeholders})`,
    [...uniqueUserIds, targetAt, oldestAllowedAt, ...uniqueUserIds],
  )).rows;

  const deltas = new Map<number, { globalChange: number | null; countryChange: number | null }>();
  for (const row of rows) {
    const userId = readInteger(row.user_id);
    if (userId == null) continue;
    const oldGlobalRank = readPositiveInteger(row.old_global_rank);
    const oldCountryRank = readPositiveInteger(row.old_country_rank);
    const currentGlobalRank = readPositiveInteger(row.current_global_rank);
    const currentCountryRank = readPositiveInteger(row.current_country_rank);
    deltas.set(userId, {
      globalChange: oldGlobalRank != null && currentGlobalRank != null ? oldGlobalRank - currentGlobalRank : null,
      countryChange: oldCountryRank != null && currentCountryRank != null ? oldCountryRank - currentCountryRank : null,
    });
  }

  return deltas;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return null;
}

function readInteger(value: unknown): number | null {
  const numberValue = readNumber(value);
  return numberValue != null && Number.isInteger(numberValue) ? numberValue : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const numberValue = readInteger(value);
  return numberValue != null && numberValue >= 0 ? numberValue : null;
}

function readPositiveInteger(value: unknown): number | null {
  const numberValue = readInteger(value);
  return numberValue != null && numberValue > 0 ? numberValue : null;
}

function readGradeCounts(value: unknown): GradeCounts | null {
  const gradeCounts = readRecord(value);
  if (!gradeCounts) return null;
  return {
    ss: readNonNegativeInteger(gradeCounts.ss) ?? 0,
    ssh: readNonNegativeInteger(gradeCounts.ssh) ?? 0,
    s: readNonNegativeInteger(gradeCounts.s) ?? 0,
    sh: readNonNegativeInteger(gradeCounts.sh) ?? 0,
    a: readNonNegativeInteger(gradeCounts.a) ?? 0,
  };
}
