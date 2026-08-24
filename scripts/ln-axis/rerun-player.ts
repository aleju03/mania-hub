// Manual one-user skill recompute against the local DB (the same code path the
// job runner uses), then a before/after view of the LN plays surface.
// Usage: node --env-file-if-exists=live-backend/.env npx tsx scripts/ln-axis/rerun-player.ts --user 7095193
import { createDb, exec, parseJson } from "../../live-backend/src/db.js";
import { readConfig } from "../../live-backend/src/config.js";
import { OsuApiClient } from "../../live-backend/src/osu/client.js";
import { JobQueue } from "../../live-backend/src/jobs/queue.js";
import {
  PLAYER_SKILLS_VERSION,
  computePlayerSkillsJob,
  getPlayerSkillPlays,
} from "../../live-backend/src/features/player-skills.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const userId = Number(args[args.indexOf("--user") + 1]);
if (!Number.isInteger(userId) || userId <= 0) throw new Error("--user <id> required");

const config = readConfig();
// Hardening after the 2026-08-21 incident: a cwd-relative databaseUrl resolved
// against the wrong working directory and wrecked an unrelated file. Resolve to
// an absolute path here and refuse to open anything that is not already a
// multi-GB database before a read-write handle exists.
const dbFile = resolve(config.databaseUrl.slice("file:".length));
const dbStat = await stat(dbFile);
if (config.databaseUrl.startsWith("file:") && dbStat.size < 1_000_000_000) {
  throw new Error(`refusing to open ${dbFile} (${dbStat.size} bytes) — not the main database`);
}
console.log(`database: ${dbFile} (${(dbStat.size / 1e9).toFixed(2)} GB)`);
config.databaseUrl = `file:${dbFile}`;
const logOsuCall = (entry: { caller: string; path: string; startedAt: number; durationMs?: number | null; status?: number | null }): void => {
  console.log(`  [osu] ${entry.caller} ${entry.path} -> ${entry.status ?? "?"} (${entry.durationMs ?? "?"}ms)`);
};
const osu = new OsuApiClient(config, fetch, logOsuCall);
console.log(`osu credentials present: ${osu.hasCredentials()}`);

const db = await createDb({ databaseUrl: config.databaseUrl });

function printPlays(title: string, items: Array<{ beatmapId: number; title: string; version: string; keyCount: number; rating: number; overallRating: number; rate: number }>): void {
  console.log(`\n== ${title} ==`);
  for (const item of items.slice(0, 10)) {
    console.log(
      `  ${String(item.beatmapId).padEnd(9)} ${item.keyCount}K x${item.rate} O=${item.overallRating.toFixed(2)} lnRating=${item.rating.toFixed(2)}  ${item.title.slice(0, 38)} [${item.version.slice(0, 24)}]`,
    );
  }
}

async function oldGateView(): Promise<void> {
  const row = (await exec(
    db,
    "select plays_json from player_skill_ratings where user_id = ? and analysis_version = ?",
    [userId, PLAYER_SKILLS_VERSION],
  )).rows[0];
  const stored = parseJson<{ plays?: Array<{ keyCount?: number; patterns?: string[]; values?: Record<string, number>; beatmapId?: number }> }>(String(row?.plays_json ?? ""), {});
  const ln = (stored.plays ?? [])
    .filter((p) => p.keyCount === 7 && Array.isArray(p.patterns) && p.patterns.includes("ln"))
    .sort((a, b) => Number(b.values?.Overall ?? 0) - Number(a.values?.Overall ?? 0));
  console.log(`\n== BEFORE (stored row, OLD gate: tag only) — ${ln.length} tagged 7K plays ==`);
  for (const p of ln.slice(0, 10)) {
    console.log(`  ${String(p.beatmapId).padEnd(9)} 7K O=${Number(p.values?.Overall ?? 0).toFixed(2)}`);
  }
}

await oldGateView();

console.log(`\nrecomputing skills for user ${userId} ...`);
const queue = new JobQueue(db);
await computePlayerSkillsJob(db, osu, queue, { userId });
console.log("compute done");

for (const keyCount of [7, 4]) {
  const page = await getPlayerSkillPlays(db, userId, keyCount, "pattern:ln", { limit: 10 });
  printPlays(`AFTER compute + NEW gate (pattern:ln @ ${keyCount}K): total ${page.total}`, page.items as never);
}
