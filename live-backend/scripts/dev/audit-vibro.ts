/** Read-only cached-corpus audit. Run from live-backend:
 * node --import tsx scripts/dev/audit-vibro.ts [--rate 1.5] [--limit 1000] [--output /tmp/vibro.json]
 * SWEEP_DB_URL overrides the local DB. No osu! API or calculator calls. */
import { createClient } from "@libsql/client";
import { writeFile } from "node:fs/promises";
import { parseManiaBeatmap } from "../../src/dan/beatmap-parser.js";
import { analyzeVibroSections, usesSectionVibro } from "../../src/dan/vibro-sections.js";
import { readCachedBeatmapFile } from "../../src/osu/beatmap-file-cache.js";
import { logInfo } from "../../src/logger.js";

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const rate = Number(arg("--rate") ?? 1);
const limit = Number(arg("--limit") ?? Infinity);
if (!(rate > 0) || !Number.isFinite(rate) || !(limit > 0)) throw new Error("Invalid rate or limit");
const db = createClient({ url: process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db" });
await db.execute("pragma busy_timeout = 5000");
await db.execute("pragma query_only = on");
const counts: Record<string, number> = {};
const changes: unknown[] = [];
let cursor = 0;
let scanned = 0;
try {
  while (scanned < limit) {
    const rows = (await db.execute({ sql: `select beatmap_id, title, version, status, vibro
      from map_search_index where key_count = 4 and beatmap_id > ? order by beatmap_id limit ?`,
    args: [cursor, Math.min(250, limit - scanned)] })).rows;
    if (!rows.length) break;
    for (const row of rows) {
      cursor = Number(row.beatmap_id);
      scanned++;
      const text = await readCachedBeatmapFile(db, cursor, { touch: false });
      if (!text) { counts.missing = (counts.missing ?? 0) + 1; continue; }
      const map = parseManiaBeatmap(text);
      if (!usesSectionVibro(map)) continue;
      const analysis = analyzeVibroSections(map, rate);
      const key = `${String(row.status)}:${analysis.status}`;
      counts[key] = (counts[key] ?? 0) + 1;
      if (row.vibro || analysis.status !== "clean") changes.push({
        id: cursor, title: row.title, difficulty: row.version, mapStatus: row.status,
        previouslyFlagged: Number(row.vibro) === 1, ...analysis,
      });
    }
    if (scanned % 5000 === 0) logInfo("vibro_audit_progress", { scanned, rate });
  }
  const result = { scanned, rate, counts, changes };
  if (arg("--output")) await writeFile(arg("--output")!, JSON.stringify(result, null, 2) + "\n");
  logInfo("vibro_audit_complete", { scanned, rate, counts, changed: changes.length });
} finally {
  db.close();
}
