import type { Db, DbStatement } from "../db.js";
import { exec, execBatch, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import { OsuApiError } from "../osu/client.js";
import { logInfo, logWarn } from "../logger.js";
import { nowIso } from "../shared/score.js";
import { persistScoresDisplayMetadata } from "../shared/score-storage.js";
import { enqueueMissingChartAnalyses } from "./chart-analysis.js";
import { normalizeMapSetStatus, normalizeRankedDate, shapeManiaDiffScores } from "./qualified-maps-watch.js";

// Settled-sets reconcile -----------------------------------------------------
//
// Companion to the qualified-maps watch for the transition it cannot see: a
// graveyard set revived and then loved (or ranked). Two things go stale when
// that happens. First, the index rows keep their dead-end status: none of the
// zero-API heals cover graveyard (buildMapStatusPropagationStatement /
// reconcileMapSearchIndexStatuses only upgrade in-flux rows, deliberately).
// Second -- the uglier half -- revival usually re-uploads diffs under new
// beatmap ids, so the old ids no longer exist upstream. Nothing ever re-fetches
// a deleted beatmap, so its index row survives as a phantom graveyard card on
// /maps (with the set's *other* rows correctly loved under the new ids).
//
// The sweep is candidate-driven and self-terminating: a set qualifies only
// while the index holds a dead-end row for it AND some already-stored signal
// (a settled sibling row, or a settled set status in maps_beatmapsets /
// beatmapsets) says the set has settled. Each candidate costs one
// /beatmapsets/{id} read, whose payload is reconciled per diff: ids still in
// the set get its authoritative status (any direction), ids missing from it are
// deleted from the index and stamped `deleted` in beatmaps.metadata_json so a
// full index rebuild does not resurrect them (SOURCE_SELECT skips that stamp).
// After one resolution every signal agrees with upstream, so the set drops out
// of the candidate list; steady state is zero API calls.
export const RECONCILE_SETTLED_SETS_JOB = "reconcile_settled_sets";
const RECONCILE_SETTLED_SETS_DEDUPE = "reconcile-settled-sets";
const LAST_ENQUEUED_META_KEY = "settled_sets_reconcile:last_enqueued";
const RESOLVED_META_KEY_PREFIX = "settled_sets_reconcile:resolved:";
const RESOLVE_CALLER = "job:reconcile_settled_sets:resolve";
// One API call per set; the backlog (23 sets at ship time) clears in one run
// and steady state is a handful per Loved round at most.
const MAX_SETS_PER_RUN = 30;
// Partially-Loved sets are a *permanent* candidate signature: osu! loves diffs
// selectively, so a loved set can legitimately keep wip/graveyard diffs
// forever (dead-end index rows + settled set status, exactly the stale shape).
// Resolution confirms them unchanged, so re-checking hourly would burn one API
// call per such set per run for good. The per-set marker written after each
// resolution puts the set on this cooldown; a week bounds how long a later
// real transition (its remaining diffs getting loved) can sit stale, in line
// with osu!'s monthly Loved rounds.
const RESOLVE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const DEAD_END_STATUSES = ["graveyard", "wip", "pending"] as const;
const SETTLED_STATUSES = ["ranked", "approved", "loved"] as const;

// Schedule entry: enqueue at most once per interval (same restart-loop guard as
// the qualified watch), the constant dedupe key collapses the rest.
export async function enqueueSettledSetsReconcileIfDue(db: Db, queue: JobQueue, intervalMs: number): Promise<boolean> {
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
  await queue.enqueue(RECONCILE_SETTLED_SETS_JOB, RECONCILE_SETTLED_SETS_DEDUPE, {}, { priority: -50, replaceDone: true });
  return true;
}

export interface SettledSetsReconcileResult {
  candidates: number;
  resolved: number;
  updatedRows: number;
  deletedRows: number;
}

export async function runSettledSetsReconcile(db: Db, osu: OsuApiClient, queue: JobQueue): Promise<SettledSetsReconcileResult> {
  const updatedAt = nowIso();
  const candidates = await getCandidateSetIds(db);
  let resolved = 0;
  let updatedRows = 0;
  let deletedRows = 0;
  const analysisTargets: number[] = [];
  for (const setId of candidates) {
    const outcome = await resolveSet(db, osu, setId, updatedAt).catch((error) => {
      logWarn("settled_sets_reconcile_resolve_failed", { beatmapset_id: setId, error: errorMessage(error) });
      return null;
    });
    if (!outcome) continue;
    await markSetResolved(db, setId, updatedAt);
    resolved++;
    updatedRows += outcome.updatedRows;
    deletedRows += outcome.deletedRows;
    analysisTargets.push(...outcome.maniaDiffIds);
  }
  // Any current diff still missing analysis gets indexed via the chart-analysis
  // completion hook, so the healed set shows its full live diff list.
  if (analysisTargets.length > 0) await enqueueMissingChartAnalyses(db, queue, analysisTargets);
  if (candidates.length > 0) {
    logInfo("settled_sets_reconcile", {
      candidates: candidates.length,
      resolved,
      updated_rows: updatedRows,
      deleted_rows: deletedRows,
    });
  }
  return { candidates: candidates.length, resolved, updatedRows, deletedRows };
}

// A candidate is a set the index still shows with a dead-end status while any
// already-stored projection says it settled. Pure DB, seeks idx_map_search_set
// and the two set-table PKs per outer row; ~0.3s warm over today's 89k-row
// index, worker lane only.
async function getCandidateSetIds(db: Db): Promise<number[]> {
  const deadEnd = DEAD_END_STATUSES.map(() => "?").join(", ");
  const settled = SETTLED_STATUSES.map(() => "?").join(", ");
  // Cooldown check lives in the query (not post-filter) so on-cooldown sets do
  // not eat MAX_SETS_PER_RUN slots away from fresh candidates.
  const cooldownCutoff = new Date(Date.now() - RESOLVE_COOLDOWN_MS).toISOString();
  const rows = (await exec(
    db,
    `select distinct i.beatmapset_id as beatmapset_id
       from map_search_index i
      where i.status in (${deadEnd})
        and (
          exists (select 1 from map_search_index sib
                   where sib.beatmapset_id = i.beatmapset_id
                     and sib.status in (${settled}))
          or exists (select 1 from maps_beatmapsets mb
                      where mb.beatmapset_id = i.beatmapset_id
                        and lower(coalesce(mb.status, '')) in (${settled}))
          or exists (select 1 from beatmapsets bs
                      where bs.beatmapset_id = i.beatmapset_id
                        and lower(coalesce(bs.status, '')) in (${settled}))
        )
        and not exists (select 1 from live_meta lm
                         where lm.key = ? || i.beatmapset_id
                           and lm.updated_at > ?)
      order by i.beatmapset_id
      limit ?`,
    [
      ...DEAD_END_STATUSES,
      ...SETTLED_STATUSES,
      ...SETTLED_STATUSES,
      ...SETTLED_STATUSES,
      RESOLVED_META_KEY_PREFIX,
      cooldownCutoff,
      MAX_SETS_PER_RUN,
    ],
  )).rows;
  const ids: number[] = [];
  for (const row of rows) {
    const id = Math.floor(Number(row.beatmapset_id));
    if (Number.isFinite(id) && id > 0) ids.push(id);
  }
  return ids;
}

interface ResolveOutcome {
  updatedRows: number;
  deletedRows: number;
  maniaDiffIds: number[];
}

// One /beatmapsets/{id} read, reconciled per diff. Trusts the payload as
// current truth in every direction, like the qualified watch's resolveLeftSet.
async function resolveSet(db: Db, osu: OsuApiClient, setId: number, updatedAt: string): Promise<ResolveOutcome | null> {
  let set: Record<string, unknown>;
  try {
    set = await osu.getBeatmapset(setId, RESOLVE_CALLER);
  } catch (error) {
    if (error instanceof OsuApiError && error.status === 404) {
      // Set deleted outright upstream: drop every phantom row and stamp the
      // beatmaps so a rebuild does not bring them back.
      const rows = await getIndexRows(db, setId);
      await execBatch(db, [
        ...[...rows.keys()].map((id) => stampBeatmapDeletedStatement(id, updatedAt)),
        { sql: "delete from map_search_index where beatmapset_id = ?", args: [setId] },
      ]);
      return { updatedRows: 0, deletedRows: rows.size, maniaDiffIds: [] };
    }
    throw error;
  }

  const setStatus = normalizeMapSetStatus(set.status);
  if (!setStatus) return null;

  // Fresh metadata for every current native mania diff (beatmaps +
  // beatmapsets, status column and metadata_json both), so later full rebuilds
  // re-materialize the right status.
  const shaped = shapeManiaDiffScores(set);
  if (shaped.scores.length > 0) await persistScoresDisplayMetadata(db, shaped.scores, updatedAt);

  // Per-diff truth: an id present in the payload (any ruleset) is alive and
  // takes its own status; an id absent from it was deleted upstream.
  const payloadStatuses = new Map<number, string>();
  const payloadDiffs = Array.isArray(set.beatmaps) ? (set.beatmaps as Record<string, unknown>[]) : [];
  for (const diff of payloadDiffs) {
    const diffId = Math.floor(Number(diff.id));
    if (!Number.isFinite(diffId) || diffId <= 0) continue;
    payloadStatuses.set(diffId, normalizeMapSetStatus(diff.status) || setStatus);
  }

  // The payload's ranked_date rides along: osu! stamps it at the loved or
  // ranked moment, so a revived set lands on the Newest sort like a new one.
  const rankedDate = normalizeRankedDate(set.ranked_date);
  const statements: DbStatement[] = [];
  let updatedRows = 0;
  let deletedRows = 0;
  for (const [beatmapId, indexStatus] of await getIndexRows(db, setId)) {
    const alive = payloadStatuses.get(beatmapId);
    if (alive) {
      if (alive === indexStatus) continue;
      statements.push({
        sql: "update map_search_index set status = ?, ranked_date = ?, updated_at = ? where beatmap_id = ?",
        args: [alive, rankedDate, updatedAt, beatmapId],
      });
      updatedRows++;
    } else {
      statements.push(stampBeatmapDeletedStatement(beatmapId, updatedAt));
      statements.push({ sql: "delete from map_search_index where beatmap_id = ?", args: [beatmapId] });
      deletedRows++;
    }
  }
  // Kill the stale set-level signals too, so the set cannot re-qualify as a
  // candidate off a projection that still disagrees with upstream.
  statements.push({
    sql: "update maps_beatmapsets set status = ?, updated_at = ? where beatmapset_id = ?",
    args: [setStatus, updatedAt, setId],
  });
  await execBatch(db, statements);
  return { updatedRows, deletedRows, maniaDiffIds: shaped.diffIds };
}

async function markSetResolved(db: Db, setId: number, updatedAt: string): Promise<void> {
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [`${RESOLVED_META_KEY_PREFIX}${setId}`, json(updatedAt), updatedAt],
  );
}

async function getIndexRows(db: Db, setId: number): Promise<Map<number, string>> {
  const rows = (await exec(db, "select beatmap_id, status from map_search_index where beatmapset_id = ?", [setId])).rows;
  const byId = new Map<number, string>();
  for (const row of rows) {
    const id = Math.floor(Number(row.beatmap_id));
    if (Number.isFinite(id) && id > 0) byId.set(id, String(row.status ?? ""));
  }
  return byId;
}

// Mark a beatmap as deleted upstream in metadata_json only: the status column
// keeps the last real osu! status for stored-score display, while the map-search
// SOURCE_SELECT filters on the stamp so rebuilds and re-touches skip the row.
function stampBeatmapDeletedStatement(beatmapId: number, updatedAt: string): DbStatement {
  return {
    sql: `update beatmaps
             set metadata_json = case when json_valid(metadata_json)
                   then json_set(metadata_json, '$.status', 'deleted')
                   else json_object('status', 'deleted') end,
                 updated_at = ?
           where beatmap_id = ?`,
    args: [updatedAt, beatmapId],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
