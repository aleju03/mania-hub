import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { nowIso } from "../shared/score.js";

export type JobStatus = "queued" | "running" | "done" | "failed";

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

export class JobQueue {
  constructor(private readonly db: Db) {}

  async enqueue(type: string, dedupeKey: string, payload: unknown, options: { priority?: number; runAfter?: Date; replaceDone?: boolean } = {}): Promise<void> {
    const now = nowIso();
    await exec(
      this.db,
      `insert into jobs (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at)
       values (?, ?, 'queued', ?, ?, 0, ?, ?, ?)
       on conflict(dedupe_key) do update set
         status = 'queued',
         priority = max(priority, excluded.priority),
         run_after = min(run_after, excluded.run_after),
         attempts = case when jobs.status = 'done' then 0 else jobs.attempts end,
         payload_json = excluded.payload_json,
         last_error = case when jobs.status = 'done' then null else jobs.last_error end,
         updated_at = excluded.updated_at
       where jobs.status in ('queued', 'failed') or (? and jobs.status = 'done')`,
      [type, dedupeKey, options.priority ?? 0, (options.runAfter ?? new Date()).toISOString(), json(payload), now, now, options.replaceDone ? 1 : 0],
    );
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
    const row = (await exec(this.db, "select count(*) as count from jobs where status in ('queued', 'failed', 'running')")).rows[0];
    return Number(row?.count ?? 0);
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
