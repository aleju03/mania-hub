CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  cache_value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
ON cache_entries (expires_at);
