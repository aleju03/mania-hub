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

    await db.execute(`
      CREATE TABLE IF NOT EXISTS cache_locks (
        lock_key TEXT PRIMARY KEY,
        lock_owner TEXT,
        expires_at INTEGER NOT NULL
      )
    `);

    try {
      await db.execute("ALTER TABLE cache_locks ADD COLUMN lock_owner TEXT");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column|already exists/i.test(message)) throw error;
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS country_top_plays (
        country TEXT NOT NULL,
        score_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        avatar_url TEXT NOT NULL,
        score_json TEXT NOT NULL,
        pp REAL NOT NULL,
        weighted_pp REAL NOT NULL,
        pp_gain REAL NOT NULL,
        score_time INTEGER NOT NULL,
        discovered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (country, score_id)
      )
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_country_top_plays_country_time
      ON country_top_plays (country, score_time DESC)
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_country_top_plays_country_pp
      ON country_top_plays (country, pp DESC)
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS beatmap_asset_cache (
        storage_key TEXT PRIMARY KEY,
        beatmapset_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_beatmap_asset_cache_accessed
      ON beatmap_asset_cache (last_accessed_at)
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_beatmap_asset_cache_set_kind
      ON beatmap_asset_cache (beatmapset_id, kind)
    `);
  })().catch((error) => {
    cacheSchemaReady = null;
    throw error;
  });

  return cacheSchemaReady;
}
