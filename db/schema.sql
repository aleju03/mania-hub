CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  cache_prefix TEXT NOT NULL DEFAULT '',
  cache_value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
ON cache_entries (expires_at);

CREATE INDEX IF NOT EXISTS idx_cache_entries_prefix_expires
ON cache_entries (cache_prefix, expires_at);

CREATE TABLE IF NOT EXISTS cache_locks (
  lock_key TEXT PRIMARY KEY,
  lock_owner TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_locks_expires_at
ON cache_locks (expires_at);

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
);

CREATE INDEX IF NOT EXISTS idx_country_top_plays_country_time
ON country_top_plays (country, score_time DESC);

CREATE INDEX IF NOT EXISTS idx_country_top_plays_country_pp
ON country_top_plays (country, pp DESC);

CREATE INDEX IF NOT EXISTS idx_country_top_plays_country_pp_time
ON country_top_plays (country, pp DESC, score_time DESC);

CREATE TABLE IF NOT EXISTS beatmap_asset_cache (
  storage_key TEXT PRIMARY KEY,
  beatmapset_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_beatmap_asset_cache_accessed
ON beatmap_asset_cache (last_accessed_at);

CREATE INDEX IF NOT EXISTS idx_beatmap_asset_cache_set_kind
ON beatmap_asset_cache (beatmapset_id, kind);

CREATE TABLE IF NOT EXISTS beatmap_asset_cache_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_size_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
