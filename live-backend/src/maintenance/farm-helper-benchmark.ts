import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { readConfig } from "../config.js";
import { createDb, exec, type Db } from "../db.js";
import {
  clearFarmHelperCache,
  getFarmHelperSnapshot,
  type FarmHelperKeyMode,
  type FarmHelperView,
} from "../features/farm-helper.js";
import { FarmHelperTimings } from "../features/farm-helper-timing.js";
import { OsuApiClient } from "../osu/client.js";

// Read-only load benchmark for the Farm Helper serving path.
//
// Measures where the time goes for a STORED subject (the primary target: the
// player exists in profile_snapshots, so no osu! call is needed) across three
// states the plan cares about:
//
//   cold      the first build in a fresh process - every process-level pool
//             (peer pools, calibration, baseline vectors) starts empty
//   uncached  the subject's snapshot cache entry is dropped, pools stay warm
//   repeat    the immediately following identical request (cache hit)
//
// Run before AND after each optimization stage and diff the tables.
//
// Usage:
//   npm run bench:farm-helper
//   npm run bench:farm-helper -- --label after --out ./bench-out
//   npm run bench:farm-helper -- --users 12345,67890 --key 4k --view popular
//   npm run bench:farm-helper -- --repeats 3
//   npm run bench:farm-helper -- --cold-mint SomeUnseenPlayer   (osu! I/O, opt-in)
//
// READ-ONLY BY DEFAULT. Every non-SELECT statement is intercepted and dropped
// before it reaches SQLite, and the count is reported as `writes` - which
// doubles as the plan's evidence that no optional write sits on the serving
// path. `--allow-writes` lets them through when you specifically want to
// measure write contention.
//
// The osu! API is never called unless --cold-mint is passed: stored subjects
// get a client stub that throws, so an accidental external fetch fails loudly
// instead of quietly inflating a "local" number.

interface Args {
  label: string;
  out: string | null;
  users: number[];
  keyMode: FarmHelperKeyMode;
  view: FarmHelperView;
  limit: number;
  repeats: number;
  allowWrites: boolean;
  coldMint: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const parsed = Number(get(flag));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const keyRaw = get("--key") ?? "any";
  const viewRaw = get("--view") ?? "gain";
  return {
    label: get("--label") ?? "baseline",
    out: get("--out") ?? null,
    users: (get("--users") ?? "")
      .split(",")
      .map((raw) => Number(raw.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
    keyMode: keyRaw === "4k" || keyRaw === "7k" ? keyRaw : "any",
    view: viewRaw === "popular" ? "popular" : "gain",
    limit: num("--limit", 200),
    repeats: Math.max(1, num("--repeats", 1)),
    allowWrites: argv.includes("--allow-writes"),
    coldMint: get("--cold-mint") ?? null,
    json: argv.includes("--json"),
  };
}

// ---------------------------------------------------------------------------
// Counting / read-only DB wrapper
// ---------------------------------------------------------------------------

interface DbStats {
  queries: number;
  rows: number;
  writes: number;
}

const READ_STATEMENT = /^\s*(?:select|pragma|with|explain)\b/i;

// A Proxy over the libsql client that counts statements and rows, and (unless
// --allow-writes) drops writes instead of executing them. Keeping this in the
// benchmark rather than in db.ts means the serving path carries no counter.
function instrumentDb(db: Db, stats: DbStats, allowWrites: boolean): Db {
  const emptyResult = () => ({
    columns: [],
    columnTypes: [],
    rows: [],
    rowsAffected: 0,
    lastInsertRowid: undefined,
    toJSON: () => ({}),
  });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (stmt: { sql: string; args?: unknown[] } | string) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          stats.queries += 1;
          if (!READ_STATEMENT.test(sql)) {
            stats.writes += 1;
            if (!allowWrites) return emptyResult();
          }
          const result = await (target.execute as (s: unknown) => Promise<{ rows: unknown[] }>)(stmt);
          stats.rows += result.rows.length;
          return result;
        };
      }
      if (prop === "batch") {
        return async (stmts: Array<{ sql: string }>, mode?: unknown) => {
          stats.queries += stmts.length;
          const writes = stmts.filter((s) => !READ_STATEMENT.test(s.sql)).length;
          stats.writes += writes;
          if (writes > 0 && !allowWrites) return stmts.map(() => emptyResult());
          return (target.batch as (s: unknown, m?: unknown) => Promise<unknown>)(stmts, mode);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

// ---------------------------------------------------------------------------
// Subject selection
// ---------------------------------------------------------------------------

interface Subject {
  userId: number;
  shape: string;
  username: string;
  pp: number;
}

// One representative stored player per shape the plan calls out. Each query is
// deterministic (fixed ordering) so before/after runs pick the same subjects.
async function selectSubjects(db: Db): Promise<Subject[]> {
  const stored = `join profile_snapshots p on p.user_id = u.user_id and length(p.best_scores_json) > 100`;
  const shapes: Array<{ shape: string; sql: string; args: number[] }> = [
    {
      shape: "4k_main_10k",
      sql: `select u.user_id, u.username, u.pp from users u ${stored}
            where u.is_active = 1 and u.pp_4k > 0 and u.pp_4k > coalesce(u.pp_7k, 0)
              and u.pp between 8000 and 12000
            order by abs(u.pp - 10000) asc, u.user_id asc limit 1`,
      args: [],
    },
    {
      shape: "7k_main",
      sql: `select u.user_id, u.username, u.pp from users u ${stored}
            where u.is_active = 1 and u.pp_7k > 0 and u.pp_7k > coalesce(u.pp_4k, 0) * 1.5
              and u.pp > 3000
            order by abs(u.pp - 10000) asc, u.user_id asc limit 1`,
      args: [],
    },
    {
      shape: "mixed_4k_7k",
      sql: `select u.user_id, u.username, u.pp from users u ${stored}
            where u.is_active = 1 and u.pp_4k > 0 and u.pp_7k > 0
              and u.pp_4k between u.pp_7k * 0.8 and u.pp_7k * 1.25
              and u.pp > 3000
            order by u.pp desc, u.user_id asc limit 1`,
      args: [],
    },
    {
      shape: "top_ranked_sparse",
      sql: `select u.user_id, u.username, u.pp from users u ${stored}
            where u.is_active = 1 and u.global_rank is not null and u.global_rank > 0
            order by u.global_rank asc, u.user_id asc limit 1`,
      args: [],
    },
    {
      shape: "no_skill_model",
      sql: `select u.user_id, u.username, u.pp from users u ${stored}
            where u.is_active = 1 and u.pp > 2000
              and not exists (
                select 1 from player_skill_ratings r
                where r.user_id = u.user_id and r.status = 'ready')
            order by u.pp desc, u.user_id asc limit 1`,
      args: [],
    },
    {
      shape: "active_feedback",
      sql: `select u.user_id, u.username, u.pp from users u ${stored}
            where exists (
              select 1 from farm_helper_feedback f
              where f.user_id = u.user_id and f.resolved_at is null)
            order by u.user_id asc limit 1`,
      args: [],
    },
  ];

  const subjects: Subject[] = [];
  const seen = new Set<number>();
  for (const { shape, sql, args } of shapes) {
    const row = (await exec(db, sql, args).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows[0];
    if (!row) continue;
    const userId = Number(row.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0 || seen.has(userId)) continue;
    seen.add(userId);
    subjects.push({ userId, shape, username: String(row.username ?? ""), pp: Number(row.pp ?? 0) });
  }
  return subjects;
}

async function describeUsers(db: Db, userIds: number[]): Promise<Subject[]> {
  const subjects: Subject[] = [];
  for (const userId of userIds) {
    const row = (await exec(db, "select username, pp from users where user_id = ? limit 1", [userId])).rows[0];
    subjects.push({ userId, shape: "requested", username: String(row?.username ?? ""), pp: Number(row?.pp ?? 0) });
  }
  return subjects;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface RunResult {
  ms: number;
  queries: number;
  rows: number;
  writes: number;
  recs: number;
  totalQualifying: number;
  jsonBytes: number;
  brotliBytes: number;
  gzipBytes: number;
  stages: Record<string, number | string>;
}

interface SubjectResult {
  subject: Subject;
  cold: RunResult | null;
  uncached: RunResult[];
  repeat: RunResult[];
  error?: string;
}

// The osu! client stub for stored subjects: reaching it means the subject was
// not actually stored, which would silently turn a local measurement into a
// network one.
const NO_OSU = new Proxy({}, {
  get(_target, prop) {
    return () => {
      throw new Error(`farm-helper benchmark: unexpected osu! API call (${String(prop)}) for a stored subject`);
    };
  },
}) as unknown as OsuApiClient;

async function runOnce(
  db: Db,
  osu: OsuApiClient,
  stats: DbStats,
  subject: Subject,
  args: Args,
): Promise<RunResult> {
  const before = { ...stats };
  const timings = new FarmHelperTimings();
  const startedAt = performance.now();
  const snapshot = await getFarmHelperSnapshot(
    db,
    osu,
    String(subject.userId),
    { keyMode: args.keyMode, view: args.view, limit: args.limit },
    undefined,
    { timings },
  );
  const ms = performance.now() - startedAt;
  const body = Buffer.from(JSON.stringify(snapshot), "utf8");
  return {
    ms,
    queries: stats.queries - before.queries,
    rows: stats.rows - before.rows,
    writes: stats.writes - before.writes,
    recs: snapshot.recs.length,
    totalQualifying: snapshot.totalQualifying,
    jsonBytes: body.byteLength,
    brotliBytes: brotliCompressSync(body, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    }).byteLength,
    gzipBytes: gzipSync(body, { level: 6 }).byteLength,
    stages: timings.toLogFields(),
  };
}

async function measureSubject(
  db: Db,
  osu: OsuApiClient,
  stats: DbStats,
  subject: Subject,
  args: Args,
  isFirst: boolean,
): Promise<SubjectResult> {
  const result: SubjectResult = { subject, cold: null, uncached: [], repeat: [] };
  try {
    // Cold = the very first build in this process: nothing is pooled yet.
    if (isFirst) {
      clearFarmHelperCache(db);
      result.cold = await runOnce(db, osu, stats, subject, args);
    }
    for (let i = 0; i < args.repeats; i++) {
      // Uncached subject, warm process pools: drop only the snapshot cache.
      clearFarmHelperCache(db);
      result.uncached.push(await runOnce(db, osu, stats, subject, args));
      // Immediate repeat of the identical request: the cache-hit path.
      result.repeat.push(await runOnce(db, osu, stats, subject, args));
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ms(value: number): string {
  return `${value.toFixed(0)}ms`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function printTable(results: SubjectResult[]): void {
  const header = [pad("subject", 22), padLeft("uncached", 10), padLeft("repeat", 8), padLeft("sql", 6), padLeft("rows", 9), padLeft("writes", 7), padLeft("recs", 6), padLeft("br", 8)].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const result of results) {
    if (result.error) {
      console.log(`${pad(result.subject.shape, 22)} ERROR ${result.error}`);
      continue;
    }
    const uncached = median(result.uncached.map((run) => run.ms));
    const repeat = median(result.repeat.map((run) => run.ms));
    const first = result.uncached[0];
    console.log([
      pad(result.subject.shape, 22),
      padLeft(ms(uncached), 10),
      padLeft(ms(repeat), 8),
      padLeft(String(first?.queries ?? 0), 6),
      padLeft(String(first?.rows ?? 0), 9),
      padLeft(String(first?.writes ?? 0), 7),
      padLeft(String(first?.recs ?? 0), 6),
      padLeft(`${Math.round((first?.brotliBytes ?? 0) / 1024)}KB`, 8),
    ].join(" "));
  }
}

function printStages(results: SubjectResult[]): void {
  console.log("\nstage breakdown (uncached, median run, ms):");
  const stageKeys = new Set<string>();
  for (const result of results) {
    for (const run of result.uncached) {
      for (const key of Object.keys(run.stages)) if (key.startsWith("ms_")) stageKeys.add(key);
    }
  }
  const ordered = [...stageKeys].sort();
  console.log([pad("subject", 22), ...ordered.map((key) => padLeft(key.replace("ms_fh_", ""), 11))].join(" "));
  for (const result of results) {
    if (result.uncached.length === 0) continue;
    console.log([
      pad(result.subject.shape, 22),
      ...ordered.map((key) => padLeft(String(median(result.uncached.map((run) => Number(run.stages[key] ?? 0)))), 11)),
    ].join(" "));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig();
  const rawDb = await createDb(config);
  const stats: DbStats = { queries: 0, rows: 0, writes: 0 };
  const db = instrumentDb(rawDb, stats, args.allowWrites);

  const subjects = args.users.length > 0 ? await describeUsers(db, args.users) : await selectSubjects(db);
  if (subjects.length === 0) {
    console.error("no benchmark subjects found (is this a synced production database?)");
    process.exitCode = 1;
    return;
  }

  console.log(`farm-helper benchmark [${args.label}] key=${args.keyMode} view=${args.view} limit=${args.limit} repeats=${args.repeats} writes=${args.allowWrites ? "allowed" : "suppressed"}`);
  console.log(`db=${config.databaseUrl}\n`);

  const results: SubjectResult[] = [];
  for (const [index, subject] of subjects.entries()) {
    const result = await measureSubject(db, NO_OSU, stats, subject, args, index === 0);
    results.push(result);
    if (index === 0 && result.cold) {
      console.log(`cold process (first build, empty pools): ${ms(result.cold.ms)} `
        + `sql=${result.cold.queries} rows=${result.cold.rows} recs=${result.cold.recs}\n`);
    }
  }

  printTable(results);
  printStages(results);

  // External I/O section: an unseen player must fetch the osu! user and their
  // best-200, so it is reported apart from the stored-player target and never
  // runs unless asked for.
  let coldMint: { key: string; ms: number; recs: number } | null = null;
  if (args.coldMint) {
    const osu = new OsuApiClient(config, fetch);
    const startedAt = performance.now();
    const snapshot = await getFarmHelperSnapshot(
      db,
      osu,
      args.coldMint,
      { keyMode: args.keyMode, view: args.view, limit: args.limit },
    );
    coldMint = { key: args.coldMint, ms: performance.now() - startedAt, recs: snapshot.recs.length };
    console.log(`\ncold mint (osu! I/O, ${args.coldMint}): ${ms(coldMint.ms)} recs=${coldMint.recs}`);
  }

  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    const path = `${args.out}/farm-helper-bench-${args.label}.json`;
    writeFileSync(path, JSON.stringify({ label: args.label, args, results, coldMint }, null, 2));
    console.log(`\nwrote ${path}`);
  }
  if (args.json) console.log(JSON.stringify({ label: args.label, results, coldMint }, null, 2));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
