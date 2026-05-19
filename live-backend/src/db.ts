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
  await migrateScoreEventsIdentity(db);
  await migrateProfileSnapshots(db);
  await migrateMapsFarmedOverlay(db);
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
    create table if not exists country_maps_farmed_scores (
      country text not null,
      user_id integer not null,
      beatmap_id integer not null,
      score_id integer not null,
      pp real not null,
      score_json text not null,
      detected_at text not null,
      updated_at text not null,
      primary key (country, user_id, beatmap_id)
    )
  `);
  await db.execute(`
    create index if not exists idx_country_maps_farmed_scores_country_updated
      on country_maps_farmed_scores(country, updated_at desc)
  `);
  await db.execute(`
    create index if not exists idx_country_maps_farmed_scores_country_beatmap
      on country_maps_farmed_scores(country, beatmap_id)
  `);
}
