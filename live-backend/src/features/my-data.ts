import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { getCountryTimezone } from "../shared/country-timezones.js";
import { getModAcronyms, toLeanTrackerScore } from "../shared/score.js";
import { hydrateScoresDisplayMetadata } from "../shared/score-storage.js";
import type { CountryTopPlay, LeanTrackerScore, OscScore, OsuBeatmap, OsuBeatmapset, ScoreUser } from "../shared/types.js";

export interface MyDataTopPlay {
  score: LeanTrackerScore;
  ppGain: number;
}

export interface MyDataTrackedPlay extends LeanTrackerScore {
  archived?: boolean;
  archivedExact?: boolean;
}

export interface MyDataPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type MyDataModFilter = "all" | "nomod" | "modded";
export type MyDataArchiveFilter = "all" | "current" | "archived";
export type MyDataTrackedSort = "recent_desc" | "recent_asc" | "pp_desc" | "accuracy_desc" | "stars_desc";
export type MyDataTopPlaySort = "pp_desc" | "pp_asc" | "recent_desc" | "recent_asc" | "gain_desc" | "accuracy_desc";

export interface MyDataTrackedFeedQuery {
  search?: string | null;
  key?: string | number | null;
  mods?: string | null;
  archive?: string | null;
  sort?: string | null;
}

export interface MyDataTopPlaysQuery {
  search?: string | null;
  key?: string | number | null;
  mods?: string | null;
  sort?: string | null;
}

// "My Data": a logged-in player's personal dashboard. The page renders a tracker-style feed of
// their own tracked plays plus insight panels; this module supplies the cross-cutting aggregates
// that aren't on an osu! profile - personal records, a play-rhythm clock, a mods fingerprint - and
// the tracked-plays feed itself.

export interface MyDataBeatmapRef {
  beatmapId: number;
  beatmapsetId: number | null;
  label: string | null;
}

export interface MyDataRecord {
  value: number;
  beatmap: MyDataBeatmapRef | null;
}

export interface MyDataModStat {
  mod: string;
  count: number;
  pct: number;
}

export interface MyDataKeyStat {
  keyCount: number;
  weightedPp: number;
  scoreCount: number;
}

export interface MyDataSummary {
  userId: number;
  username: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  countryCode: string | null;
  pp: number | null;
  globalRank: number | null;
  countryRank: number | null;
  tracked: boolean;
  rankedMember: boolean;
  trackedCountries: string[];
  totalScores: number;
  passedScores: number;
  activeDays: number;
  sessions: number;
  firstTrackedDay: string | null;
  lastTrackedDay: string | null;
  topPlayCount: number;
  highlights: {
    topPlay: MyDataRecord | null;
    biggestDay: { count: number; day: string } | null;
    longestStreak: number;
    longestStreakRange: { startDay: string; endDay: string } | null;
    ppGainedTracked: number;
  };
  rhythm: {
    timezone: string;
    sampleSize: number;
    byHour: number[];
    byDay: number[];
    peakHour: number | null;
    peakDay: number | null;
  };
  mods: {
    sample: number;
    noModPct: number;
    top: MyDataModStat[];
  };
  keyStats: MyDataKeyStat[];
  cardsCollected: number;
  cardCopies: number;
  goalsOpen: number;
  goalsCompleted: number;
  generatedAt: string;
}

function longestDayStreak(days: string[]): { count: number; startDay: string | null; endDay: string | null } {
  const sorted = [...new Set(days)]
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort();
  if (sorted.length === 0) return { count: 0, startDay: null, endDay: null };
  let best = { count: 1, startDay: sorted[0], endDay: sorted[0] };
  let run = 1;
  let runStart = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const prev = Date.parse(`${sorted[i - 1]}T00:00:00Z`);
    const cur = Date.parse(`${sorted[i]}T00:00:00Z`);
    if (Number.isNaN(prev) || Number.isNaN(cur)) {
      run = 1;
      runStart = sorted[i];
      continue;
    }
    const diff = Math.round((cur - prev) / 86_400_000);
    if (diff === 1) run += 1;
    else if (diff !== 0) {
      run = 1;
      runStart = sorted[i];
    }
    if (run > best.count) best = { count: run, startDay: runStart, endDay: sorted[i] };
  }
  return best;
}

async function beatmapRef(db: Db, beatmapId: number | null | undefined): Promise<MyDataBeatmapRef | null> {
  if (!beatmapId || !Number.isFinite(beatmapId)) return null;
  const row = (await exec(
    db,
    `select b.beatmapset_id as beatmapset_id, b.version as version, s.title as title, s.artist as artist
     from beatmaps b left join beatmapsets s on s.beatmapset_id = b.beatmapset_id
     where b.beatmap_id = ?`,
    [beatmapId],
  )).rows[0];
  if (!row) return { beatmapId, beatmapsetId: null, label: null };
  const title = row.title ? String(row.title) : null;
  const artist = row.artist ? String(row.artist) : null;
  const version = row.version ? String(row.version) : null;
  const label = title ? `${artist ? `${artist} - ` : ""}${title}${version ? ` [${version}]` : ""}` : null;
  return { beatmapId, beatmapsetId: row.beatmapset_id == null ? null : Number(row.beatmapset_id), label };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function officialVariantKeyStats(profile: Record<string, unknown>, fallbackRows: Record<string, unknown>[]): MyDataKeyStat[] {
  const byKey = new Map<number, MyDataKeyStat>();
  for (const row of fallbackRows) {
    const keyCount = Number(row.key_count);
    const weightedPp = positiveNumber(row.weighted_pp);
    if (!Number.isSafeInteger(keyCount) || (keyCount !== 4 && keyCount !== 7) || weightedPp == null) continue;
    byKey.set(keyCount, {
      keyCount,
      weightedPp,
      scoreCount: Math.max(0, Number(row.score_count) || 0),
    });
  }

  const variants = asRecord(profile.statistics).variants;
  if (Array.isArray(variants)) {
    for (const rawVariant of variants) {
      const variant = asRecord(rawVariant);
      if (String(variant.mode ?? "") !== "mania") continue;
      const keyMode = String(variant.variant ?? "").toLowerCase();
      const keyCount = keyMode === "4k" ? 4 : keyMode === "7k" ? 7 : null;
      const weightedPp = positiveNumber(variant.pp);
      if (keyCount == null || weightedPp == null) continue;
      const previous = byKey.get(keyCount);
      byKey.set(keyCount, {
        keyCount,
        weightedPp,
        scoreCount: previous?.scoreCount ?? 0,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => b.weightedPp - a.weightedPp);
}

function topPlayBeatmapId(payloadJson: unknown): number | null {
  const payload = parseJson<{ score?: { beatmap_id?: number; beatmap?: { id?: number } } }>(String(payloadJson ?? ""), {});
  const id = payload.score?.beatmap_id ?? payload.score?.beatmap?.id;
  return id != null && Number.isFinite(Number(id)) ? Number(id) : null;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const RHYTHM_SAMPLE_LIMIT = 2500;
const MODS_SAMPLE_LIMIT = 400;
const SUMMARY_CACHE_TTL_MS = 30_000;

// The summary is heavy (many queries + timestamp/JSON scans) and admin-gated, so it skips the
// public rate limiter. A short per-user cache caps recomputation if the owner spam-refreshes,
// keeping the synchronous libsql loop free for ingest. Aggregates here are slow-moving; the
// live feed updates over SSE independently.
const summaryCache = new Map<number, { at: number; value: MyDataSummary }>();

async function computeRhythm(db: Db, userId: number, country: string | null) {
  const timezone = getCountryTimezone(country);
  const rows = (await exec(
    db,
    "select ended_at from player_activity_score_refs where user_id = ? order by ended_at desc limit ?",
    [userId, RHYTHM_SAMPLE_LIMIT],
  )).rows;
  const byHour = new Array(24).fill(0) as number[];
  const byDay = new Array(7).fill(0) as number[];
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hour12: false, weekday: "short" });
  let sample = 0;
  for (const row of rows) {
    const raw = row.ended_at == null ? null : String(row.ended_at);
    if (!raw) continue;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) continue;
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((p) => p.type === "hour")?.value;
    const weekdayPart = parts.find((p) => p.type === "weekday")?.value;
    const hour = hourPart != null ? Number(hourPart) % 24 : null;
    const day = weekdayPart != null ? WEEKDAY_INDEX[weekdayPart] : undefined;
    if (hour == null || Number.isNaN(hour) || day == null) continue;
    byHour[hour] += 1;
    byDay[day] += 1;
    sample += 1;
  }
  const peakHour = sample > 0 ? byHour.indexOf(Math.max(...byHour)) : null;
  const peakDay = sample > 0 ? byDay.indexOf(Math.max(...byDay)) : null;
  return { timezone, sampleSize: sample, byHour, byDay, peakHour, peakDay };
}

async function computeMods(db: Db, userId: number) {
  const rows = (await exec(
    db,
    "select score_json from score_events where user_id = ? order by ended_at desc limit ?",
    [userId, MODS_SAMPLE_LIMIT],
  )).rows;
  const counts = new Map<string, number>();
  let noMod = 0;
  let sample = 0;
  for (const row of rows) {
    const score = parseJson<OscScore>(String(row.score_json ?? ""), {} as OscScore);
    const acronyms = getModAcronyms(score.mods).filter((m) => m !== "CL");
    sample += 1;
    if (acronyms.length === 0) {
      noMod += 1;
      continue;
    }
    for (const acronym of acronyms) counts.set(acronym, (counts.get(acronym) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .map(([mod, count]) => ({ mod, count, pct: sample > 0 ? Math.round((count / sample) * 100) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);
  return { sample, noModPct: sample > 0 ? Math.round((noMod / sample) * 100) : 0, top };
}

export async function getMyDataSummary(db: Db, userId: number): Promise<MyDataSummary> {
  const cached = summaryCache.get(userId);
  if (cached && Date.now() - cached.at < SUMMARY_CACHE_TTL_MS) return cached.value;

  const user = (await exec(
    db,
    "select username, avatar_url, country_code, pp, global_rank, country_rank, profile_json from users where user_id = ?",
    [userId],
  )).rows[0];
  const country = user?.country_code ? String(user.country_code).toUpperCase() : null;
  const profile = parseJson<Record<string, unknown>>(String(user?.profile_json ?? ""), {});
  const coverUrl = typeof profile.cover_url === "string"
    ? profile.cover_url
    : typeof asRecord(profile.cover).url === "string"
      ? String(asRecord(profile.cover).url)
      : null;

  const rosterRows = (await exec(db, "select country, rank from country_rosters where user_id = ? and is_tracked = 1", [userId])).rows;
  const trackedCountries = rosterRows.map((r) => String(r.country));
  const rankedMember = rosterRows.some((r) => r.rank != null);

  const activity = (await exec(
    db,
    `select coalesce(sum(score_count), 0) as total_scores,
            coalesce(sum(passed_count), 0) as passed_scores,
            count(distinct day) as active_days,
            coalesce(sum(session_count), 0) as sessions,
            min(day) as first_day,
            max(day) as last_day
     from player_activity_days where user_id = ?`,
    [userId],
  )).rows[0];

  const topPlayCount = Number((await exec(db, "select count(*) as cnt from top_play_events where user_id = ?", [userId])).rows[0]?.cnt ?? 0);

  // Highlights, chosen so they don't all collapse to a single play and aren't on an osu! profile:
  // the top pp play (the one map-art tile), the biggest grind day, the longest streak, and the pp
  // the tracker has watched the player gain. (Highest-SR and best-accuracy were dropped: SR is
  // gameable by vibro maps and best accuracy is always a farmed SS.)
  const peakPlayRow = (await exec(db, "select pp, payload_json from top_play_events where user_id = ? order by pp desc limit 1", [userId])).rows[0];
  const biggestDayRow = (await exec(
    db,
    "select day, sum(score_count) as n from player_activity_days where user_id = ? group by day order by n desc limit 1",
    [userId],
  )).rows[0];
  const ppGainedTracked = Number((await exec(db, "select coalesce(sum(pp_gain), 0) as g from top_play_events where user_id = ?", [userId])).rows[0]?.g ?? 0);
  const dayRows = (await exec(db, "select distinct day from player_activity_days where user_id = ? order by day", [userId])).rows;
  const longestStreak = longestDayStreak(dayRows.map((r) => String(r.day)));

  const keyStatsRows = (await exec(
    db,
    "select key_count, weighted_pp, score_count from farm_helper_user_key_stats where user_id = ? order by weighted_pp desc",
    [userId],
  )).rows;

  const cards = (await exec(
    db,
    "select count(*) as distinct_cards, coalesce(sum(copies), 0) as copies from pack_collection_cards where owner_user_id = ?",
    [userId],
  )).rows[0];

  const goals = (await exec(
    db,
    `select coalesce(sum(case when status = 'open' then 1 else 0 end), 0) as open_count,
            coalesce(sum(case when status = 'completed' then 1 else 0 end), 0) as completed_count
     from user_goals where user_id = ?`,
    [userId],
  )).rows[0];

  const [rhythm, mods, peakPlay] = await Promise.all([
    computeRhythm(db, userId, country),
    computeMods(db, userId),
    peakPlayRow ? beatmapRef(db, topPlayBeatmapId(peakPlayRow.payload_json)) : Promise.resolve(null),
  ]);

  const summary: MyDataSummary = {
    userId,
    username: user?.username ? String(user.username) : null,
    avatarUrl: user?.avatar_url ? String(user.avatar_url) : null,
    coverUrl,
    countryCode: country,
    pp: user?.pp == null ? null : Number(user.pp),
    globalRank: user?.global_rank == null ? null : Number(user.global_rank),
    countryRank: user?.country_rank == null ? null : Number(user.country_rank),
    tracked: trackedCountries.length > 0,
    rankedMember,
    trackedCountries,
    totalScores: Number(activity?.total_scores ?? 0),
    passedScores: Number(activity?.passed_scores ?? 0),
    activeDays: Number(activity?.active_days ?? 0),
    sessions: Number(activity?.sessions ?? 0),
    firstTrackedDay: activity?.first_day ? String(activity.first_day) : null,
    lastTrackedDay: activity?.last_day ? String(activity.last_day) : null,
    topPlayCount,
    highlights: {
      topPlay: peakPlayRow ? { value: Number(peakPlayRow.pp), beatmap: peakPlay } : null,
      biggestDay: biggestDayRow ? { count: Number(biggestDayRow.n), day: String(biggestDayRow.day) } : null,
      longestStreak: longestStreak.count,
      longestStreakRange: longestStreak.startDay && longestStreak.endDay
        ? { startDay: longestStreak.startDay, endDay: longestStreak.endDay }
        : null,
      ppGainedTracked,
    },
    rhythm,
    mods,
    keyStats: officialVariantKeyStats(profile, keyStatsRows),
    cardsCollected: Number(cards?.distinct_cards ?? 0),
    cardCopies: Number(cards?.copies ?? 0),
    goalsOpen: Number(goals?.open_count ?? 0),
    goalsCompleted: Number(goals?.completed_count ?? 0),
    generatedAt: new Date().toISOString(),
  };
  summaryCache.set(userId, { at: Date.now(), value: summary });
  return summary;
}

type SqlArg = string | number;

function normalizeSearch(value: string | null | undefined): string | null {
  const search = value?.trim().slice(0, 80).toLowerCase();
  return search ? search : null;
}

function normalizeKeyFilter(value: string | number | null | undefined): number | null {
  if (value == null || value === "all") return null;
  const key = Number(value);
  return Number.isInteger(key) && key >= 1 && key <= 18 ? key : null;
}

function normalizeModFilter(value: string | null | undefined): MyDataModFilter | null {
  return value === "nomod" || value === "modded" ? value : null;
}

function normalizeArchiveFilter(value: string | null | undefined): MyDataArchiveFilter | null {
  return value === "current" || value === "archived" ? value : null;
}

function normalizeTrackedSort(value: string | null | undefined): MyDataTrackedSort {
  return value === "recent_asc" || value === "pp_desc" || value === "accuracy_desc" || value === "stars_desc"
    ? value
    : "recent_desc";
}

function normalizeTopPlaySort(value: string | null | undefined): MyDataTopPlaySort {
  return value === "pp_asc" || value === "recent_desc" || value === "recent_asc" || value === "gain_desc" || value === "accuracy_desc"
    ? value
    : "pp_desc";
}

function trackedOrderBy(sort: string | null | undefined): string {
  switch (normalizeTrackedSort(sort)) {
    case "recent_asc":
      return "r.ended_at asc, r.score_identity asc";
    case "pp_desc":
      return "coalesce(se.pp, m.best_pp, 0) desc, r.ended_at desc, r.score_identity desc";
    case "accuracy_desc":
      return "coalesce(se.accuracy, m.best_accuracy, 0) desc, r.ended_at desc, r.score_identity desc";
    case "stars_desc":
      return "coalesce(b.difficulty_rating, 0) desc, r.ended_at desc, r.score_identity desc";
    case "recent_desc":
    default:
      return "r.ended_at desc, r.score_identity desc";
  }
}

function topPlayOrderBy(sort: string | null | undefined): string {
  switch (normalizeTopPlaySort(sort)) {
    case "pp_asc":
      return "t.pp asc, t.detected_at asc, t.score_id asc";
    case "recent_desc":
      return "t.detected_at desc, t.score_id desc";
    case "recent_asc":
      return "t.detected_at asc, t.score_id asc";
    case "gain_desc":
      return "t.pp_gain desc, t.pp desc, t.detected_at desc";
    case "accuracy_desc":
      return "coalesce(cast(json_extract(t.payload_json, '$.score.accuracy') as real), 0) desc, t.pp desc, t.detected_at desc";
    case "pp_desc":
    default:
      return "t.pp desc, t.detected_at desc, t.score_id desc";
  }
}

function buildTrackedFeedSql(userId: number, query: MyDataTrackedFeedQuery = {}): { fromSql: string; whereSql: string; args: SqlArg[] } {
  const where = ["r.user_id = ?"];
  const args: SqlArg[] = [userId];
  const search = normalizeSearch(query.search);
  if (search) {
    const like = `%${search}%`;
    where.push(`(
      lower(coalesce(bs.title, '')) like ?
      or lower(coalesce(bs.artist, '')) like ?
      or lower(coalesce(b.version, '')) like ?
      or cast(r.beatmap_id as text) like ?
    )`);
    args.push(like, like, like, like);
  }
  const key = normalizeKeyFilter(query.key);
  if (key != null) {
    where.push("cast(round(coalesce(b.cs, 0)) as integer) = ?");
    args.push(key);
  }
  const mods = normalizeModFilter(query.mods);
  if (mods === "nomod") where.push("coalesce(json_array_length(se.score_json, '$.mods'), 0) = 0");
  if (mods === "modded") where.push("coalesce(json_array_length(se.score_json, '$.mods'), 0) > 0");
  const archive = normalizeArchiveFilter(query.archive);
  if (archive === "current") where.push("se.score_json is not null");
  if (archive === "archived") where.push("se.score_json is null");
  return {
    fromSql: `from player_activity_score_refs r
     left join score_events se
       on se.country = r.country and se.score_identity = r.score_identity
     left join users u on u.user_id = r.user_id
     left join beatmaps b on b.beatmap_id = r.beatmap_id
     left join beatmapsets bs on bs.beatmapset_id = b.beatmapset_id
     left join player_activity_maps m
       on m.country = r.country and m.user_id = r.user_id and m.day = r.day and m.beatmap_id = r.beatmap_id`,
    whereSql: where.join(" and "),
    args,
  };
}

/** A user-scoped tracker feed: every stored tracked play, lean-shaped for the row UI. */
export async function getUserTrackedFeed(db: Db, userId: number, limit = 30, offset = 0, query: MyDataTrackedFeedQuery = {}): Promise<MyDataPage<MyDataTrackedPlay>> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeOffset = Math.max(0, Math.floor(offset));
  const built = buildTrackedFeedSql(userId, query);
  const total = Number((await exec(
    db,
    `select count(*) as count ${built.fromSql} where ${built.whereSql}`,
    built.args,
  )).rows[0]?.count ?? 0);
  const rows = (await exec(
    db,
    `select
       r.country,
       r.score_identity,
       r.user_id,
       r.day,
       r.beatmap_id,
       r.passed,
       r.ended_at,
       se.score_json,
       u.username,
       u.avatar_url,
       u.country_code,
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
       bs.covers_json,
       m.best_score_id,
       m.best_pp,
       m.best_accuracy,
       m.best_rank,
       m.play_count
     ${built.fromSql}
     where ${built.whereSql}
     order by ${trackedOrderBy(query.sort)}
     limit ? offset ?`,
    [...built.args, safeLimit, safeOffset],
  )).rows;
  return { items: rows.flatMap(activityRefRowToTrackedPlay), total, limit: safeLimit, offset: safeOffset };
}

function activityRefRowToTrackedPlay(row: Record<string, unknown>): MyDataTrackedPlay[] {
  const storedScore = parseJson<OscScore | null>(String(row.score_json ?? ""), null);
  if (storedScore) {
    const score = {
      ...storedScore,
      user: storedScore.user ?? activityRowUser(row),
      beatmap: storedScore.beatmap ?? activityRowBeatmap(row),
      beatmapset: storedScore.beatmapset ?? activityRowBeatmapset(row),
    };
    if (score.beatmap && score.beatmapset && score.user) return [toLeanTrackerScore(score)];
  }
  const archived = archivedActivityRowToTrackedPlay(row);
  return archived ? [archived] : [];
}

function archivedActivityRowToTrackedPlay(row: Record<string, unknown>): MyDataTrackedPlay | null {
  const user = activityRowUser(row);
  if (!user) return null;
  const beatmap = activityRowBeatmap(row);
  if (!beatmap) return null;
  const beatmapset = activityRowBeatmapset(row) ?? {
    id: beatmap.beatmapset_id,
    title: "Unknown map",
    artist: "Unknown artist",
    covers: {},
  };
  const exactMapPlay = Number(row.play_count ?? 0) === 1;
  const scoreId = Number(row.best_score_id);
  const identityId = parseOfficialScoreIdentity(row.score_identity);
  const accuracy = exactMapPlay ? Number(row.best_accuracy ?? 0) : 0;
  return {
    id: Number.isFinite(scoreId) && scoreId > 0 ? scoreId : (identityId ?? 0),
    user_id: Number(row.user_id),
    accuracy: Number.isFinite(accuracy) ? accuracy : 0,
    beatmap_id: Number(row.beatmap_id),
    mods: [],
    score: 0,
    max_combo: 0,
    passed: !!Number(row.passed),
    rank: exactMapPlay && row.best_rank != null ? String(row.best_rank) : (Number(row.passed) ? "A" : "F"),
    statistics: {},
    pp: exactMapPlay && row.best_pp != null ? Number(row.best_pp) : null,
    beatmap,
    beatmapset,
    user,
    ended_at: String(row.ended_at),
    archived: true,
    archivedExact: exactMapPlay,
  };
}

function parseOfficialScoreIdentity(value: unknown): number | null {
  const match = String(value ?? "").match(/^official:(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function activityRowUser(row: Record<string, unknown>): ScoreUser | undefined {
  const id = Number(row.user_id);
  if (!Number.isFinite(id) || id <= 0) return undefined;
  return {
    id,
    username: String(row.username ?? "Unknown player"),
    avatar_url: String(row.avatar_url ?? ""),
    country_code: String(row.country_code ?? ""),
  };
}

function activityRowBeatmap(row: Record<string, unknown>): OsuBeatmap | undefined {
  const id = Number(row.beatmap_id);
  if (!Number.isFinite(id) || id <= 0) return undefined;
  const beatmapsetId = Number(row.beatmapset_id);
  return {
    id,
    beatmapset_id: Number.isFinite(beatmapsetId) && beatmapsetId > 0 ? beatmapsetId : 0,
    difficulty_rating: Number(row.difficulty_rating ?? 0),
    mode: String(row.mode ?? "mania"),
    status: row.beatmap_status == null ? undefined : String(row.beatmap_status),
    cs: Number(row.cs ?? 0),
    bpm: Number(row.bpm ?? 0),
    max_combo: row.max_combo == null ? undefined : Number(row.max_combo),
    version: String(row.version ?? "Unknown"),
    url: String(row.url ?? `https://osu.ppy.sh/beatmaps/${id}`),
  };
}

function activityRowBeatmapset(row: Record<string, unknown>): OsuBeatmapset | undefined {
  const id = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0) return undefined;
  return {
    id,
    title: String(row.title ?? "Unknown map"),
    artist: String(row.artist ?? "Unknown artist"),
    status: row.beatmapset_status == null ? undefined : String(row.beatmapset_status),
    covers: parseJson<OsuBeatmapset["covers"]>(row.covers_json, {}),
  };
}

/**
 * The player's saved top plays (durable, all-time), highest pp first, lean-shaped for the same row
 * UI plus the pp the play added. Stored scores are compacted, so beatmap/user metadata is
 * re-hydrated at read time (preserving order).
 */
const TOP_PLAY_BEATMAP_ID_SQL = "coalesce(cast(json_extract(t.payload_json, '$.score.beatmap.id') as integer), cast(json_extract(t.payload_json, '$.score.beatmap_id') as integer))";

function buildTopPlaysSql(userId: number, query: MyDataTopPlaysQuery = {}): { fromSql: string; whereSql: string; args: SqlArg[] } {
  const where = ["t.user_id = ?"];
  const args: SqlArg[] = [userId];
  const search = normalizeSearch(query.search);
  if (search) {
    const like = `%${search}%`;
    where.push(`(
      lower(coalesce(bs.title, json_extract(t.payload_json, '$.score.beatmapset.title'), '')) like ?
      or lower(coalesce(bs.artist, json_extract(t.payload_json, '$.score.beatmapset.artist'), '')) like ?
      or lower(coalesce(b.version, json_extract(t.payload_json, '$.score.beatmap.version'), '')) like ?
      or cast(t.score_id as text) like ?
      or cast(${TOP_PLAY_BEATMAP_ID_SQL} as text) like ?
    )`);
    args.push(like, like, like, like, like);
  }
  const key = normalizeKeyFilter(query.key);
  if (key != null) {
    where.push("cast(round(coalesce(cast(json_extract(t.payload_json, '$.score.beatmap.cs') as real), b.cs, 0)) as integer) = ?");
    args.push(key);
  }
  const mods = normalizeModFilter(query.mods);
  if (mods === "nomod") where.push("coalesce(json_array_length(t.payload_json, '$.score.mods'), 0) = 0");
  if (mods === "modded") where.push("coalesce(json_array_length(t.payload_json, '$.score.mods'), 0) > 0");
  return {
    fromSql: `from top_play_events t
     left join beatmaps b on b.beatmap_id = ${TOP_PLAY_BEATMAP_ID_SQL}
     left join beatmapsets bs on bs.beatmapset_id = b.beatmapset_id`,
    whereSql: where.join(" and "),
    args,
  };
}

export async function getUserTopPlaysFeed(db: Db, userId: number, limit = 40, offset = 0, query: MyDataTopPlaysQuery = {}): Promise<MyDataPage<MyDataTopPlay>> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeOffset = Math.max(0, Math.floor(offset));
  const built = buildTopPlaysSql(userId, query);
  const total = Number((await exec(
    db,
    `select count(*) as count ${built.fromSql} where ${built.whereSql}`,
    built.args,
  )).rows[0]?.count ?? 0);
  const rows = (await exec(
    db,
    `select t.payload_json, t.pp_gain
     ${built.fromSql}
     where ${built.whereSql}
     order by ${topPlayOrderBy(query.sort)}
     limit ? offset ?`,
    [...built.args, safeLimit, safeOffset],
  )).rows;
  const entries = rows
    .map((r) => ({ event: parseJson<CountryTopPlay>(String(r.payload_json ?? ""), {} as CountryTopPlay), ppGain: Number(r.pp_gain ?? 0) }))
    .filter((e): e is { event: CountryTopPlay & { score: OscScore }; ppGain: number } => !!e.event.score);
  const hydrated = await hydrateScoresDisplayMetadata(db, entries.map((e) => e.event.score));
  return {
    items: entries.map((e, i) => ({ score: toLeanTrackerScore(hydrated[i]), ppGain: e.ppGain })),
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}
