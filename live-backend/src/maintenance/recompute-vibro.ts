import { readConfig } from "../config.js";
import { createDb, exec, migrate } from "../db.js";
import { recomputeVibroChunk } from "../features/chart-analysis.js";

// Manual/inspection wrapper around the vibro recompute sweep. The backend runs
// the same sweep automatically at boot as a one-shot job (see
// ensureVibroRecomputeSeeded in features/chart-analysis.ts); this script exists
// for --dry-run auditing and for re-running by hand after detector changes.
//
// Usage: npm run recompute:vibro          (add --dry-run to only report)

const dryRun = process.argv.includes("--dry-run");

const config = readConfig();
const db = await createDb(config);
await migrate(db);

let cursor = 0;
let scanned = 0;
let flagged = 0;
for (;;) {
  const result = await recomputeVibroChunk(db, cursor, 200, { dryRun });
  cursor = result.nextCursor;
  scanned += result.scanned;
  flagged += result.flagged.length;
  for (const beatmapId of result.flagged) {
    const row = (await exec(
      db,
      "select title, version from map_search_index where beatmap_id = ? limit 1",
      [beatmapId],
    )).rows[0];
    console.log(`vibro: ${beatmapId} ${String(row?.title ?? "?")} [${String(row?.version ?? "?")}]`);
  }
  if (result.done) break;
  if (scanned % 2000 < 200) console.log(`scanned ${scanned} candidates (${flagged} flagged)...`);
}

console.log(`${dryRun ? "[dry-run] " : ""}Done: ${scanned} holds-heavy candidates scanned, ${flagged} flagged as LN vibro.`);
db.close();
process.exit(0);
