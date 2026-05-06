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
        cache_prefix TEXT NOT NULL DEFAULT '',
        cache_value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    try {
      await db.execute("ALTER TABLE cache_entries ADD COLUMN cache_prefix TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column|already exists/i.test(message)) throw error;
    }

    await db.execute(`
      UPDATE cache_entries
      SET cache_prefix = CASE
        WHEN instr(cache_key, ':') > 0 THEN substr(cache_key, 1, instr(cache_key, ':') - 1)
        ELSE cache_key
      END
      WHERE cache_prefix = ''
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
      ON cache_entries (expires_at)
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_cache_entries_prefix_expires
      ON cache_entries (cache_prefix, expires_at)
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
      CREATE INDEX IF NOT EXISTS idx_cache_locks_expires_at
      ON cache_locks (expires_at)
    `);

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
      CREATE INDEX IF NOT EXISTS idx_country_top_plays_country_pp_time
      ON country_top_plays (country, pp DESC, score_time DESC)
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

    await db.execute(`
      CREATE TABLE IF NOT EXISTS replay_cache (
        score_id INTEGER PRIMARY KEY,
        storage_key TEXT NOT NULL,
        endpoint_kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_replay_cache_accessed
      ON replay_cache (last_accessed_at)
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS beatmap_asset_cache_stats (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        total_size_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);

    await db.execute({
      sql: `
        INSERT INTO beatmap_asset_cache_stats (id, total_size_bytes, updated_at)
        VALUES (
          1,
          (
            (SELECT COALESCE(SUM(size_bytes), 0) FROM beatmap_asset_cache)
            + (SELECT COALESCE(SUM(size_bytes), 0) FROM replay_cache)
          ),
          ?
        )
        ON CONFLICT(id) DO NOTHING
      `,
      args: [Date.now()],
    });
  })().catch((error) => {
    cacheSchemaReady = null;
    throw error;
  });

  return cacheSchemaReady;
}
