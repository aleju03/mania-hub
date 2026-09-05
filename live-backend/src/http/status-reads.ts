import { exec, parseJson, type Db } from "../db.js";
import { isGlobalCountry } from "../countries.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../features/activity.js";
import { getBeatmapOsuFileBackfillStatus } from "../features/beatmap-osu-file-backfill.js";
import { JobQueue } from "../jobs/queue.js";

export interface StatusReadOptions {
  includeWorkerActivity?: boolean;
  snapshotCountry?: string;
}

// Only final aggregates cross the thread boundary, never raw jobs or score JSON.
export async function readStatusAggregates(db: Db, journalDb: Db, options: StatusReadOptions, queue = new JobQueue(db)) {
  const [queuePressure, queueSummary, roster, analysis, osuFileBackfill, apiCalls, catchup, snapshotStats, sharedRate] = await Promise.all([
    queue.pressure(), queue.summary(), rosterSummary(db), analysisStats(db),
    getBeatmapOsuFileBackfillStatus(db, { cacheCounts: true }), apiCallHistory(journalDb),
    countryCatchupStatus(db), options.snapshotCountry ? adminSnapshotStats(db, options.snapshotCountry) : undefined,
    sharedRateBreakdown(journalDb),
  ]);
  const apiCallNames = options.includeWorkerActivity
    ? await apiCallPathNames(db, [...apiCalls.byPath.map((row) => row.path), ...(sharedRate?.byPath ?? []).map((row) => row.path)])
    : null;
  return { queueDepth: queuePressure.depth, queuePressure, queueSummary, roster, analysis, osuFileBackfill, apiCalls, catchup, snapshotStats, sharedRate, apiCallNames };
}

async function analysisStats(db: Db) {
  const [vectors, indexed] = await Promise.all([
    exec(
      db,
      "select status, count(*) as count from beatmap_skill_vectors where analysis_version = ? group by status",
      [ACTIVITY_SKILL_ANALYSIS_VERSION],
    ),
    exec(db, "select count(*) as count from map_search_index"),
  ]);
  const byStatus: Record<string, number> = {};
  for (const row of vectors.rows) byStatus[String(row.status)] = Number(row.count ?? 0);
  return {
    version: ACTIVITY_SKILL_ANALYSIS_VERSION,
    analyzed: byStatus.ready ?? 0,
    running: byStatus.running ?? 0,
    failed: byStatus.failed ?? 0,
    unavailable: byStatus.unavailable ?? 0,
    searchIndexed: Number(indexed.rows[0]?.count ?? 0),
  };
}

async function adminSnapshotStats(db: Db, country: string) {
  const normalized = country.toUpperCase();
  const global = isGlobalCountry(normalized);
  const now = Date.now();
  const topPlaysCutoff = new Date(now - 7 * 24 * 60 * 60_000).toISOString();
  const [tracker, topPlays, snipes] = await Promise.all([
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from score_events
         where ${global ? "" : "country = ? and "}passed = 1
         order by ended_at desc
         limit 100
       )`,
      global ? [] : [normalized],
    ),
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from top_play_events
         where ${global ? "" : "country = ? and "}detected_at >= ?
         order by pp desc, detected_at desc
         limit 200
       )`,
      global ? [topPlaysCutoff] : [normalized, topPlaysCutoff],
    ),
    exec(
      db,
      `select count(*) as count
       from (
         select 1
         from snipe_events
         where ${global ? "1 = 1" : "country = ?"}
         order by detected_at desc
         limit 500
       )`,
      global ? [] : [normalized],
    ),
  ]);

  return {
    trackerScores: Number(tracker.rows[0]?.count ?? 0),
    trackerFetchedAt: now,
    topPlays: Number(topPlays.rows[0]?.count ?? 0),
    topPlaysFetchedAt: now,
    snipes: Number(snipes.rows[0]?.count ?? 0),
    snipesFetchedAt: now,
  };
}


interface CountryCatchupResult {
  fetched: number;
  inserted: number;
  skipped: number;
  after: number;
  nextAfter: number | null;
  hasMore: boolean;
}

interface CountryCatchupState {
  pending: number;
  running: number;
  failed: number;
  lastError: string | null;
  lastRunAt: string | null;
  cursorMs: number | null;
  lastResult: CountryCatchupResult | null;
}

async function countryCatchupStatus(db: Db): Promise<Record<string, CountryCatchupState>> {
  const meta = (await exec(
    db,
    "select key, value_json, updated_at from live_meta where key like 'osc_country_catchup_last_result:%' or key like 'osc_country_catchup_cursor_ms:%'",
  )).rows;
  const jobs = (await exec(
    db,
    "select status, payload_json, last_error from jobs where type = 'osc_country_catchup' and status in ('queued', 'running', 'failed')",
  )).rows;
  const byCountry = new Map<string, CountryCatchupState>();
  const ensure = (country: string): CountryCatchupState => {
    let state = byCountry.get(country);
    if (!state) {
      state = { pending: 0, running: 0, failed: 0, lastError: null, lastRunAt: null, cursorMs: null, lastResult: null };
      byCountry.set(country, state);
    }
    return state;
  };
  for (const row of meta) {
    const key = String(row.key);
    const country = key.split(":")[1]?.toUpperCase();
    if (!country) continue;
    const state = ensure(country);
    if (key.startsWith("osc_country_catchup_last_result:")) {
      state.lastResult = parseJson<CountryCatchupResult | null>(row.value_json, null);
      state.lastRunAt = row.updated_at == null ? null : String(row.updated_at);
    } else {
      const cursor = parseJson<number>(row.value_json, Number.NaN);
      state.cursorMs = Number.isFinite(cursor) ? cursor : null;
    }
  }
  for (const row of jobs) {
    const payload = parseJson<{ country?: string }>(row.payload_json, {});
    const country = typeof payload.country === "string" ? payload.country.toUpperCase() : null;
    if (!country) continue;
    const state = ensure(country);
    const status = String(row.status);
    if (status === "running") state.running += 1;
    else if (status === "queued") state.pending += 1;
    else if (status === "failed") {
      state.failed += 1;
      if (row.last_error != null) state.lastError = String(row.last_error);
    }
  }
  return Object.fromEntries(byCountry);
}


async function rosterSummary(db: Db) {
  const rows = (await exec(
    db,
    `select country, count(*) as users, max(refreshed_at) as refreshed_at
     from country_rosters
     where is_tracked = 1
     group by country
     order by country asc`,
  )).rows;
  return rows.map((row) => ({
    country: String(row.country),
    users: Number(row.users),
    refreshedAt: row.refreshed_at == null ? null : String(row.refreshed_at),
  }));
}


// Cross-process last-minute osu! rate view from the shared limiter's
// reservation log: unlike the per-process limiter state, this covers server
// interactive calls, worker jobs, and the scores-fallback poller together.
async function sharedRateBreakdown(db: Db): Promise<{
  usedLastMinute: number;
  byCaller: Array<{ caller: string; count: number }>;
  byPath: Array<{ path: string; count: number }>;
  byLane: Array<{ lane: string; count: number }>;
} | null> {
  try {
    const rows = (await exec(
      db,
      "select caller, path, lane from api_rate_limit_reservations where provider = 'osu' and started_at_ms > ?",
      [Date.now() - 60_000],
    )).rows;
    const tally = (key: "caller" | "path" | "lane") => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = String(row[key] ?? "unknown");
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      usedLastMinute: rows.length,
      byCaller: tally("caller").map(([caller, count]) => ({ caller, count })),
      byPath: tally("path").slice(0, 10).map(([path, count]) => ({ path, count })),
      byLane: tally("lane").map(([lane, count]) => ({ lane, count })),
    };
  } catch {
    return null;
  }
}

async function apiCallHistory(db: Db) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const [byCaller, byPath] = await Promise.all([
    exec(
      db,
      `select coalesce(t.caller, l.caller) as caller, count(*) as count,
              round(avg(l.duration_ms)) as avg_ms, max(l.duration_ms) as max_ms,
              sum(case when l.status >= 400 then 1 else 0 end) as errors
       from api_call_log l
       left join api_call_targets t on t.id = l.target_id
       where l.provider = 'osu' and l.started_at >= ?
       group by coalesce(t.caller, l.caller)
       order by count desc
       limit 20`,
      [since],
    ),
    exec(
      db,
      `select coalesce(t.path, l.path) as path, count(*) as count,
              round(avg(l.duration_ms)) as avg_ms, max(l.duration_ms) as max_ms,
              sum(case when l.status >= 400 then 1 else 0 end) as errors
       from api_call_log l
       left join api_call_targets t on t.id = l.target_id
       where l.provider = 'osu' and l.started_at >= ?
       group by coalesce(t.path, l.path)
       order by count desc
       limit 20`,
      [since],
    ),
  ]);
  const stats = (row: Record<string, unknown>) => ({
    count: Number(row.count),
    avgMs: row.avg_ms == null ? null : Number(row.avg_ms),
    maxMs: row.max_ms == null ? null : Number(row.max_ms),
    errors: Number(row.errors ?? 0),
  });
  return {
    windowMinutes: 15,
    byCaller: byCaller.rows.map((row) => ({ caller: String(row.caller), ...stats(row) })),
    byPath: byPath.rows.map((row) => ({ path: String(row.path), ...stats(row) })),
  };
}

/* Names for the ids inside logged osu! paths, so the admin panel can render
   "Top 100 · Rii" instead of "/users/39867808/scores/best?mode=mania&...".
   Admin-only and best-effort: a lookup miss (or a whole failed query) just
   leaves the panel showing the bare id it already had. */
const API_PATH_ID_LIMIT = 60;

async function apiCallPathNames(db: Db, paths: string[]): Promise<{
  users: Record<string, string>;
  beatmaps: Record<string, string>;
  beatmapsets: Record<string, string>;
}> {
  const empty = { users: {}, beatmaps: {}, beatmapsets: {} };
  const userIds = new Set<string>();
  const beatmapIds = new Set<string>();
  const beatmapsetIds = new Set<string>();
  for (const path of paths) {
    for (const [, id] of path.matchAll(/\/users\/(\d+)/g)) userIds.add(id);
    // /osu/<id> is the .osu file download, the same beatmap id by another name.
    for (const [, id] of path.matchAll(/\/(?:beatmaps|osu)\/(\d+)/g)) beatmapIds.add(id);
    for (const [, id] of path.matchAll(/\/beatmapsets\/(\d+)/g)) beatmapsetIds.add(id);
  }
  const ids = (set: Set<string>) => [...set].slice(0, API_PATH_ID_LIMIT).map((id) => Number(id));
  const userList = ids(userIds);
  const beatmapList = ids(beatmapIds);
  const beatmapsetList = ids(beatmapsetIds);
  if (!userList.length && !beatmapList.length && !beatmapsetList.length) return empty;
  const holes = (count: number) => new Array(count).fill("?").join(",");
  try {
    const [users, beatmaps, sets] = await Promise.all([
      userList.length
        ? exec(db, `select user_id, username from users where user_id in (${holes(userList.length)})`, userList)
        : null,
      beatmapList.length
        ? exec(
          db,
          `select b.beatmap_id as id, s.artist as artist, s.title as title, b.version as version
             from beatmaps b left join beatmapsets s on s.beatmapset_id = b.beatmapset_id
            where b.beatmap_id in (${holes(beatmapList.length)})`,
          beatmapList,
        )
        : null,
      beatmapsetList.length
        ? exec(
          db,
          `select beatmapset_id as id, artist, title from beatmapsets where beatmapset_id in (${holes(beatmapsetList.length)})`,
          beatmapsetList,
        )
        : null,
    ]);
    const mapTitle = (row: Record<string, unknown>) => {
      const artist = row.artist ? String(row.artist) : "";
      const title = row.title ? String(row.title) : "";
      const name = [artist, title].filter(Boolean).join(" - ") || `map ${row.id}`;
      return row.version ? `${name} [${String(row.version)}]` : name;
    };
    return {
      users: Object.fromEntries((users?.rows ?? []).map((row) => [String(row.user_id), String(row.username)])),
      beatmaps: Object.fromEntries((beatmaps?.rows ?? []).map((row) => [String(row.id), mapTitle(row)])),
      beatmapsets: Object.fromEntries((sets?.rows ?? []).map((row) => [String(row.id), mapTitle(row)])),
    };
  } catch {
    return empty;
  }
}
