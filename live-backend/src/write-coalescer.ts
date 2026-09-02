import type { InArgs, InStatement, ResultSet, Row, TransactionMode } from "@libsql/client";
import { RECONNECT, WRITE_GATE, writeTurnContext, type Db, type ReconnectHook, type ReconnectReason, type WriteGateState } from "./db.js";

/*
 * One writer queue with batching for the serving process's write connections.
 *
 * Every execute()/batch() on a coalesced connection becomes a "group" (one
 * statement, or a batch that must stay atomic). Groups queue in JS and go to
 * SQLite as one transaction per flush: the first group of a quiet period is
 * flushed at once, and everything that arrives while that flush is waiting on
 * the write lock rides the next one. Under contention that is exactly when
 * writes pile up, so the busier the lock the more each acquisition carries; an
 * idle write pays no fixed delay. SERVE_WRITE_COALESCE_MS adds a fixed window
 * on top for anyone who wants time-based batching regardless of load.
 *
 * The transport is pluggable: an executor runs a flush's groups on a real
 * connection, either inline (source-mode dev and tests, where the calling
 * thread blocks inside SQLite exactly as before) or on the write thread
 * (write-thread.ts, production), where the busy wait never touches the event
 * loop. Both run the same runWriteGroups below.
 *
 * A flush that fails mid-way is rolled back and its groups re-run one
 * transaction each, so a constraint error in one caller's write never takes a
 * neighbour's with it; a group's own atomicity holds either way.
 */

export interface WriteStatement {
  sql: string;
  args: InArgs;
}

export interface WriteGroup {
  statements: WriteStatement[];
  mode: TransactionMode;
}

export interface SerializedResultSet {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}

export interface SerializedError {
  message: string;
  code?: string;
  name?: string;
}

export type GroupOutcome =
  | { ok: true; results: SerializedResultSet[] }
  | { ok: false; error: SerializedError };

export interface RunWriteGroupsResult {
  outcomes: GroupOutcome[];
  /** A ROLLBACK failed after an error inside an open transaction; the
   * connection cannot be trusted and must be reopened before its next use. */
  poisoned: boolean;
}

/** Runs the groups in order on a real connection and reports one outcome per
 * group. Never throws for a SQL failure; transport failures are the caller's. */
export type WriteExecutor = (groups: WriteGroup[]) => Promise<GroupOutcome[]>;

export interface WriteCoalescerOptions {
  /** Fixed batching window in ms; 0 flushes on the next event-loop turn. */
  coalesceMs?: number;
  /** Upper bound on statements per flush (SQLite happily takes more, but a
   * flush that fails re-runs each group alone, so keep the blast radius sane). */
  maxStatementsPerFlush?: number;
}

const DEFAULT_MAX_STATEMENTS_PER_FLUSH = 500;
const WRITE_GATE_EWMA_ALPHA = 0.2;
const TRANSACTION_CONTROL = /^\s*(begin|commit|end|rollback|savepoint|release)\b/i;

interface PendingGroup {
  group: WriteGroup;
  queuedAt: number;
  resolve: (results: ResultSet[]) => void;
  reject: (error: unknown) => void;
}

export class WriteCoalescer {
  readonly state: WriteGateState;
  private readonly coalesceMs: number;
  private readonly maxStatementsPerFlush: number;
  private pending: PendingGroup[] = [];
  private flushing = false;
  private flushTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> | null = null;
  private turnHeld = false;
  private turnWaiters: Array<() => void> = [];
  // Direct (turn-held) executions in flight; a flush never starts under one.
  private directInFlight = 0;

  constructor(private readonly executor: WriteExecutor, options: WriteCoalescerOptions = {}) {
    this.coalesceMs = Math.max(0, Math.floor(options.coalesceMs ?? 0));
    this.maxStatementsPerFlush = Math.max(1, Math.floor(options.maxStatementsPerFlush ?? DEFAULT_MAX_STATEMENTS_PER_FLUSH));
    this.state = {
      depth: 0,
      peakDepth: 0,
      gatedCalls: 0,
      sheds: 0,
      lastWaitMs: 0,
      ewmaWaitMs: 0,
      flushes: 0,
      groupsFlushed: 0,
      turnToken: null,
      acquireTurn: () => this.acquireTurn(),
    };
  }

  submit(group: WriteGroup): Promise<ResultSet[]> {
    const turn = writeTurnContext.getStore();
    if (turn != null && turn === this.state.turnToken) return this.runDirect(group);
    return new Promise<ResultSet[]>((resolve, reject) => {
      this.pending.push({ group, queuedAt: Date.now(), resolve, reject });
      this.enter();
      this.scheduleFlush();
    });
  }

  /** Groups waiting for a flush (not executing). Exposed for tests. */
  get queued(): number {
    return this.pending.length;
  }

  private enter(): void {
    this.state.depth += 1;
    if (this.state.depth > this.state.peakDepth) this.state.peakDepth = this.state.depth;
  }

  private leave(count = 1): void {
    this.state.depth -= count;
  }

  private recordWait(waitedMs: number): void {
    this.state.gatedCalls += 1;
    this.state.lastWaitMs = waitedMs;
    this.state.ewmaWaitMs = this.state.ewmaWaitMs * (1 - WRITE_GATE_EWMA_ALPHA) + waitedMs * WRITE_GATE_EWMA_ALPHA;
  }

  private async runDirect(group: WriteGroup): Promise<ResultSet[]> {
    this.enter();
    this.directInFlight += 1;
    try {
      const [outcome] = await this.executor([group]);
      this.recordWait(0);
      this.state.flushes += 1;
      this.state.groupsFlushed += 1;
      return settleOutcome(outcome);
    } finally {
      this.directInFlight -= 1;
      this.leave();
      // A turn that released before this write settled must not strand the
      // queue behind it.
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushing || this.turnHeld || this.pending.length === 0) return;
    const run = () => {
      this.flushTimer = null;
      void this.flush();
    };
    this.flushTimer = this.coalesceMs > 0 ? setTimeout(run, this.coalesceMs) : setImmediate(run);
  }

  private takeBatch(): PendingGroup[] {
    const batch: PendingGroup[] = [];
    let statements = 0;
    while (this.pending.length > 0) {
      const next = this.pending[0];
      const size = next.group.statements.length;
      if (batch.length > 0 && statements + size > this.maxStatementsPerFlush) break;
      batch.push(this.pending.shift()!);
      statements += size;
    }
    return batch;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.turnHeld || this.directInFlight > 0 || this.pending.length === 0) return;
    const batch = this.takeBatch();
    this.flushing = true;
    const startedAt = Date.now();
    for (const entry of batch) this.recordWait(startedAt - entry.queuedAt);
    try {
      const outcomes = await this.executor(batch.map((entry) => entry.group));
      this.state.flushes += 1;
      this.state.groupsFlushed += batch.length;
      batch.forEach((entry, index) => {
        const outcome = outcomes[index];
        if (!outcome) {
          entry.reject(new Error("write coalescer: executor returned no outcome for a group"));
          return;
        }
        try {
          entry.resolve(settleOutcome(outcome));
        } catch (error) {
          entry.reject(error);
        }
      });
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    } finally {
      this.leave(batch.length);
      this.flushing = false;
      this.wakeTurnWaiters();
      this.scheduleFlush();
    }
  }

  private acquireTurn(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      this.enter();
      const attempt = () => {
        if (this.flushing || this.turnHeld) {
          this.turnWaiters.push(attempt);
          return;
        }
        this.turnHeld = true;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.turnHeld = false;
          this.leave();
          this.wakeTurnWaiters();
          this.scheduleFlush();
        });
      };
      attempt();
    });
  }

  private wakeTurnWaiters(): void {
    if (this.turnWaiters.length === 0) return;
    const next = this.turnWaiters.shift()!;
    next();
  }
}

/** The result a caller sees: real ResultSets, or the group's own error. */
function settleOutcome(outcome: GroupOutcome): ResultSet[] {
  if (!outcome.ok) throw deserializeError(outcome.error);
  return outcome.results.map(deserializeResultSet);
}

// ---------------------------------------------------------------------------
// Running groups on a real connection (shared by the inline executor and the
// write thread).

export async function runWriteGroups(db: Db, groups: WriteGroup[]): Promise<RunWriteGroupsResult> {
  if (groups.length === 0) return { outcomes: [], poisoned: false };
  if (groups.length === 1) {
    return runGroupAlone(db, groups[0]);
  }
  // Merged attempt: every group in one transaction.
  try {
    await db.execute("begin immediate");
  } catch (error) {
    // Nothing ran (the lock was busy, typically): every caller retries on its
    // own budget, and re-running each group alone here would only line them
    // up for the same busy wait N times over.
    const failure = serializeError(error);
    return { outcomes: groups.map(() => ({ ok: false, error: failure })), poisoned: false };
  }
  const outcomes: GroupOutcome[] = [];
  try {
    for (const group of groups) {
      const results: SerializedResultSet[] = [];
      for (const statement of group.statements) {
        results.push(serializeResultSet(await db.execute(toInStatement(statement))));
      }
      outcomes.push({ ok: true, results });
    }
    await db.execute("commit");
    return { outcomes, poisoned: false };
  } catch {
    // One group failed; the whole merged transaction goes, then each group
    // gets its own so the failure stays with its caller.
    const poisoned = !(await rollbackQuietly(db));
    if (poisoned) {
      const failure: SerializedError = { message: "SQLITE_BUSY: write connection lost its transaction and was reopened", code: "SQLITE_BUSY" };
      return { outcomes: groups.map(() => ({ ok: false, error: failure })), poisoned: true };
    }
    const isolated: GroupOutcome[] = [];
    let anyPoisoned = false;
    for (const group of groups) {
      const result = await runGroupAlone(db, group);
      isolated.push(result.outcomes[0]);
      anyPoisoned ||= result.poisoned;
    }
    return { outcomes: isolated, poisoned: anyPoisoned };
  }
}

async function runGroupAlone(db: Db, group: WriteGroup): Promise<RunWriteGroupsResult> {
  const results: SerializedResultSet[] = [];
  if (group.statements.length === 1) {
    try {
      results.push(serializeResultSet(await db.execute(toInStatement(group.statements[0]))));
      return { outcomes: [{ ok: true, results }], poisoned: false };
    } catch (error) {
      return { outcomes: [{ ok: false, error: serializeError(error) }], poisoned: false };
    }
  }
  try {
    await db.execute(group.mode === "read" ? "begin" : "begin immediate");
  } catch (error) {
    return { outcomes: [{ ok: false, error: serializeError(error) }], poisoned: false };
  }
  try {
    for (const statement of group.statements) {
      results.push(serializeResultSet(await db.execute(toInStatement(statement))));
    }
    await db.execute("commit");
    return { outcomes: [{ ok: true, results }], poisoned: false };
  } catch (error) {
    const poisoned = !(await rollbackQuietly(db));
    return { outcomes: [{ ok: false, error: serializeError(error) }], poisoned };
  }
}

async function rollbackQuietly(db: Db): Promise<boolean> {
  try {
    await db.execute("rollback");
    return true;
  } catch {
    return false;
  }
}

function toInStatement(statement: WriteStatement): InStatement {
  return { sql: statement.sql, args: statement.args };
}

/** Wraps a plain connection as an executor, serializing calls so two flushes
 * (a turn-held direct call beside a queued flush) can never interleave their
 * BEGIN/COMMIT on the one connection. */
export function createInlineWriteExecutor(db: Db): WriteExecutor {
  let tail: Promise<unknown> = Promise.resolve();
  return (groups) => {
    const run = tail.then(async () => {
      const result = await runWriteGroups(db, groups);
      if (result.poisoned) await reopenConnection(db, "batch");
      return result.outcomes;
    });
    tail = run.catch(() => undefined);
    return run;
  };
}

async function reopenConnection(db: Db, reason: ReconnectReason): Promise<boolean> {
  const reconnect = (db as unknown as Record<symbol, unknown>)[RECONNECT] as ReconnectHook | undefined;
  if (!reconnect) return false;
  try {
    return await reconnect(reason);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Result marshalling. Rows cross a thread boundary as plain arrays and come
// back in libsql's shape (array-like objects with enumerable column props), so
// callers reading row.column, row[0], row.length or spreading a row see no
// difference.

export function serializeResultSet(result: ResultSet): SerializedResultSet {
  const columns = result.columns;
  return {
    columns,
    columnTypes: result.columnTypes,
    rows: result.rows.map((row) => columns.map((_, index) => row[index])),
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid,
  };
}

export function deserializeResultSet(result: SerializedResultSet): ResultSet {
  const rows = result.rows.map((values) => rowFromValues(result.columns, values));
  const resultSet: ResultSet = {
    columns: result.columns,
    columnTypes: result.columnTypes,
    rows,
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid,
    toJSON: () => ({
      columns: result.columns,
      columnTypes: result.columnTypes,
      rows: rows.map((row) => Array.from({ length: row.length }, (_, index) => row[index])),
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid == null ? null : String(result.lastInsertRowid),
    }),
  };
  return resultSet;
}

function rowFromValues(columns: string[], values: unknown[]): Row {
  const row: Record<string | number, unknown> = {};
  Object.defineProperty(row, "length", { value: values.length });
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    Object.defineProperty(row, index, { value });
    const column = columns[index];
    if (!Object.hasOwn(row, column)) {
      Object.defineProperty(row, column, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  return row as unknown as Row;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { message: error.message, code: typeof code === "string" ? code : undefined, name: error.name };
  }
  return { message: String(error) };
}

export function deserializeError(error: SerializedError): Error {
  const restored = new Error(error.message);
  if (error.name) restored.name = error.name;
  if (error.code) (restored as { code?: string }).code = error.code;
  return restored;
}

// ---------------------------------------------------------------------------
// The Db-shaped face of a coalescer.

export interface CoalescedDbOptions {
  /** Reopens the executor's underlying connection (wedge/batch recovery). */
  reconnect?: ReconnectHook;
  close?: () => void;
}

/**
 * A Client whose execute()/batch() go through the coalescer. Transaction
 * control statements are refused rather than merged: a stray BEGIN or
 * ROLLBACK inside a merged flush would break every neighbour's write, and the
 * one caller that issues one (the wedge-recovery forensics probe in db.ts)
 * treats a throw as "no open transaction".
 */
export function createCoalescedDb(coalescer: WriteCoalescer, options: CoalescedDbOptions = {}): Db {
  let closed = false;
  const submit = (statements: WriteStatement[], mode: TransactionMode): Promise<ResultSet[]> => {
    if (closed) return Promise.reject(new Error("write connection is closed"));
    for (const statement of statements) {
      if (TRANSACTION_CONTROL.test(statement.sql)) {
        return Promise.reject(new Error(`transaction control is not supported on a coalesced write connection: ${statement.sql.trim().slice(0, 40)}`));
      }
    }
    return coalescer.submit({ statements, mode });
  };
  const client = {
    execute(stmt: InStatement | string, args?: InArgs): Promise<ResultSet> {
      return submit([normalizeStatement(stmt, args)], "write").then((results) => results[0]);
    },
    batch(stmts: Array<InStatement | [string, InArgs?]>, mode: TransactionMode = "deferred"): Promise<ResultSet[]> {
      return submit(stmts.map((stmt) => Array.isArray(stmt) ? normalizeStatement(stmt[0], stmt[1]) : normalizeStatement(stmt)), mode);
    },
    migrate(): Promise<ResultSet[]> {
      return Promise.reject(new Error("migrate() is not supported on a coalesced write connection"));
    },
    transaction(): Promise<never> {
      return Promise.reject(new Error("transaction() is not supported on a coalesced write connection"));
    },
    executeMultiple(): Promise<void> {
      return Promise.reject(new Error("executeMultiple() is not supported on a coalesced write connection"));
    },
    sync(): Promise<never> {
      return Promise.reject(new Error("sync() is not supported on a coalesced write connection"));
    },
    reconnect(): void {
      void options.reconnect?.("wedge");
    },
    close(): void {
      closed = true;
      options.close?.();
    },
    get closed(): boolean {
      return closed;
    },
    protocol: "file" as const,
    [WRITE_GATE]: coalescer.state,
    [RECONNECT]: options.reconnect,
  };
  return client as unknown as Db;
}

function normalizeStatement(stmt: InStatement | string, args?: InArgs): WriteStatement {
  if (typeof stmt === "string") return { sql: stmt, args: args ?? [] };
  return { sql: stmt.sql, args: stmt.args ?? [] };
}
