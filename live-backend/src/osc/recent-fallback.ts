import type { Config } from "../config.js";
import { getActiveCountryCodes } from "../countries.js";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { CountryClientStats } from "../live/country-clients.js";
import type { OscStatus } from "./client.js";

const FALLBACK_DEDUPE_BUCKET_MS = 5 * 60_000;
const FALLBACK_META_KEY = "osu_recent_fallback_last_result";

type RecentFallbackConfig = Pick<
  Config,
  | "trackedCountries"
  | "prewarmCountries"
  | "mapsWarmCountries"
  | "countryWarmTtlMs"
  | "oscSocketStaleMs"
  | "enableOsuRecentFallback"
  | "osuRecentFallbackIntervalMs"
  | "osuRecentFallbackUsersPerMinute"
  | "osuRecentFallbackCountriesPerTick"
  | "osuRecentFallbackMaxPending"
>;

export interface RecentFallbackResult {
  ran: boolean;
  reason: string | null;
  budget: number;
  pending: number;
  countries: Array<{ country: string; requested: number; weight: number }>;
  enqueued: number;
}

interface CountryCandidate {
  country: string;
  priority: number;
  weight: number;
  lastRequestedMs: number;
  lastScoreMs: number;
}

interface RosterUserBatch {
  users: number[];
  nextOffset: number;
  total: number;
}

export function startRecentScoresFallbackScheduler(
  db: Db,
  queue: JobQueue,
  config: RecentFallbackConfig,
  oscStatus: () => OscStatus,
  countryClients?: { snapshot(): CountryClientStats[] },
): () => void {
  let stopped = false;
  const intervalMs = Math.max(10_000, config.osuRecentFallbackIntervalMs);
  const tick = async () => {
    if (stopped) return;
    await enqueueRecentScoresFallbackBatch(db, queue, config, {
      oscStatus: oscStatus(),
      countryClients: countryClients?.snapshot() ?? [],
    }).catch((error) => {
      console.warn("[osu-recent-fallback] enqueue failed", error);
    });
    if (!stopped) setTimeout(tick, intervalMs).unref();
  };
  setTimeout(tick, Math.min(30_000, intervalMs)).unref();
  return () => {
    stopped = true;
  };
}

export async function enqueueRecentScoresFallbackBatch(
  db: Db,
  queue: JobQueue,
  config: RecentFallbackConfig,
  options: { oscStatus: OscStatus; countryClients?: CountryClientStats[]; now?: number },
): Promise<RecentFallbackResult> {
  const now = options.now ?? Date.now();
  const budget = getFallbackBudget(config);
  if (!config.enableOsuRecentFallback) {
    return recordResult(db, { ran: false, reason: "disabled", budget, pending: 0, countries: [], enqueued: 0 }, now);
  }
  if (!shouldRunRecentScoresFallback(options.oscStatus, config.oscSocketStaleMs, now)) {
    return recordResult(db, { ran: false, reason: "osc_fresh", budget, pending: 0, countries: [], enqueued: 0 }, now);
  }

  const pending = await getPendingFallbackJobs(db);
  const maxPending = Math.max(budget, config.osuRecentFallbackMaxPending);
  const availableBudget = Math.max(0, Math.min(budget, maxPending - pending));
  if (availableBudget === 0) {
    return recordResult(db, { ran: false, reason: "pending_limit", budget, pending, countries: [], enqueued: 0 }, now);
  }

  const countries = await selectFallbackCountries(db, config, options.countryClients ?? [], availableBudget);
  if (countries.length === 0) {
    return recordResult(db, { ran: false, reason: "no_countries", budget: availableBudget, pending, countries: [], enqueued: 0 }, now);
  }

  const allocations = allocateCountryRequests(countries, availableBudget);
  let enqueued = 0;
  const requestedCountries: RecentFallbackResult["countries"] = [];
  for (const allocation of allocations) {
    const batch = await getNextRosterUsers(db, allocation.country.country, allocation.count);
    if (batch.users.length === 0) continue;
    await setCountryCursor(db, allocation.country.country, batch.nextOffset, now);
    requestedCountries.push({ country: allocation.country.country, requested: batch.users.length, weight: allocation.country.weight });
    for (const userId of batch.users) {
      const bucket = Math.floor(now / FALLBACK_DEDUPE_BUCKET_MS);
      await queue.enqueue(
        "reconcile_user_recent_scores",
        `recent-fallback:user:${userId}:${bucket}`,
        { userId, source: "osu_recent_fallback", processLeaderboardFeatures: false },
        { priority: allocation.country.priority >= 90 ? 55 : 35 },
      );
      enqueued++;
    }
  }

  return recordResult(db, { ran: true, reason: null, budget: availableBudget, pending, countries: requestedCountries, enqueued }, now);
}

export function shouldRunRecentScoresFallback(status: OscStatus, staleMs: number, now = Date.now()): boolean {
  if (status.stale) return true;
  const lastBatchAt = parseTime(status.lastBatchAt);
  if (!Number.isFinite(lastBatchAt)) return true;
  return now - lastBatchAt > staleMs;
}

async function selectFallbackCountries(
  db: Db,
  config: RecentFallbackConfig,
  countryClients: CountryClientStats[],
  limit: number,
): Promise<CountryCandidate[]> {
  const activeCountrySet = new Set(await getActiveCountryCodes(db, config));
  const activeClientSet = new Set(
    countryClients
      .filter((entry) => entry.activeUsers > 0)
      .map((entry) => entry.country.toUpperCase())
      .filter((country) => activeCountrySet.has(country)),
  );
  const trackedCountrySet = new Set(config.trackedCountries.map((country) => country.toUpperCase()));
  const rows = (await exec(
    db,
    `select country, status, pinned, last_requested_at, last_score_at
     from country_registry
     where status != 'paused'`,
  )).rows;
  const candidates = rows
    .map((row): CountryCandidate | null => {
      const country = String(row.country).toUpperCase();
      if (!activeCountrySet.has(country)) return null;
      const hasActiveClient = activeClientSet.has(country);
      const tracked = trackedCountrySet.has(country);
      const pinned = Number(row.pinned ?? 0) === 1;
      const active = String(row.status) === "active";
      const priority = hasActiveClient ? 100 : tracked || pinned ? 90 : active ? 70 : 50;
      const weight = hasActiveClient ? 12 : tracked || pinned ? 4 : active ? 2 : 1;
      return {
        country,
        priority,
        weight,
        lastRequestedMs: parseTime(row.last_requested_at),
        lastScoreMs: parseTime(row.last_score_at),
      };
    })
    .filter((candidate): candidate is CountryCandidate => candidate != null)
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.lastRequestedMs !== a.lastRequestedMs) return b.lastRequestedMs - a.lastRequestedMs;
      if (b.lastScoreMs !== a.lastScoreMs) return b.lastScoreMs - a.lastScoreMs;
      return a.country.localeCompare(b.country);
    });

  const maxCountries = Math.max(
    1,
    Math.min(limit, Math.max(config.osuRecentFallbackCountriesPerTick, activeClientSet.size)),
  );
  return candidates.slice(0, maxCountries);
}

function allocateCountryRequests(countries: CountryCandidate[], budget: number): Array<{ country: CountryCandidate; count: number }> {
  const selected = countries.slice(0, Math.min(countries.length, budget));
  if (selected.length === 0) return [];
  const totalWeight = selected.reduce((total, country) => total + country.weight, 0);
  const allocations = selected.map((country) => ({
    country,
    count: Math.max(1, Math.floor((budget * country.weight) / totalWeight)),
  }));
  while (allocations.reduce((total, allocation) => total + allocation.count, 0) > budget) {
    const smallest = [...allocations].sort((a, b) => a.count - b.count)[0];
    smallest.count = Math.max(0, smallest.count - 1);
  }
  let remaining = budget - allocations.reduce((total, allocation) => total + allocation.count, 0);
  for (const allocation of [...allocations].sort((a, b) => b.country.priority - a.country.priority || b.country.weight - a.country.weight)) {
    if (remaining <= 0) break;
    allocation.count++;
    remaining--;
  }
  return allocations.filter((allocation) => allocation.count > 0);
}

async function getNextRosterUsers(db: Db, country: string, limit: number): Promise<RosterUserBatch> {
  const total = Number((await exec(
    db,
    "select count(*) as count from country_rosters where country = ? and is_tracked = 1",
    [country],
  )).rows[0]?.count ?? 0);
  if (total <= 0 || limit <= 0) return { users: [], nextOffset: 0, total };

  const offset = await getCountryCursor(db, country, total);
  const cappedLimit = Math.min(limit, total);
  const first = await getRosterUsersAtOffset(db, country, cappedLimit, offset);
  const remaining = cappedLimit - first.length;
  const wrapped = remaining > 0 ? await getRosterUsersAtOffset(db, country, remaining, 0) : [];
  const users = [...first, ...wrapped];
  return { users, nextOffset: (offset + users.length) % total, total };
}

async function getRosterUsersAtOffset(db: Db, country: string, limit: number, offset: number): Promise<number[]> {
  const rows = (await exec(
    db,
    `select user_id
     from country_rosters
     where country = ? and is_tracked = 1
     order by coalesce(rank, 1000000), user_id
     limit ? offset ?`,
    [country, limit, offset],
  )).rows;
  return rows
    .map((row) => Number(row.user_id))
    .filter((userId) => Number.isFinite(userId) && userId > 0);
}

async function getCountryCursor(db: Db, country: string, total: number): Promise<number> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [countryCursorKey(country)])).rows[0];
  const cursor = parseJson<number>(row?.value_json, 0);
  return Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) % total : 0;
}

async function setCountryCursor(db: Db, country: string, offset: number, now: number): Promise<void> {
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
    countryCursorKey(country),
    json(offset),
    new Date(now).toISOString(),
  ]);
}

async function getPendingFallbackJobs(db: Db): Promise<number> {
  const row = (await exec(
    db,
    `select count(*) as count
     from jobs
     where type = 'reconcile_user_recent_scores'
       and dedupe_key like 'recent-fallback:%'
       and status in ('queued', 'failed', 'running')`,
  )).rows[0];
  return Number(row?.count ?? 0);
}

async function recordResult(db: Db, result: RecentFallbackResult, now: number): Promise<RecentFallbackResult> {
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
    FALLBACK_META_KEY,
    json(result),
    new Date(now).toISOString(),
  ]).catch(() => undefined);
  return result;
}

function getFallbackBudget(config: RecentFallbackConfig): number {
  const intervalMs = Math.max(10_000, config.osuRecentFallbackIntervalMs);
  return Math.max(1, Math.floor((config.osuRecentFallbackUsersPerMinute * intervalMs) / 60_000));
}

function countryCursorKey(country: string): string {
  return `osu_recent_fallback_cursor:${country}`;
}

function parseTime(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.NaN;
}
