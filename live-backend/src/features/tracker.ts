import { countryScopeSql, resolveCountryScope, type CountryScope } from "../countries.js";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { getDisplayedRank, getScoreTimestamp, toLeanTrackerScore } from "../shared/score.js";
import type { LeanTrackerScore, OscScore, OsuBeatmap, OsuBeatmapset, ScoreUser } from "../shared/types.js";

export interface TrackerSnapshotFilters {
  score?: "ranked";
  grade?: "SS" | "S" | "A" | "B";
  key?: "4k" | "other";
  miss?: "fc" | "fc_choke";
}

export interface TrackerSnapshotOptions {
  since?: string;
  filters?: TrackerSnapshotFilters;
  sort?: "recent" | "stars";
  sortDirection?: "asc" | "desc";
  userIds?: number[];
}

// Grade/miss/ranked filters live inside score_json, so the hydrated path has
// to parse rows in JS before it can filter or re-sort them. Cap how many of
// the most recent rows it may scan: an uncapped filtered request would parse
// every score_json in the window on the event loop, stalling all other
// responses. Past the cap, older scores fall out of filtered results and
// `total` undercounts.
const HYDRATED_SNAPSHOT_SCAN_LIMIT = 5000;

export async function getTrackerSnapshot(
  db: Db,
  country: string,
  limit: number,
  offset = 0,
  options: TrackerSnapshotOptions = {},
): Promise<{ country: string; scores: LeanTrackerScore[]; gains: Record<number, number>; fetchedAt: number; total: number; offset: number }> {
  // Global aggregates every tracked country (only tracked countries ever land
  // rows in score_events, so dropping the country filter is exactly the union).
  // A region narrows the same table to its member countries at read time.
  const scope = resolveCountryScope(country);
  const scopeSql = countryScopeSql(scope, "se.country");
  const clauses = ["se.passed = 1"];
  const args: Array<string | number> = [];
  if (scopeSql) {
    clauses.push(scopeSql.clause);
    args.push(...scopeSql.args);
  }
  if (scope.kind === "global" && options.since) {
    clauses.push("se.ended_at >= ?");
    args.push(options.since);
  }
  const userIds = [...new Set(
    (options.userIds ?? [])
      .map((id) => Math.floor(Number(id)))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
  if (userIds.length > 0) {
    clauses.push(`se.user_id in (${userIds.map(() => "?").join(",")})`);
    args.push(...userIds);
  }
  const whereSql = clauses.join(" and ");
  const sort = options.sort ?? "recent";
  const sortDirection = options.sortDirection ?? "desc";
  const needsHydratedSnapshot = hasTrackerSnapshotFilters(options.filters) || sort === "stars";
  if (needsHydratedSnapshot) {
    const hydratedClauses = [...clauses];
    // The key filter is derivable from beatmaps.cs, so push it into SQL (the
    // exact range form of getBeatmapKeyCount's ceil) and spend the scan cap on
    // rows that can actually match.
    if (options.filters?.key === "4k") {
      hydratedClauses.push("b.cs > 3 and b.cs <= 4");
    } else if (options.filters?.key === "other") {
      hydratedClauses.push("b.cs > 0 and (b.cs <= 3 or b.cs > 4)");
    }
    const rows = (await exec(
      db,
      `${trackerScoreSelectSql()}
       where ${hydratedClauses.join(" and ")}
       order by se.ended_at desc
       limit ?`,
      [...args, HYDRATED_SNAPSHOT_SCAN_LIMIT],
    )).rows;
    const allScores = rows
      .map((row) => hydrateScoreMetadata(row, parseJson<OscScore | null>(row.score_json, null)))
      .filter((score): score is OscScore => !!score?.beatmap && !!score.beatmapset && !!score.user)
      .map(toLeanTrackerScore)
      .filter((score) => scoreMatchesTrackerSnapshotFilters(score, options.filters))
      .sort((a, b) => compareTrackerScores(a, b, sort, sortDirection));
    const scores = allScores.slice(offset, offset + limit);
    const gains = await getTrackerScoreGains(db, scope, scores);
    return { country, scores, gains, fetchedAt: Date.now(), total: allScores.length, offset };
  }

  const totalRows = (await exec(
    db,
    `select count(*) as count
     from score_events se
     where ${whereSql}`,
    args,
  )).rows;
  const rows = (await exec(
    db,
    `select
       se.score_json,
       u.user_id,
       u.username,
       u.avatar_url,
       u.country_code,
       b.beatmap_id,
       b.beatmapset_id,
       b.mode,
       b.cs,
       b.difficulty_rating,
       b.bpm,
       b.max_combo,
       b.version,
       b.url,
       bs.title,
       bs.artist,
       bs.covers_json
     from score_events se
     left join users u on u.user_id = se.user_id
     left join beatmaps b on b.beatmap_id = se.beatmap_id
     left join beatmapsets bs on bs.beatmapset_id = b.beatmapset_id
     where ${whereSql}
     order by ${getTrackerSnapshotOrderSql(sort, sortDirection)}
     limit ? offset ?`,
    [...args, limit, offset],
  )).rows;
  const scores = rows
    .map((row) => hydrateScoreMetadata(row, parseJson<OscScore | null>(row.score_json, null)))
    .filter((score): score is OscScore => !!score?.beatmap && !!score.beatmapset && !!score.user)
    .map(toLeanTrackerScore);
  const gains = await getTrackerScoreGains(db, scope, scores);
  return { country, scores, gains, fetchedAt: Date.now(), total: Number(totalRows[0]?.count ?? scores.length), offset };
}

function compareTrackerScores(a: LeanTrackerScore, b: LeanTrackerScore, sort: "recent" | "stars", direction: "asc" | "desc"): number {
  if (sort === "stars") {
    const starDelta = direction === "asc"
      ? (a.beatmap?.difficulty_rating ?? Number.MAX_SAFE_INTEGER) - (b.beatmap?.difficulty_rating ?? Number.MAX_SAFE_INTEGER)
      : (b.beatmap?.difficulty_rating ?? -1) - (a.beatmap?.difficulty_rating ?? -1);
    if (starDelta !== 0) return starDelta;
  }
  return getTrackerScoreTimeMs(b) - getTrackerScoreTimeMs(a);
}

function getTrackerSnapshotOrderSql(sort: "recent" | "stars", direction: "asc" | "desc"): string {
  if (sort === "stars") {
    return direction === "asc"
      ? "coalesce(b.difficulty_rating, 999999) asc, se.ended_at desc"
      : "coalesce(b.difficulty_rating, -1) desc, se.ended_at desc";
  }
  return "se.ended_at desc";
}

function getTrackerScoreTimeMs(score: LeanTrackerScore): number {
  const time = Date.parse(getScoreTimestamp(score));
  return Number.isFinite(time) ? time : 0;
}

async function getTrackerScoreGains(db: Db, scope: CountryScope, scores: LeanTrackerScore[]): Promise<Record<number, number>> {
  const scoreIdPlaceholders = scores.map(() => "?").join(",") || "null";
  const scopeSql = countryScopeSql(scope, "country");
  const gainRows = (await exec(
    db,
    `select score_id, pp_gain from top_play_events
     where ${scopeSql ? `${scopeSql.clause} and ` : ""}score_id in (${scoreIdPlaceholders})`,
    [...(scopeSql?.args ?? []), ...scores.map((score) => score.id)],
  )).rows;
  return Object.fromEntries(gainRows.map((row) => [Number(row.score_id), Number(row.pp_gain)]));
}

function hasTrackerSnapshotFilters(filters: TrackerSnapshotFilters | undefined): boolean {
  return !!filters?.score || !!filters?.grade || !!filters?.key || !!filters?.miss;
}

function getScoreMissCount(score: LeanTrackerScore): number {
  const stats = score.statistics ?? {};
  return stats.count_miss ?? stats.miss ?? 0;
}

function getBeatmapKeyCount(score: LeanTrackerScore): number | null {
  const keys = Number(score.beatmap?.cs);
  if (!Number.isFinite(keys) || keys <= 0) return null;
  return Number.isInteger(keys) ? keys : Math.ceil(keys);
}

function scoreMatchesTrackerSnapshotFilters(score: LeanTrackerScore, filters: TrackerSnapshotFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.score === "ranked" && !(score.pp != null && score.pp > 0)) return false;
  if (filters.key) {
    const keys = getBeatmapKeyCount(score);
    if (keys == null) return false;
    if (filters.key === "4k" && keys !== 4) return false;
    if (filters.key === "other" && keys === 4) return false;
  }
  if (filters.miss) {
    const misses = getScoreMissCount(score);
    if (filters.miss === "fc" && misses !== 0) return false;
    if (filters.miss === "fc_choke" && misses !== 1) return false;
  }
  if (filters.grade) {
    const rank = getDisplayedRank(score);
    if (filters.grade === "SS" && !["SS", "SSH", "X", "XH"].includes(rank)) return false;
    if (filters.grade === "S" && !["S", "SH"].includes(rank)) return false;
    if (filters.grade !== "SS" && filters.grade !== "S" && rank !== filters.grade) return false;
  }
  return true;
}

export async function getTrackerScoreById(db: Db, scoreId: number): Promise<{ country: string; score: LeanTrackerScore } | null> {
  const row = (await exec(
    db,
    `${trackerScoreSelectSql()}
     where se.score_id = ? and se.passed = 1
     limit 1`,
    [scoreId],
  )).rows[0];
  if (!row) return null;
  const score = hydrateScoreMetadata(row, parseJson<OscScore | null>(row.score_json, null));
  if (!score?.beatmap || !score.beatmapset || !score.user || row.country == null) return null;
  return { country: String(row.country), score: toLeanTrackerScore(score) };
}

export async function getTrackerScoreByIdentity(db: Db, country: string, scoreIdentity: string): Promise<{ country: string; score: LeanTrackerScore } | null> {
  const hydrated = await getHydratedScoreByIdentity(db, country, scoreIdentity);
  return hydrated ? { country: hydrated.country, score: toLeanTrackerScore(hydrated.score) } : null;
}

export async function getHydratedScoreByIdentity(db: Db, country: string, scoreIdentity: string): Promise<{ country: string; score: OscScore } | null> {
  const row = (await exec(
    db,
    `${trackerScoreSelectSql()}
     where se.country = ? and se.score_identity = ? and se.passed = 1
     limit 1`,
    [country, scoreIdentity],
  )).rows[0];
  if (!row) return null;
  const score = hydrateScoreMetadata(row, parseJson<OscScore | null>(row.score_json, null));
  if (!score?.beatmap || !score.beatmapset || !score.user || row.country == null) return null;
  return { country: String(row.country), score };
}

export async function getHydratedTrackerScoresForMetadata(db: Db, filter: { userId?: number; beatmapId?: number }, limit = 10, offset = 0): Promise<Array<{ country: string; score: LeanTrackerScore }>> {
  return (await getHydratedScoresForMetadata(db, filter, limit, offset))
    .map((row) => ({ country: row.country, score: toLeanTrackerScore(row.score) }));
}

export async function getHydratedScoresForMetadata(
  db: Db,
  filter: { userId?: number; beatmapId?: number },
  limit = 10,
  offset = 0,
  options: { passedOnly?: boolean } = {},
): Promise<Array<{ country: string; score: OscScore }>> {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  if (filter.userId != null) {
    clauses.push("se.user_id = ?");
    args.push(filter.userId);
  }
  if (filter.beatmapId != null) {
    clauses.push("se.beatmap_id = ?");
    args.push(filter.beatmapId);
  }
  if (clauses.length === 0) return [];
  const rows = (await exec(
    db,
    `${trackerScoreSelectSql()}
     where (${clauses.join(" or ")})${options.passedOnly === false ? "" : " and se.passed = 1"}
     order by se.ended_at desc
     limit ? offset ?`,
    [...args, limit, Math.max(0, Math.floor(offset))],
  )).rows;
  return rows.flatMap((row) => {
    const score = hydrateScoreMetadata(row, parseJson<OscScore | null>(row.score_json, null));
    if (!score?.beatmap || !score.beatmapset || !score.user || row.country == null) return [];
    return [{ country: String(row.country), score }];
  });
}

function trackerScoreSelectSql(): string {
  return `select
       se.score_json,
       se.country,
       u.user_id,
       u.username,
       u.avatar_url,
       u.country_code,
       b.beatmap_id,
       b.beatmapset_id,
       b.mode,
       b.status as beatmap_status,
       b.cs,
       b.difficulty_rating,
       b.bpm,
       b.max_combo,
       b.version,
       b.url,
       bs.title,
       bs.artist,
       bs.status as beatmapset_status,
       bs.covers_json
     from score_events se
     left join users u on u.user_id = se.user_id
     left join beatmaps b on b.beatmap_id = se.beatmap_id
     left join beatmapsets bs on bs.beatmapset_id = b.beatmapset_id`;
}

function hydrateScoreMetadata(row: Record<string, unknown>, score: OscScore | null): OscScore | null {
  if (!score) return null;
  const storedUser = rowUser(row);
  const user = storedUser ? mergeScoreUser(score.user, storedUser) : score.user;
  const beatmap = score.beatmap ?? rowBeatmap(row);
  const beatmapset = score.beatmapset ?? rowBeatmapset(row);
  return { ...score, user, beatmap, beatmapset };
}

function mergeScoreUser(current: ScoreUser | undefined, stored: ScoreUser): ScoreUser {
  if (!current) return stored;
  return {
    ...current,
    id: stored.id,
    username: stored.username || current.username,
    avatar_url: stored.avatar_url || current.avatar_url,
    country_code: stored.country_code || current.country_code,
  };
}

function rowUser(row: Record<string, unknown>): ScoreUser | undefined {
  const id = Number(row.user_id);
  if (!Number.isFinite(id) || id <= 0 || row.username == null) return undefined;
  return {
    id,
    username: String(row.username),
    avatar_url: String(row.avatar_url ?? ""),
    country_code: String(row.country_code ?? ""),
  };
}

function rowBeatmap(row: Record<string, unknown>): OsuBeatmap | undefined {
  const id = Number(row.beatmap_id);
  const beatmapsetId = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(beatmapsetId) || beatmapsetId <= 0 || row.version == null) return undefined;
  return {
    id,
    beatmapset_id: beatmapsetId,
    difficulty_rating: Number(row.difficulty_rating ?? 0),
    mode: String(row.mode ?? "mania"),
    status: row.beatmap_status == null ? undefined : String(row.beatmap_status),
    cs: Number(row.cs ?? 0),
    bpm: Number(row.bpm ?? 0),
    max_combo: row.max_combo == null ? undefined : Number(row.max_combo),
    version: String(row.version),
    url: String(row.url ?? `https://osu.ppy.sh/beatmaps/${id}`),
  };
}

function rowBeatmapset(row: Record<string, unknown>): OsuBeatmapset | undefined {
  const id = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0 || row.title == null || row.artist == null) return undefined;
  return {
    id,
    title: String(row.title),
    artist: String(row.artist),
    status: row.beatmapset_status == null ? undefined : String(row.beatmapset_status),
    covers: parseJson<OsuBeatmapset["covers"]>(row.covers_json, {}),
  };
}
