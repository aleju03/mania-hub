/**
 * Verifies the rate-edit base-length resolution against the live DB and counts
 * how many 4K charts it moves onto the stamina tile.
 *
 * Read-only. Run: npx tsx scripts/dev/rate-edit-check.ts
 */
import { createClient } from "@libsql/client";
import { loadChartSkillInfo, parseNamedRate } from "../../src/features/player-skills.js";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";

const NAME_CASES: Array<[string, number | null]> = [
  ["[4K] NB5 Hard 54235 1.4x", 1.4],
  ["[4K] Insane [1,1x Rate]", 1.1],
  ["[4K] [Lv.19] IcyWorld's Hard x1.4", 1.4],
  ["[4K] Challenge 1.4x (191bpm) OD8", 1.4],
  ["[4K] NB5 Hard 54235", null],
  ["[4K] Cool Gamer", null],
  ["[4K] x0.85", null],
  ["[4K] Battle Cats - 2nd Battle Theme 1.3x 35.73 MSD", 1.3],
];

async function main() {
  for (const [version, expected] of NAME_CASES) {
    const got = parseNamedRate(version);
    console.log(`${got === expected ? "ok  " : "FAIL"} ${JSON.stringify(version)} -> ${got}`);
  }

  const db = createClient({ url: DB_URL });
  // The FUTURE DOMINATORS ladder plus its unrated base.
  const ladder = [3123872, 3123871, 3123870, 3123869, 3123873];
  const info = await loadChartSkillInfo(db as never, ladder);
  console.log("\n== FUTURE DOMINATORS ladder (stored -> resolved) ==");
  const stored = (await db.execute({
    sql: `select beatmap_id, version, length as length_seconds from map_search_index where beatmap_id in (${ladder.map(() => "?").join(",")})`,
    args: ladder,
  })).rows;
  for (const row of stored) {
    const id = Number(row.beatmap_id);
    console.log(`  ${id} ${String(row.version).padEnd(34)} ${row.length_seconds}s -> ${info.get(id)?.lengthSeconds}s`);
  }
  db.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
