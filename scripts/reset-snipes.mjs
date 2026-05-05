#!/usr/bin/env node
// One-shot cache cleaner for the snipes system. Deletes server-side Turso
// entries so the next scan starts clean. In-memory cache on the dev server
// is separate — restart `npm run dev` after running this.
//
// Usage:
//   npm run snipes:reset              # clears all countries
//   npm run snipes:reset -- CR        # clears only Costa Rica
//   npm run snipes:reset -- CR US JP  # clears multiple countries

import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN. Run via `npm run snipes:reset` so .env is loaded.");
  process.exit(1);
}

const countries = process.argv.slice(2).map((c) => c.trim().toUpperCase()).filter(Boolean);
const scope = countries.length === 0 ? "all countries" : countries.join(", ");

const db = createClient({ url, authToken });

async function hasColumn(table, column) {
  const result = await db.execute(`PRAGMA table_info("${table.replaceAll('"', '""')}")`);
  return result.rows.some((row) => row.name === column);
}

function cachePrefix(prefix) {
  const separatorIndex = prefix.indexOf(":");
  return separatorIndex >= 0 ? prefix.slice(0, separatorIndex) : prefix;
}

// (table, column, keyPrefix) triples. The response cache + snipe log are
// country-scoped; the snapshot is stored with the current schema version in
// its key, so we wildcard across all versions to catch older shapes too.
const targets = [
  { table: "cache_entries", column: "cache_key", prefix: "country-snipes-response:" },
  { table: "cache_entries", column: "cache_key", prefix: "country-snipes-log:" },
  { table: "cache_entries", column: "cache_key", prefix: "country-board-snapshot:" },
  { table: "cache_entries", column: "cache_key", prefix: "snipes-scan-status:" },
  { table: "cache_locks",   column: "lock_key",  prefix: "country-snipes-response:" },
];

function buildPatterns(prefix) {
  if (countries.length === 0) return [`${prefix}%`];
  return countries.flatMap((c) => [
    `${prefix}%:${c}`,
    // Also match keys where the country is immediately after the prefix (no
    // version segment, e.g. `snipes-scan-status:CR`).
    `${prefix}${c}`,
  ]);
}

const cacheEntriesHasPrefix = await hasColumn("cache_entries", "cache_prefix");
let total = 0;
for (const { table, column, prefix } of targets) {
  for (const pattern of buildPatterns(prefix)) {
    const canUseCachePrefix = table === "cache_entries" && cacheEntriesHasPrefix;
    const result = await db.execute({
      sql: canUseCachePrefix
        ? `DELETE FROM ${table} WHERE cache_prefix = ? AND ${column} LIKE ?`
        : `DELETE FROM ${table} WHERE ${column} LIKE ?`,
      args: canUseCachePrefix ? [cachePrefix(prefix), pattern] : [pattern],
    });
    const n = result.rowsAffected ?? 0;
    if (n > 0) {
      console.log(`  ${table}: removed ${n} row(s) matching "${pattern}"`);
      total += n;
    }
  }
}

console.log(`\nDone. Cleared ${total} row(s) for ${scope}.`);
console.log("Restart `npm run dev` so the in-memory cache layer drops its copy too.");
