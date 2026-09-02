import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deleteInBatches, exec, execBatch, json, splitSql, type Db, type DbStatement } from "./db.js";
import { errorContext, logInfo, logWarn } from "./logger.js";

/*
 * The journal database: a second SQLite file beside the main one holding the
 * hot append-only tables that used to contend for the main file's write lock
 * on every osu! call and every live event. Every process opens it, because
 * what it holds is shared state between the server and worker processes: the
 * osu! budget (api_rate_limit_reservations, plus the 429 pause in
 * journal_meta), the osu! call history (api_call_log / api_call_targets) and
 * the SSE event journal (live_event_log, which the server role tails to learn
 * what the worker ingested). Same shape as the analytics file, with one
 * difference: the worker role opens this one too.
 *
 * Schema is idempotent and applied by every boot. The one-time move of the
 * rows out of the main file (adoptJournalFromMain) is owned by the process
 * that owns schema DDL, and a server-role process waits for it the way it
 * waits for the main schema: a tail that started on an empty journal would
 * otherwise replay every copied event into the SSE sinks and Discord feeds.
 */

export const JOURNAL_TABLES = ["live_event_log", "api_call_log", "api_call_targets", "api_rate_limit_reservations"] as const;
export const JOURNAL_ADOPTED_KEY = "journal:adopted_from_main:v1";
const OSU_PAUSE_KEY = "control:osu_rate_limit_paused_until";
const ADOPT_EVENT_ROWS = 2_000;
const ADOPT_CALL_LOG_WINDOW_MS = 24 * 60 * 60_000;
const ADOPT_RESERVATION_WINDOW_MS = 5 * 60_000;
const ADOPT_CHUNK_ROWS = 500;

export function journalFilePath(journalDatabaseUrl: string): string | null {
  if (!journalDatabaseUrl.startsWith("file:")) return null;
  const raw = journalDatabaseUrl.slice("file:".length);
  if (!raw || raw === ":memory:") return null;
  return resolve(raw);
}

export async function ensureJournalSchema(db: Db): Promise<void> {
  const sql = await readFile(new URL("../migrations/journal.sql", import.meta.url), "utf8");
  for (const statement of splitSql(sql)) await exec(db, statement);
}

export async function isJournalAdopted(db: Db): Promise<boolean> {
  const row = (await exec(db, "select 1 as present from journal_meta where key = ? limit 1", [JOURNAL_ADOPTED_KEY])).rows[0];
  return row != null;
}

export interface JournalAdoption {
  copied: Record<string, number>;
}

/**
 * Moves the tail of each journal table out of the main database once. Copies
 * preserve ids, so the SSE `sequence` cursor every connected browser holds
 * keeps meaning what it meant, and the autoincrement counters are seeded to
 * the main file's so nothing new ever collides with an old id. Idempotent
 * per row (insert or ignore), so a boot that loses this to a busy writer
 * simply re-runs it on the next one. Returns null when already adopted.
 */
export async function adoptJournalFromMain(main: Db, journal: Db): Promise<JournalAdoption | null> {
  if (await isJournalAdopted(journal)) return null;
  const copied: Record<string, number> = {};
  const mainTables = new Set(
    (await exec(main, "select name from sqlite_master where type = 'table'")).rows.map((row) => String(row.name)),
  );
  if (mainTables.has("live_event_log")) {
    copied.live_event_log = await copyRows(
      main,
      journal,
      `select sequence, event_id, type, country, payload_json, created_at
       from (select * from live_event_log order by sequence desc limit ?)
       order by sequence asc`,
      [ADOPT_EVENT_ROWS],
      (row) => ({
        sql: "insert or ignore into live_event_log (sequence, event_id, type, country, payload_json, created_at) values (?, ?, ?, ?, ?, ?)",
        args: [Number(row.sequence), String(row.event_id), String(row.type), row.country == null ? null : String(row.country), String(row.payload_json), String(row.created_at)],
      }),
    );
    await seedSequence(main, journal, "live_event_log");
  }
  if (mainTables.has("api_call_log") && mainTables.has("api_call_targets")) {
    const since = new Date(Date.now() - ADOPT_CALL_LOG_WINDOW_MS).toISOString();
    copied.api_call_targets = await copyRows(
      main,
      journal,
      `select id, provider, caller, path from api_call_targets
       where id in (select target_id from api_call_log where started_at >= ? and target_id is not null)`,
      [since],
      (row) => ({
        sql: "insert or ignore into api_call_targets (id, provider, caller, path) values (?, ?, ?, ?)",
        args: [Number(row.id), String(row.provider), String(row.caller), String(row.path)],
      }),
    );
    copied.api_call_log = await copyRows(
      main,
      journal,
      `select id, provider, caller, path, target_id, started_at, duration_ms, status
       from api_call_log where started_at >= ? order by id asc`,
      [since],
      (row) => ({
        sql: "insert or ignore into api_call_log (id, provider, caller, path, target_id, started_at, duration_ms, status) values (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          Number(row.id),
          String(row.provider),
          String(row.caller ?? ""),
          String(row.path ?? ""),
          row.target_id == null ? null : Number(row.target_id),
          String(row.started_at),
          row.duration_ms == null ? null : Number(row.duration_ms),
          row.status == null ? null : Number(row.status),
        ],
      }),
    );
    await seedSequence(main, journal, "api_call_targets");
    await seedSequence(main, journal, "api_call_log");
  }
  if (mainTables.has("api_rate_limit_reservations")) {
    copied.api_rate_limit_reservations = await copyRows(
      main,
      journal,
      "select provider, started_at_ms, caller, path, lane, created_at_ms from api_rate_limit_reservations where started_at_ms > ?",
      [Date.now() - ADOPT_RESERVATION_WINDOW_MS],
      (row) => ({
        sql: "insert into api_rate_limit_reservations (provider, started_at_ms, caller, path, lane, created_at_ms) values (?, ?, ?, ?, ?, ?)",
        args: [String(row.provider), Number(row.started_at_ms), String(row.caller), String(row.path), String(row.lane), Number(row.created_at_ms)],
      }),
    );
  }
  if (mainTables.has("live_meta")) {
    const pause = (await exec(main, "select value_json, updated_at from live_meta where key = ?", [OSU_PAUSE_KEY])).rows[0];
    if (pause) {
      await exec(
        journal,
        "insert or replace into journal_meta (key, value_json, updated_at) values (?, ?, ?)",
        [OSU_PAUSE_KEY, String(pause.value_json), String(pause.updated_at)],
      );
    }
  }
  await exec(
    journal,
    "insert or replace into journal_meta (key, value_json, updated_at) values (?, ?, ?)",
    [JOURNAL_ADOPTED_KEY, json({ copied, at: new Date().toISOString() }), new Date().toISOString()],
  );
  logInfo("journal_adopted_from_main", { ...copied });
  return { copied };
}

/**
 * After adoption the main file's copies are dead weight. Drained in bounded
 * batches behind boot (they can be millions of rows), and the main file's
 * `create table if not exists` keeps the empty tables around so a rollback
 * still boots.
 */
export async function drainJournalTablesFromMain(main: Db): Promise<Record<string, number>> {
  const drained: Record<string, number> = {};
  for (const table of JOURNAL_TABLES) {
    try {
      drained[table] = await deleteInBatches(main, table, "1 = 1", []);
    } catch (error) {
      logWarn("journal_drain_failed", { table, ...errorContext(error) });
    }
  }
  return drained;
}

async function copyRows(
  main: Db,
  journal: Db,
  selectSql: string,
  selectArgs: Array<string | number>,
  toStatement: (row: Record<string, unknown>) => DbStatement,
): Promise<number> {
  const rows = (await exec(main, selectSql, selectArgs)).rows as unknown as Array<Record<string, unknown>>;
  let copied = 0;
  for (let index = 0; index < rows.length; index += ADOPT_CHUNK_ROWS) {
    const chunk = rows.slice(index, index + ADOPT_CHUNK_ROWS).map(toStatement);
    const results = await execBatch(journal, chunk);
    for (const result of results) copied += Number(result.rowsAffected ?? 0);
  }
  return copied;
}

async function seedSequence(main: Db, journal: Db, table: string): Promise<void> {
  const row = (await exec(main, "select seq from sqlite_sequence where name = ?", [table])).rows[0];
  const seq = Number(row?.seq ?? 0);
  if (!Number.isFinite(seq) || seq <= 0) return;
  const updated = await exec(journal, "update sqlite_sequence set seq = max(seq, ?) where name = ?", [seq, table]);
  if (Number(updated.rowsAffected ?? 0) === 0) {
    await exec(journal, "insert into sqlite_sequence (name, seq) values (?, ?)", [table, seq]);
  }
}
