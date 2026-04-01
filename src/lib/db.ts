import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

export const db = url && authToken
  ? createClient({
      url,
      authToken,
    })
  : null;

let cacheSchemaReady: Promise<void> | null = null;

export function hasDb(): boolean {
  return db !== null;
}

export async function ensureCacheSchema(): Promise<void> {
  if (!db) return;
  if (cacheSchemaReady) return cacheSchemaReady;

  cacheSchemaReady = (async () => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        cache_key TEXT PRIMARY KEY,
        cache_value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
      ON cache_entries (expires_at)
    `);
  })();

  return cacheSchemaReady;
}
