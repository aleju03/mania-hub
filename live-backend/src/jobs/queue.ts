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

const SHEDDABLE_TYPES = [
  "refresh_user_maps_farmed_scores",
  "refresh_country_maps",
  "seed_snipe_board",
  "refresh_country_roster",
  "osc_backfill",
  "osc_country_catchup",
  "build_map_search_index",
  "rebuild_map_collections",
];

const ACTIVE_TYPE_CAPS: Record<string, number> = {
  refresh_user_top_scores: 80,
  reconcile_user_recent_scores: 10,
};

// Types with a reserved lane: invisible to the shared depth/shedding pool so
// they drain steadily even when the queue hovers above the soft-pressure line,
// but capped to this many active jobs so they cannot crowd anything out. The
// osu! API token bucket still governs their actual request rate.
const RESERVED_LANE_TYPES: Record<string, number> = {
  analyze_activity_beatmap: 10,
};

export class JobQueue {
  constructor(private readonly db: Db) {}

  async enqueue(type: string, dedupeKey: string, payload: unknown, options: { priority?: number; runAfter?: Date; replaceDone?: boolean } = {}): Promise<void> {
    const pressureStatus = await this.pressureStatusFor(type);
    const now = nowIso();
    const status = pressureStatus.defer ? "deferred_pressure" : "queued";
    const runAfter = pressureStatus.defer ? new Date(Date.now() + PRESSURE_DEFER_MS) : options.runAfter ?? new Date();
    await exec(
      this.db,
      `insert into jobs (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at, last_error)
       values (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
       on conflict(dedupe_key) do update set
         status = excluded.status,
         priority = max(priority, excluded.priority),
         run_after = case when jobs.status = 'done' then excluded.run_after else min(run_after, excluded.run_after) end,
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
