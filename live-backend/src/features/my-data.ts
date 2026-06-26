import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { getCountryTimezone } from "../shared/country-timezones.js";
import { getModAcronyms, toLeanTrackerScore } from "../shared/score.js";
import { hydrateScoresDisplayMetadata } from "../shared/score-storage.js";
import { getHydratedScoresForMetadata } from "./tracker.js";
import type { CountryTopPlay, LeanTrackerScore, OscScore } from "../shared/types.js";

export interface MyDataTopPlay {
  score: LeanTrackerScore;
  ppGain: number;
}

export interface MyDataPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
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

/** A user-scoped tracker feed: every retained tracked play, lean-shaped for the row UI. */
export async function getUserTrackedFeed(db: Db, userId: number, limit = 30, offset = 0): Promise<MyDataPage<LeanTrackerScore>> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeOffset = Math.max(0, Math.floor(offset));
  const total = Number((await exec(
    db,
    "select count(*) as count from score_events where user_id = ?",
    [userId],
  )).rows[0]?.count ?? 0);
  const rows = await getHydratedScoresForMetadata(db, { userId }, safeLimit, safeOffset, { passedOnly: false });
  return { items: rows.map((r) => toLeanTrackerScore(r.score)), total, limit: safeLimit, offset: safeOffset };
}

/**
 * The player's saved top plays (durable, all-time), highest pp first, lean-shaped for the same row
 * UI plus the pp the play added. Stored scores are compacted, so beatmap/user metadata is
 * re-hydrated at read time (preserving order).
 */
export async function getUserTopPlaysFeed(db: Db, userId: number, limit = 40, offset = 0): Promise<MyDataPage<MyDataTopPlay>> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeOffset = Math.max(0, Math.floor(offset));
  const total = Number((await exec(
    db,
    "select count(*) as count from top_play_events where user_id = ?",
    [userId],
  )).rows[0]?.count ?? 0);
  const rows = (await exec(
    db,
    "select payload_json, pp_gain from top_play_events where user_id = ? order by pp desc limit ? offset ?",
    [userId, safeLimit, safeOffset],
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
