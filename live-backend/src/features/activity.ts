import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { parseManiaBeatmap, type ManiaNote } from "../dan/beatmap-parser.js";
import { extractDanFeatures } from "../dan/dan-estimator/features.js";
import type { DanFeatureMetrics } from "../dan/dan-estimator/types.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import { getDisplayedAccuracy, getDisplayedRank, getScoreTimestamp, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

export const ACTIVITY_SKILL_ANALYSIS_VERSION = 3;

const ACTIVITY_SESSION_GAP_MS = 45 * 60_000;
const ACTIVITY_DAY_MAP_LIMIT = 6;
const ACTIVITY_DAY_DETAIL_MAP_LIMIT = 500;
const ACTIVITY_ANALYSIS_RUNNING_REQUEUE_MS = 10 * 60_000;
const ACTIVITY_ANALYSIS_FAILED_RETRY_MS = 5 * 60_000;

interface ActivitySkillVector {
  stream: number;
  jack: number;
  bracket: number;
  ln: number;
  lnGeneral: number;
  lnRelease: number;
  lnInverse: number;
  lnTech: number;
}

export type PlayerActivityPrimarySkill =
  | "stream"
  | "jack"
  | "bracket"
  | "ln"
  | "lnGeneral"
  | "lnRelease"
  | "lnInverse"
  | "lnTech"
  | "mixed"
  | "unknown";

export interface PlayerActivityKeyModeSkillReadout extends ActivitySkillVector {
  keyCount: number | null;
  analyzedPlays: number;
  totalPlays: number;
}

export interface PlayerActivitySkillReadout extends ActivitySkillVector {
  analyzedPlays: number;
  totalPlays: number;
  keyModes: PlayerActivityKeyModeSkillReadout[];
}

export interface PlayerActivityMap {
  key: string;
  beatmapId: number;
  beatmapsetId: number | null;
  title: string;
  artist: string;
  version: string;
  coverUrl: string | null;
  plays: number;
  accuracy: number | null;
  pp: number | null;
  rank: string | null;
  keyCount: number | null;
  skills: ActivitySkillVector | null;
}

export interface PlayerActivityTimelineSegment {
  key: string;
  sessionIndex: number;
  startAt: string;
  endAt: string;
  playCount: number;
  keyCount: number | null;
  primarySkill: PlayerActivityPrimarySkill;
  stream: number;
  jack: number;
  bracket: number;
  ln: number;
  lnGeneral: number;
  lnRelease: number;
  lnInverse: number;
  lnTech: number;
}

export interface PlayerActivityDay {
  date: string;
  scoreCount: number;
  passedCount: number;
  sessionCount: number;
  mapCount: number;
  maps: PlayerActivityMap[];
  skills: PlayerActivitySkillReadout | null;
  timeline: PlayerActivityTimelineSegment[];
}

export interface PlayerActivitySnapshot {
  available: boolean;
  isTracked: boolean;
  userId: number;
  country: string | null;
  year: number;
  availableYears: number[];
  totalScores: number;
  activeDays: number;
  totalSessions: number;
  typicalSession: number;
  currentStreak: number;
  generatedAt: string;
  days: PlayerActivityDay[];
}

export interface PlayerActivityAvailability {
  available: boolean;
  isTracked: boolean;
  userId: number;
  country: string | null;
  availableYears: number[];
  generatedAt: string;
}

interface ResolvedActivityCountry {
  country: string | null;
  isTracked: boolean;
}

export async function recordPlayerActivity(
  db: Db,
  queue: JobQueue,
  country: string,
  score: OscScore,
  scoreIdentity: string,
): Promise<void> {
  const activity = readScoreActivityInput(country, score, scoreIdentity);
  if (!activity) return;
  const now = nowIso();
  const inserted = await exec(
    db,
    `insert or ignore into player_activity_score_refs
       (country, score_identity, user_id, day, beatmap_id, passed, ended_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      activity.country,
      activity.scoreIdentity,
      activity.userId,
      activity.day,
      activity.beatmapId,
      activity.passed ? 1 : 0,
      activity.endedAt,
      now,
    ],
  );
  if (Number(inserted.rowsAffected ?? 0) === 0) return;

  await upsertActivityDay(db, activity, now);
  await recomputeActivitySessions(db, activity.country, activity.userId, activity.day);
  await upsertActivityMap(db, activity, score, now);
  await enqueueBeatmapSkillAnalysisIfNeeded(db, queue, activity.beatmapId);
}

export async function removePlayerActivityScore(db: Db, country: string, scoreIdentity: string): Promise<void> {
  const row = (await exec(
    db,
    `select country, score_identity, user_id, day, beatmap_id, passed
     from player_activity_score_refs
     where country = ? and score_identity = ?
     limit 1`,
    [country, scoreIdentity],
  )).rows[0];
  if (!row) return;

  const deleted = await exec(
    db,
    "delete from player_activity_score_refs where country = ? and score_identity = ?",
    [country, scoreIdentity],
  );
  if (Number(deleted.rowsAffected ?? 0) === 0) return;

  const normalizedCountry = String(row.country);
  const userId = Number(row.user_id);
  const day = String(row.day);
  const beatmapId = Number(row.beatmap_id);
  const passed = Number(row.passed) ? 1 : 0;
  const now = nowIso();

  await exec(
    db,
    `update player_activity_days
     set score_count = max(0, score_count - 1),
         passed_count = max(0, passed_count - ?),
         updated_at = ?
     where country = ? and user_id = ? and day = ?`,
    [passed, now, normalizedCountry, userId, day],
  );
  await recomputeActivitySessions(db, normalizedCountry, userId, day);
  await exec(
    db,
    `update player_activity_maps
     set play_count = max(0, play_count - 1),
         updated_at = ?
     where country = ? and user_id = ? and day = ? and beatmap_id = ?`,
    [now, normalizedCountry, userId, day, beatmapId],
  );
  await exec(db, "delete from player_activity_maps where play_count <= 0");
  await exec(db, "delete from player_activity_days where score_count <= 0");
}

export async function getPlayerActivitySnapshot(
  db: Db,
  queue: JobQueue,
  userId: number,
  requestedCountry: string,
  requestedYear: number,
): Promise<PlayerActivitySnapshot> {
  const year = clampYear(requestedYear);
  const resolved = await resolveActivityCountry(db, userId, requestedCountry);
  const generatedAt = nowIso();
  if (!resolved.country) {
    return emptyActivitySnapshot(userId, null, year, false, generatedAt);
  }

  await backfillPlayerActivityFromRetainedScores(db, queue, userId, resolved.country, year);
  const years = await getActivityYears(db, userId, resolved.country);
  const availableYears = years.length > 0 ? years : [year];
  const dayRows = (await exec(
    db,
    `select day, score_count, passed_count, session_count
     from player_activity_days
     where country = ? and user_id = ? and day >= ? and day <= ?
     order by day asc`,
    [resolved.country, userId, `${year}-01-01`, `${year}-12-31`],
  )).rows;
  const mapCountsByDay = await getActivityMapCountsByDay(db, userId, resolved.country, year);
  const days: PlayerActivityDay[] = dayRows.map((row) => {
    const date = String(row.day);
    return {
      date,
      scoreCount: Number(row.score_count) || 0,
      passedCount: Number(row.passed_count) || 0,
      sessionCount: Number(row.session_count) || 0,
      mapCount: mapCountsByDay.get(date) ?? 0,
      maps: [],
      skills: null,
      timeline: [],
    };
  });
  const totalScores = days.reduce((sum, day) => sum + day.scoreCount, 0);
  const totalSessions = days.reduce((sum, day) => sum + day.sessionCount, 0);
  const activeDays = days.filter((day) => day.scoreCount > 0).length;

  return {
    available: resolved.isTracked || days.length > 0,
    isTracked: resolved.isTracked,
    userId,
    country: resolved.country,
    year,
    availableYears,
    totalScores,
    activeDays,
    totalSessions,
    typicalSession: getTypicalSession(totalScores, totalSessions, activeDays),
    currentStreak: await getCurrentActivityStreak(db, userId, resolved.country, year),
    generatedAt,
    days,
  };
}

export async function getPlayerActivityDayDetail(
  db: Db,
  queue: JobQueue,
  userId: number,
  requestedCountry: string,
  requestedDay: string,
): Promise<PlayerActivityDay | null> {
  const day = normalizeActivityDayKey(requestedDay);
  if (!day) return null;
  const year = Number(day.slice(0, 4));
  const resolved = await resolveActivityCountry(db, userId, requestedCountry);
  if (!resolved.country) return null;

  await backfillPlayerActivityFromRetainedScores(db, queue, userId, resolved.country, year);
  const row = (await exec(
    db,
    `select day, score_count, passed_count, session_count
     from player_activity_days
     where country = ? and user_id = ? and day = ?
     limit 1`,
    [resolved.country, userId, day],
  )).rows[0];
  if (!row) return null;

  const mapsByDay = await getActivityMapsByDay(db, userId, resolved.country, year, {
    day,
    limit: ACTIVITY_DAY_DETAIL_MAP_LIMIT,
  });
  const maps = mapsByDay.get(day) ?? [];
  await enqueueMissingActivitySkillAnalyses(db, queue, mapsByDay);
  const mapCountsByDay = await getActivityMapCountsByDay(db, userId, resolved.country, year, day);
  const skillsByDay = await getActivitySkillsByDay(db, userId, resolved.country, year, day);
  const timelineByDay = await getActivityTimelineByDay(db, userId, resolved.country, year, day);

  return {
    date: day,
    scoreCount: Number(row.score_count) || 0,
    passedCount: Number(row.passed_count) || 0,
    sessionCount: Number(row.session_count) || 0,
    mapCount: mapCountsByDay.get(day) ?? maps.length,
    maps,
    skills: skillsByDay.get(day) ?? null,
    timeline: timelineByDay.get(day) ?? [],
  };
}

export async function getPlayerActivityAvailability(
  db: Db,
  userId: number,
  requestedCountry: string,
): Promise<PlayerActivityAvailability> {
  const generatedAt = nowIso();
  const resolved = await resolveActivityCountry(db, userId, requestedCountry);
  if (!resolved.country) {
    return {
      available: false,
      isTracked: false,
      userId,
      country: null,
      availableYears: [],
      generatedAt,
    };
  }

  const availableYears = await getActivityYears(db, userId, resolved.country);
  return {
    available: resolved.isTracked || availableYears.length > 0,
    isTracked: resolved.isTracked,
    userId,
    country: resolved.country,
    availableYears,
    generatedAt,
  };
}

async function backfillPlayerActivityFromRetainedScores(
  db: Db,
  queue: JobQueue,
  userId: number,
  country: string,
  year: number,
): Promise<void> {
  const rows = (await exec(
    db,
    `select score_identity, score_json
     from score_events
     where country = ? and user_id = ? and ended_at >= ? and ended_at <= ?
     order by ended_at asc
     limit 2000`,
    [country, userId, `${year}-01-01`, `${year}-12-31T23:59:59.999Z`],
  )).rows;
  for (const row of rows) {
    const score = parseJson<OscScore | null>(row.score_json, null);
    if (!score) continue;
    await recordPlayerActivity(db, queue, country, score, String(row.score_identity));
  }
}

async function enqueueMissingActivitySkillAnalyses(
  db: Db,
  queue: JobQueue,
  mapsByDay: Map<string, PlayerActivityMap[]>,
): Promise<void> {
  const beatmapIds = [...new Set([...mapsByDay.values()].flatMap((maps) => maps.map((map) => map.beatmapId)))]
    .filter((beatmapId) => Number.isInteger(beatmapId) && beatmapId > 0)
    .slice(0, 300);
  for (const beatmapId of beatmapIds) {
    await enqueueBeatmapSkillAnalysisIfNeeded(db, queue, beatmapId);
  }
}

export async function computeBeatmapActivitySkillVector(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  payload: { beatmapId: number },
): Promise<void> {
  const beatmapId = Math.floor(Number(payload.beatmapId));
  if (!Number.isFinite(beatmapId) || beatmapId <= 0) return;
  const now = nowIso();
  await exec(
    db,
    `insert into beatmap_skill_vectors (beatmap_id, analysis_version, status, updated_at)
     values (?, ?, 'running', ?)
     on conflict(beatmap_id, analysis_version) do update set
       status = 'running',
       error = null,
       updated_at = excluded.updated_at`,
    [beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION, now],
  );

  try {
    const osuFile = await osu.getBeatmapFile(beatmapId, "job:analyze_activity_beatmap");
    const map = parseManiaBeatmap(osuFile);
    const vector = getActivitySkillVector(map);
    const computedAt = nowIso();
    await exec(
      db,
      `insert into beatmap_skill_vectors
         (beatmap_id, analysis_version, status, stream_score, jack_score, bracket_score, ln_score, ln_general_score, ln_release_score, ln_inverse_score, ln_tech_score, error, computed_at, updated_at)
       values (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)
       on conflict(beatmap_id, analysis_version) do update set
         status = excluded.status,
         stream_score = excluded.stream_score,
         jack_score = excluded.jack_score,
         bracket_score = excluded.bracket_score,
         ln_score = excluded.ln_score,
         ln_general_score = excluded.ln_general_score,
         ln_release_score = excluded.ln_release_score,
         ln_inverse_score = excluded.ln_inverse_score,
         ln_tech_score = excluded.ln_tech_score,
         error = excluded.error,
         computed_at = excluded.computed_at,
         updated_at = excluded.updated_at`,
      [
        beatmapId,
        ACTIVITY_SKILL_ANALYSIS_VERSION,
        vector.stream,
        vector.jack,
        vector.bracket,
        vector.ln,
        vector.lnGeneral,
        vector.lnRelease,
        vector.lnInverse,
        vector.lnTech,
        computedAt,
        computedAt,
      ],
    );
  } catch (error) {
    const failedAt = nowIso();
    await exec(
      db,
      `insert into beatmap_skill_vectors
         (beatmap_id, analysis_version, status, error, updated_at)
       values (?, ?, 'failed', ?, ?)
       on conflict(beatmap_id, analysis_version) do update set
         status = excluded.status,
         error = excluded.error,
         updated_at = excluded.updated_at`,
      [beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION, error instanceof Error ? error.message : String(error), failedAt],
    );
    throw error;
  }
}

async function upsertActivityDay(
  db: Db,
  activity: NonNullable<ReturnType<typeof readScoreActivityInput>>,
  now: string,
): Promise<void> {
  await exec(
    db,
    `insert into player_activity_days
       (country, user_id, day, score_count, passed_count, session_count, first_score_at, last_score_at, updated_at)
     values (?, ?, ?, 1, ?, 1, ?, ?, ?)
     on conflict(country, user_id, day) do update set
       score_count = player_activity_days.score_count + 1,
       passed_count = player_activity_days.passed_count + excluded.passed_count,
       first_score_at = case
         when player_activity_days.first_score_at is null or excluded.first_score_at < player_activity_days.first_score_at
           then excluded.first_score_at
         else player_activity_days.first_score_at
       end,
       last_score_at = case
         when player_activity_days.last_score_at is null or excluded.last_score_at > player_activity_days.last_score_at
           then excluded.last_score_at
         else player_activity_days.last_score_at
       end,
       updated_at = excluded.updated_at`,
    [
      activity.country,
      activity.userId,
      activity.day,
      activity.passed ? 1 : 0,
      activity.endedAt,
      activity.endedAt,
      now,
    ],
  );
}

async function upsertActivityMap(
  db: Db,
  activity: NonNullable<ReturnType<typeof readScoreActivityInput>>,
  score: OscScore,
  now: string,
): Promise<void> {
  const pp = score.pp == null ? null : Number(score.pp);
  const accuracy = getDisplayedAccuracy(score);
  const scoreId = Number(score.legacy_score_id && score.legacy_score_id > 0 ? score.legacy_score_id : score.id);
  await exec(
    db,
    `insert into player_activity_maps
       (country, user_id, day, beatmap_id, play_count, best_score_id, best_pp, best_accuracy, best_rank, first_played_at, last_played_at, updated_at)
     values (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     on conflict(country, user_id, day, beatmap_id) do update set
       play_count = player_activity_maps.play_count + 1,
       best_score_id = case when ${activityMapBetterSql()} then excluded.best_score_id else player_activity_maps.best_score_id end,
       best_pp = case when ${activityMapBetterSql()} then excluded.best_pp else player_activity_maps.best_pp end,
       best_accuracy = case when ${activityMapBetterSql()} then excluded.best_accuracy else player_activity_maps.best_accuracy end,
       best_rank = case when ${activityMapBetterSql()} then excluded.best_rank else player_activity_maps.best_rank end,
       first_played_at = case
         when player_activity_maps.first_played_at is null or excluded.first_played_at < player_activity_maps.first_played_at
           then excluded.first_played_at
         else player_activity_maps.first_played_at
       end,
       last_played_at = case
         when player_activity_maps.last_played_at is null or excluded.last_played_at > player_activity_maps.last_played_at
           then excluded.last_played_at
         else player_activity_maps.last_played_at
       end,
       updated_at = excluded.updated_at`,
    [
      activity.country,
      activity.userId,
      activity.day,
      activity.beatmapId,
      Number.isFinite(scoreId) && scoreId > 0 ? scoreId : null,
      Number.isFinite(pp) ? pp : null,
      Number.isFinite(accuracy) ? accuracy : null,
      getDisplayedRank(score),
      activity.endedAt,
      activity.endedAt,
      now,
    ],
  );
}

async function recomputeActivitySessions(db: Db, country: string, userId: number, day: string): Promise<void> {
  const rows = (await exec(
    db,
    `select ended_at
     from player_activity_score_refs
     where country = ? and user_id = ? and day = ?
     order by ended_at asc`,
    [country, userId, day],
  )).rows;
  let sessions = 0;
  let previous = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const row of rows) {
    const endedAt = String(row.ended_at);
    const time = Date.parse(endedAt);
    if (!Number.isFinite(time)) continue;
    first ??= endedAt;
    last = endedAt;
    if (sessions === 0 || time - previous > ACTIVITY_SESSION_GAP_MS) sessions++;
    previous = time;
  }
  await exec(
    db,
    `update player_activity_days
     set session_count = ?,
         first_score_at = ?,
         last_score_at = ?,
         updated_at = ?
     where country = ? and user_id = ? and day = ?`,
    [sessions, first, last, nowIso(), country, userId, day],
  );
}

async function enqueueBeatmapSkillAnalysisIfNeeded(db: Db, queue: JobQueue, beatmapId: number): Promise<void> {
  const row = (await exec(
    db,
    `select status, updated_at
     from beatmap_skill_vectors
     where beatmap_id = ? and analysis_version = ?
     limit 1`,
    [beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION],
  )).rows[0];
  if (row) {
    const status = String(row.status);
    const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
    if (status === "ready") return;
    if (status === "running" && isRecentActivityAnalysisStatus(updatedAt, ACTIVITY_ANALYSIS_RUNNING_REQUEUE_MS)) return;
    if (status === "failed" && isRecentActivityAnalysisStatus(updatedAt, ACTIVITY_ANALYSIS_FAILED_RETRY_MS)) return;
  }
  await queue.enqueue(
    "analyze_activity_beatmap",
    `activity-beatmap:${ACTIVITY_SKILL_ANALYSIS_VERSION}:${beatmapId}`,
    { beatmapId },
    { priority: 5, replaceDone: true },
  );
}

function isRecentActivityAnalysisStatus(updatedAt: string, cooldownMs: number): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;
  return Date.now() - updatedAtMs < cooldownMs;
}

async function resolveActivityCountry(db: Db, userId: number, requestedCountry: string): Promise<ResolvedActivityCountry> {
  const normalized = requestedCountry.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) {
    const row = (await exec(
      db,
      `select
         exists(select 1 from country_rosters where country = ? and user_id = ? and is_tracked = 1) as roster_tracked,
         exists(select 1 from player_activity_days where country = ? and user_id = ? limit 1) as has_activity`,
      [normalized, userId, normalized, userId],
    )).rows[0];
    return {
      country: normalized,
      isTracked: !!Number(row?.roster_tracked) || !!Number(row?.has_activity),
    };
  }

  const activityCountry = (await exec(
    db,
    `select country
     from player_activity_days
     where user_id = ?
     order by last_score_at desc
     limit 1`,
    [userId],
  )).rows[0]?.country;
  if (typeof activityCountry === "string" && /^[A-Z]{2}$/.test(activityCountry)) {
    return { country: activityCountry, isTracked: true };
  }

  const rosterCountry = (await exec(
    db,
    `select country
     from country_rosters
     where user_id = ? and is_tracked = 1
     order by case when rank is null then 1 else 0 end, rank asc, country asc
     limit 1`,
    [userId],
  )).rows[0]?.country;
  if (typeof rosterCountry === "string" && /^[A-Z]{2}$/.test(rosterCountry)) {
    return { country: rosterCountry, isTracked: true };
  }

  return { country: null, isTracked: false };
}

async function getActivityYears(db: Db, userId: number, country: string): Promise<number[]> {
  const rows = (await exec(
    db,
    `select distinct substr(day, 1, 4) as year
     from player_activity_days
     where country = ? and user_id = ?
     order by year desc`,
    [country, userId],
  )).rows;
  return rows
    .map((row) => Number(row.year))
    .filter((year) => Number.isInteger(year) && year >= 2007 && year <= 2100);
}

async function getActivityMapsByDay(
  db: Db,
  userId: number,
  country: string,
  year: number,
  options: { day?: string; limit?: number } = {},
): Promise<Map<string, PlayerActivityMap[]>> {
  const day = options.day ? normalizeActivityDayKey(options.day) : null;
  const limit = Math.max(1, Math.min(options.limit ?? ACTIVITY_DAY_MAP_LIMIT, ACTIVITY_DAY_DETAIL_MAP_LIMIT));
  const rangeSql = day ? "m.day = ?" : "m.day >= ? and m.day <= ?";
  const rangeArgs = day ? [day] : [`${year}-01-01`, `${year}-12-31`];
  const rows = (await exec(
    db,
    `with ranked_maps as (
       select
         m.*,
         b.beatmapset_id,
         b.cs,
         b.version,
         s.title,
         s.artist,
         s.covers_json,
         v.status as skill_status,
         v.stream_score,
         v.jack_score,
         v.bracket_score,
         v.ln_score,
         v.ln_general_score,
         v.ln_release_score,
         v.ln_inverse_score,
         v.ln_tech_score,
         row_number() over (
           partition by m.day
           order by m.play_count desc, coalesce(m.best_pp, 0) desc, m.last_played_at desc, m.beatmap_id asc
         ) as rn
       from player_activity_maps m
       left join beatmaps b on b.beatmap_id = m.beatmap_id
       left join beatmapsets s on s.beatmapset_id = b.beatmapset_id
       left join beatmap_skill_vectors v
         on v.beatmap_id = m.beatmap_id and v.analysis_version = ?
       where m.country = ? and m.user_id = ? and ${rangeSql}
     )
     select *
     from ranked_maps
     where rn <= ?
     order by day asc, rn asc`,
    [ACTIVITY_SKILL_ANALYSIS_VERSION, country, userId, ...rangeArgs, limit],
  )).rows;
  const byDay = new Map<string, PlayerActivityMap[]>();
  for (const row of rows) {
    const day = String(row.day);
    const beatmapId = Number(row.beatmap_id);
    const beatmapsetId = row.beatmapset_id == null ? null : Number(row.beatmapset_id);
    const safeBeatmapsetId = beatmapsetId != null && Number.isFinite(beatmapsetId) && beatmapsetId > 0 ? beatmapsetId : null;
    const map: PlayerActivityMap = {
      key: `${day}:${beatmapId}`,
      beatmapId,
      beatmapsetId: safeBeatmapsetId,
      title: String(row.title ?? "Unknown"),
      artist: String(row.artist ?? "Unknown artist"),
      version: String(row.version ?? "Unknown"),
      coverUrl: getActivityCoverUrl(row.covers_json, safeBeatmapsetId),
      plays: Number(row.play_count) || 0,
      accuracy: row.best_accuracy == null ? null : Number(row.best_accuracy),
      pp: row.best_pp == null ? null : Number(row.best_pp),
      rank: row.best_rank == null ? null : String(row.best_rank),
      keyCount: row.cs == null ? null : Number(row.cs),
      skills: readActivitySkillVector(row),
    };
    byDay.set(day, [...(byDay.get(day) ?? []), map]);
  }
  return byDay;
}

async function getActivityMapCountsByDay(db: Db, userId: number, country: string, year: number, requestedDay?: string): Promise<Map<string, number>> {
  const day = requestedDay ? normalizeActivityDayKey(requestedDay) : null;
  const rangeSql = day ? "day = ?" : "day >= ? and day <= ?";
  const rangeArgs = day ? [day] : [`${year}-01-01`, `${year}-12-31`];
  const rows = (await exec(
    db,
    `select day, count(*) as map_count
     from player_activity_maps
     where country = ? and user_id = ? and ${rangeSql}
     group by day`,
    [country, userId, ...rangeArgs],
  )).rows;
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(String(row.day), Number(row.map_count) || 0);
  }
  return counts;
}

async function getActivitySkillsByDay(db: Db, userId: number, country: string, year: number, requestedDay?: string): Promise<Map<string, PlayerActivitySkillReadout>> {
  const day = requestedDay ? normalizeActivityDayKey(requestedDay) : null;
  const rangeSql = day ? "m.day = ?" : "m.day >= ? and m.day <= ?";
  const rangeArgs = day ? [day] : [`${year}-01-01`, `${year}-12-31`];
  const rows = (await exec(
    db,
    `select
       m.day,
       b.cs as key_count,
       sum(m.play_count) as total_plays,
       sum(case when v.status = 'ready' then m.play_count else 0 end) as analyzed_plays,
       sum(case when v.status = 'ready' then m.play_count * v.stream_score else 0 end) as stream_sum,
       sum(case when v.status = 'ready' then m.play_count * v.jack_score else 0 end) as jack_sum,
       sum(case when v.status = 'ready' then m.play_count * v.bracket_score else 0 end) as bracket_sum,
       sum(case when v.status = 'ready' then m.play_count * v.ln_score else 0 end) as ln_sum,
       sum(case when v.status = 'ready' then m.play_count * v.ln_general_score else 0 end) as ln_general_sum,
       sum(case when v.status = 'ready' then m.play_count * v.ln_release_score else 0 end) as ln_release_sum,
       sum(case when v.status = 'ready' then m.play_count * v.ln_inverse_score else 0 end) as ln_inverse_sum,
       sum(case when v.status = 'ready' then m.play_count * v.ln_tech_score else 0 end) as ln_tech_sum
     from player_activity_maps m
     left join beatmaps b on b.beatmap_id = m.beatmap_id
     left join beatmap_skill_vectors v
       on v.beatmap_id = m.beatmap_id and v.analysis_version = ?
     where m.country = ? and m.user_id = ? and ${rangeSql}
     group by m.day, b.cs`,
    [ACTIVITY_SKILL_ANALYSIS_VERSION, country, userId, ...rangeArgs],
  )).rows;
  const byDay = new Map<string, ActivitySkillAccumulator>();
  for (const row of rows) {
    const analyzedPlays = Number(row.analyzed_plays) || 0;
    const totalPlays = Number(row.total_plays) || 0;
    if (totalPlays <= 0) continue;
    const day = String(row.day);
    const streamSum = Number(row.stream_sum ?? 0);
    const jackSum = Number(row.jack_sum ?? 0);
    const bracketSum = Number(row.bracket_sum ?? 0);
    const lnSum = Number(row.ln_sum ?? 0);
    const lnGeneralSum = Number(row.ln_general_sum ?? 0);
    const lnReleaseSum = Number(row.ln_release_sum ?? 0);
    const lnInverseSum = Number(row.ln_inverse_sum ?? 0);
    const lnTechSum = Number(row.ln_tech_sum ?? 0);
    const keyCount = Number(row.key_count);
    const safeKeyCount = Number.isFinite(keyCount) && keyCount > 0 ? Math.round(keyCount) : null;
    const keyMode: PlayerActivityKeyModeSkillReadout = {
      keyCount: safeKeyCount,
      stream: analyzedPlays > 0 ? streamSum / analyzedPlays : 0,
      jack: analyzedPlays > 0 ? jackSum / analyzedPlays : 0,
      bracket: analyzedPlays > 0 ? bracketSum / analyzedPlays : 0,
      ln: analyzedPlays > 0 ? lnSum / analyzedPlays : 0,
      lnGeneral: analyzedPlays > 0 ? lnGeneralSum / analyzedPlays : 0,
      lnRelease: analyzedPlays > 0 ? lnReleaseSum / analyzedPlays : 0,
      lnInverse: analyzedPlays > 0 ? lnInverseSum / analyzedPlays : 0,
      lnTech: analyzedPlays > 0 ? lnTechSum / analyzedPlays : 0,
      analyzedPlays,
      totalPlays,
    };
    const accumulator = byDay.get(day) ?? {
      streamSum: 0,
      jackSum: 0,
      bracketSum: 0,
      lnSum: 0,
      lnGeneralSum: 0,
      lnReleaseSum: 0,
      lnInverseSum: 0,
      lnTechSum: 0,
      analyzedPlays: 0,
      totalPlays: 0,
      keyModes: [],
    };
    accumulator.streamSum += streamSum;
    accumulator.jackSum += jackSum;
    accumulator.bracketSum += bracketSum;
    accumulator.lnSum += lnSum;
    accumulator.lnGeneralSum += lnGeneralSum;
    accumulator.lnReleaseSum += lnReleaseSum;
    accumulator.lnInverseSum += lnInverseSum;
    accumulator.lnTechSum += lnTechSum;
    accumulator.analyzedPlays += analyzedPlays;
    accumulator.totalPlays += totalPlays;
    accumulator.keyModes.push(keyMode);
    byDay.set(day, accumulator);
  }
  const output = new Map<string, PlayerActivitySkillReadout>();
  for (const [day, accumulator] of byDay) {
    const analyzedPlays = accumulator.analyzedPlays;
    output.set(day, {
      stream: analyzedPlays > 0 ? accumulator.streamSum / analyzedPlays : 0,
      jack: analyzedPlays > 0 ? accumulator.jackSum / analyzedPlays : 0,
      bracket: analyzedPlays > 0 ? accumulator.bracketSum / analyzedPlays : 0,
      ln: analyzedPlays > 0 ? accumulator.lnSum / analyzedPlays : 0,
      lnGeneral: analyzedPlays > 0 ? accumulator.lnGeneralSum / analyzedPlays : 0,
      lnRelease: analyzedPlays > 0 ? accumulator.lnReleaseSum / analyzedPlays : 0,
      lnInverse: analyzedPlays > 0 ? accumulator.lnInverseSum / analyzedPlays : 0,
      lnTech: analyzedPlays > 0 ? accumulator.lnTechSum / analyzedPlays : 0,
      analyzedPlays,
      totalPlays: accumulator.totalPlays,
      keyModes: accumulator.keyModes.sort((left, right) =>
        (left.keyCount ?? Number.MAX_SAFE_INTEGER) - (right.keyCount ?? Number.MAX_SAFE_INTEGER),
      ),
    });
  }
  return output;
}

interface ActivitySkillAccumulator {
  streamSum: number;
  jackSum: number;
  bracketSum: number;
  lnSum: number;
  lnGeneralSum: number;
  lnReleaseSum: number;
  lnInverseSum: number;
  lnTechSum: number;
  analyzedPlays: number;
  totalPlays: number;
  keyModes: PlayerActivityKeyModeSkillReadout[];
}

async function getActivityTimelineByDay(db: Db, userId: number, country: string, year: number, requestedDay?: string): Promise<Map<string, PlayerActivityTimelineSegment[]>> {
  const day = requestedDay ? normalizeActivityDayKey(requestedDay) : null;
  const rangeSql = day ? "r.day = ?" : "r.day >= ? and r.day <= ?";
  const rangeArgs = day ? [day] : [`${year}-01-01`, `${year}-12-31`];
  const rows = (await exec(
    db,
    `select
       r.day,
       r.score_identity,
       r.ended_at,
       r.beatmap_id,
       b.cs,
       v.status as skill_status,
       v.stream_score,
       v.jack_score,
       v.bracket_score,
       v.ln_score,
       v.ln_general_score,
       v.ln_release_score,
       v.ln_inverse_score,
       v.ln_tech_score
     from player_activity_score_refs r
     left join beatmaps b on b.beatmap_id = r.beatmap_id
     left join beatmap_skill_vectors v
       on v.beatmap_id = r.beatmap_id and v.analysis_version = ?
     where r.country = ? and r.user_id = ? and ${rangeSql}
     order by r.day asc, r.ended_at asc, r.score_identity asc`,
    [ACTIVITY_SKILL_ANALYSIS_VERSION, country, userId, ...rangeArgs],
  )).rows;
  const byDay = new Map<string, PlayerActivityTimelineSegment[]>();
  let currentDay: string | null = null;
  let sessionIndex = 1;
  let previousMs = 0;
  let draft: TimelineSegmentDraft | null = null;

  const flush = () => {
    if (!currentDay || !draft) return;
    byDay.set(currentDay, [...(byDay.get(currentDay) ?? []), finalizeTimelineDraft(currentDay, draft)]);
    draft = null;
  };

  for (const row of rows) {
    const day = String(row.day);
    const endedAt = String(row.ended_at);
    const endedAtMs = Date.parse(endedAt);
    if (!Number.isFinite(endedAtMs)) continue;

    if (currentDay !== day) {
      flush();
      currentDay = day;
      sessionIndex = 1;
      previousMs = 0;
    }

    const keyCount = Number(row.cs);
    const safeKeyCount = Number.isFinite(keyCount) && keyCount > 0 ? Math.round(keyCount) : null;
    const skills = readActivitySkillVector(row);
    const primarySkill = getPrimaryActivitySkill(skills);
    const startsNewSession = previousMs > 0 && endedAtMs - previousMs > ACTIVITY_SESSION_GAP_MS;
    if (
      startsNewSession ||
      !draft ||
      draft.keyCount !== safeKeyCount ||
      draft.primarySkill !== primarySkill
    ) {
      flush();
      if (startsNewSession) sessionIndex++;
      draft = {
        sessionIndex,
        startAt: endedAt,
        endAt: endedAt,
        playCount: 0,
        keyCount: safeKeyCount,
        primarySkill,
        streamSum: 0,
        jackSum: 0,
        bracketSum: 0,
        lnSum: 0,
        lnGeneralSum: 0,
        lnReleaseSum: 0,
        lnInverseSum: 0,
        lnTechSum: 0,
        analyzedCount: 0,
      };
    }

    draft.endAt = endedAt;
    draft.playCount++;
    if (skills) {
      draft.streamSum += skills.stream;
      draft.jackSum += skills.jack;
      draft.bracketSum += skills.bracket;
      draft.lnSum += skills.ln;
      draft.lnGeneralSum += skills.lnGeneral;
      draft.lnReleaseSum += skills.lnRelease;
      draft.lnInverseSum += skills.lnInverse;
      draft.lnTechSum += skills.lnTech;
      draft.analyzedCount++;
    }
    previousMs = endedAtMs;
  }
  flush();
  return byDay;
}

interface TimelineSegmentDraft {
  sessionIndex: number;
  startAt: string;
  endAt: string;
  playCount: number;
  keyCount: number | null;
  primarySkill: PlayerActivityPrimarySkill;
  streamSum: number;
  jackSum: number;
  bracketSum: number;
  lnSum: number;
  lnGeneralSum: number;
  lnReleaseSum: number;
  lnInverseSum: number;
  lnTechSum: number;
  analyzedCount: number;
}

function finalizeTimelineDraft(day: string, draft: TimelineSegmentDraft): PlayerActivityTimelineSegment {
  const divisor = Math.max(1, draft.analyzedCount);
  return {
    key: `${day}:${draft.sessionIndex}:${draft.startAt}:${draft.endAt}`,
    sessionIndex: draft.sessionIndex,
    startAt: draft.startAt,
    endAt: draft.endAt,
    playCount: draft.playCount,
    keyCount: draft.keyCount,
    primarySkill: draft.primarySkill,
    stream: draft.analyzedCount > 0 ? draft.streamSum / divisor : 0,
    jack: draft.analyzedCount > 0 ? draft.jackSum / divisor : 0,
    bracket: draft.analyzedCount > 0 ? draft.bracketSum / divisor : 0,
    ln: draft.analyzedCount > 0 ? draft.lnSum / divisor : 0,
    lnGeneral: draft.analyzedCount > 0 ? draft.lnGeneralSum / divisor : 0,
    lnRelease: draft.analyzedCount > 0 ? draft.lnReleaseSum / divisor : 0,
    lnInverse: draft.analyzedCount > 0 ? draft.lnInverseSum / divisor : 0,
    lnTech: draft.analyzedCount > 0 ? draft.lnTechSum / divisor : 0,
  };
}

function readActivitySkillVector(row: Record<string, unknown>): ActivitySkillVector | null {
  if (String(row.skill_status ?? "") !== "ready") return null;
  const stream = Number(row.stream_score);
  const jack = Number(row.jack_score);
  const bracket = Number(row.bracket_score);
  const ln = Number(row.ln_score);
  const lnGeneral = Number(row.ln_general_score ?? 0);
  const lnRelease = Number(row.ln_release_score ?? 0);
  const lnInverse = Number(row.ln_inverse_score ?? 0);
  const lnTech = Number(row.ln_tech_score ?? 0);
  if (
    !Number.isFinite(stream)
    || !Number.isFinite(jack)
    || !Number.isFinite(bracket)
    || !Number.isFinite(ln)
    || !Number.isFinite(lnGeneral)
    || !Number.isFinite(lnRelease)
    || !Number.isFinite(lnInverse)
    || !Number.isFinite(lnTech)
  ) {
    return null;
  }
  return {
    stream: clamp01(stream),
    jack: clamp01(jack),
    bracket: clamp01(bracket),
    ln: clamp01(ln),
    lnGeneral: clamp01(lnGeneral),
    lnRelease: clamp01(lnRelease),
    lnInverse: clamp01(lnInverse),
    lnTech: clamp01(lnTech),
  };
}

function getPrimaryActivitySkill(vector: ActivitySkillVector | null): PlayerActivityPrimarySkill {
  if (!vector) return "unknown";
  const entries = [
    ["stream", vector.stream],
    ["jack", vector.jack],
    ["bracket", vector.bracket],
    ["ln", vector.ln],
  ] as const;
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] < 0.1) return "unknown";
  if (sorted[0][1] - sorted[1][1] <= 0.08) return "mixed";
  if (sorted[0][0] === "ln") return getPrimaryLnActivitySubtype(vector) ?? "ln";
  return sorted[0][0];
}

function getPrimaryLnActivitySubtype(vector: ActivitySkillVector): PlayerActivityPrimarySkill | null {
  const entries = [
    ["lnGeneral", vector.lnGeneral],
    ["lnRelease", vector.lnRelease],
    ["lnInverse", vector.lnInverse],
    ["lnTech", vector.lnTech],
  ] as const;
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  return sorted[0][1] >= 0.2 ? sorted[0][0] : null;
}

async function getCurrentActivityStreak(db: Db, userId: number, country: string, year: number): Promise<number> {
  const today = new Date();
  const selectedYear = clampYear(year);
  const cursor = selectedYear === today.getUTCFullYear()
    ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
    : new Date(Date.UTC(selectedYear, 11, 31));
  const start = new Date(Date.UTC(selectedYear, 0, 1));
  const rows = (await exec(
    db,
    `select day
     from player_activity_days
     where country = ? and user_id = ? and day >= ? and day <= ? and score_count > 0`,
    [country, userId, toUtcDateKey(start), toUtcDateKey(cursor)],
  )).rows;
  const active = new Set(rows.map((row) => String(row.day)));
  let streak = 0;
  for (let day = cursor; day >= start; day = addUtcDays(day, -1)) {
    if (!active.has(toUtcDateKey(day))) break;
    streak++;
  }
  return streak;
}

function getActivitySkillVector(map: ReturnType<typeof parseManiaBeatmap>): ActivitySkillVector {
  const features = extractDanFeatures(map, {
    totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
    version: map.version,
  }, 1);
  const { metrics } = features;
  const chordGate = clamp01((metrics.chordRatio - 0.35) / 0.35);
  const bracketScore = clamp01(
    pressureScore(metrics.chordjackPressure, 240) * 0.45
    + chordGate * 0.22
    + clamp01(metrics.chordSizeChangeRate / 0.75) * 0.14
    + clamp01(metrics.twoNoteChordRatio / 0.5) * 0.1
    + clamp01(metrics.rowPatternVariety / 0.9) * 0.09,
  );
  const chordHeavyStreamPenalty = 1 - bracketScore * 0.45;
  const chordHeavyJackPenalty = 1 - chordGate * 0.28;
  const lnScore = clamp01(
    metrics.holdRatio * 1.25
    + pressureScore(metrics.lnReleasePressure, 30) * 0.28
    + pressureScore(metrics.lnOverlapPressure, 8) * 0.24
    + pressureScore(metrics.lnChordPressure, 1) * 0.18,
  );
  const lnSubtypeScores = getActivityLnSubtypeScores(features.notes, features.orderedRows, metrics);
  return {
    stream: clamp01(
      (
        pressureScore(metrics.streamPressure, 8) * 0.42
        + pressureScore(metrics.jumpstreamPressure, 30) * 0.18
        + pressureScore(metrics.staminaPressure, 30) * 0.25
        + pressureScore(metrics.activeNps, 30) * 0.15
      ) * chordHeavyStreamPenalty,
    ),
    jack: clamp01(
      (
        pressureScore(metrics.jackPressure, 190) * 0.64
        + pressureScore(metrics.anchorPressure, 2) * 0.22
        + clamp01(metrics.repeatedRowPatternRatio / 0.35) * 0.14
      ) * chordHeavyJackPenalty
      + pressureScore(metrics.chordjackPressure, 240) * 0.08,
    ),
    bracket: bracketScore,
    ln: lnScore,
    ...lnSubtypeScores,
  };
}

interface ActivityLnPatternStats {
  inverseReleaseRatio: number;
  releaseOnlyRatio: number;
  headTailSwitchRatio: number;
  mixedRowRatio: number;
  tapWhileHoldingRatio: number;
}

function getActivityLnPatternStats(
  notes: ManiaNote[],
  orderedRows: Array<[number, ManiaNote[]]>,
  keyCount: number,
): ActivityLnPatternStats {
  const releaseRows = new Map<number, ManiaNote[]>();
  const headTimes = new Set<number>();
  const holdEvents: Array<{ time: number; delta: number }> = [];
  const notesByColumn = Array.from({ length: Math.max(1, keyCount) }, () => [] as ManiaNote[]);

  for (const note of notes) {
    if (note.column >= 0 && note.column < notesByColumn.length) notesByColumn[note.column].push(note);
    if (!note.isHold || note.endTime <= note.time) continue;

    const releaseRow = releaseRows.get(note.endTime);
    if (releaseRow) releaseRow.push(note);
    else releaseRows.set(note.endTime, [note]);
    holdEvents.push({ time: note.time, delta: 1 }, { time: note.endTime, delta: -1 });
  }

  holdEvents.sort((left, right) => left.time - right.time || right.delta - left.delta);

  let activeHolds = 0;
  let eventIndex = 0;
  let mixedRows = 0;
  let tapWhileHoldingRows = 0;
  let headTailSwitchRows = 0;

  for (const [time, rowNotes] of orderedRows) {
    headTimes.add(time);

    while (eventIndex < holdEvents.length && holdEvents[eventIndex].time < time) {
      activeHolds = Math.max(0, activeHolds + holdEvents[eventIndex].delta);
      eventIndex++;
    }

    const hasHold = rowNotes.some((note) => note.isHold);
    const hasTap = rowNotes.some((note) => !note.isHold);
    if (hasHold && hasTap) mixedRows++;
    if (hasTap && activeHolds > 0) tapWhileHoldingRows++;
    if (releaseRows.has(time)) headTailSwitchRows++;
  }

  let releaseOnlyRows = 0;
  for (const time of releaseRows.keys()) {
    if (!headTimes.has(time)) releaseOnlyRows++;
  }

  let inverseLikeHolds = 0;
  let sameColumnNextHolds = 0;
  for (const columnNotes of notesByColumn) {
    columnNotes.sort((left, right) => left.time - right.time || left.endTime - right.endTime);
    for (let index = 0; index < columnNotes.length - 1; index++) {
      const note = columnNotes[index];
      if (!note.isHold || note.endTime <= note.time) continue;

      const nextNote = columnNotes[index + 1];
      const gap = nextNote.time - note.endTime;
      if (gap < 0) continue;

      const gapRatio = gap / Math.max(1, note.endTime - note.time);
      sameColumnNextHolds++;
      if (gap <= 120 && gapRatio <= 0.7) inverseLikeHolds++;
    }
  }

  const rowCount = Math.max(1, orderedRows.length);
  const releaseRowCount = releaseRows.size;

  return {
    inverseReleaseRatio: sameColumnNextHolds ? inverseLikeHolds / sameColumnNextHolds : 0,
    releaseOnlyRatio: releaseRowCount ? releaseOnlyRows / releaseRowCount : 0,
    headTailSwitchRatio: headTailSwitchRows / rowCount,
    mixedRowRatio: mixedRows / rowCount,
    tapWhileHoldingRatio: tapWhileHoldingRows / rowCount,
  };
}

function getActivityLnSubtypeScores(
  notes: ManiaNote[],
  orderedRows: Array<[number, ManiaNote[]]>,
  metrics: DanFeatureMetrics,
): Pick<ActivitySkillVector, "lnGeneral" | "lnRelease" | "lnInverse" | "lnTech"> {
  if (metrics.keyCount !== 7) {
    return { lnGeneral: 0, lnRelease: 0, lnInverse: 0, lnTech: 0 };
  }

  const stats = getActivityLnPatternStats(notes, orderedRows, metrics.keyCount);
  const lnPatternScore = Math.max(
    pressure(metrics.holdRatio, 0.03, 0.32),
    minGate(pressure(metrics.lnDensity, 0.02, 0.18), pressure(metrics.lnOverlapPressure, 0.4, 2.4)),
    minGate(pressure(metrics.lnReleasePressure, 1.2, 5.5), pressure(metrics.holdRatio, 0.015, 0.16)),
    minGate(pressure(metrics.lnChordPressure, 0.15, 0.65), pressure(metrics.holdRatio, 0.02, 0.18)),
  );
  const gate = pressure(lnPatternScore, 0.18, 0.58);
  const lnInverse = gate * minGate(
    pressure(stats.inverseReleaseRatio, 0.24, 0.62),
    pressure(metrics.lnDensity, 0.12, 0.5),
    Math.max(
      pressure(metrics.lnOverlapPressure, 1.1, 3.1),
      pressure(metrics.lnHoldDurationP90, 260, 520),
    ),
    clamp01((0.16 - stats.mixedRowRatio) / 0.16),
  );
  const lnRelease = gate * minGate(
    pressure(stats.releaseOnlyRatio, 0.48, 0.68),
    pressure(metrics.lnReleasePressure, 12, 30),
    clamp01((0.45 - stats.inverseReleaseRatio) / 0.32),
    clamp01((520 - metrics.lnHoldDurationP90) / 260),
  );
  const lnTechBurst = Math.max(
    pressure(metrics.fastRowRatio, 0.18, 0.36),
    pressure(metrics.rowBurstPressure, 16, 26),
  );
  const lnTechCoordination = Math.max(
    pressure(stats.tapWhileHoldingRatio, 0.04, 0.11),
    pressure(stats.headTailSwitchRatio, 0.52, 0.72),
    pressure(metrics.chordSizeChangeRate, 0.55, 0.78),
  );
  const lnTech = gate * minGate(
    lnTechBurst,
    lnTechCoordination,
    Math.max(
      pressure(metrics.techPressure, 4.2, 8.4),
      pressure(metrics.rowIntervalEntropy, 2.0, 2.45),
    ),
    clamp01((0.6 - stats.inverseReleaseRatio) / 0.34),
    clamp01((0.66 - stats.releaseOnlyRatio) / 0.22),
  );
  const lnGeneralCoverage = Math.max(
    minGate(
      pressure(metrics.holdRatio, 0.35, 0.82),
      pressure(metrics.lnChordPressure, 0.32, 0.66),
      pressure(stats.headTailSwitchRatio, 0.35, 0.62),
    ),
    minGate(
      pressure(metrics.lnDensity, 0.12, 0.42),
      pressure(metrics.lnReleasePressure, 8, 24),
      pressure(metrics.chordRatio, 0.28, 0.62),
    ),
  );
  const lnSpecialtyScore = Math.max(lnInverse, lnRelease, lnTech);
  const lnGeneral = gate
    * lnGeneralCoverage
    * (0.35 + 0.65 * clamp01((0.78 - lnSpecialtyScore) / 0.38));

  return {
    lnGeneral: clamp01(lnGeneral),
    lnRelease: clamp01(lnRelease),
    lnInverse: clamp01(lnInverse),
    lnTech: clamp01(lnTech),
  };
}

function readScoreActivityInput(country: string, score: OscScore, scoreIdentity: string) {
  const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
  const userId = Number(score.user_id);
  const endedAt = getScoreTimestamp(score) || nowIso();
  const endedAtMs = Date.parse(endedAt);
  const normalizedCountry = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedCountry)) return null;
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(beatmapId) || beatmapId <= 0) return null;
  if (!Number.isFinite(endedAtMs)) return null;
  return {
    country: normalizedCountry,
    scoreIdentity,
    userId,
    beatmapId,
    passed: !!score.passed,
    endedAt: new Date(endedAtMs).toISOString(),
    day: new Date(endedAtMs).toISOString().slice(0, 10),
  };
}

function activityMapBetterSql(): string {
  return `(
    coalesce(excluded.best_pp, -1) > coalesce(player_activity_maps.best_pp, -1)
    or (
      coalesce(excluded.best_pp, -1) = coalesce(player_activity_maps.best_pp, -1)
      and coalesce(excluded.best_accuracy, -1) > coalesce(player_activity_maps.best_accuracy, -1)
    )
  )`;
}

function emptyActivitySnapshot(
  userId: number,
  country: string | null,
  year: number,
  isTracked: boolean,
  generatedAt: string,
): PlayerActivitySnapshot {
  return {
    available: false,
    isTracked,
    userId,
    country,
    year,
    availableYears: [year],
    totalScores: 0,
    activeDays: 0,
    totalSessions: 0,
    typicalSession: 0,
    currentStreak: 0,
    generatedAt,
    days: [],
  };
}

function getTypicalSession(totalScores: number, totalSessions: number, activeDays: number): number {
  if (totalSessions > 0) return Math.max(1, Math.round(totalScores / totalSessions));
  if (activeDays > 0) return Math.max(1, Math.round(totalScores / activeDays));
  return 0;
}

function getActivityCoverUrl(rawCovers: unknown, beatmapsetId: number | null): string | null {
  const covers = parseJson<Record<string, unknown> | null>(rawCovers, null);
  const url = covers && (
    readString(covers.list)
    ?? readString(covers.cover)
    ?? readString(covers.card)
    ?? readString(covers.slimcover)
  );
  if (url) return url;
  return beatmapsetId && Number.isFinite(beatmapsetId) && beatmapsetId > 0
    ? `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list.jpg`
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function pressureScore(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp01(value / cap);
}

function pressure(value: number, low: number, high: number): number {
  return clamp01((value - low) / Math.max(0.001, high - low));
}

function minGate(...values: number[]): number {
  return clamp01(Math.min(...values));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampYear(year: number): number {
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year)) return currentYear;
  return Math.max(2007, Math.min(currentYear + 1, year));
}

function normalizeActivityDayKey(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  const normalized = parsed.toISOString().slice(0, 10);
  return normalized === value ? value : null;
}

function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
