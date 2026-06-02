import type { Config } from "../config.js";
import { getActiveCountryCodes } from "../countries.js";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { ScoreIngestor } from "../ingest/score-ingestor.js";
import type { OsuApiClient } from "../osu/client.js";
import type { OscScore } from "../shared/types.js";
import type { OscStatus } from "./client.js";

const FALLBACK_CURSOR_KEY = "osu_scores_fallback_cursor_string";
const FALLBACK_RESULT_KEY = "osu_scores_fallback_last_result";
const FALLBACK_CANDIDATE_SEEN_UNTIL_KEY = "osu_scores_fallback_candidate_seen_until_ms";
const FALLBACK_CALLER = "osu_scores_fallback";
const FALLBACK_SOURCE = "osu_scores_fallback";

type ScoresFallbackConfig = Pick<
  Config,
  | "oscSocketStaleMs"
  | "enableOsuScoresFallback"
  | "osuScoresFallbackIntervalMs"
  | "trackedCountries"
  | "prewarmCountries"
  | "mapsWarmCountries"
  | "countryWarmTtlMs"
>;

export interface ScoresFallbackResult {
  ran: boolean;
  reason: string | null;
  fetched: number;
  candidates: number;
  inserted: number;
  skipped: number;
  cursorString: string | null;
  nextCursorString: string | null;
  latestEndedAt: string | null;
  latestCandidateEndedAt: string | null;
}

export function startScoresFallbackScheduler(
  db: Db,
  config: ScoresFallbackConfig,
  osu: Pick<OsuApiClient, "getScores">,
  ingestor: ScoreIngestor,
  oscStatus: () => OscStatus,
): () => void {
  let stopped = false;
  const intervalMs = Math.max(10_000, config.osuScoresFallbackIntervalMs);
  const tick = async () => {
    if (stopped) return;
    await runScoresFallbackPage(db, config, osu, ingestor, {
      oscStatus: oscStatus(),
    }).catch((error) => {
      console.warn("[osu-scores-fallback] page failed", error);
    });
    if (!stopped) setTimeout(tick, intervalMs).unref();
  };
  setTimeout(tick, Math.min(10_000, intervalMs)).unref();
  return () => {
    stopped = true;
  };
}

export async function runScoresFallbackPage(
  db: Db,
  config: ScoresFallbackConfig,
  osu: Pick<OsuApiClient, "getScores">,
  ingestor: ScoreIngestor,
  options: { oscStatus: OscStatus; now?: number; cursorString?: string | null },
): Promise<ScoresFallbackResult> {
  const now = options.now ?? Date.now();
  const cursorString = options.cursorString ?? await getStoredCursorString(db);
  if (!config.enableOsuScoresFallback) {
    return recordResult(db, emptyResult("disabled", cursorString), now);
  }
  if (!shouldRunScoresFallback(options.oscStatus, config.oscSocketStaleMs, now)) {
    return recordResult(db, emptyResult("osc_fresh", cursorString), now);
  }

  const response = await osu.getScores("mania", cursorString, FALLBACK_CALLER);
  const scores = normalizeScores(response.scores ?? []);
  const nextCursorString = response.cursor_string ?? cursorString;
  if (nextCursorString) await setStoredCursorString(db, nextCursorString, now);
  const candidateScores = await filterCandidateScores(db, config, scores);
  const latestCandidateEndedAt = getLatestEndedAt(candidateScores);
  const ingestResult = await ingestor.ingestBatch(candidateScores, FALLBACK_SOURCE, {
    enqueueRecentReconcile: false,
    processTopPlayFeatures: true,
    processMapsFarmedFeatures: true,
    processSnipeFeatures: true,
  });
  await advanceCandidateSeenUntil(db, latestCandidateEndedAt, now);
  return recordResult(db, {
    ran: true,
    reason: null,
    fetched: scores.length,
    candidates: candidateScores.length,
    inserted: ingestResult.inserted,
    skipped: ingestResult.skipped,
    cursorString,
    nextCursorString,
    latestEndedAt: getLatestEndedAt(scores),
    latestCandidateEndedAt,
  }, now);
}

export function shouldRunScoresFallback(status: OscStatus, staleMs: number, now = Date.now()): boolean {
  if (status.stale) return true;
  const lastBatchAt = parseTime(status.lastBatchAt);
  if (!Number.isFinite(lastBatchAt)) return true;
  return now - lastBatchAt > staleMs;
}

function normalizeScores(scores: OscScore[]): OscScore[] {
  return scores.map((score) => ({ ...score, ruleset_id: score.ruleset_id ?? 3 }));
}

async function filterCandidateScores(db: Db, config: ScoresFallbackConfig, scores: OscScore[]): Promise<OscScore[]> {
  if (scores.length === 0) return [];
  const activeCountries = new Set((await getActiveCountryCodes(db, config)).map((country) => country.toUpperCase()));
  if (activeCountries.size === 0) return [];
  const scoreUserIds = [...new Set(scores
    .map((score) => Number(score.user_id))
    .filter((userId) => Number.isFinite(userId) && userId > 0))];
  const rosterUserIds = new Set<number>();
  for (const chunk of chunks(scoreUserIds, 500)) {
    const countryArgs = [...activeCountries];
    const rows = (await exec(
      db,
      `select distinct user_id
       from country_rosters
       where is_tracked = 1
         and country in (${countryArgs.map(() => "?").join(", ")})
         and user_id in (${chunk.map(() => "?").join(", ")})`,
      [...countryArgs, ...chunk],
    )).rows;
    for (const row of rows) rosterUserIds.add(Number(row.user_id));
  }
  return scores.filter((score) => {
    const userId = Number(score.user_id);
    if (Number.isFinite(userId) && rosterUserIds.has(userId)) return true;
    const userCountry = score.user?.country_code?.toUpperCase();
    return !!userCountry && activeCountries.has(userCountry);
  });
}

async function getStoredCursorString(db: Db): Promise<string | null> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [FALLBACK_CURSOR_KEY])).rows[0];
  return parseJson<string | null>(row?.value_json, null);
}

async function setStoredCursorString(db: Db, cursorString: string, now: number): Promise<void> {
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
    FALLBACK_CURSOR_KEY,
    json(cursorString),
    new Date(now).toISOString(),
  ]);
}

async function advanceCandidateSeenUntil(db: Db, latestCandidateEndedAt: string | null, now: number): Promise<void> {
  const next = parseTime(latestCandidateEndedAt);
  if (!Number.isFinite(next)) return;
  const row = (await exec(db, "select value_json from live_meta where key = ?", [FALLBACK_CANDIDATE_SEEN_UNTIL_KEY])).rows[0];
  const current = parseJson<number>(row?.value_json, 0);
  if (Number.isFinite(current) && current >= next) return;
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
    FALLBACK_CANDIDATE_SEEN_UNTIL_KEY,
    json(next),
    new Date(now).toISOString(),
  ]);
}

async function recordResult(db: Db, result: ScoresFallbackResult, now: number): Promise<ScoresFallbackResult> {
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
    FALLBACK_RESULT_KEY,
    json(result),
    new Date(now).toISOString(),
  ]).catch(() => undefined);
  return result;
}

function emptyResult(reason: string, cursorString: string | null): ScoresFallbackResult {
  return {
    ran: false,
    reason,
    fetched: 0,
    candidates: 0,
    inserted: 0,
    skipped: 0,
    cursorString,
    nextCursorString: cursorString,
    latestEndedAt: null,
    latestCandidateEndedAt: null,
  };
}

function getLatestEndedAt(scores: OscScore[]): string | null {
  const latest = scores.reduce<string | null>((current, score) => {
    const candidate = score.ended_at ?? score.created_at ?? null;
    if (!candidate) return current;
    if (!current) return candidate;
    return new Date(candidate).getTime() > new Date(current).getTime() ? candidate : current;
  }, null);
  return latest;
}

function parseTime(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.NaN;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
