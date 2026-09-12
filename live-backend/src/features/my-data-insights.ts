import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { unpackJson } from "../shared/compressed-json.js";
import { calculateStableAccuracy, getManiaKeyModCount, getScoreHitCounts } from "../shared/score.js";
import type { OsuMod, OsuScoreStatistics } from "../shared/types.js";
import { loadMyDataBeatmapRef, type MyDataBeatmapRef } from "./my-data.js";

// The second half of "My Stats": the aggregates that only exist because this
// site keeps its own projections. Everything here reads tables the ingest
// already maintains - no new writes, no new jobs.
//
//  - diet:      what the player actually plays, by chart-analysis pattern tag,
//               next to the pattern ratings computed from the same tags.
//  - sessions:  how a sitting looks (length, plays, the longest one ever).
//  - grind:     the most-played map.
//  - judgement: the MAX:300 ratio, misses per 1k notes and accuracy per
//               keymode over the durable per-map judgement counts.

/** The gap that ends a session, the same 45 minutes activity.ts counts with. */
const SESSION_GAP_MS = 45 * 60_000;
/** Rows scanned for the judgement fingerprint (a JSON parse per row). */
const JUDGEMENT_SAMPLE_LIMIT = 5000;
/** A keymode needs this many sampled plays before its accuracy row is shown. */
const JUDGEMENT_KEY_MIN_PLAYS = 5;
/** A map needs this many plays before it can be the grind record. */
const GRIND_MIN_PLAYS = 5;
const INSIGHTS_CACHE_TTL_MS = 60_000;
const INSIGHTS_CACHE_MAX_ENTRIES = 200;

export interface MyDataDietTag {
  id: string;
  plays: number;
  pct: number;
}

export interface MyDataDietMode {
  keyCount: number;
  analyzed: number;
  /** Plays whose chart carries no pattern tag at all (unanalyzed or plain). */
  untagged: number;
  tags: MyDataDietTag[];
}

export interface MyDataSessionShape {
  sessions: number;
  plays: number;
  avgPlays: number;
  /** Mean first-to-last span of a session, in minutes. */
  avgMinutes: number;
  longest: { minutes: number; plays: number; startedAt: string; endedAt: string } | null;
  busiest: { plays: number; minutes: number; startedAt: string } | null;
  firstPlayAt: string | null;
}

export interface MyDataGrindMap {
  beatmap: MyDataBeatmapRef | null;
  plays: number;
}

export interface MyDataJudgementKey {
  keyCount: number;
  plays: number;
  accuracy: number;
}

export interface MyDataJudgement {
  plays: number;
  notes: number;
  /** Share of judged notes that were MAX (300g), 0-1. */
  maxShare: number;
  /** MAX:300 ratio, the number mania players quote. Null with no 300s. */
  maxRatio: number | null;
  missPer1k: number;
  accuracy: number;
  byKey: MyDataJudgementKey[];
  since: string | null;
}

export interface MyDataInsights {
  diet: MyDataDietMode[];
  sessions: MyDataSessionShape | null;
  grind: { mostPlayed: MyDataGrindMap | null };
  judgement: MyDataJudgement | null;
  generatedAt: string;
}

interface StoredDietPlay {
  keyCount?: unknown;
  patterns?: unknown;
}

/**
 * Play diet per keymode: how many of the player's analyzed plays carry each
 * chart-analysis pattern tag. Tags overlap (a chart can be jack and tech), so
 * the shares are per-tag fractions of the keymode's plays rather than a split
 * that sums to 100.
 */
export function summarizePlayDiet(plays: StoredDietPlay[]): MyDataDietMode[] {
  const byKey = new Map<number, { analyzed: number; untagged: number; tags: Map<string, number> }>();
  for (const play of plays) {
    const keyCount = Number(play?.keyCount);
    if (!Number.isInteger(keyCount) || keyCount <= 0) continue;
    let mode = byKey.get(keyCount);
    if (!mode) {
      mode = { analyzed: 0, untagged: 0, tags: new Map() };
      byKey.set(keyCount, mode);
    }
    mode.analyzed += 1;
    const tags = Array.isArray(play.patterns) ? play.patterns.filter((tag): tag is string => typeof tag === "string" && tag !== "") : [];
    if (tags.length === 0) {
      mode.untagged += 1;
      continue;
    }
    for (const tag of new Set(tags)) mode.tags.set(tag, (mode.tags.get(tag) ?? 0) + 1);
  }
  return [...byKey.entries()]
    .map(([keyCount, mode]) => ({
      keyCount,
      analyzed: mode.analyzed,
      untagged: mode.untagged,
      tags: [...mode.tags.entries()]
        .map(([id, count]) => ({ id, plays: count, pct: Math.round((count / mode.analyzed) * 100) }))
        .sort((a, b) => b.plays - a.plays || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => b.analyzed - a.analyzed);
}

/**
 * Session shape from play timestamps, folded on the same 45-minute gap the
 * activity projection counts sessions with. A span is first play to last play
 * of the sitting, so it understates by the length of the final map; a
 * one-play session spans zero minutes and still counts as a session.
 */
export function summarizeSessions(timestampsMs: number[]): MyDataSessionShape | null {
  const sorted = timestampsMs.filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const sessions: Array<{ start: number; end: number; plays: number }> = [];
  for (const ms of sorted) {
    const current = sessions[sessions.length - 1];
    if (!current || ms - current.end > SESSION_GAP_MS) sessions.push({ start: ms, end: ms, plays: 1 });
    else {
      current.end = ms;
      current.plays += 1;
    }
  }
  const totalMinutes = sessions.reduce((sum, session) => sum + (session.end - session.start) / 60_000, 0);
  const longest = sessions.reduce((best, session) =>
    session.end - session.start > best.end - best.start ? session : best);
  const busiest = sessions.reduce((best, session) => (session.plays > best.plays ? session : best));
  return {
    sessions: sessions.length,
    plays: sorted.length,
    avgPlays: sorted.length / sessions.length,
    avgMinutes: totalMinutes / sessions.length,
    longest: {
      minutes: (longest.end - longest.start) / 60_000,
      plays: longest.plays,
      startedAt: new Date(longest.start).toISOString(),
      endedAt: new Date(longest.end).toISOString(),
    },
    busiest: {
      plays: busiest.plays,
      minutes: (busiest.end - busiest.start) / 60_000,
      startedAt: new Date(busiest.start).toISOString(),
    },
    firstPlayAt: new Date(sorted[0]).toISOString(),
  };
}

export interface JudgementSampleRow {
  statisticsJson: string;
  modsJson: string;
  /** Rounded beatmap CS, i.e. the chart's keymode. Null when unenriched. */
  keyCount: number | null;
  playedAt: string | null;
}

/**
 * Judgement fingerprint over the retained score payloads: how the player's
 * MAX count sits against their 300s, how often they miss, and how their
 * accuracy splits by keymode. Accuracy is recomputed from the judgement counts (stable
 * weighting) so a lazer play and a stable play of the same performance land on
 * the same number, the way score.ts does everywhere else.
 */
export function summarizeJudgements(rows: JudgementSampleRow[]): MyDataJudgement | null {
  let plays = 0;
  let notes = 0;
  let max = 0;
  let great = 0;
  let misses = 0;
  let weightedAccuracy = 0;
  let since: string | null = null;
  const byKey = new Map<number, { plays: number; notes: number; weighted: number }>();
  for (const row of rows) {
    const statistics = parseJson<OsuScoreStatistics | null>(row.statisticsJson, null);
    if (!statistics) continue;
    const counts = getScoreHitCounts({ statistics });
    const judged = counts.max + counts.great + counts.good + counts.ok + counts.meh + counts.miss;
    if (judged <= 0) continue;
    const accuracy = calculateStableAccuracy(statistics);
    plays += 1;
    notes += judged;
    max += counts.max;
    great += counts.great;
    misses += counts.miss;
    weightedAccuracy += accuracy * judged;
    if (row.playedAt && (since == null || row.playedAt < since)) since = row.playedAt;
    // A key mod rewrites the chart's keymode, so it outranks the stored CS.
    const mods = parseJson<OsuMod[] | null>(row.modsJson, null);
    const keyCount = getManiaKeyModCount(mods ?? undefined) ?? row.keyCount;
    if (keyCount != null && Number.isInteger(keyCount) && keyCount > 0) {
      const bucket = byKey.get(keyCount) ?? { plays: 0, notes: 0, weighted: 0 };
      bucket.plays += 1;
      bucket.notes += judged;
      bucket.weighted += accuracy * judged;
      byKey.set(keyCount, bucket);
    }
  }
  if (plays === 0 || notes === 0) return null;
  return {
    plays,
    notes,
    maxShare: max / notes,
    maxRatio: great > 0 ? max / great : null,
    missPer1k: (misses / notes) * 1000,
    accuracy: weightedAccuracy / notes,
    byKey: [...byKey.entries()]
      .filter(([, bucket]) => bucket.plays >= JUDGEMENT_KEY_MIN_PLAYS)
      .map(([keyCount, bucket]) => ({ keyCount, plays: bucket.plays, accuracy: bucket.weighted / bucket.notes }))
      .sort((a, b) => b.plays - a.plays),
    since,
  };
}

async function loadPlayDiet(db: Db, userId: number): Promise<MyDataDietMode[]> {
  // The newest ready snapshot, whichever analysis version computed it: the
  // tags are refreshed on every compute, so an older row is still the same
  // vocabulary the pattern ratings on the page were aggregated from.
  const row = (await exec(
    db,
    `select plays_json from player_skill_ratings
      where user_id = ? and status = 'ready' and plays_json is not null
      order by analysis_version desc limit 1`,
    [userId],
  )).rows[0];
  const stored = unpackJson<{ plays?: StoredDietPlay[] } | null>(row?.plays_json, null);
  return Array.isArray(stored?.plays) ? summarizePlayDiet(stored.plays) : [];
}

/**
 * Every tracked play time of one player. Bounded by what one player can have
 * logged (the deepest history in the production DB is ~4.3k rows), so the
 * session fold runs in memory over one indexed read.
 */
async function loadPlayTimestamps(db: Db, userId: number): Promise<number[]> {
  const rows = (await exec(
    db,
    "select ended_at from player_activity_score_refs where user_id = ?",
    [userId],
  )).rows;
  return rows.map((row) => Date.parse(String(row.ended_at ?? ""))).filter((ms) => Number.isFinite(ms));
}

export interface ActivityMapRow {
  beatmapId: number;
  playCount: number;
}

/** The map the player has logged the most plays on, across every day. */
export function summarizeGrind(maps: ActivityMapRow[]): { mostPlayedId: number | null; mostPlayedPlays: number } {
  const plays = new Map<number, number>();
  for (const row of maps) {
    plays.set(row.beatmapId, (plays.get(row.beatmapId) ?? 0) + Math.max(0, row.playCount));
  }
  let mostPlayedId: number | null = null;
  let mostPlayedPlays = 0;
  for (const [beatmapId, count] of plays) {
    if (count > mostPlayedPlays || (count === mostPlayedPlays && mostPlayedId != null && beatmapId < mostPlayedId)) {
      mostPlayedId = beatmapId;
      mostPlayedPlays = count;
    }
  }
  return { mostPlayedId, mostPlayedPlays };
}

async function loadActivityMaps(db: Db, userId: number): Promise<ActivityMapRow[]> {
  const rows = (await exec(
    db,
    "select beatmap_id, play_count from player_activity_maps where user_id = ?",
    [userId],
  )).rows;
  return rows
    .map((row) => ({ beatmapId: Number(row.beatmap_id), playCount: Number(row.play_count) || 0 }))
    .filter((row) => Number.isInteger(row.beatmapId));
}

async function loadGrindRecords(db: Db, userId: number): Promise<{ mostPlayed: MyDataGrindMap | null }> {
  const grind = summarizeGrind(await loadActivityMaps(db, userId));
  if (grind.mostPlayedId == null || grind.mostPlayedPlays < GRIND_MIN_PLAYS) return { mostPlayed: null };
  return { mostPlayed: { beatmap: await loadMyDataBeatmapRef(db, grind.mostPlayedId), plays: grind.mostPlayedPlays } };
}

async function loadJudgement(db: Db, userId: number): Promise<MyDataJudgement | null> {
  // player_activity_maps rather than score_events: the raw payloads are pruned
  // on SCORE_EVENT_RETENTION_DAYS (14), so reading them capped the fingerprint
  // at whatever happened to be ingested that fortnight, while these rows only
  // go on ACTIVITY_RETENTION_YEARS (unset in prod, so never) and reach back to
  // the player's first tracked day. Newest days first, so the sample cap takes
  // a heavy player's recent history rather than an arbitrary subset.
  const rows = (await exec(
    db,
    `select m.best_statistics_json as statistics_json,
            m.best_mods_json as mods_json,
            coalesce(m.best_played_at, m.day) as played_at,
            b.cs as cs
       from player_activity_maps m
       left join beatmaps b on b.beatmap_id = m.beatmap_id
      where m.user_id = ? and m.best_statistics_json is not null
      order by m.day desc
      limit ?`,
    [userId, JUDGEMENT_SAMPLE_LIMIT],
  )).rows;
  return summarizeJudgements(rows.map((row) => {
    const cs = Number(row.cs);
    return {
      statisticsJson: String(row.statistics_json ?? ""),
      modsJson: String(row.mods_json ?? ""),
      keyCount: Number.isFinite(cs) && cs > 0 ? Math.round(cs) : null,
      playedAt: row.played_at == null ? null : String(row.played_at),
    };
  }));
}

// Same shape of cache as the My Data summary: the page fires this once per
// load, the numbers move slowly, and the queries below scan a player's whole
// ref history, so a spam-refresh must not sit on the libsql loop.
const insightsCache = new Map<number, { at: number; value: MyDataInsights }>();

function rememberInsights(userId: number, value: MyDataInsights): void {
  const now = Date.now();
  for (const [key, entry] of insightsCache) {
    if (now - entry.at >= INSIGHTS_CACHE_TTL_MS) insightsCache.delete(key);
  }
  insightsCache.set(userId, { at: now, value });
  while (insightsCache.size > INSIGHTS_CACHE_MAX_ENTRIES) {
    const oldest = insightsCache.keys().next().value;
    if (oldest === undefined) break;
    insightsCache.delete(oldest);
  }
}

export async function getMyDataInsights(db: Db, userId: number): Promise<MyDataInsights> {
  const cached = insightsCache.get(userId);
  if (cached && Date.now() - cached.at < INSIGHTS_CACHE_TTL_MS) return cached.value;

  const [diet, timestamps, grind, judgement] = await Promise.all([
    loadPlayDiet(db, userId),
    loadPlayTimestamps(db, userId),
    loadGrindRecords(db, userId),
    loadJudgement(db, userId),
  ]);

  const insights: MyDataInsights = {
    diet,
    sessions: summarizeSessions(timestamps),
    grind,
    judgement,
    generatedAt: new Date().toISOString(),
  };
  rememberInsights(userId, insights);
  return insights;
}
