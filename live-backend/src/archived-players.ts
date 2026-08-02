/* Archived players: profiles the osu! API can no longer serve.

   A handful of osu!mania's historical greats have deleted accounts (or accounts
   wiped to 0pp), so every live path for them 404s. Their profiles are
   reconstructed from Wayback Machine captures, checked in under
   `seeds/archived-players/*.snapshot.json`, and seeded into `profile_snapshots`
   on boot. That table alone is enough to serve `/player/<name>`: the cached
   snapshot endpoint reads it by username key without touching the osu! API.

   The files sit beside `migrations/` rather than under `data/` because `data/`
   is gitignored (it holds the SQLite database), and these must ship with the
   repo to reach prod. Both resolve off import.meta.url, so the same relative
   path works from `src/` and from the built `dist/`.

   Deliberately no `users` row. Rankings, rosters, the global snapshot, and the
   pack pool all build off `users`/`country_rosters`, so leaving these players
   out of both keeps a 2023-frozen 22,684pp profile from outranking live
   players. They stay reachable by direct profile link and by card pull, which
   draws them from the honorary pool instead of the ranked pool.

   Seeding is idempotent and content-addressed: each player's row is rewritten
   only when the checked-in file's hash changes, so a prod boot picks up new or
   updated archived players by itself and does nothing on every boot after.
*/
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Db } from "./db.js";
import { logInfo, logWarn } from "./logger.js";

const SEED_DIR = new URL("../seeds/archived-players/", import.meta.url);
const SENTINEL_PREFIX = "archived_player_seed:";

export interface ArchivedPlayerSnapshot {
  user_id: number;
  username_key: string;
  user: Record<string, unknown>;
  best_scores: unknown[];
  best_scores_limit: number;
  archived: true;
}

function isSnapshot(value: unknown): value is ArchivedPlayerSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ArchivedPlayerSnapshot>;
  return (
    Number.isInteger(snapshot.user_id) &&
    (snapshot.user_id ?? 0) > 0 &&
    typeof snapshot.username_key === "string" &&
    snapshot.username_key.length > 0 &&
    !!snapshot.user &&
    Array.isArray(snapshot.best_scores)
  );
}

export async function readArchivedPlayerSnapshots(): Promise<ArchivedPlayerSnapshot[]> {
  let files: string[];
  try {
    files = (await readdir(SEED_DIR)).filter((name) => name.endsWith(".snapshot.json"));
  } catch {
    return [];
  }

  const snapshots: ArchivedPlayerSnapshot[] = [];
  for (const file of files.sort()) {
    try {
      const parsed: unknown = JSON.parse(await readFile(new URL(file, SEED_DIR), "utf8"));
      if (!isSnapshot(parsed)) {
        logWarn("archived_player_seed_invalid", { file });
        continue;
      }
      snapshots.push(parsed);
    } catch (error) {
      logWarn("archived_player_seed_unreadable", { file, error: (error as Error).message });
    }
  }
  return snapshots;
}

/* True when this profile key belongs to a seeded archived player. Refresh
   paths use it to skip the osu! API instead of 404ing and stamping
   refresh_error over a profile that will never come back. */
export function isArchivedProfileUser(user: unknown): boolean {
  return !!user && typeof user === "object" && (user as { archived?: unknown }).archived === true;
}

export async function ensureArchivedPlayers(db: Db): Promise<void> {
  const snapshots = await readArchivedPlayerSnapshots();
  if (snapshots.length === 0) return;

  const now = new Date().toISOString();
  let written = 0;

  for (const snapshot of snapshots) {
    const userJson = JSON.stringify(snapshot.user);
    const scoresJson = JSON.stringify(snapshot.best_scores);
    const hash = createHash("sha256").update(`${userJson}\n${scoresJson}`).digest("hex").slice(0, 32);
    const sentinelKey = `${SENTINEL_PREFIX}${snapshot.user_id}`;

    const existing = (await db.execute({
      sql: "select value_json from live_meta where key = ? limit 1",
      args: [sentinelKey],
    })).rows[0];
    const stored = existing ? String(existing.value_json) : "";
    // The row can be missing even when the sentinel matches (a restored or
    // reset database), so confirm both before skipping.
    const rowPresent = (await db.execute({
      sql: "select 1 from profile_snapshots where user_id = ? limit 1",
      args: [snapshot.user_id],
    })).rows.length > 0;
    if (stored.includes(hash) && rowPresent) continue;

    await db.execute({
      sql: `insert into profile_snapshots
              (user_id, username_key, user_json, best_scores_json, best_scores_limit,
               fetched_at, user_fetched_at, updated_at, refresh_error)
            values (?, ?, ?, ?, ?, ?, ?, ?, null)
            on conflict(user_id) do update set
              username_key = excluded.username_key,
              user_json = excluded.user_json,
              best_scores_json = excluded.best_scores_json,
              best_scores_limit = excluded.best_scores_limit,
              fetched_at = excluded.fetched_at,
              user_fetched_at = excluded.user_fetched_at,
              updated_at = excluded.updated_at,
              refresh_error = null`,
      args: [
        snapshot.user_id,
        snapshot.username_key,
        userJson,
        scoresJson,
        snapshot.best_scores_limit || snapshot.best_scores.length,
        now,
        now,
        now,
      ],
    });
    await db.execute({
      sql: `insert into live_meta (key, value_json, updated_at) values (?, ?, ?)
            on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
      args: [sentinelKey, JSON.stringify({ hash, seededAt: now }), now],
    });
    written += 1;
  }

  if (written > 0) {
    logInfo("archived_players_seeded", { total: snapshots.length, written });
  }
}
