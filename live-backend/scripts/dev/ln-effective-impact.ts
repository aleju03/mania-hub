/* Corpus impact of the effective LN share (dan/dan-estimator/ln-effective.ts)
   on the local DB: which 4K hold-share LN charts the effective gate demotes,
   whether any low-hold chart is accidentally promoted, and whether
   every registered 4K LN dan course still reads LN at 1.0x. Read-only.
   Run from live-backend/:
     npx tsx scripts/dev/ln-effective-impact.ts [--min-hold 0.25] [--rate 1.5] [--limit N] */
import { createDb, exec } from "../../src/db.js";
import { parseManiaBeatmap } from "../../src/dan/beatmap-parser.js";
import { analyzeEffectiveLn, chartIsLn, lnIdentityMinRatioFor } from "../../src/dan/dan-estimator/ln-effective.js";
import { lnPrimaryMinRatioFor } from "../../src/dan/dan-estimator/ln.js";

import { CHART_ANALYSIS_VERSION } from "../../src/features/chart-analysis.js";
import { listDanCourses } from "../../src/features/dan-courses.js";
import { readCachedBeatmapFile } from "../../src/osu/beatmap-file-cache.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : fallback;
};
const MIN_HOLD = flag("--min-hold", 0.25);
const RATE = flag("--rate", 1.5);
const LIMIT = flag("--limit", 0);
const DB_URL = process.env.DATABASE_URL ?? "file:./data/mania-hub-live.db";

const db = await createDb({ databaseUrl: DB_URL, sqliteCacheMb: 8, sqliteMmapMb: 0 });
const line = lnIdentityMinRatioFor(4);
const holdLine = lnPrimaryMinRatioFor(4);

const rows = (await exec(
  db,
  `select a.beatmap_id, json_extract(a.classification_json, '$.lnRatio') as ln_ratio,
          json_extract(a.classification_json, '$.ln.displayName') as ln_name,
          a.primary_family, b.version, s.title
   from beatmap_chart_analysis a
   left join beatmaps b on b.beatmap_id = a.beatmap_id
   left join beatmapsets s on s.beatmapset_id = b.beatmapset_id
   where a.analysis_version = ? and a.status = 'ready' and a.key_count = 4
     and json_extract(a.classification_json, '$.lnRatio') >= ?
   order by a.beatmap_id
   ${LIMIT > 0 ? `limit ${Math.floor(LIMIT)}` : ""}`,
  [CHART_ANALYSIS_VERSION, MIN_HOLD],
)).rows;

interface Row { id: number; name: string; hold: number; eff1: number; effRate: number; wasLn: boolean; hasLnHalf: boolean }
const results: Row[] = [];
let missing = 0;
const started = Date.now();
for (const row of rows) {
  const id = Number(row.beatmap_id);
  const text = await readCachedBeatmapFile(db, id, { touch: false }).catch(() => null);
  if (!text) { missing += 1; continue; }
  let map;
  try { map = parseManiaBeatmap(text); } catch { missing += 1; continue; }
  if (map.keyCount !== 4) continue;
  const at1 = analyzeEffectiveLn(map.notes, { rate: 1, od: map.od });
  const atRate = analyzeEffectiveLn(map.notes, { rate: RATE, od: map.od });
  results.push({
    id,
    name: `${String(row.title ?? "?")} [${String(row.version ?? "?")}]`,
    hold: Number(row.ln_ratio),
    eff1: at1.effectiveLnRatio,
    effRate: atRate.effectiveLnRatio,
    wasLn: Number(row.ln_ratio) >= holdLine,
    hasLnHalf: row.ln_name != null,
  });
}
console.log(`scanned ${rows.length} 4K rows with hold share >= ${MIN_HOLD} (${missing} without a cached .osu) in ${((Date.now() - started) / 1000).toFixed(0)}s`);

const lnNow = results.filter((r) => r.wasLn);
const readsLn = (row: Row, effective: number) => chartIsLn(4, { lnRatio: row.hold, lnEffectiveRatio: effective }) === true;
const toRice = lnNow.filter((r) => !readsLn(r, r.eff1));
const toLn = results.filter((r) => !r.wasLn && readsLn(r, r.eff1));
console.log(`\nidentity at 1.0x (line ${line}):`);
console.log(`  LN by hold share: ${lnNow.length}; of those now rice by effective share: ${toRice.length} (${(100 * toRice.length / Math.max(1, lnNow.length)).toFixed(0)}%)`);
console.log(`  rice by hold share but LN by effective share: ${toLn.length} (${toLn.filter((r) => r.hasLnHalf).length} carry an LN half to route to)`);
const stillLnAtRate = lnNow.filter((r) => readsLn(r, r.eff1) && readsLn(r, r.effRate)).length;
console.log(`  of the ${lnNow.filter((r) => readsLn(r, r.eff1)).length} still LN at 1.0x, LN at ${RATE}x too: ${stillLnAtRate}`);

const bucket = (values: number[]) => {
  const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.45, 0.6, 0.8, 1.01];
  return edges.slice(0, -1).map((lo, i) => `${lo.toFixed(2)}-${edges[i + 1] > 1 ? "1.00" : edges[i + 1].toFixed(2)}: ${values.filter((v) => v >= lo && v < edges[i + 1]).length}`).join("  ");
};
console.log(`\neffective share at 1.0x among hold-share LN charts:\n  ${bucket(lnNow.map((r) => r.eff1))}`);

const show = (list: Row[], title: string, n = 25) => {
  console.log(`\n${title} (${list.length}, showing ${Math.min(n, list.length)}):`);
  for (const r of list.slice(0, n)) console.log(`  ${r.id}  hold ${r.hold.toFixed(2)}  eff ${r.eff1.toFixed(2)} / ${RATE}x ${r.effRate.toFixed(2)}  ${r.name.slice(0, 70)}`);
};
show([...toRice].sort((a, b) => b.hold - a.hold), "LN -> rice, highest hold share first");
show([...toLn].sort((a, b) => b.eff1 - a.eff1), "rice -> LN, highest effective share first");

// Borderline charts: nearest the line on either side, most-played first, so
// the cases worth a human look are the ones players actually meet.
const playsByBeatmap = new Map<number, number>();
for (const row of (await exec(
  db,
  `select beatmap_id, count(*) as plays from country_maps_farmed_scores
   where beatmap_id in (${results.map(() => "?").join(",")}) group by beatmap_id`,
  results.map((r) => r.id),
)).rows) playsByBeatmap.set(Number(row.beatmap_id), Number(row.plays));
const nearLine = (list: Row[], title: string, n = 15) => {
  const ranked = [...list].sort((a, b) => (playsByBeatmap.get(b.id) ?? 0) - (playsByBeatmap.get(a.id) ?? 0));
  console.log(`\n${title} (${list.length}, ${Math.min(n, list.length)} most played):`);
  for (const r of ranked.slice(0, n)) console.log(`  ${r.id}  plays ${playsByBeatmap.get(r.id) ?? 0}  hold ${r.hold.toFixed(2)}  eff ${r.eff1.toFixed(2)} / ${RATE}x ${r.effRate.toFixed(2)}  ${r.name.slice(0, 70)}`);
};
nearLine(results.filter((r) => r.wasLn && r.eff1 >= line && r.eff1 < line + 0.04), `LN by a hair (effective ${line.toFixed(2)}-${(line + 0.04).toFixed(2)})`);
nearLine(results.filter((r) => r.wasLn && r.eff1 < line && r.eff1 >= line - 0.04), `rice by a hair (effective ${(line - 0.04).toFixed(2)}-${line.toFixed(2)})`);
nearLine(results.filter((r) => r.eff1 < line && r.hold >= 0.8), "rice now, but 80%+ holds");

console.log("\nregistered 4K LN dan courses at 1.0x:");
for (const course of listDanCourses().filter((c) => c.keyCount === 4 && c.side === "ln")) {
  const text = await readCachedBeatmapFile(db, course.beatmapId, { touch: false }).catch(() => null);
  if (!text) { console.log(`  ${course.beatmapId}  ${course.courseName}: no cached .osu`); continue; }
  const map = parseManiaBeatmap(text);
  const a = analyzeEffectiveLn(map.notes, { rate: 1, od: map.od });
  const mark = chartIsLn(4, { lnRatio: a.holdRatio, lnEffectiveRatio: a.effectiveLnRatio }) === true ? "LN  " : "RICE";
  console.log(`  ${mark} ${course.beatmapId}  OD ${map.od}  hold ${a.holdRatio.toFixed(2)}  eff ${a.effectiveLnRatio.toFixed(2)}  short ${a.shortTails} shortSpan ${a.shortSpanning} long ${a.longTails}  ${course.courseName}`);
}
db.close();
