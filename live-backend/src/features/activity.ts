import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { parseManiaBeatmap, type ManiaNote } from "../dan/beatmap-parser.js";
import { extractDanFeatures } from "../dan/dan-estimator/features.js";
import { chooseSkillFamily } from "../dan/dan-estimator/family-choice.js";
import { estimateFamilyScores } from "../dan/dan-estimator/scoring.js";
import { DAN_PRIMARY_FAMILIES, type DanFeatureMetrics } from "../dan/dan-estimator/types.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import { getCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { enqueueChartAnalysisIfNeeded, enqueueMissingChartAnalyses } from "./chart-analysis.js";
import { addDayKeyDays, getCountryTimezone, getZonedDayKey } from "../shared/country-timezones.js";
import { getDisplayedAccuracy, getDisplayedRank, getScoreTimestamp, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

export const ACTIVITY_SKILL_ANALYSIS_VERSION = 4;

const ACTIVITY_SESSION_GAP_MS = 45 * 60_000;
const ACTIVITY_DAY_DETAIL_MAP_LIMIT = 500;
const ACTIVITY_ANALYSIS_RUNNING_REQUEUE_MS = 10 * 60_000;
const ACTIVITY_ANALYSIS_FAILED_RETRY_MS = 5 * 60_000;

// Pattern intensities are a relative mix over the dan estimator's family
// scores: the strongest family sits at 1 and the rest decay with their score
// distance, so the mix reads as "what this chart is" rather than raw SR.
const ACTIVITY_PATTERN_MIX_TEMPERATURE = 0.75;
const ACTIVITY_LN_PRIMARY_THRESHOLD = 0.6;
const ACTIVITY_MIN_ANALYZED_NOTES = 24;
const ACTIVITY_PATTERN_MIN_VALUE = 0.01;

const ACTIVITY_LN_SUBTYPES = ["lnGeneral", "lnRelease", "lnInverse", "lnTech"] as const;

// Pattern ids come from the dan estimator's families plus LN and its 7K
// subtypes; the record stays open so new estimator families flow through the
// stored JSON, the HTTP payloads, and the frontend without schema changes.
export interface ActivityPatternVector {
  primary: string;
  patterns: Record<string, number>;
}

export type PlayerActivityPrimarySkill = string;

export interface PlayerActivityKeyModeSkillReadout {
  keyCount: number | null;
  patterns: Record<string, number>;
  analyzedPlays: number;
  totalPlays: number;
}

export interface PlayerActivitySkillReadout {
  patterns: Record<string, number>;
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
  skills: ActivityPatternVector | null;
}

export interface PlayerActivityTimelineSegment {
  key: string;
  sessionIndex: number;
  startAt: string;
  endAt: string;
  playCount: number;
  keyCount: number | null;
  primarySkill: PlayerActivityPrimarySkill;
  patterns: Record<string, number>;
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
  timezone: string;
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
  options: { deferSessionRecompute?: boolean } = {},
): Promise<{ day: string } | null> {
  const activity = readScoreActivityInput(country, score, scoreIdentity);
  if (!activity) return null;
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
  if (Number(inserted.rowsAffected ?? 0) === 0) return null;

  await upsertActivityDay(db, activity, now);
  if (!options.deferSessionRecompute) {
    await recomputeActivitySessions(db, activity.country, activity.userId, activity.day);
  }
  await upsertActivityMap(db, activity, score, now);
  await enqueueBeatmapSkillAnalysisIfNeeded(db, queue, activity.beatmapId);
  await enqueueChartAnalysisIfNeeded(db, queue, activity.beatmapId);
  return { day: activity.day };
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
  await exec(
    db,
    "delete from player_activity_maps where country = ? and user_id = ? and day = ? and beatmap_id = ? and play_count <= 0",
    [normalizedCountry, userId, day, beatmapId],
  );
  await exec(
    db,
    "delete from player_activity_days where country = ? and user_id = ? and day = ? and score_count <= 0",
    [normalizedCountry, userId, day],
  );
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

  await backfillPlayerActivityFromRetainedScores(db, queue, userId, resolved.country);
  const timezone = getCountryTimezone(resolved.country);
  const years = await getActivityYears(db, userId, resolved.country);
  const availableYears = years.length > 0 ? years : [year];
  // Days are bucketed in the player country's local timezone. Local days near
  // New Year can land on adjacent UTC days, so pad the stored UTC range and
  // keep the scores whose local year matches.
  const refs = await getActivityScoreRefs(db, userId, resolved.country, timezone, {
    from: `${year - 1}-12-30`,
    to: `${year + 1}-01-02`,
  });
  const days = buildActivityDaysFromRefs(refs.filter((ref) => ref.dayKey.startsWith(`${year}-`)));
  const totalScores = days.reduce((sum, day) => sum + day.scoreCount, 0);
  const totalSessions = days.reduce((sum, day) => sum + day.sessionCount, 0);
  const activeDays = days.filter((day) => day.scoreCount > 0).length;
  const todayKey = getZonedDayKey(timezone, Date.now()) ?? nowIso().slice(0, 10);

  return {
    available: resolved.isTracked || days.length > 0,
    isTracked: resolved.isTracked,
    userId,
    country: resolved.country,
    timezone,
    year,
    availableYears,
    totalScores,
    activeDays,
    totalSessions,
    typicalSession: getTypicalSession(totalScores, totalSessions, activeDays),
    currentStreak: getCurrentActivityStreak(days, year, todayKey),
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
  const resolved = await resolveActivityCountry(db, userId, requestedCountry);
  if (!resolved.country) return null;

  await backfillPlayerActivityFromRetainedScores(db, queue, userId, resolved.country);
  const timezone = getCountryTimezone(resolved.country);
  const rows = await getActivityDayScoreRows(db, userId, resolved.country, timezone, day);
  if (rows.length === 0) return null;

  const maps = await getActivityMapsForLocalDay(db, userId, resolved.country, day, rows);
  await enqueueMissingActivitySkillAnalyses(db, queue, new Map([[day, maps]]));

  let sessionCount = 0;
  let passedCount = 0;
  let previousMs = 0;
  const beatmapIds = new Set<number>();
  for (const row of rows) {
    if (sessionCount === 0 || row.endedAtMs - previousMs > ACTIVITY_SESSION_GAP_MS) sessionCount++;
    previousMs = row.endedAtMs;
    if (row.passed) passedCount++;
    beatmapIds.add(row.beatmapId);
  }

  return {
    date: day,
    scoreCount: rows.length,
    passedCount,
    sessionCount,
    mapCount: beatmapIds.size,
    maps,
    skills: buildActivitySkillReadout(rows),
    timeline: buildActivityTimeline(day, rows),
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
): Promise<void> {
  // Live ingestion records activity for every new score, so this only has to
  // catch up on score_events ingested before the cursor (one-time per player).
  const cursor = Number((await exec(
    db,
    "select last_event_id from player_activity_backfill_cursors where country = ? and user_id = ?",
    [country, userId],
  )).rows[0]?.last_event_id ?? 0);
  const rows = (await exec(
    db,
    `select id, score_identity, score_json
     from score_events
     where country = ? and user_id = ? and id > ?
     order by id asc
     limit 2000`,
    [country, userId, cursor],
  )).rows;
  if (rows.length === 0) return;

  let lastEventId = cursor;
  const touchedDays = new Set<string>();
  for (const row of rows) {
    lastEventId = Math.max(lastEventId, Number(row.id) || 0);
    const score = parseJson<OscScore | null>(row.score_json, null);
    if (!score) continue;
    const recorded = await recordPlayerActivity(db, queue, country, score, String(row.score_identity), {
      deferSessionRecompute: true,
    });
    if (recorded) touchedDays.add(recorded.day);
  }
  for (const day of touchedDays) {
    await recomputeActivitySessions(db, country, userId, day);
  }
  await exec(
    db,
    `insert into player_activity_backfill_cursors (country, user_id, last_event_id, updated_at)
     values (?, ?, ?, ?)
     on conflict(country, user_id) do update set
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at`,
    [country, userId, lastEventId, nowIso()],
  );
}

async function enqueueMissingActivitySkillAnalyses(
  db: Db,
  queue: JobQueue,
  mapsByDay: Map<string, PlayerActivityMap[]>,
): Promise<void> {
  const beatmapIds = [...new Set([...mapsByDay.values()].flatMap((maps) => maps.map((map) => map.beatmapId)))]
    .filter((beatmapId) => Number.isInteger(beatmapId) && beatmapId > 0)
    .slice(0, 300);
  if (beatmapIds.length === 0) return;
  const placeholders = beatmapIds.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select beatmap_id, status, error, updated_at
     from beatmap_skill_vectors
     where analysis_version = ? and beatmap_id in (${placeholders})`,
    [ACTIVITY_SKILL_ANALYSIS_VERSION, ...beatmapIds],
  )).rows;
  const statusByBeatmapId = new Map(rows.map((row) => [Number(row.beatmap_id), row]));
  for (const beatmapId of beatmapIds) {
    const row = statusByBeatmapId.get(beatmapId);
    if (row && shouldSkipActivitySkillAnalysis(row)) continue;
    await enqueueActivitySkillAnalysis(queue, beatmapId);
  }
  await enqueueMissingChartAnalyses(db, queue, beatmapIds);
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
    const osuFile = await getActivityBeatmapFile(db, osu, beatmapId);
    const map = parseManiaBeatmap(osuFile);
    const starRating = Number((await exec(
      db,
      "select difficulty_rating from beatmaps where beatmap_id = ? limit 1",
      [beatmapId],
    )).rows[0]?.difficulty_rating ?? 0);
    const vector = getActivityPatternVector(map, Number.isFinite(starRating) && starRating > 0 ? starRating : 0);
    const computedAt = nowIso();
    await exec(
      db,
      `insert into beatmap_skill_vectors
         (beatmap_id, analysis_version, status, skills_json, error, computed_at, updated_at)
       values (?, ?, 'ready', ?, null, ?, ?)
       on conflict(beatmap_id, analysis_version) do update set
         status = excluded.status,
         skills_json = excluded.skills_json,
         error = excluded.error,
         computed_at = excluded.computed_at,
         updated_at = excluded.updated_at`,
      [
        beatmapId,
        ACTIVITY_SKILL_ANALYSIS_VERSION,
        json(vector),
        computedAt,
        computedAt,
      ],
    );
    // Keep the global search index live: a freshly analyzed map becomes
    // searchable without waiting for the next full rebuild. Best-effort, and a
    // dynamic import so the search module's static dep on this one stays acyclic.
    await import("./map-search.js")
      .then((module) => module.upsertMapSearchIndexRow(db, beatmapId))
      .catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    const status = isTerminalActivitySkillAnalysisError(message) ? "unavailable" : "failed";
    await exec(
      db,
      `insert into beatmap_skill_vectors
         (beatmap_id, analysis_version, status, error, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(beatmap_id, analysis_version) do update set
         status = excluded.status,
         error = excluded.error,
         updated_at = excluded.updated_at`,
      [beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION, status, message, failedAt],
    );
    if (status === "unavailable") return;
    throw error;
  }
}

async function getActivityBeatmapFile(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  beatmapId: number,
): Promise<string> {
  return getCachedBeatmapFile(db, osu, beatmapId, "job:analyze_activity_beatmap");
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
       (country, user_id, day, beatmap_id, play_count, best_score_id, best_pp, best_accuracy, best_rank, best_mods_json, best_statistics_json, first_played_at, last_played_at, updated_at)
     values (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(country, user_id, day, beatmap_id) do update set
       play_count = player_activity_maps.play_count + 1,
       best_score_id = case when ${activityMapBetterSql()} then excluded.best_score_id else player_activity_maps.best_score_id end,
       best_pp = case when ${activityMapBetterSql()} then excluded.best_pp else player_activity_maps.best_pp end,
       best_accuracy = case when ${activityMapBetterSql()} then excluded.best_accuracy else player_activity_maps.best_accuracy end,
       best_rank = case when ${activityMapBetterSql()} then excluded.best_rank else player_activity_maps.best_rank end,
       best_mods_json = case when ${activityMapBetterSql()} then excluded.best_mods_json else player_activity_maps.best_mods_json end,
       best_statistics_json = case when ${activityMapBetterSql()} then excluded.best_statistics_json else player_activity_maps.best_statistics_json end,
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
      // The two payload fields the skill pipeline needs once the raw score is
      // pruned: mods carry the rate, judgement counts carry goal + miss share.
      JSON.stringify(score.mods ?? []),
      JSON.stringify(score.statistics ?? {}),
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
    `select status, error, updated_at
     from beatmap_skill_vectors
     where beatmap_id = ? and analysis_version = ?
     limit 1`,
    [beatmapId, ACTIVITY_SKILL_ANALYSIS_VERSION],
  )).rows[0];
  if (row && shouldSkipActivitySkillAnalysis(row)) return;
  await enqueueActivitySkillAnalysis(queue, beatmapId);
}

function shouldSkipActivitySkillAnalysis(row: Record<string, unknown>): boolean {
  const status = String(row.status);
  const error = typeof row.error === "string" ? row.error : "";
  const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
  if (status === "ready") return true;
  if (status === "unavailable") return true;
  if (status === "failed" && isTerminalActivitySkillAnalysisError(error)) return true;
  if (status === "running" && isRecentActivityAnalysisStatus(updatedAt, ACTIVITY_ANALYSIS_RUNNING_REQUEUE_MS)) return true;
  if (status === "failed" && isRecentActivityAnalysisStatus(updatedAt, ACTIVITY_ANALYSIS_FAILED_RETRY_MS)) return true;
  return false;
}

function isTerminalActivitySkillAnalysisError(message: string): boolean {
  if (!message.startsWith("Failed to fetch .osu file for beatmap ")) return false;
  const separatorIndex = message.indexOf(": ");
  if (separatorIndex < 0) return false;
  const sourceErrors = message
    .slice(separatorIndex + 2)
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return sourceErrors.length > 0 && sourceErrors.every((part) => part.includes("(404)") || part.includes("invalid .osu file"));
}

async function enqueueActivitySkillAnalysis(queue: JobQueue, beatmapId: number): Promise<void> {
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

interface ActivityScoreRef {
  dayKey: string;
  endedAt: string;
  endedAtMs: number;
  passed: boolean;
  beatmapId: number;
}

interface ActivityDayScoreRow extends ActivityScoreRef {
  keyCount: number | null;
  skills: ActivityPatternVector | null;
}

async function getActivityScoreRefs(
  db: Db,
  userId: number,
  country: string,
  timezone: string,
  range: { from: string; to: string },
): Promise<ActivityDayScoreRow[]> {
  const rows = (await exec(
    db,
    `select
       r.day,
       r.ended_at,
       r.passed,
       r.beatmap_id,
       b.cs,
       v.status as skill_status,
       v.skills_json
     from player_activity_score_refs r
     left join beatmaps b on b.beatmap_id = r.beatmap_id
     left join beatmap_skill_vectors v
       on v.beatmap_id = r.beatmap_id and v.analysis_version = ?
     where r.country = ? and r.user_id = ? and r.day >= ? and r.day <= ?
     order by r.ended_at asc, r.score_identity asc`,
    [ACTIVITY_SKILL_ANALYSIS_VERSION, country, userId, range.from, range.to],
  )).rows;
  const refs: ActivityDayScoreRow[] = [];
  for (const row of rows) {
    const endedAt = String(row.ended_at);
    const endedAtMs = Date.parse(endedAt);
    if (!Number.isFinite(endedAtMs)) continue;
    const dayKey = getZonedDayKey(timezone, endedAtMs);
    if (!dayKey) continue;
    const keyCount = Number(row.cs);
    refs.push({
      dayKey,
      endedAt,
      endedAtMs,
      passed: !!Number(row.passed),
      beatmapId: Number(row.beatmap_id),
      keyCount: Number.isFinite(keyCount) && keyCount > 0 ? Math.round(keyCount) : null,
      skills: readActivitySkillVector(row),
    });
  }
  return refs;
}

interface ActivityDayAccumulator {
  scoreCount: number;
  passedCount: number;
  sessionCount: number;
  previousMs: number;
  beatmapIds: Set<number>;
  rows: ActivityDayScoreRow[];
}

// Refs arrive ordered by ended_at, so each local day's scores are contiguous
// and the session gap scan can run per day in a single pass.
function buildActivityDaysFromRefs(refs: ActivityDayScoreRow[]): PlayerActivityDay[] {
  const byDay = new Map<string, ActivityDayAccumulator>();
  for (const ref of refs) {
    let day = byDay.get(ref.dayKey);
    if (!day) {
      day = { scoreCount: 0, passedCount: 0, sessionCount: 0, previousMs: 0, beatmapIds: new Set(), rows: [] };
      byDay.set(ref.dayKey, day);
    }
    if (day.sessionCount === 0 || ref.endedAtMs - day.previousMs > ACTIVITY_SESSION_GAP_MS) day.sessionCount++;
    day.previousMs = ref.endedAtMs;
    day.scoreCount++;
    if (ref.passed) day.passedCount++;
    day.beatmapIds.add(ref.beatmapId);
    day.rows.push(ref);
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([date, day]) => ({
      date,
      scoreCount: day.scoreCount,
      passedCount: day.passedCount,
      sessionCount: day.sessionCount,
      mapCount: day.beatmapIds.size,
      maps: [],
      skills: buildActivitySkillReadout(day.rows),
      timeline: [],
    }));
}

// A local day overlaps at most two UTC days, so query the padded stored range
// and keep the scores whose local date matches.
async function getActivityDayScoreRows(
  db: Db,
  userId: number,
  country: string,
  timezone: string,
  day: string,
): Promise<ActivityDayScoreRow[]> {
  const rows = (await exec(
    db,
    `select
       r.ended_at,
       r.passed,
       r.beatmap_id,
       b.cs,
       v.status as skill_status,
       v.skills_json
     from player_activity_score_refs r
     left join beatmaps b on b.beatmap_id = r.beatmap_id
     left join beatmap_skill_vectors v
       on v.beatmap_id = r.beatmap_id and v.analysis_version = ?
     where r.country = ? and r.user_id = ? and r.day >= ? and r.day <= ?
     order by r.ended_at asc, r.score_identity asc`,
    [ACTIVITY_SKILL_ANALYSIS_VERSION, country, userId, addDayKeyDays(day, -1), addDayKeyDays(day, 1)],
  )).rows;
  const output: ActivityDayScoreRow[] = [];
  for (const row of rows) {
    const endedAt = String(row.ended_at);
    const endedAtMs = Date.parse(endedAt);
    if (!Number.isFinite(endedAtMs)) continue;
    if (getZonedDayKey(timezone, endedAtMs) !== day) continue;
    const keyCount = Number(row.cs);
    output.push({
      dayKey: day,
      endedAt,
      endedAtMs,
      passed: !!Number(row.passed),
      beatmapId: Number(row.beatmap_id),
      keyCount: Number.isFinite(keyCount) && keyCount > 0 ? Math.round(keyCount) : null,
      skills: readActivitySkillVector(row),
    });
  }
  return output;
}

async function getActivityMapsForLocalDay(
  db: Db,
  userId: number,
  country: string,
  day: string,
  rows: ActivityDayScoreRow[],
): Promise<PlayerActivityMap[]> {
  const playStats = new Map<number, { plays: number; lastPlayedAt: string }>();
  for (const row of rows) {
    if (!Number.isInteger(row.beatmapId) || row.beatmapId <= 0) continue;
    const stats = playStats.get(row.beatmapId);
    if (stats) {
      stats.plays++;
      if (row.endedAt > stats.lastPlayedAt) stats.lastPlayedAt = row.endedAt;
    } else {
      playStats.set(row.beatmapId, { plays: 1, lastPlayedAt: row.endedAt });
    }
  }
  const beatmapIds = [...playStats.entries()]
    .sort(([leftId, left], [rightId, right]) =>
      right.plays - left.plays
      || (left.lastPlayedAt < right.lastPlayedAt ? 1 : left.lastPlayedAt > right.lastPlayedAt ? -1 : 0)
      || leftId - rightId)
    .slice(0, ACTIVITY_DAY_DETAIL_MAP_LIMIT)
    .map(([beatmapId]) => beatmapId);
  if (beatmapIds.length === 0) return [];

  // Best pp/accuracy projections are keyed by UTC day; take the best across
  // the UTC days this local day overlaps. A play from the neighbouring local
  // day sharing a UTC bucket can leak into the best stats, but the play
  // counts come from the score refs and stay exact.
  const placeholders = beatmapIds.map(() => "?").join(", ");
  const mapRows = (await exec(
    db,
    `select
       m.beatmap_id,
       m.best_pp,
       m.best_accuracy,
       m.best_rank,
       b.beatmapset_id,
       b.cs,
       b.version,
       s.title,
       s.artist,
       s.covers_json,
       v.status as skill_status,
       v.skills_json
     from player_activity_maps m
     left join beatmaps b on b.beatmap_id = m.beatmap_id
     left join beatmapsets s on s.beatmapset_id = b.beatmapset_id
     left join beatmap_skill_vectors v
       on v.beatmap_id = m.beatmap_id and v.analysis_version = ?
     where m.country = ? and m.user_id = ? and m.day >= ? and m.day <= ? and m.beatmap_id in (${placeholders})`,
    [ACTIVITY_SKILL_ANALYSIS_VERSION, country, userId, addDayKeyDays(day, -1), addDayKeyDays(day, 1), ...beatmapIds],
  )).rows;
  const bestByBeatmap = new Map<number, Record<string, unknown>>();
  for (const row of mapRows) {
    const beatmapId = Number(row.beatmap_id);
    const current = bestByBeatmap.get(beatmapId);
    if (!current || isBetterActivityMapRow(row, current)) bestByBeatmap.set(beatmapId, row);
  }

  const maps: PlayerActivityMap[] = [];
  for (const beatmapId of beatmapIds) {
    const row = bestByBeatmap.get(beatmapId);
    if (!row) continue;
    const beatmapsetId = row.beatmapset_id == null ? null : Number(row.beatmapset_id);
    const safeBeatmapsetId = beatmapsetId != null && Number.isFinite(beatmapsetId) && beatmapsetId > 0 ? beatmapsetId : null;
    maps.push({
      key: `${day}:${beatmapId}`,
      beatmapId,
      beatmapsetId: safeBeatmapsetId,
      title: String(row.title ?? "Unknown"),
      artist: String(row.artist ?? "Unknown artist"),
      version: String(row.version ?? "Unknown"),
      coverUrl: getActivityCoverUrl(row.covers_json, safeBeatmapsetId),
      plays: playStats.get(beatmapId)?.plays ?? 0,
      accuracy: row.best_accuracy == null ? null : Number(row.best_accuracy),
      pp: row.best_pp == null ? null : Number(row.best_pp),
      rank: row.best_rank == null ? null : String(row.best_rank),
      keyCount: row.cs == null ? null : Number(row.cs),
      skills: readActivitySkillVector(row),
    });
  }
  return maps;
}

function isBetterActivityMapRow(candidate: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const candidatePp = candidate.best_pp == null ? -1 : Number(candidate.best_pp);
  const currentPp = current.best_pp == null ? -1 : Number(current.best_pp);
  if (candidatePp !== currentPp) return candidatePp > currentPp;
  const candidateAccuracy = candidate.best_accuracy == null ? -1 : Number(candidate.best_accuracy);
  const currentAccuracy = current.best_accuracy == null ? -1 : Number(current.best_accuracy);
  return candidateAccuracy > currentAccuracy;
}

interface ActivityPatternSums {
  keyCount: number | null;
  patternSums: Record<string, number>;
  analyzedPlays: number;
  totalPlays: number;
}

function emptyActivitySkillSums(keyCount: number | null): ActivityPatternSums {
  return {
    keyCount,
    patternSums: {},
    analyzedPlays: 0,
    totalPlays: 0,
  };
}

function addActivitySkillRow(sums: ActivityPatternSums, row: ActivityDayScoreRow): void {
  sums.totalPlays++;
  if (!row.skills) return;
  sums.analyzedPlays++;
  addPatternSums(sums.patternSums, row.skills.patterns);
}

function addPatternSums(target: Record<string, number>, patterns: Record<string, number>): void {
  for (const [key, value] of Object.entries(patterns)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function averagePatternSums(patternSums: Record<string, number>, analyzedPlays: number): Record<string, number> {
  const scale = analyzedPlays > 0 ? 1 / analyzedPlays : 0;
  const patterns: Record<string, number> = {};
  for (const [key, value] of Object.entries(patternSums)) {
    const average = value * scale;
    if (average >= ACTIVITY_PATTERN_MIN_VALUE) patterns[key] = average;
  }
  return patterns;
}

function toActivityKeyModeReadout(sums: ActivityPatternSums): PlayerActivityKeyModeSkillReadout {
  return {
    keyCount: sums.keyCount,
    patterns: averagePatternSums(sums.patternSums, sums.analyzedPlays),
    analyzedPlays: sums.analyzedPlays,
    totalPlays: sums.totalPlays,
  };
}

function buildActivitySkillReadout(rows: ActivityDayScoreRow[]): PlayerActivitySkillReadout | null {
  if (rows.length === 0) return null;
  const total = emptyActivitySkillSums(null);
  const byKeyMode = new Map<string, ActivityPatternSums>();
  for (const row of rows) {
    addActivitySkillRow(total, row);
    const key = String(row.keyCount);
    let sums = byKeyMode.get(key);
    if (!sums) {
      sums = emptyActivitySkillSums(row.keyCount);
      byKeyMode.set(key, sums);
    }
    addActivitySkillRow(sums, row);
  }
  const overall = toActivityKeyModeReadout(total);
  return {
    patterns: overall.patterns,
    analyzedPlays: overall.analyzedPlays,
    totalPlays: overall.totalPlays,
    keyModes: [...byKeyMode.values()]
      .map(toActivityKeyModeReadout)
      .sort((left, right) =>
        (left.keyCount ?? Number.MAX_SAFE_INTEGER) - (right.keyCount ?? Number.MAX_SAFE_INTEGER),
      ),
  };
}

function buildActivityTimeline(day: string, rows: ActivityDayScoreRow[]): PlayerActivityTimelineSegment[] {
  const segments: PlayerActivityTimelineSegment[] = [];
  let sessionIndex = 1;
  let previousMs = 0;
  let draft: TimelineSegmentDraft | null = null;

  const flush = () => {
    if (!draft) return;
    segments.push(finalizeTimelineDraft(day, draft));
    draft = null;
  };

  for (const row of rows) {
    const primarySkill = getPrimaryActivitySkill(row.skills);
    const startsNewSession = previousMs > 0 && row.endedAtMs - previousMs > ACTIVITY_SESSION_GAP_MS;
    if (
      startsNewSession ||
      !draft ||
      draft.keyCount !== row.keyCount ||
      draft.primarySkill !== primarySkill
    ) {
      flush();
      if (startsNewSession) sessionIndex++;
      draft = {
        sessionIndex,
        startAt: row.endedAt,
        endAt: row.endedAt,
        playCount: 0,
        keyCount: row.keyCount,
        primarySkill,
        patternSums: {},
        analyzedCount: 0,
      };
    }

    draft.endAt = row.endedAt;
    draft.playCount++;
    if (row.skills) {
      addPatternSums(draft.patternSums, row.skills.patterns);
      draft.analyzedCount++;
    }
    previousMs = row.endedAtMs;
  }
  flush();
  return segments;
}

interface TimelineSegmentDraft {
  sessionIndex: number;
  startAt: string;
  endAt: string;
  playCount: number;
  keyCount: number | null;
  primarySkill: PlayerActivityPrimarySkill;
  patternSums: Record<string, number>;
  analyzedCount: number;
}

function finalizeTimelineDraft(day: string, draft: TimelineSegmentDraft): PlayerActivityTimelineSegment {
  return {
    key: `${day}:${draft.sessionIndex}:${draft.startAt}:${draft.endAt}`,
    sessionIndex: draft.sessionIndex,
    startAt: draft.startAt,
    endAt: draft.endAt,
    playCount: draft.playCount,
    keyCount: draft.keyCount,
    primarySkill: draft.primarySkill,
    patterns: averagePatternSums(draft.patternSums, draft.analyzedCount),
  };
}

function readActivitySkillVector(row: Record<string, unknown>): ActivityPatternVector | null {
  if (String(row.skill_status ?? "") !== "ready") return null;
  const parsed = parseJson<{ primary?: unknown; patterns?: unknown } | null>(row.skills_json, null);
  if (!parsed || typeof parsed !== "object") return null;
  const rawPatterns = parsed.patterns;
  if (!rawPatterns || typeof rawPatterns !== "object") return null;
  const patterns: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawPatterns as Record<string, unknown>)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) patterns[key] = clamp01(numeric);
  }
  const primary = typeof parsed.primary === "string" && parsed.primary ? parsed.primary : "unknown";
  return { primary, patterns };
}

function getPrimaryActivitySkill(vector: ActivityPatternVector | null): PlayerActivityPrimarySkill {
  return vector?.primary ?? "unknown";
}

function getPrimaryLnActivitySubtype(patterns: Record<string, number>): string | null {
  let best: string | null = null;
  let bestValue = 0.2;
  for (const key of ACTIVITY_LN_SUBTYPES) {
    const value = patterns[key] ?? 0;
    if (value >= bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

export function getCurrentActivityStreak(days: PlayerActivityDay[], year: number, todayKey: string): number {
  const selectedYear = clampYear(year);
  const cursorKey = todayKey.startsWith(`${selectedYear}-`) ? todayKey : `${selectedYear}-12-31`;
  const startKey = `${selectedYear}-01-01`;
  const active = new Set(days.filter((day) => day.scoreCount > 0).map((day) => day.date));
  let streak = 0;
  let key = cursorKey;
  // The current local day is still in progress; an empty "today" shouldn't zero
  // out a streak the player is otherwise keeping. Start counting from yesterday.
  if (key === todayKey && !active.has(key)) {
    key = addDayKeyDays(key, -1);
  }
  for (; key >= startKey; key = addDayKeyDays(key, -1)) {
    if (!active.has(key)) break;
    streak++;
  }
  return streak;
}

function getActivityPatternVector(map: ReturnType<typeof parseManiaBeatmap>, starRating: number): ActivityPatternVector {
  const features = extractDanFeatures(map, {
    totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined,
    version: map.version,
  }, 1);
  const { metrics, durationMs } = features;
  if (features.notes.length < ACTIVITY_MIN_ANALYZED_NOTES) {
    return { primary: "unknown", patterns: {} };
  }

  const { skillScores } = estimateFamilyScores(metrics, starRating, durationMs);
  const top = Math.max(...DAN_PRIMARY_FAMILIES.map((family) => skillScores[family]));
  const patterns: Record<string, number> = {};
  for (const family of DAN_PRIMARY_FAMILIES) {
    patterns[family] = clamp01(Math.exp(Math.min(0, skillScores[family] - top) / ACTIVITY_PATTERN_MIX_TEMPERATURE));
  }

  // The estimator scores jumpstream on the handstream scale, so the two tie;
  // split them by chord-row composition (2-note rows read as jumpstream,
  // 3+-note rows as handstream).
  const twoNoteShare = metrics.chordRatio > 0 ? clamp01(metrics.twoNoteChordRatio / metrics.chordRatio) : 0;
  patterns.jumpstream *= pressure(twoNoteShare, 0.45, 0.85);
  patterns.handstream *= pressure(1 - twoNoteShare, 0.08, 0.35);

  // LN stays an absolute hold-pressure score: it is an orthogonal axis that
  // hybrids combine with any of the families above.
  const lnScore = clamp01(
    metrics.holdRatio * 1.25
    + pressureScore(metrics.lnReleasePressure, 30) * 0.28
    + pressureScore(metrics.lnOverlapPressure, 8) * 0.24
    + pressureScore(metrics.lnChordPressure, 1) * 0.18,
  );
  patterns.ln = lnScore;
  Object.assign(
    patterns,
    getActivityLnSubtypeScores(
      features.notes,
      features.orderedRows,
      metrics,
      Number.isFinite(map.bpm) && map.bpm > 0 ? 60000 / map.bpm : 0,
    ),
  );

  let primary: string = chooseSkillFamily(skillScores, metrics).family;
  if (primary === "handstream" || primary === "jumpstream") {
    primary = patterns.jumpstream > patterns.handstream ? "jumpstream" : "handstream";
  }

  // The family chooser is benchmarked on real charts and can pick a primary
  // whose raw score trails other families; cap the rejected families just
  // under the chosen one so the displayed mix agrees with the chart identity.
  const chosenValue = patterns[primary] ?? 0;
  if (chosenValue > 0 && chosenValue < 1) {
    for (const family of DAN_PRIMARY_FAMILIES) {
      if (family !== primary && patterns[family] > chosenValue) {
        patterns[family] = Math.min(patterns[family], Math.max(chosenValue, 0.92));
      }
    }
    patterns[primary] = 1;
  }

  if (lnScore >= ACTIVITY_LN_PRIMARY_THRESHOLD) {
    primary = getPrimaryLnActivitySubtype(patterns) ?? "ln";
  }

  for (const [key, value] of Object.entries(patterns)) {
    if (!(value >= ACTIVITY_PATTERN_MIN_VALUE)) delete patterns[key];
  }
  return { primary, patterns };
}

interface ActivityLnPatternStats {
  inverseReleaseRatio: number;
  releaseOnlyRatio: number;
  headTailSwitchRatio: number;
  mixedRowRatio: number;
  tapWhileHoldingRatio: number;
}

// Same tempo-aware inverse gap cap as the dan-estimator pattern analyzer:
// inverse release gaps are charted as beat fractions (1/8 to 1/4 beat), so a
// fixed 120ms cutoff misses slow charts (127ms gaps at 79 BPM).
function inverseGapCapMs(beatLengthMs: number): number {
  if (!Number.isFinite(beatLengthMs) || beatLengthMs <= 0) return 120;
  return Math.min(250, Math.max(120, beatLengthMs * 0.27));
}

function getActivityLnPatternStats(
  notes: ManiaNote[],
  orderedRows: Array<[number, ManiaNote[]]>,
  keyCount: number,
  beatLengthMs: number,
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

  const gapCap = inverseGapCapMs(beatLengthMs);
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
      if (gap <= gapCap && gapRatio <= 0.7) inverseLikeHolds++;
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
  beatLengthMs: number,
): Record<(typeof ACTIVITY_LN_SUBTYPES)[number], number> {
  if (metrics.keyCount !== 7) {
    return { lnGeneral: 0, lnRelease: 0, lnInverse: 0, lnTech: 0 };
  }

  const stats = getActivityLnPatternStats(notes, orderedRows, metrics.keyCount, beatLengthMs);
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
    timezone: getCountryTimezone(country),
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
