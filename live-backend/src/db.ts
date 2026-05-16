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
