CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  cache_value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
ON cache_entries (expires_at);

CREATE TABLE IF NOT EXISTS cache_locks (
  lock_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

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
