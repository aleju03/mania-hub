import type { Db, DbStatement } from "../db.js";
import { exec, execBatch, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import { OsuApiError } from "../osu/client.js";
import { logInfo, logWarn } from "../logger.js";
import { nowIso } from "../shared/score.js";
import { persistScoresDisplayMetadata } from "../shared/score-storage.js";
import type { OscScore } from "../shared/types.js";
import { enqueueMissingChartAnalyses } from "./chart-analysis.js";

// Qualified-maps watch -------------------------------------------------------
//
// osu! qualifies a handful of mania sets at a time (never more than ~50) and
// moves them off that list on a multi-day cadence: a set either ranks or gets
// dequalified back to pending. /maps materializes status into map_search_index,
// which otherwise only refreshes when a tracked player scores on the map -- so a
// dequalify (or a qualify of a set no roster player touched) can sit stale for a
// long time. This hourly job pulls the authoritative qualified list in one API
// call, upserts it, and reconciles the index in both directions.
//
// It is deliberately the ONE writer allowed to move a row backwards
// (qualified -> pending): buildMapStatusPropagationStatement only ever upgrades
// in-flux -> settled because score payloads can be stale, whereas the osu! API
// read here is current truth. So its index writes go through the authoritative
// helper below, never the propagation helper, and it writes the fresh status
// into beatmaps.metadata_json + the status column (via persistScoresDisplayMetadata)
// as well as the index, so a later full rebuild re-materializes the right value.
export const REFRESH_QUALIFIED_MAPS_JOB = "refresh_qualified_maps";
const REFRESH_QUALIFIED_MAPS_DEDUPE = "refresh-qualified-maps";
const LAST_ENQUEUED_META_KEY = "qualified_maps_watch:last_enqueued";
const SEARCH_CALLER = "job:refresh_qualified_maps:search";
const RESOLVE_CALLER = "job:refresh_qualified_maps:resolve";
// Mania qualified is ~33 today and capped well under 50 by osu!; the cursor loop
// is defensive only, so bound it hard rather than trust an unbounded feed.
const MAX_SEARCH_PAGES = 4;

// Schedule entry: enqueue at most once per interval (guards restart loops and the
// server/worker split), letting the constant dedupe key collapse the rest.
export async function enqueueQualifiedMapsWatchIfDue(db: Db, queue: JobQueue, intervalMs: number): Promise<boolean> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [LAST_ENQUEUED_META_KEY])).rows[0];
  const lastRun = row ? Date.parse(parseJson<string>(row.value_json, "")) : Number.NaN;
  if (Number.isFinite(lastRun) && Date.now() - lastRun < intervalMs) return false;
  const now = nowIso();
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [LAST_ENQUEUED_META_KEY, json(now), now],
  );
  // Low priority (background reconciler) but a reserved queue lane keeps it from
  // starving under pressure; the worker maps-refresh lane claims the type.
  await queue.enqueue(REFRESH_QUALIFIED_MAPS_JOB, REFRESH_QUALIFIED_MAPS_DEDUPE, {}, { priority: -50, replaceDone: true });
  return true;
}

export interface QualifiedMapsWatchResult {
  qualifiedSets: number;
  maniaDiffs: number;
  resolvedLeft: number;
}

export async function runQualifiedMapsWatch(db: Db, osu: OsuApiClient, queue: JobQueue): Promise<QualifiedMapsWatchResult> {
  const updatedAt = nowIso();

  // 1. Authoritative current list (1 API call; paginated only as a safety net).
  const sets = await fetchQualifiedManiaSets(osu);
  const currentSetIds = new Set<number>();
  const scores: OscScore[] = [];
  const maniaDiffIds: number[] = [];
  for (const set of sets) {
    const setId = Math.floor(Number(set.id));
    if (!Number.isFinite(setId) || setId <= 0) continue;
    const shaped = shapeManiaDiffScores(set);
    if (shaped.scores.length === 0) continue; // std/taiko set with no native mania diff
    currentSetIds.add(setId);
    scores.push(...shaped.scores);
    maniaDiffIds.push(...shaped.diffIds);
  }

  // 2. Upsert sets + native mania diffs at status=qualified (status column,
  //    metadata_json.$.status, cs/bpm) in one non-lossy pass.
  if (scores.length > 0) await persistScoresDisplayMetadata(db, scores, updatedAt);

  // 3. Flip the index rows we already show to qualified (idempotent for the ones
  //    already qualified; the real work is pending -> qualified promotions).
  const statements: DbStatement[] = [];
  for (const setId of currentSetIds) statements.push(authoritativeIndexStatusStatement(setId, "qualified", updatedAt));
  if (statements.length > 0) await execBatch(db, statements);

  // 4. Resolve sets that dropped off the qualified list (ranked or dequalified).
  const priorSetIds = await getIndexedQualifiedSetIds(db);
  const leftSetIds = [...priorSetIds].filter((id) => !currentSetIds.has(id));
  let resolvedLeft = 0;
  for (const setId of leftSetIds) {
    const ok = await resolveLeftSet(db, osu, setId, updatedAt).catch((error) => {
      logWarn("qualified_maps_watch_resolve_failed", { beatmapset_id: setId, error: errorMessage(error) });
      return false;
    });
    if (ok) resolvedLeft++;
  }

  // 5. Make brand-new qualified diffs searchable (only the ones missing analysis
  //    get a job; the chart-analysis completion hook indexes them as qualified).
  if (maniaDiffIds.length > 0) await enqueueMissingChartAnalyses(db, queue, maniaDiffIds);

  logInfo("qualified_maps_watch", {
    qualified_sets: currentSetIds.size,
    mania_diffs: maniaDiffIds.length,
    left_candidates: leftSetIds.length,
    resolved_left: resolvedLeft,
  });
  return { qualifiedSets: currentSetIds.size, maniaDiffs: maniaDiffIds.length, resolvedLeft };
}

async function fetchQualifiedManiaSets(osu: OsuApiClient): Promise<Record<string, unknown>[]> {
  const sets: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const body = await osu.searchBeatmapsets({ m: 3, s: "qualified", cursor_string: cursor }, SEARCH_CALLER);
    const batch = Array.isArray(body.beatmapsets) ? (body.beatmapsets as Record<string, unknown>[]) : [];
    sets.push(...batch);
    cursor = typeof body.cursor_string === "string" && body.cursor_string ? body.cursor_string : undefined;
    if (!cursor || batch.length === 0) break;
  }
  return sets;
}

// A dropped-off set is resolved with a single /beatmapsets/{id} read; rare and
// bounded (only sets that changed since the last sweep). Writes the new status
// authoritatively so a dequalify (qualified -> pending) actually lands.
async function resolveLeftSet(db: Db, osu: OsuApiClient, setId: number, updatedAt: string): Promise<boolean> {
  let set: Record<string, unknown>;
  try {
    set = await osu.getBeatmapset(setId, RESOLVE_CALLER);
  } catch (error) {
    if (error instanceof OsuApiError && error.status === 404) {
      // Set was deleted outright: drop the stale qualified rows so they stop
      // surfacing on /maps.
      await exec(db, "delete from map_search_index where beatmapset_id = ?", [setId]);
      return true;
    }
    throw error;
  }
  const status = normalizeMapSetStatus(set.status);
  if (!status) return false;
  const shaped = shapeManiaDiffScores(set);
  if (shaped.scores.length > 0) await persistScoresDisplayMetadata(db, shaped.scores, updatedAt);
  const statement = authoritativeIndexStatusStatement(setId, status, updatedAt, normalizeRankedDate(set.ranked_date));
  await exec(db, statement.sql, statement.args);
  return true;
}

// Authoritative, unguarded index write: unlike buildMapStatusPropagationStatement
// (guarded to in-flux -> settled against stale score payloads), this trusts the
// osu! API as current truth and moves every index row of the set to `status` in
// any direction, including the settled -> in-flux dequalify path. A resolved
// set also carries osu!'s ranked_date, re-stamped to the ranking moment when a
// qualified set ranks, so the Newest sort surfaces it like a new map; the
// current-list promotions (step 3) leave the date alone, the search payload
// dates a qualified set too but the hourly sweep copies it from the set row.
function authoritativeIndexStatusStatement(beatmapsetId: number, status: string, updatedAt: string, rankedDate?: string | null): DbStatement {
  if (rankedDate === undefined) {
    return {
      sql: "update map_search_index set status = ?, updated_at = ? where beatmapset_id = ?",
      args: [status.toLowerCase(), updatedAt, Math.floor(beatmapsetId)],
    };
  }
  return {
    sql: "update map_search_index set status = ?, ranked_date = ?, updated_at = ? where beatmapset_id = ?",
    args: [status.toLowerCase(), rankedDate, updatedAt, Math.floor(beatmapsetId)],
  };
}

export function normalizeRankedDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

// The index is the materialized truth users see (beatmapsets.status column is
// write-once stale), so it is the right source for "what we currently show as
// qualified". A qualified set that never got analyzed is not here, but the
// hourly status reconciler + farmed-score path are the backstop for that.
async function getIndexedQualifiedSetIds(db: Db): Promise<Set<number>> {
  const rows = (await exec(db, "select distinct beatmapset_id from map_search_index where status = 'qualified'")).rows;
  const ids = new Set<number>();
  for (const row of rows) {
    const id = Math.floor(Number(row.beatmapset_id));
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return ids;
}

// Shape a set's native mania diffs as synthetic scores for the shared upsert
// (persistScoresDisplayMetadata reads only .beatmap/.beatmapset). Converts are
// skipped to match the search index, which excludes them. Shared with the
// settled-sets reconcile sweep, which resolves sets the same way.
export function shapeManiaDiffScores(set: Record<string, unknown>): { scores: OscScore[]; diffIds: number[] } {
  const setId = Math.floor(Number(set.id));
  const beatmaps = Array.isArray(set.beatmaps) ? (set.beatmaps as Record<string, unknown>[]) : [];
  const { beatmaps: _diffs, ...setMeta } = set; // keep metadata_json lean
  const scores: OscScore[] = [];
  const diffIds: number[] = [];
  for (const diff of beatmaps) {
    if (String(diff.mode) !== "mania") continue;
    if (Number(diff.convert ?? 0) === 1 || diff.convert === true) continue;
    const diffId = Math.floor(Number(diff.id));
    if (!Number.isFinite(diffId) || diffId <= 0) continue;
    diffIds.push(diffId);
    scores.push({ beatmap: { ...diff, beatmapset_id: setId }, beatmapset: setMeta } as unknown as OscScore);
  }
  return { scores, diffIds };
}

export function normalizeMapSetStatus(status: unknown): string {
  return String(status ?? "").trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
