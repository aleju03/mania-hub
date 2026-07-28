import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { nowIso } from "../shared/score.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "deferred_pressure";

export interface Job<T = unknown> {
  id: number;
  type: string;
  dedupeKey: string;
  status: JobStatus;
  priority: number;
  runAfter: string;
  attempts: number;
  payload: T;
}

export interface ClaimOptions {
  types?: string[];
}

const QUEUE_TARGET_DEPTH = 100;
const QUEUE_SOFT_PRESSURE_DEPTH = 80;
const QUEUE_RECOVERY_DEPTH = 60;
const PRESSURE_DEFER_MS = 30 * 60_000;

// Empty by design. Globally-sheddable background types repeatedly starved on
// prod: the queue's steady state sits AT the soft-pressure cap (recent-score
// reconciliation refills it as fast as the osu! API budget drains it), so
// "defer until pressure clears" meant "defer forever". It killed the map
// search index build first, then collections, then snipe seeding. Every
// former member now runs as a reserved-lane type below: a small always-
// runnable reserve with the overflow parked, which guarantees a trickle of
// progress under any pressure. Only add a type here if it has no dedicated
// lane or reserve AND losing it entirely under sustained pressure is
// acceptable.
const SHEDDABLE_TYPES: string[] = [];

const ACTIVE_TYPE_CAPS: Record<string, number> = {
  refresh_user_top_scores: 80,
};

// Types with a reserved lane: invisible to the shared depth/shedding pool so
// they drain steadily even when the queue hovers above the soft-pressure line,
// but capped to this many active jobs so they cannot crowd anything out. The
// osu! API token bucket still governs their actual request rate.
const RESERVED_LANE_TYPES: Record<string, number> = {
  analyze_activity_beatmap: 10,
  analyze_beatmap_chart: 10,
  // Self-chaining top-up runner for the chart-analysis backfill: one slot for
  // the runner and one for the queued continuation.
  chart_analysis_backfill: 2,
  // The backfill chains its next batch from inside the currently running job,
  // so reserve one slot for the runner and one for the queued continuation.
  // The worker lane still claims only one job at a time.
  backfill_beatmap_osu_files: 2,
  // Background index maintenance. A reserve of 1 keeps each draining steadily even
  // while the shared queue sits above the soft-pressure cap (a busy prod queue
  // otherwise starves them forever). They touch no osu! API and self-serialise with
  // the claimLimit:1 map-search-index worker lane.
  build_map_search_index: 1,
  rebuild_map_collections: 1,
  // The pack-pool snapshot warm chains its next batch from inside the running
  // job, so reserve a slot for the runner and one for the continuation.
  warm_profile_pool: 2,
  // The skill-baseline sweep chains its next user chunk from inside the
  // running job: runner + queued continuation. No osu! API involved.
  refresh_skill_baseline: 2,
  // Formerly sheddable (see the SHEDDABLE_TYPES note): each starved on prod
  // whenever the queue hovered at the soft-pressure cap. Snipe seeding was the
  // observed incident (boards for new beatmaps stopped for a day); the others
  // fail the same way, just more quietly (stale farm data, rotting rosters,
  // score gaps after a socket outage).
  seed_snipe_board: 1,
  refresh_country_maps: 1,
  // Hourly qualified-maps watch: one API call, but reserve a slot so it still
  // reconciles /maps status when the queue sits at the soft-pressure cap.
  refresh_qualified_maps: 1,
  refresh_user_maps_farmed_scores: 2,
  refresh_country_roster: 2,
  // The type the SHEDDABLE_TYPES note names as the thing pinning the queue at
  // the soft-pressure cap. As a shared-pool capped type it starved on its own
  // backlog: the cap only trims above QUEUE_TARGET_DEPTH and reactivation only
  // runs below QUEUE_SOFT_PRESSURE_DEPTH, so a queue resting between the two
  // (which its own self-chaining inflow guarantees) neither trimmed nor
  // revived, and parked reconciles sat for hours -- players stopped appearing
  // in the tracker while still playing. A reserve keeps a trickle runnable
  // under any pressure, same remedy as every other former shared-pool type.
  reconcile_user_recent_scores: 10,
  // Both backfills chain their next page from inside the running job:
  // runner + queued continuation.
  osc_backfill: 2,
  osc_country_catchup: 2,
};

export class JobQueue {
  constructor(private readonly db: Db) {}

  async enqueue(type: string, dedupeKey: string, payload: unknown, options: { priority?: number; runAfter?: Date; replaceDone?: boolean; debounce?: boolean } = {}): Promise<void> {
    const pressureStatus = await this.pressureStatusFor(type);
    const now = nowIso();
    const status = pressureStatus.defer ? "deferred_pressure" : "queued";
    const runAfter = pressureStatus.defer ? new Date(Date.now() + PRESSURE_DEFER_MS) : options.runAfter ?? new Date();
    await exec(
      this.db,
      // run_after merge: normally the earliest request wins so an urgent
      // enqueue pulls a scheduled job forward. `debounce` inverts that for the
      // incoming value (max) so repeated events keep pushing the job out —
      // e.g. one skills recompute after a play session instead of one per
      // play. ISO strings compare lexicographically, so min/max are sound.
      `insert into jobs (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at, last_error)
       values (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
       on conflict(dedupe_key) do update set
         status = excluded.status,
         priority = max(priority, excluded.priority),
         run_after = case
           when jobs.status = 'done' then excluded.run_after
           when ? then max(jobs.run_after, excluded.run_after)
           else min(jobs.run_after, excluded.run_after)
         end,
         attempts = case when jobs.status = 'done' then 0 else jobs.attempts end,
         payload_json = excluded.payload_json,
         last_error = case when jobs.status = 'done' then excluded.last_error else coalesce(jobs.last_error, excluded.last_error) end,
         updated_at = excluded.updated_at
       where jobs.status in ('queued', 'failed', 'deferred_pressure') or (? and jobs.status = 'done')`,
      [
        type,
        dedupeKey,
        status,
        options.priority ?? 0,
        runAfter.toISOString(),
        json(payload),
        now,
        now,
        pressureStatus.reason,
        options.debounce ? 1 : 0,
        options.replaceDone ? 1 : 0,
      ],
    );
    await this.shedPressure();
  }

  async claim(workerId: string, limit = 1, options: ClaimOptions = {}): Promise<Job[]> {
    const now = nowIso();
    const lockedUntil = new Date(Date.now() + 60_000).toISOString();
    const typeFilter = buildTypeFilter(options.types);
    const rows = (await exec(
      this.db,
      `select * from jobs
       where ((status in ('queued', 'failed') and run_after <= ?)
          or (status = 'running' and locked_until <= ?))
       ${typeFilter.sql}
       order by priority desc, run_after asc
       limit ?`,
      [now, now, ...typeFilter.args, limit],
    )).rows;
    const jobs: Job[] = [];
    for (const row of rows) {
      const result = await exec(
        this.db,
        `update jobs set status = 'running', locked_by = ?, locked_until = ?, attempts = attempts + 1, updated_at = ?
         where id = ?
           and ((status in ('queued', 'failed') and run_after <= ?) or (status = 'running' and locked_until <= ?))`,
        [workerId, lockedUntil, now, Number(row.id), now, now],
      );
      if (result.rowsAffected > 0) jobs.push(rowToJob(row));
    }
    // A reserved-lane type whose lane comes up short refills itself from its
    // deferred pool right away. shedPressure() also refills, but it only runs
    // on enqueues and a 60s tick; during a backfill the lane drains its small
    // reserve in seconds and would otherwise sit starved between refills.
    if (jobs.length < limit && options.types) {
      for (const type of options.types) {
        const reserve = RESERVED_LANE_TYPES[type];
        if (reserve == null) continue;
        const activeOfType = await activeDepth(this.db, type);
        if (activeOfType < reserve) {
          await this.reactivateDeferred(reserve - activeOfType, type);
        }
      }
    }
    return jobs;
  }

  async hasRunnableOutsideTypes(types: string[]): Promise<boolean> {
    if (types.length === 0) return false;
    const now = nowIso();
    const placeholders = types.map(() => "?").join(", ");
    const row = (await exec(
      this.db,
      `select 1 as runnable
       from jobs
       where status in ('queued', 'failed')
         and run_after <= ?
         and type not in (${placeholders})
       limit 1`,
      [now, ...types],
    )).rows[0];
    return !!row;
  }

  async complete(id: number): Promise<void> {
    await exec(this.db, "update jobs set status = 'done', locked_by = null, locked_until = null, last_error = null, updated_at = ? where id = ?", [nowIso(), id]);
  }

  async fail(id: number, error: unknown, retryDelayMs = 30_000): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await exec(
      this.db,
      "update jobs set status = 'failed', locked_by = null, locked_until = null, run_after = ?, last_error = ?, updated_at = ? where id = ?",
      [new Date(Date.now() + retryDelayMs).toISOString(), message, nowIso(), id],
    );
  }

  async defer(id: number, retryDelayMs = 30_000): Promise<void> {
    await exec(
      this.db,
      "update jobs set status = 'queued', locked_by = null, locked_until = null, run_after = ?, last_error = null, updated_at = ? where id = ?",
      [new Date(Date.now() + retryDelayMs).toISOString(), nowIso(), id],
    );
  }

  async depth(): Promise<number> {
    return activeDepth(this.db);
  }

  async pressure(): Promise<{ depth: number; deferred: number; targetDepth: number; softDepth: number; recoveryDepth: number; shedding: boolean; sheddableTypes: string[]; typeCaps: Record<string, number>; reservedLanes: Record<string, number> }> {
    const depth = await this.depth();
    const deferred = await deferredDepth(this.db);
    return {
      depth,
      deferred,
      targetDepth: QUEUE_TARGET_DEPTH,
      softDepth: QUEUE_SOFT_PRESSURE_DEPTH,
      recoveryDepth: QUEUE_RECOVERY_DEPTH,
      shedding: depth >= QUEUE_SOFT_PRESSURE_DEPTH,
      sheddableTypes: SHEDDABLE_TYPES,
      typeCaps: ACTIVE_TYPE_CAPS,
      reservedLanes: RESERVED_LANE_TYPES,
    };
  }

  async shedPressure(targetDepth = QUEUE_TARGET_DEPTH): Promise<number> {
    let deferred = 0;
    // Reserved lanes are refilled to their reserve (and trimmed back to it)
    // independently of the shared pool below.
    for (const [type, reserve] of Object.entries(RESERVED_LANE_TYPES)) {
      const activeOfType = await activeDepth(this.db, type);
      if (activeOfType < reserve) {
        await this.reactivateDeferred(reserve - activeOfType, type);
      } else if (activeOfType > reserve) {
        deferred += await this.deferQueuedOrFailedType(type, reserve);
      }
    }

    let depth = await this.depth();
    // Drain parked jobs whenever there is headroom below the soft-pressure
    // line. Waiting for the recovery floor starves the deferred pool when
    // steady inflow keeps depth hovering between recovery and target.
    if (depth < QUEUE_SOFT_PRESSURE_DEPTH) {
      await this.reactivateDeferred(QUEUE_SOFT_PRESSURE_DEPTH - depth);
      depth = await this.depth();
    }
    if (depth <= targetDepth) return 0;

    deferred += await this.deferQueuedOrFailedByTypes(SHEDDABLE_TYPES, depth - targetDepth);
    depth = await this.depth();
    if (depth <= targetDepth) return deferred;

    for (const [type, keep] of Object.entries(ACTIVE_TYPE_CAPS)) {
      deferred += await this.deferQueuedOrFailedType(type, keep);
      depth = await this.depth();
      if (depth <= targetDepth) return deferred;
    }

    return deferred;
  }

  async summary(): Promise<Array<{ status: string; type: string; count: number; oldestRunAfter: string | null; newestError: string | null }>> {
    const rows = (await exec(
      this.db,
      `select
         j.status,
         j.type,
         count(*) as count,
         min(j.run_after) as oldest_run_after,
         (
           select j2.last_error
           from jobs j2
           where j2.status = j.status
             and j2.type = j.type
             and j2.status != 'done'
             and j2.last_error is not null
           order by j2.updated_at desc, j2.id desc
           limit 1
         ) as newest_error
       from jobs j
       where j.status in ('queued', 'running', 'failed', 'deferred_pressure')
       group by j.status, j.type
       order by count desc`,
    )).rows;
    return rows.map((row) => ({
      status: String(row.status),
      type: String(row.type),
      count: Number(row.count),
      oldestRunAfter: row.oldest_run_after == null ? null : String(row.oldest_run_after),
      newestError: row.newest_error == null ? null : String(row.newest_error),
    }));
  }

  async clearFailed(type?: string): Promise<number> {
    const result = type
      ? await exec(this.db, "delete from jobs where status = 'failed' and type = ?", [type])
      : await exec(this.db, "delete from jobs where status = 'failed'");
    return Number(result.rowsAffected ?? 0);
  }

  private async pressureStatusFor(type: string): Promise<{ defer: boolean; reason: string | null }> {
    const reserve = RESERVED_LANE_TYPES[type];
    if (reserve != null) {
      const activeOfType = await activeDepth(this.db, type);
      if (activeOfType >= reserve) {
        return { defer: true, reason: `deferred by ${type} reserve (${activeOfType}/${reserve})` };
      }
      return { defer: false, reason: null };
    }

    const depth = await this.depth();
    if (depth >= QUEUE_SOFT_PRESSURE_DEPTH && SHEDDABLE_TYPES.includes(type)) {
      return { defer: true, reason: `deferred by queue pressure (${depth}/${QUEUE_TARGET_DEPTH})` };
    }

    const cap = ACTIVE_TYPE_CAPS[type];
    if (cap == null || depth < QUEUE_TARGET_DEPTH) return { defer: false, reason: null };
    const activeOfType = await activeDepth(this.db, type);
    if (activeOfType >= cap) {
      return { defer: true, reason: `deferred by ${type} cap (${activeOfType}/${cap})` };
    }
    return { defer: false, reason: null };
  }

  private async deferQueuedOrFailedByTypes(types: string[], limit: number): Promise<number> {
    if (limit <= 0 || types.length === 0) return 0;
    const result = await exec(
      this.db,
      `update jobs
       set status = 'deferred_pressure',
           locked_by = null,
           locked_until = null,
           run_after = ?,
           last_error = ?,
           updated_at = ?
       where id in (
         select id
         from jobs
         where status in ('queued', 'failed')
           and run_after <= ?
           and type in (${types.map(() => "?").join(", ")})
         order by priority asc, run_after desc, updated_at asc, id asc
         limit ?
       )`,
      [
        new Date(Date.now() + PRESSURE_DEFER_MS).toISOString(),
        `deferred by queue pressure`,
        nowIso(),
        nowIso(),
        ...types,
        Math.max(0, Math.floor(limit)),
      ],
    );
    return Number(result.rowsAffected ?? 0);
  }

  private async deferQueuedOrFailedType(type: string, keep: number): Promise<number> {
    const activeOfType = await activeDepth(this.db, type);
    const excess = activeOfType - keep;
    if (excess <= 0) return 0;
    const result = await exec(
      this.db,
      `update jobs
       set status = 'deferred_pressure',
           locked_by = null,
           locked_until = null,
           run_after = ?,
           last_error = ?,
           updated_at = ?
       where id in (
         select id
         from jobs
         where status in ('queued', 'failed')
           and run_after <= ?
           and type = ?
         order by
           case when status = 'failed' then 0 else 1 end asc,
           priority asc,
           run_after desc,
           updated_at asc,
           id asc
         limit ?
       )`,
      [
        new Date(Date.now() + PRESSURE_DEFER_MS).toISOString(),
        `deferred by ${type} cap`,
        nowIso(),
        nowIso(),
        type,
        excess,
      ],
    );
    return Number(result.rowsAffected ?? 0);
  }

  private async reactivateDeferred(limit: number, type?: string): Promise<number> {
    if (limit <= 0) return 0;
    // run_after is reset so reactivated jobs are runnable immediately and count
    // toward depth; the parked run_after was only the +30min pressure stamp.
    // Without a type this serves the shared pool, so reserved-lane types are
    // excluded; they only re-enter through their own lane's refill.
    const now = nowIso();
    const reserved = Object.keys(RESERVED_LANE_TYPES);
    const typeFilter = type != null
      ? { sql: "and type = ?", args: [type] }
      : reserved.length > 0
        ? { sql: `and type not in (${reserved.map(() => "?").join(", ")})`, args: reserved }
        : { sql: "", args: [] as string[] };
    const result = await exec(
      this.db,
      `update jobs
       set status = 'queued',
           run_after = ?,
           last_error = null,
           updated_at = ?
       where id in (
         select id
         from jobs
         where status = 'deferred_pressure'
         ${typeFilter.sql}
         order by priority desc, run_after asc, updated_at asc, id asc
         limit ?
       )`,
      [now, now, ...typeFilter.args, Math.max(0, Math.floor(limit))],
    );
    return Number(result.rowsAffected ?? 0);
  }
}

async function activeDepth(db: Db, type?: string): Promise<number> {
  // Jobs scheduled for the future (self-rescheduling reconciles, retry backoffs)
  // are appointments, not backlog; counting them kept the queue permanently
  // above the shedding threshold.
  const now = nowIso();
  const runnable = "(status = 'running' or (status in ('queued', 'failed') and run_after <= ?))";
  if (type != null) {
    const row = (await exec(db, `select count(*) as count from jobs where ${runnable} and type = ?`, [now, type])).rows[0];
    return Number(row?.count ?? 0);
  }
  // Reserved-lane jobs are capped on their own; counting them here would push
  // the shared pool into shedding just for keeping their reserve full.
  const reserved = Object.keys(RESERVED_LANE_TYPES);
  const filter = reserved.length > 0 ? ` and type not in (${reserved.map(() => "?").join(", ")})` : "";
  const row = (await exec(db, `select count(*) as count from jobs where ${runnable}${filter}`, [now, ...reserved])).rows[0];
  return Number(row?.count ?? 0);
}

async function deferredDepth(db: Db): Promise<number> {
  const row = (await exec(db, "select count(*) as count from jobs where status = 'deferred_pressure'")).rows[0];
  return Number(row?.count ?? 0);
}

function buildTypeFilter(types: string[] | undefined): { sql: string; args: string[] } {
  if (!types?.length) return { sql: "", args: [] };
  return {
    sql: `and type in (${types.map(() => "?").join(", ")})`,
    args: types,
  };
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: Number(row.id),
    type: String(row.type),
    dedupeKey: String(row.dedupe_key),
    status: String(row.status) as JobStatus,
    priority: Number(row.priority),
    runAfter: String(row.run_after),
    attempts: Number(row.attempts),
    payload: parseJson(row.payload_json, {}),
  };
}
