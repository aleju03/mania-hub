import { createClient, type Client, type InValue } from "@libsql/client";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "./config.js";

export type Db = Client;

export async function createDb(config: Pick<Config, "databaseUrl" | "databaseAuthToken">): Promise<Db> {
  if (config.databaseUrl.startsWith("file:")) {
    const filePath = config.databaseUrl.slice("file:".length);
    await mkdir(dirname(resolve(filePath)), { recursive: true });
  }
  return createClient({
    url: config.databaseUrl,
    authToken: config.databaseAuthToken,
  });
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
  await migratePlayerActivity(db);
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
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement && !statement.startsWith("--"));
}

export async function exec(db: Db, sql: string, args: InValue[] = []) {
  return db.execute({ sql, args });
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
    create index if not exists idx_player_activity_refs_day
      on player_activity_score_refs(day)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_days_user_day
      on player_activity_days(country, user_id, day)
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
    create index if not exists idx_player_activity_maps_beatmap
      on player_activity_maps(beatmap_id)
  `);
  await db.execute(`
    create index if not exists idx_player_activity_maps_day
      on player_activity_maps(day)
  `);
}
