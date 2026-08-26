import { rm } from "node:fs/promises";
import { readConfig } from "../config.js";
import { createDb, exec } from "../db.js";
import { PLAYER_SKILLS_VERSION } from "../features/player-skills.js";

// Exports the current ready player-skill corpus into a standalone sqlite file.
// The target imports these rows as stale cache seeds, not as authoritative
// current ratings: plays_json carries the expensive per-play MinaCalc SSRs,
// while the target's next compute folds in its newer profile snapshot and
// tracked-score history without rating the shared historical plays again.
//
// Usage: npm run export:player-skills [-- ./data/player-skills-export.db]
// Import counterpart: import-player-skills.ts

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

const outPath = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "./data/player-skills-export.db";
const config = readConfig();
const source = await createDb(config);

for (const suffix of ["", "-wal", "-shm"]) {
  await rm(`${outPath}${suffix}`, { force: true });
}
const out = await createDb({ ...config, databaseUrl: `file:${outPath}` });

await exec(
  out,
  `create table export_meta (
    key text primary key,
    value text not null
  )`,
);
await exec(out, "insert into export_meta (key, value) values (?, ?), (?, ?)", [
  "player_skills_version",
  String(PLAYER_SKILLS_VERSION),
  "exported_at",
  new Date().toISOString(),
]);
await exec(
  out,
  `create table player_skill_ratings (
    user_id integer not null,
    analysis_version integer not null,
    status text not null,
    modes_json text,
    plays_json text,
    acc_model_json text,
    source_fetched_at text,
    error text,
    computed_at text,
    updated_at text not null,
    primary key (user_id, analysis_version)
  )`,
);

let cursor = 0;
let exported = 0;
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
  const args = rows.flatMap((row) => COLUMNS.map((column) => row[column] ?? null));
  await exec(out, `insert into player_skill_ratings (${COLUMNS.join(", ")}) values ${placeholders}`, args);

  exported += rows.length;
  cursor = Number(rows[rows.length - 1].user_id);
  if (exported % 1_000 < CHUNK) console.log(`exported ${exported} rows...`);
}

await exec(out, "pragma wal_checkpoint(TRUNCATE)");
console.log(`Export complete: ${exported} version-${PLAYER_SKILLS_VERSION} rows -> ${outPath}`);
console.log("Transfer it (gzip + scp) and run import-player-skills on the target before starting workers.");

out.close();
source.close();
process.exit(0);
