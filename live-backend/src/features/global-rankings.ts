import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";

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
  hit_accuracy: number;
  play_count: number;
  ranked_score: number;
  grade_counts: GradeCounts;
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

// The Global leaderboard is the union of every tracked country's roster, ranked
// by mania pp. Because the warmed rosters span the top mania countries, this is
// effectively the real global mania top-N (limited to players we track).
export async function getGlobalRankingsSnapshot(db: Db, query: GlobalRankingsQuery = {}): Promise<GlobalRankingsSnapshot> {
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  const pageSize = Math.max(1, Math.min(GLOBAL_RANKINGS_MAX_PAGE_SIZE, Math.floor(query.pageSize ?? 50) || 50));
  const sort = query.sort ?? "rank";
  const dir = query.dir ?? "desc";
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
     where ro.is_tracked = 1 and u.pp is not null
     group by u.user_id
     order by u.pp desc, u.global_rank asc`,
  )).rows;

  const deltas = await readGlobalRankingDeltas(db, rows.map((row) => Number(row.user_id)));

  const allEntries: GlobalRankingEntry[] = rows.map((row, index) => ({
    ...buildGlobalRankingEntry(row, index + 1),
    global_change: deltas.get(Number(row.user_id))?.globalChange ?? null,
    country_change: deltas.get(Number(row.user_id))?.countryChange ?? null,
  }));
  const sortedEntries = sortGlobalRankingEntries(allEntries, sort, dir);
  const start = (page - 1) * pageSize;
  const ranking = sortedEntries.slice(start, start + pageSize);

  return {
    ranking,
    total: allEntries.length,
    page,
    pageSize,
    fetchedAt: Date.now(),
  };
}

function sortGlobalRankingEntries(
  entries: GlobalRankingEntry[],
  sort: GlobalRankingsSort,
  dir: GlobalRankingsSortDirection,
): GlobalRankingEntry[] {
  if (sort === "rank" || sort === "pp") {
    return dir === "desc" ? entries : [...entries].reverse();
  }

  const flip = dir === "desc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    switch (sort) {
      case "player":
        return dir === "asc"
          ? a.user.username.localeCompare(b.user.username)
          : b.user.username.localeCompare(a.user.username);
      case "7d":
        return ((b.global_change ?? -99999) - (a.global_change ?? -99999)) * flip || a.rank - b.rank;
      case "cr7d":
        return ((b.country_change ?? -99999) - (a.country_change ?? -99999)) * flip || a.rank - b.rank;
      case "accuracy":
        return compareAccuracy(a, b, dir);
      case "playcount":
        return (b.play_count - a.play_count) * flip || a.rank - b.rank;
      case "ss":
        return ((b.grade_counts.ss + b.grade_counts.ssh) - (a.grade_counts.ss + a.grade_counts.ssh)) * flip || a.rank - b.rank;
      case "s":
        return ((b.grade_counts.s + b.grade_counts.sh) - (a.grade_counts.s + a.grade_counts.sh)) * flip || a.rank - b.rank;
      case "a":
        return (b.grade_counts.a - a.grade_counts.a) * flip || a.rank - b.rank;
      default:
        return a.rank - b.rank;
    }
  });
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

  const diff = dir === "desc"
    ? b.hit_accuracy - a.hit_accuracy
    : a.hit_accuracy - b.hit_accuracy;
  return diff || a.rank - b.rank;
}

function hasKnownAccuracy(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function buildGlobalRankingEntry(row: Record<string, unknown>, rank: number): Omit<GlobalRankingEntry, "global_change" | "country_change"> {
  const profile = parseJson<Record<string, unknown>>(row.profile_json, {});
  const stats = readRecord(profile.statistics);
  const gradeCounts = readRecord(stats?.grade_counts);
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
    hit_accuracy: readNumber(stats?.hit_accuracy) ?? 0,
    play_count: readInteger(stats?.play_count) ?? 0,
    ranked_score: readInteger(stats?.ranked_score) ?? 0,
    grade_counts: {
      ss: readInteger(gradeCounts?.ss) ?? 0,
      ssh: readInteger(gradeCounts?.ssh) ?? 0,
      s: readInteger(gradeCounts?.s) ?? 0,
      sh: readInteger(gradeCounts?.sh) ?? 0,
      a: readInteger(gradeCounts?.a) ?? 0,
    },
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

function readPositiveInteger(value: unknown): number | null {
  const numberValue = readInteger(value);
  return numberValue != null && numberValue > 0 ? numberValue : null;
}
