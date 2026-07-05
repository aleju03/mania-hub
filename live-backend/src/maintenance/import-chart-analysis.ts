import { access } from "node:fs/promises";
import { readConfig } from "../config.js";
import { createDb, exec, migrate } from "../db.js";
import { forceMapSearchIndexRebuild } from "../features/map-search.js";
import { JobQueue } from "../jobs/queue.js";

// Imports beatmap_chart_analysis rows from an export file produced by
// export-chart-analysis.ts. Existing rows win (on conflict do nothing): a row
// the target computed itself is just as valid, and this must never downgrade
// a newer analysis_version. Safe to run while the backend is serving; chunked
// inserts keep write-lock holds short.
//
// After importing it schedules a full map search index rebuild, because the
// per-beatmap index upserts only fire from analysis jobs, which never ran for
// imported rows.
//
// Usage: npm run import:chart-analysis -- ./chart-analysis-export.db
//        (on the VPS: npm run import:chart-analysis:dist -- <file>)

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

const inPath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!inPath) {
  console.error("Usage: import-chart-analysis <path/to/chart-analysis-export.db>");
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

let cursor = -1;
let processed = 0;
let inserted = 0;
for (;;) {
  const rows = (await exec(
    source,
    `select ${COLUMNS.join(", ")} from beatmap_chart_analysis
     where beatmap_id > ?
     order by beatmap_id
     limit ?`,
    [cursor, CHUNK],
  )).rows;
  if (rows.length === 0) break;

  const placeholders = rows.map(() => `(${COLUMNS.map(() => "?").join(", ")})`).join(", ");
  const args = rows.flatMap((row) => COLUMNS.map((column) => row[column] ?? null));
  const result = await exec(
    db,
    `insert into beatmap_chart_analysis (${COLUMNS.join(", ")}) values ${placeholders}
     on conflict(beatmap_id, analysis_version) do nothing`,
    args,
  );
  inserted += Number(result.rowsAffected ?? 0);

  processed += rows.length;
  cursor = Number(rows[rows.length - 1].beatmap_id);
  if (processed % 10_000 < CHUNK) console.log(`processed ${processed} rows (${inserted} inserted)...`);
}

console.log(`Import complete: ${inserted} inserted, ${processed - inserted} already present.`);

const queue = new JobQueue(db);
await forceMapSearchIndexRebuild(db, queue);
console.log("Map search index rebuild enqueued; dan/MSD columns fill in as it pages through.");
console.log("Remaining uncovered charts: press \"Analyze cached charts\" on /admin/live-backend.");

source.close();
db.close();
process.exit(0);
