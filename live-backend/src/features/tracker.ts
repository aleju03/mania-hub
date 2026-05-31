import { isGlobalCountry } from "../countries.js";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { toLeanTrackerScore } from "../shared/score.js";
import type { LeanTrackerScore, OscScore, OsuBeatmap, OsuBeatmapset, ScoreUser } from "../shared/types.js";

export async function getTrackerSnapshot(db: Db, country: string, limit: number): Promise<{ country: string; scores: LeanTrackerScore[]; gains: Record<number, number>; fetchedAt: number }> {
  // Global aggregates every tracked country (only tracked countries ever land
  // rows in score_events, so dropping the country filter is exactly the union).
  const global = isGlobalCountry(country);
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
     where ${global ? "" : "se.country = ? and "}se.passed = 1
     order by se.ended_at desc
     limit ?`,
    global ? [limit] : [country, limit],
  )).rows;
  const scores = rows
    .map((row) => hydrateScoreMetadata(row, parseJson<OscScore | null>(row.score_json, null)))
    .filter((score): score is OscScore => !!score?.beatmap && !!score.beatmapset && !!score.user)
    .map(toLeanTrackerScore);
  const scoreIdPlaceholders = scores.map(() => "?").join(",") || "null";
  const gainRows = (await exec(
    db,
    `select score_id, pp_gain from top_play_events
     where ${global ? "" : "country = ? and "}score_id in (${scoreIdPlaceholders})`,
    global ? scores.map((score) => score.id) : [country, ...scores.map((score) => score.id)],
  )).rows;
  const gains = Object.fromEntries(gainRows.map((row) => [Number(row.score_id), Number(row.pp_gain)]));
  return { country, scores, gains, fetchedAt: Date.now() };
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
  return { country: String(row.country), score: toLeanTrackerScore(score) };
}

export async function getHydratedTrackerScoresForMetadata(db: Db, filter: { userId?: number; beatmapId?: number }, limit = 10): Promise<Array<{ country: string; score: LeanTrackerScore }>> {
  return (await getHydratedScoresForMetadata(db, filter, limit))
    .map((row) => ({ country: row.country, score: toLeanTrackerScore(row.score) }));
}

export async function getHydratedScoresForMetadata(db: Db, filter: { userId?: number; beatmapId?: number }, limit = 10): Promise<Array<{ country: string; score: OscScore }>> {
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
     where (${clauses.join(" or ")}) and se.passed = 1
     order by se.ended_at desc
     limit ?`,
    [...args, limit],
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
