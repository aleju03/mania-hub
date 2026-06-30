import { createClient, type Client, type InValue, type ResultSet, type TransactionMode } from "@libsql/client";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "./config.js";

export type Db = Client;

type PragmaConfig = Partial<Pick<Config, "sqliteBusyTimeoutMs" | "sqliteSynchronous" | "sqliteCacheMb" | "sqliteMmapMb">>;

const SQLITE_BUSY_RETRY_MS = readBoundedEnvInt("SQLITE_BUSY_RETRY_MS", 30_000, 0, 120_000);
const SQLITE_BUSY_RETRY_INITIAL_DELAY_MS = 25;
const SQLITE_BUSY_RETRY_MAX_DELAY_MS = 500;

export interface SqliteBusyRetryStats {
  retryBudgetMs: number;
  operations: number;
  attempts: number;
  exhausted: number;
  totalWaitMs: number;
  lastAt: string | null;
  lastMessage: string | null;
}

const sqliteBusyRetryStats: SqliteBusyRetryStats = {
  retryBudgetMs: SQLITE_BUSY_RETRY_MS,
  operations: 0,
  attempts: 0,
  exhausted: 0,
  totalWaitMs: 0,
  lastAt: null,
  lastMessage: null,
};

export async function createDb(config: Pick<Config, "databaseUrl" | "databaseAuthToken"> & PragmaConfig): Promise<Db> {
  const isFile = config.databaseUrl.startsWith("file:");
  if (isFile) {
    const filePath = config.databaseUrl.slice("file:".length);
    await mkdir(dirname(resolve(filePath)), { recursive: true });
  }
  const client = createClient({
    url: config.databaseUrl,
    authToken: config.databaseAuthToken,
  });
  // Local libsql runs every query synchronously on the calling thread, and each
  // process opens its own connection, so connection-level pragmas must be set
  // here. Skipped for remote (Turso) URLs, which manage these server-side.
  if (isFile) await applyConnectionPragmas(client, config);
  return client;
}

async function applyConnectionPragmas(db: Db, config: PragmaConfig): Promise<void> {
  // busy_timeout makes a connection wait for a lock instead of failing with
  // SQLITE_BUSY immediately. This is mandatory once a second process/connection
  // (a split worker) writes to the same WAL file concurrently.
  const busyTimeoutMs = config.sqliteBusyTimeoutMs ?? 5_000;
  // NORMAL fsyncs only at checkpoints (not every commit) and is durable/safe
  // under WAL: a crash can lose the last few committed transactions but never
  // corrupts the database. A big win for the write-heavy ingest/job path.
  const synchronous = (config.sqliteSynchronous ?? "NORMAL").toUpperCase();
  const cacheMb = config.sqliteCacheMb ?? 64;
  const mmapBytes = (config.sqliteMmapMb ?? 256) * 1024 * 1024;
  const pragmas = [
    `pragma busy_timeout = ${busyTimeoutMs}`,
    `pragma synchronous = ${/^(OFF|NORMAL|FULL|EXTRA)$/.test(synchronous) ? synchronous : "NORMAL"}`,
    `pragma wal_autocheckpoint = 1000`,
  ];
  // Negative cache_size is in KiB of memory (positive is in pages).
  if (cacheMb > 0) pragmas.push(`pragma cache_size = ${-cacheMb * 1024}`);
  if (mmapBytes > 0) pragmas.push(`pragma mmap_size = ${mmapBytes}`);
  for (const pragma of pragmas) {
    await withSqliteBusyRetry(() => db.execute(pragma)).catch((error) => {
      console.warn(`[db] failed to apply ${pragma}:`, error instanceof Error ? error.message : error);
    });
  }
}

export async function migrate(db: Db): Promise<void> {
  const sql = await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8");
  for (const statement of splitSql(sql)) {
    await db.execute(statement);
  }
  await migrateCountryRegistryFeatureTier(db);
  await migrateCountryRegistryKeepWarm(db);
  await migrateScoreEventsIdentity(db);
  await migrateProfileSnapshots(db);
  await migrateMapsFarmedOverlay(db);
  await migrateApiCallTargets(db);
  await migrateApiRateLimitReservations(db);
  await migratePlayerActivity(db);
  await migratePackCollectionCards(db);
  await migrateTrackerIndexes(db);
  await migrateSnipePersonalBests(db);
  await migrateUserGoals(db);
}

export async function dbHealth(db: Db): Promise<boolean> {
  try {
    await db.execute("select 1");
    return true;
  } catch {
    return false;
  }
}

export function splitSql(sql: string): string[] {
  // Strip whole-line `--` comments from inside each statement, not just chunks that begin with
  // one: a comment block sitting directly above a `create table` (no `;` between) would otherwise
  // make the chunk start with `--` and drop the table entirely, leaving its index to fail.
  return sql
    .split(";")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

export interface DbStatement {
  sql: string;
  args?: InValue[];
}

const EXEC_BATCH_MAX_STATEMENTS = 500;

export async function exec(db: Db, sql: string, args: InValue[] = []) {
  return withSqliteBusyRetry(() => db.execute({ sql, args }));
}

export async function execBatch(db: Db, statements: DbStatement[], mode: TransactionMode = "write") {
  if (statements.length === 0) return [];
  const results: ResultSet[] = [];
  for (let index = 0; index < statements.length; index += EXEC_BATCH_MAX_STATEMENTS) {
    const chunk = statements.slice(index, index + EXEC_BATCH_MAX_STATEMENTS);
    results.push(...await withSqliteBusyRetry(() => db.batch(chunk.map(({ sql, args = [] }) => ({ sql, args })), mode)));
  }
  return results;
}

export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_(BUSY|LOCKED)|database is locked|database table is locked/i.test(message);
}

export function getSqliteBusyRetryStats(): SqliteBusyRetryStats {
  return { ...sqliteBusyRetryStats };
}

async function withSqliteBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  if (SQLITE_BUSY_RETRY_MS <= 0) {
    try {
      return await operation();
    } catch (error) {
      if (isSqliteBusyError(error)) recordSqliteBusyRetry(error, 0, true);
      throw error;
    }
  }
  const startedAt = Date.now();
  let delayMs = SQLITE_BUSY_RETRY_INITIAL_DELAY_MS;
  let operationAttempts = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      const elapsedMs = Date.now() - startedAt;
      operationAttempts += 1;
      if (elapsedMs >= SQLITE_BUSY_RETRY_MS) {
        recordSqliteBusyRetry(error, 0, true, operationAttempts);
        throw error;
      }
      const waitMs = Math.min(delayMs, SQLITE_BUSY_RETRY_MS - elapsedMs);
      recordSqliteBusyRetry(error, waitMs, false, operationAttempts);
      await sleep(waitMs);
      delayMs = Math.min(SQLITE_BUSY_RETRY_MAX_DELAY_MS, Math.ceil(delayMs * 1.6));
    }
  }
}

function recordSqliteBusyRetry(error: unknown, waitMs: number, exhausted: boolean, operationAttempts = 1): void {
  if (operationAttempts === 1) sqliteBusyRetryStats.operations += 1;
  sqliteBusyRetryStats.attempts += 1;
  if (exhausted) sqliteBusyRetryStats.exhausted += 1;
  sqliteBusyRetryStats.totalWaitMs += Math.max(0, Math.ceil(waitMs));
  sqliteBusyRetryStats.lastAt = new Date().toISOString();
  sqliteBusyRetryStats.lastMessage = error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.ceil(ms))));
}

function readBoundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export async function logApiCall(db: Db, entry: { provider: string; caller: string; path: string; startedAt: string }): Promise<void> {
  await exec(
    db,
    `insert or ignore into api_call_targets (provider, caller, path)
     values (?, ?, ?)`,
    [entry.provider, entry.caller, entry.path],
  );
  const row = (await exec(
    db,
    "select id from api_call_targets where provider = ? and caller = ? and path = ?",
    [entry.provider, entry.caller, entry.path],
  )).rows[0];
  await exec(
    db,
    "insert into api_call_log (provider, caller, path, target_id, started_at) values (?, '', '', ?, ?)",
    [entry.provider, Number(row.id), entry.startedAt],
  );
}

export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function migrateCountryRegistryFeatureTier(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(country_registry)")).rows.map((row) => String(row.name));
  if (columns.includes("feature_tier")) return;

  await db.execute("alter table country_registry add column feature_tier text not null default 'live'");
}

async function migrateCountryRegistryKeepWarm(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(country_registry)")).rows.map((row) => String(row.name));
  if (columns.includes("keep_warm")) return;

  await db.execute("alter table country_registry add column keep_warm integer not null default 0");
}

async function migrateScoreEventsIdentity(db: Db): Promise<void> {
  const columns = (await db.execute("pragma table_info(score_events)")).rows.map((row) => String(row.name));
  if (columns.includes("score_identity")) return;

  await db.execute("alter table score_events rename to score_events_old");
  await db.execute(`
    create table score_events (
      id integer primary key autoincrement,
      score_id integer not null,
      score_identity text not null,
      legacy_score_id integer,
      user_id integer not null,
      country text,
      beatmap_id integer not null,
      ruleset_id integer not null,
      score_json text not null,
      pp real,
      total_score integer,
      accuracy real,
      rank text,
      passed integer not null,
      processed integer not null default 0,
      is_lazer integer not null,
      has_replay integer not null,
      ended_at text not null,
      received_at text not null,
      source text not null,
      unique(country, score_identity)
    )
  `);
  await db.execute(`
    insert or ignore into score_events (
      score_id, score_identity, legacy_score_id, user_id, country, beatmap_id, ruleset_id, score_json,
      pp, total_score, accuracy, rank, passed, processed, is_lazer, has_replay, ended_at, received_at, source
    )
    select
      score_id,
      'official:' || coalesce(legacy_score_id, score_id),
      legacy_score_id,
      user_id,
      country,
      beatmap_id,
      ruleset_id,
      score_json,
      pp,
      total_score,
      accuracy,
      rank,
      passed,
      processed,
      is_lazer,
      has_replay,
      ended_at,
      received_at,
      source
    from score_events_old
  `);
  await db.execute("drop table score_events_old");
}

async function migrateProfileSnapshots(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists profile_snapshots (
      user_id integer primary key,
      username_key text not null unique,
      user_json text not null,
      best_scores_json text not null,
      best_scores_limit integer not null,
      fetched_at text not null,
      user_fetched_at text not null,
      updated_at text not null,
      refresh_error text
    )
  `);
  const snapshotColumns = (await db.execute("pragma table_info(profile_snapshots)")).rows.map((row) => String(row.name));
  if (!snapshotColumns.includes("user_fetched_at")) {
    await db.execute("alter table profile_snapshots add column user_fetched_at text");
    await db.execute("update profile_snapshots set user_fetched_at = fetched_at where user_fetched_at is null");
  }
  await db.execute(`
    create index if not exists idx_profile_snapshots_username_key
      on profile_snapshots(username_key)
  `);
  await db.execute(`
    create table if not exists profile_section_cache (
      cache_key text primary key,
      user_id integer not null,
      section text not null,
      payload_json text not null,
      fetched_at text not null,
      updated_at text not null
    )
  `);
  await db.execute(`
    create index if not exists idx_profile_section_cache_user_section
      on profile_section_cache(user_id, section)
  `);
}

async function migrateMapsFarmedOverlay(db: Db): Promise<void> {
  const userColumns = (await db.execute("pragma table_info(users)")).rows.map((row) => String(row.name));
  if (!userColumns.includes("maps_farmed_min_pp")) {
    await db.execute("alter table users add column maps_farmed_min_pp real");
  }
  if (!userColumns.includes("maps_farmed_scores_refreshed_at")) {
    await db.execute("alter table users add column maps_farmed_scores_refreshed_at text");
  }

  await db.execute(`
    create table if not exists maps_beatmapsets (
      beatmapset_id integer primary key,
      title text not null,
      artist text not null,
      creator text,
      status text,
      covers_json text,
      global_play_count integer,
      global_favourite_count integer,
      preview_url text,
      bpm real,
      mania_keys_json text,
      patterns_json text,
      updated_at text not null
    )
  `);
  await db.execute(`
    create table if not exists maps_beatmaps (
      beatmap_id integer primary key,
      beatmapset_id integer not null,
      mode text not null,
      status text,
      cs real,
      difficulty_rating real,
      bpm real,
      total_length integer,
      version text not null,
      url text,
      updated_at text not null
    )
  `);
  await db.execute(`
    create index if not exists idx_maps_beatmaps_beatmapset
      on maps_beatmaps(beatmapset_id)
  `);

  await db.execute(`
    create table if not exists country_maps_farmed_scores (
      country text not null,
      user_id integer not null,
      beatmap_id integer not null,
      score_id integer not null,
      pp real not null,
      score_json text not null,
      mods_json text,
      score_url text,
      played_at text,
      detected_at text not null,
      updated_at text not null,
      primary key (country, user_id, beatmap_id)
    )
  `);
  const farmedColumns = (await db.execute("pragma table_info(country_maps_farmed_scores)")).rows.map((row) => String(row.name));
  if (!farmedColumns.includes("mods_json")) {
    await db.execute("alter table country_maps_farmed_scores add column mods_json text");
  }
  if (!farmedColumns.includes("score_url")) {
    await db.execute("alter table country_maps_farmed_scores add column score_url text");
  }
  if (!farmedColumns.includes("played_at")) {
    await db.execute("alter table country_maps_farmed_scores add column played_at text");
  }
  await db.execute(`
    create index if not exists idx_country_maps_farmed_scores_country_updated
      on country_maps_farmed_scores(country, updated_at desc)
  `);
  await db.execute(`
    create index if not exists idx_country_maps_farmed_scores_country_beatmap
      on country_maps_farmed_scores(country, beatmap_id)
  `);

  await db.execute(`
    create table if not exists country_maps_most_played (
      country text not null,
      user_id integer not null,
      beatmap_id integer not null,
      play_count integer not null,
      updated_at text not null,
      primary key (country, user_id, beatmap_id)
    )
  `);
  await db.execute(`
    create table if not exists country_maps_favourite_sets (
      country text not null,
      user_id integer not null,
      beatmapset_id integer not null,
      updated_at text not null,
      primary key (country, user_id, beatmapset_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_country_maps_most_played_country_beatmap
      on country_maps_most_played(country, beatmap_id)
  `);
  await db.execute(`
    create index if not exists idx_country_maps_favourite_sets_country_set
      on country_maps_favourite_sets(country, beatmapset_id)
  `);
}

async function migrateApiCallTargets(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists api_call_targets (
      id integer primary key autoincrement,
      provider text not null,
      caller text not null,
      path text not null,
      unique(provider, caller, path)
    )
  `);
  const columns = (await db.execute("pragma table_info(api_call_log)")).rows.map((row) => String(row.name));
  if (!columns.includes("target_id")) {
    await db.execute("alter table api_call_log add column target_id integer");
  }
  await db.execute(`
    create index if not exists idx_api_call_log_target_time
      on api_call_log(target_id, started_at desc)
  `);
}

async function migrateApiRateLimitReservations(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists api_rate_limit_reservations (
      id integer primary key autoincrement,
      provider text not null,
      started_at_ms integer not null,
      caller text not null,
      path text not null,
      lane text not null,
      created_at_ms integer not null
    )
  `);
  await db.execute(`
    create index if not exists idx_api_rate_limit_reservations_provider_time
      on api_rate_limit_reservations(provider, started_at_ms)
  `);
}

async function migratePlayerActivity(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists beatmap_skill_vectors (
      beatmap_id integer not null,
      analysis_version integer not null,
      status text not null,
      stream_score real not null default 0,
      jack_score real not null default 0,
      bracket_score real not null default 0,
      ln_score real not null default 0,
      ln_general_score real not null default 0,
      ln_release_score real not null default 0,
      ln_inverse_score real not null default 0,
      ln_tech_score real not null default 0,
      skills_json text,
      error text,
      computed_at text,
      updated_at text not null,
      primary key (beatmap_id, analysis_version)
    )
  `);
  const vectorColumns = (await db.execute("pragma table_info(beatmap_skill_vectors)")).rows.map((row) => String(row.name));
  if (!vectorColumns.includes("bracket_score")) {
    await db.execute("alter table beatmap_skill_vectors add column bracket_score real not null default 0");
  }
  if (!vectorColumns.includes("ln_general_score")) {
    await db.execute("alter table beatmap_skill_vectors add column ln_general_score real not null default 0");
  }
  if (!vectorColumns.includes("ln_release_score")) {
    await db.execute("alter table beatmap_skill_vectors add column ln_release_score real not null default 0");
  }
  if (!vectorColumns.includes("ln_inverse_score")) {
    await db.execute("alter table beatmap_skill_vectors add column ln_inverse_score real not null default 0");
  }
  if (!vectorColumns.includes("ln_tech_score")) {
    await db.execute("alter table beatmap_skill_vectors add column ln_tech_score real not null default 0");
  }
  if (!vectorColumns.includes("skills_json")) {
    await db.execute("alter table beatmap_skill_vectors add column skills_json text");
  }
  await db.execute(`
    create table if not exists player_activity_score_refs (
      country text not null,
      score_identity text not null,
      user_id integer not null,
      day text not null,
      beatmap_id integer not null,
      passed integer not null,
      ended_at text not null,
      created_at text not null,
      primary key (country, score_identity)
    )
  `);
  const refColumns = (await db.execute("pragma table_info(player_activity_score_refs)")).rows.map((row) => String(row.name));
  if (!refColumns.includes("passed")) {
    await db.execute("alter table player_activity_score_refs add column passed integer not null default 1");
  }
  await db.execute(`
    create table if not exists player_activity_days (
      country text not null,
      user_id integer not null,
      day text not null,
      score_count integer not null default 0,
      passed_count integer not null default 0,
      session_count integer not null default 0,
      first_score_at text,
      last_score_at text,
      updated_at text not null,
      primary key (country, user_id, day)
    )
  `);
  await db.execute(`
    create table if not exists player_activity_maps (
      country text not null,
      user_id integer not null,
      day text not null,
      beatmap_id integer not null,
      play_count integer not null default 0,
      best_score_id integer,
      best_pp real,
      best_accuracy real,
      best_rank text,
      first_played_at text,
      last_played_at text,
      updated_at text not null,
      primary key (country, user_id, day, beatmap_id)
    )
  `);
  await db.execute(`
    create table if not exists player_activity_backfill_cursors (
      country text not null,
      user_id integer not null,
      last_event_id integer not null default 0,
      updated_at text not null,
      primary key (country, user_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_beatmap_skill_vectors_status_updated
      on beatmap_skill_vectors(status, updated_at desc)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_refs_user_day
      on player_activity_score_refs(country, user_id, day, ended_at)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_refs_user_time
      on player_activity_score_refs(user_id, ended_at desc)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_refs_day
      on player_activity_score_refs(day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_user_day
      on player_activity_days(country, user_id, day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_user_day_all
      on player_activity_days(user_id, day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_user_year
      on player_activity_days(country, user_id, substr(day, 1, 4))
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_day
      on player_activity_days(day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_user_day
      on player_activity_maps(country, user_id, day, play_count desc)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_user_beatmap
      on player_activity_maps(user_id, beatmap_id)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_beatmap
      on player_activity_maps(beatmap_id)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_day
      on player_activity_maps(day)
  `);
}

async function migratePackCollectionCards(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists pack_collection_cards (
      owner_user_id integer not null,
      card_user_id integer not null,
      username text not null,
      avatar_url text not null,
      country_code text not null,
      tier text,
      tier_label text,
      skills_json text,
      pp real not null,
      global_rank integer not null,
      copies integer not null,
      recycled_copies integer not null,
      first_pulled_at integer not null,
      last_pulled_at integer not null,
      updated_at integer not null,
      primary key(owner_user_id, card_user_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_pack_collection_owner_rank
      on pack_collection_cards(owner_user_id, copies, global_rank)
  `);
  await db.execute(`
    create index if not exists idx_pack_collection_owner_tier
      on pack_collection_cards(owner_user_id, tier, copies, pp desc)
  `);
  await db.execute(`
    create index if not exists idx_pack_collection_owner_username
      on pack_collection_cards(owner_user_id, username)
  `);
}

async function migrateTrackerIndexes(db: Db): Promise<void> {
  await db.execute(`
    create index if not exists idx_score_events_user_time
      on score_events(user_id, ended_at desc)
  `);
  await db.execute(`
    create index if not exists idx_top_play_events_score
      on top_play_events(score_id)
  `);
  await db.execute(`
    create index if not exists idx_top_play_events_time
      on top_play_events(detected_at desc)
  `);
  await db.execute(`
    create index if not exists idx_top_play_events_user_pp
      on top_play_events(user_id, pp desc)
  `);
}

async function migrateSnipePersonalBests(db: Db): Promise<void> {
  await db.execute(`
    create table if not exists country_beatmap_score_pbs (
      country text not null,
      beatmap_id integer not null,
      lane_key text not null,
      user_id integer not null,
      score_identity text not null,
      score_id integer not null,
      total_score integer not null,
      pp real,
      accuracy real,
      rank text,
      mods_json text not null,
      is_lazer integer not null,
      has_replay integer not null,
      ended_at text not null,
      updated_at text not null,
      primary key (country, beatmap_id, lane_key, user_id, score_identity)
    )
  `);
  await db.execute(`
    create index if not exists idx_country_beatmap_score_pbs_lookup
      on country_beatmap_score_pbs(country, beatmap_id, lane_key, user_id, ended_at desc, total_score desc)
  `);
  await db.execute(`
    create table if not exists country_beatmap_score_pb_state (
      country text not null,
      beatmap_id integer not null,
      lane_key text not null,
      user_id integer not null,
      verified_at text not null,
      primary key (country, beatmap_id, lane_key, user_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_country_beatmap_score_pb_state_lookup
      on country_beatmap_score_pb_state(country, beatmap_id, lane_key, user_id)
  `);
}

async function migrateUserGoals(db: Db): Promise<void> {
  // Per-player goals that auto-complete from the ingest pipeline. Timestamps are epoch ms
  // (matching the pack tables); status is 'open' | 'completed'. beatmap_id scopes map goals,
  // target_value carries pp / accuracy fraction, target_count carries count goals, target_grade
  // carries S/SS-style targets or the rank scope, speed_bucket carries normal/ht/dt for map goals.
  await db.execute(`
    create table if not exists user_goals (
      id text primary key,
      user_id integer not null,
      country text,
      kind text not null,
      beatmap_id integer,
      beatmapset_id integer,
      beatmap_label text,
      target_value real,
      target_count integer,
      target_grade text,
      speed_bucket text,
      note text,
      status text not null default 'open',
      created_at integer not null,
      completed_at integer,
      completed_value real,
      completed_score_id text,
      completed_beatmap_id integer,
      updated_at integer not null
    )
  `);
  const goalColumns = (await db.execute("pragma table_info(user_goals)")).rows.map((row) => String(row.name));
  if (!goalColumns.includes("beatmapset_id")) {
    await db.execute("alter table user_goals add column beatmapset_id integer");
  }
  if (!goalColumns.includes("target_count")) {
    await db.execute("alter table user_goals add column target_count integer");
  }
  if (!goalColumns.includes("speed_bucket")) {
    await db.execute("alter table user_goals add column speed_bucket text");
  }
  if (!goalColumns.includes("start_value")) {
    // Baseline captured when a numeric-target goal is set, so its progress bar measures the climb
    // from there (a "reach 15.5k" goal made at 15.1k starts near 0, not 97%). Backfill existing
    // open pp goals from the player's current totals; map-accuracy baselines fill in on recreate.
    await db.execute("alter table user_goals add column start_value real");
    await db.execute(
      "update user_goals set start_value = (select pp from users where users.user_id = user_goals.user_id) where status = 'open' and kind = 'reach_pp' and start_value is null",
    );
    await db.execute(
      "update user_goals set start_value = (select max(pp) from user_top_scores where user_top_scores.user_id = user_goals.user_id) where status = 'open' and kind = 'play_pp' and start_value is null",
    );
  }
  await db.execute(`
    create index if not exists idx_user_goals_user_status
      on user_goals(user_id, status)
  `);
  await db.execute(`
    create index if not exists idx_user_goals_user_beatmap
      on user_goals(user_id, status, beatmap_id)
  `);
}
