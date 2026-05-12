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
