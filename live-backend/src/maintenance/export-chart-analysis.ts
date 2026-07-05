import { rm } from "node:fs/promises";
import { readConfig } from "../config.js";
import { createDb, exec } from "../db.js";

// Exports beatmap_chart_analysis rows into a standalone sqlite file so a
// backfill computed on one machine can seed another database (dev -> VPS).
// Only durable outcomes travel: ready and unavailable. Failed rows stay
// behind so the target retries them itself.
//
// Usage: npm run export:chart-analysis [-- ./data/chart-analysis-export.db]
// Import counterpart: import-chart-analysis.ts

const COLUMNS = [
  "beatmap_id",
  "analysis_version",
  "status",
  "key_count",
  "primary_label",
  "primary_family",
  "raw_dan",
  "msd_overall",
  "classification_json",
  "msd_json",
  "error",
  "computed_at",
  "updated_at",
] as const;

const CHUNK = 200;

const outPath = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "./data/chart-analysis-export.db";
const config = readConfig();
const source = await createDb(config);

for (const suffix of ["", "-wal", "-shm"]) {
  await rm(`${outPath}${suffix}`, { force: true });
}
const out = await createDb({ ...config, databaseUrl: `file:${outPath}` });

await exec(
  out,
  `create table beatmap_chart_analysis (
    beatmap_id integer not null,
    analysis_version integer not null,
    status text not null,
    key_count integer,
    primary_label text,
    primary_family text,
    raw_dan real,
    msd_overall real,
    classification_json text,
    msd_json text,
    error text,
    computed_at text,
    updated_at text not null,
    primary key (beatmap_id, analysis_version)
  )`,
);

let cursor = -1;
let exported = 0;
for (;;) {
  const rows = (await exec(
    source,
    `select ${COLUMNS.join(", ")} from beatmap_chart_analysis
     where status in ('ready', 'unavailable') and beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [cursor, CHUNK],
  )).rows;
  if (rows.length === 0) break;

  const placeholders = rows.map(() => `(${COLUMNS.map(() => "?").join(", ")})`).join(", ");
  const args = rows.flatMap((row) => COLUMNS.map((column) => row[column] ?? null));
  await exec(out, `insert into beatmap_chart_analysis (${COLUMNS.join(", ")}) values ${placeholders}`, args);

  exported += rows.length;
  cursor = Number(rows[rows.length - 1].beatmap_id);
  if (exported % 10_000 < CHUNK) console.log(`exported ${exported} rows...`);
}

// Fold the WAL into the main file so the single .db is the whole export.
await exec(out, "pragma wal_checkpoint(TRUNCATE)");
console.log(`Export complete: ${exported} rows -> ${outPath}`);
console.log("Transfer it (gzip + scp) and run import-chart-analysis on the target.");

out.close();
source.close();
process.exit(0);
