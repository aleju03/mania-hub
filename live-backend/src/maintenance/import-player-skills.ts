import { access } from "node:fs/promises";
import { readConfig } from "../config.js";
import { createDb, exec, migrate } from "../db.js";
import { enqueueSkillBaselineIfDue } from "../features/skill-baseline.js";
import { PLAYER_SKILLS_VERSION } from "../features/player-skills.js";
import { JobQueue } from "../jobs/queue.js";

// Imports a dev-computed player-skill corpus as reusable SSR cache seeds.
// Existing ready target rows always win. Imported rows are deliberately
// backdated beyond the normal ready TTL: the page can serve the seed at once,
// but its next read queues a cheap target-side refresh that folds in the
// target's newer profile snapshot and tracked history. This makes an older dev
// DB useful without presenting it as fresher than prod.
//
// Run this after deploying the matching code/schema and before starting the
// worker process when possible.
//
// Usage: npm run import:player-skills -- ./player-skills-export.db
//        (on the VPS: npm run import:player-skills:dist -- <file>)

const COLUMNS = [
  "user_id",
  "analysis_version",
  "status",
  "modes_json",
  "plays_json",
  "acc_model_json",
  "source_fetched_at",
  "error",
  "computed_at",
  "updated_at",
] as const;

const CHUNK = 100;
const STALE_AGE_MS = 13 * 60 * 60_000;

const inPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!inPath) {
  console.error("Usage: import-player-skills <path/to/player-skills-export.db>");
  process.exit(1);
}
await access(inPath).catch(() => {
  console.error(`Export file not found: ${inPath}`);
  process.exit(1);
});

const config = readConfig();
const db = await createDb(config);
await migrate(db);
const source = await createDb({ ...config, databaseUrl: `file:${inPath}` });

const exportedVersion = Number((await exec(
  source,
  "select value from export_meta where key = ? limit 1",
  ["player_skills_version"],
)).rows[0]?.value ?? 0);
if (exportedVersion !== PLAYER_SKILLS_VERSION) {
  console.error(`Player-skills version mismatch: export=${exportedVersion}, target=${PLAYER_SKILLS_VERSION}`);
  source.close();
  db.close();
  process.exit(1);
}

const staleComputedAt = new Date(Date.now() - STALE_AGE_MS).toISOString();
let cursor = 0;
let processed = 0;
let applied = 0;
for (;;) {
  const rows = (await exec(
    source,
    `select ${COLUMNS.join(", ")} from player_skill_ratings
     where analysis_version = ? and status = 'ready' and user_id > ?
     order by user_id
     limit ?`,
    [PLAYER_SKILLS_VERSION, cursor, CHUNK],
  )).rows;
  if (rows.length === 0) break;

  const placeholders = rows.map(() => `(${COLUMNS.map(() => "?").join(", ")})`).join(", ");
  const importedAt = new Date().toISOString();
  const args = rows.flatMap((row) => COLUMNS.map((column) => {
    if (column === "computed_at") return staleComputedAt;
    if (column === "updated_at") return importedAt;
    return row[column] ?? null;
  }));
  const result = await exec(
    db,
    `insert into player_skill_ratings (${COLUMNS.join(", ")}) values ${placeholders}
     on conflict(user_id, analysis_version) do update set
       status = excluded.status,
       modes_json = excluded.modes_json,
       plays_json = excluded.plays_json,
       acc_model_json = excluded.acc_model_json,
       source_fetched_at = excluded.source_fetched_at,
       error = excluded.error,
       computed_at = excluded.computed_at,
       updated_at = excluded.updated_at
     where player_skill_ratings.status = 'failed'`,
    args,
  );
  applied += Number(result.rowsAffected ?? 0);

  const userIds = rows.map((row) => Number(row.user_id)).filter((userId) => Number.isSafeInteger(userId) && userId > 0);
  if (userIds.length > 0) {
    const placeholders = userIds.map(() => "?").join(", ");
    await exec(
      db,
      `delete from player_skill_ratings
       where analysis_version != ? and user_id in (${placeholders})
         and exists (
           select 1 from player_skill_ratings current
           where current.user_id = player_skill_ratings.user_id
             and current.analysis_version = ? and current.status = 'ready'
         )`,
      [PLAYER_SKILLS_VERSION, ...userIds, PLAYER_SKILLS_VERSION],
    );
  }

  processed += rows.length;
  cursor = Number(rows[rows.length - 1].user_id);
  if (processed % 1_000 < CHUNK) console.log(`processed ${processed} rows (${applied} seeds applied)...`);
}

console.log(`Import complete: ${applied} cache seeds applied, ${processed - applied} existing target rows kept.`);
console.log("Imported rows are stale by design; profile reads refresh them against target-side history while reusing per-play SSRs.");

const queue = new JobQueue(db);
const baselineQueued = await enqueueSkillBaselineIfDue(db, queue, 0);
console.log(baselineQueued ? "Skill baseline refresh enqueued." : "Skill baseline refresh already current or queued.");

source.close();
db.close();
process.exit(0);
