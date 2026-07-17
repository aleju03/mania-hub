import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { errorContext, logWarn } from "../logger.js";

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

export interface GlobalRankingsQuery {
  page?: number;
  pageSize?: number;
  sort?: GlobalRankingsSort;
  dir?: GlobalRankingsSortDirection;
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

const globalBoardCacheByDb = new WeakMap<Db, GlobalBoardCache>();
const globalBoardBuildByDb = new WeakMap<Db, Promise<GlobalBoardCache>>();

async function buildGlobalBoard(db: Db): Promise<GlobalBoardCache> {
  const rows = (await exec(
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
       ) as country_rank,
       u.profile_json
     from country_rosters ro
     join users u on u.user_id = ro.user_id
     where ro.is_tracked = 1 and ro.rank is not null and u.pp is not null
     group by u.user_id
     order by u.pp desc, u.global_rank asc`,
  )).rows;

  const deltas = await readGlobalRankingDeltas(db, rows.map((row) => Number(row.user_id)));

  const entries: GlobalRankingEntry[] = rows.map((row, index) => ({
    ...buildGlobalRankingEntry(row, index + 1),
    global_change: deltas.get(Number(row.user_id))?.globalChange ?? null,
    country_change: deltas.get(Number(row.user_id))?.countryChange ?? null,
  }));
  return { entries, builtAt: Date.now() };
}

async function getGlobalBoard(db: Db): Promise<GlobalBoardCache> {
  const cached = globalBoardCacheByDb.get(db);
  if (cached && Date.now() - cached.builtAt < GLOBAL_BOARD_CACHE_TTL_MS) return cached;
  let build = globalBoardBuildByDb.get(db);
  if (!build) {
    build = buildGlobalBoard(db)
      .then((built) => {
        globalBoardCacheByDb.set(db, built);
        return built;
      })
      .catch((error) => {
        // Keep serving the previous board through a failed rebuild; only the
        // very first build has nothing to fall back to.
        logWarn("global_board_rebuild_failed", errorContext(error));
        const stale = globalBoardCacheByDb.get(db);
        if (stale) return stale;
        throw error;
      })
      .finally(() => {
        globalBoardBuildByDb.delete(db);
      });
    globalBoardBuildByDb.set(db, build);
  }
  return cached ?? build;
}

// The Global leaderboard is the union of every tracked country's roster, ranked
// by mania pp. Because the warmed rosters span the top mania countries, this is
// effectively the real global mania top-N (limited to players we track).
export async function getGlobalRankingsSnapshot(db: Db, query: GlobalRankingsQuery = {}): Promise<GlobalRankingsSnapshot> {
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  const pageSize = Math.max(1, Math.min(GLOBAL_RANKINGS_MAX_PAGE_SIZE, Math.floor(query.pageSize ?? 50) || 50));
  const sort = query.sort ?? "rank";
  const dir = query.dir ?? "desc";
  const board = await getGlobalBoard(db);
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
