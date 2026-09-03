/**
 * Measures what an LN subtype re-tag (the v4 sweep in chart-analysis.ts) does
 * to stored 7K LN dan verdicts, locally, without workers.
 *
 * Phase 1 derives every 7K LN side from plays_json against the stored chart
 * tags. Phase 2 re-runs analyzeManiaPatterns over every stored 7K LN chart
 * with a cached .osu and patches classification_json.patterns/category plus
 * the search index's pattern_tags where the verdict moved. Phase 3 derives
 * again and prints the population deltas. --rewrite ID,ID then rewrites those
 * users' stored modes_json through the dan sweep's own chunk function.
 *
 * Writes to the local DB. Run from live-backend/:
 *   npx tsx scripts/dev/ln-subtype-retag-impact.ts [--rewrite 7095193,16918654] [--detail ID,ID]
 */
import { createClient } from "@libsql/client";
import { MAX_RATE_PERCENT, MIN_RATE_PERCENT, loadStoredRateDanVerdicts } from "../../src/features/dan-estimates.js";
import { CHART_ANALYSIS_VERSION } from "../../src/features/chart-analysis.js";
import {
  PLAYER_SKILLS_VERSION,
  collectDanClearsForTest,
  danSideFromClearEvidenceForTest,
  loadChartSkillInfo,
  loadPlayerDanCourseClears,
  recomputePlayerSkillDanChunk,
} from "../../src/features/player-skills.js";
import { readCachedBeatmapFile } from "../../src/osu/beatmap-file-cache.js";
import { parseManiaBeatmap } from "../../src/dan/beatmap-parser.js";
import { analyzeManiaPatterns } from "../../src/dan/dan-estimator/patterns.js";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";
const CHUNK = 200;
const TILES = ["lngeneral", "lntech", "lninverse", "lnrelease"];

function argList(flag: string): number[] {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? String(process.argv[at + 1] ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}
function parse<T>(value: unknown, fallback: T): T { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } }
function clearRatePercent(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return null;
  const percent = Math.round(rate * 100);
  if (percent === 100 || percent < MIN_RATE_PERCENT || percent > MAX_RATE_PERCENT) return null;
  return percent;
}
function quantiles(values: number[]): string {
  if (values.length === 0) return "n=0";
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  return `n=${s.length} p10=${q(0.1)} p25=${q(0.25)} med=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} min=${s[0].toFixed(2)} max=${s[s.length - 1].toFixed(2)}`;
}

interface SideSnap { rawDan: number; label: string; course: boolean; tiles: Record<string, { rawDan: number; label: string; clears: number; capped: boolean }> }

async function deriveAll(db: any): Promise<Map<number, SideSnap>> {
  const out = new Map<number, SideSnap>();
  let cursor = 0;
  for (;;) {
    const rows = (await db.execute({
      sql: `select user_id, modes_json, plays_json from player_skill_ratings where user_id > ? and status = 'ready' order by user_id limit ?`,
      args: [cursor, CHUNK],
    })).rows;
    if (rows.length === 0) break;
    const parsed: Array<{ userId: number; plays: any[] }> = [];
    const beatmapIds: number[] = [];
    for (const row of rows) {
      cursor = Math.max(cursor, Number(row.user_id));
      const summary = parse<{ modes?: Array<{ keyCount: number }> } | null>(row.modes_json, null);
      if (!summary?.modes?.some((m) => m.keyCount === 7)) continue;
      const stored = parse<{ plays?: any[] } | null>(row.plays_json, null);
      const plays = (Array.isArray(stored?.plays) ? stored!.plays : [])
        .filter((play) => play && Number.isInteger(play.beatmapId) && play.beatmapId > 0 && play.keyCount === 7);
      if (plays.length === 0) continue;
      parsed.push({ userId: Number(row.user_id), plays });
      for (const play of plays) beatmapIds.push(play.beatmapId);
    }
    const info = await loadChartSkillInfo(db, beatmapIds);
    const pairs: Array<{ beatmapId: number; ratePercent: number }> = [];
    for (const entry of parsed) for (const play of entry.plays) {
      const percent = clearRatePercent(play.rate);
      if (percent != null) pairs.push({ beatmapId: play.beatmapId, ratePercent: percent });
    }
    const stored = await loadStoredRateDanVerdicts(db, pairs);
    const rateVerdicts = new Map<string, any>();
    for (const [key, verdict] of stored) rateVerdicts.set(key, verdict ? { rawDan: verdict.rawDan, side: verdict.family === "ln" ? "ln" : "rc", displayName: verdict.displayName } : null);
    for (const entry of parsed) {
      const courseClears = await loadPlayerDanCourseClears(db, entry.userId);
      const clears = collectDanClearsForTest(7, entry.plays, info, rateVerdicts).filter((c) => c.side === "ln");
      const side = danSideFromClearEvidenceForTest(7, "ln", clears, info, courseClears);
      if (!side) continue;
      const tiles: SideSnap["tiles"] = {};
      for (const [id, v] of Object.entries(side.skillsets ?? {})) tiles[id] = { rawDan: v.rawDan, label: v.label, clears: v.clears, capped: v.headlineCapped === true };
      out.set(entry.userId, { rawDan: side.rawDan, label: side.label, course: Boolean((side as any).courseClear), tiles });
    }
    process.stderr.write(`derived ${out.size} sides (cursor ${cursor})\n`);
    if (rows.length < CHUNK) break;
  }
  return out;
}

async function retag(db: any): Promise<void> {
  let cursor = 0;
  let scanned = 0;
  let changed = 0;
  const transitions = new Map<string, number>();
  const tagFlow = new Map<string, number>();
  for (;;) {
    const rows = (await db.execute({
      sql: `select beatmap_id, classification_json from beatmap_chart_analysis
            where analysis_version = ? and status = 'ready' and key_count = 7
              and json_extract(classification_json, '$.lnRatio') >= 0.02 and beatmap_id > ?
            order by beatmap_id limit ?`,
      args: [CHART_ANALYSIS_VERSION, cursor, 500],
    })).rows;
    if (rows.length === 0) break;
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      cursor = Math.max(cursor, beatmapId);
      scanned += 1;
      const stored = parse<{ category?: string | null; patterns?: Array<{ id: string; score: number }> } | null>(row.classification_json, null);
      if (!stored) continue;
      const osuText = await readCachedBeatmapFile(db, beatmapId, { touch: false }).catch(() => null);
      if (!osuText) continue;
      let analysis;
      try {
        const map = parseManiaBeatmap(osuText);
        if (map.keyCount !== 7) continue;
        analysis = analyzeManiaPatterns(map, { totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined, version: map.version });
      } catch { continue; }
      const storedTags = [...new Set((stored.patterns ?? []).map((hit) => String(hit?.id ?? "")))].sort();
      const freshTags = [...new Set(analysis.patterns.map((hit) => hit.id))].sort();
      const storedCategory = stored.category ?? null;
      const freshCategory = analysis.primary?.label ?? null;
      // The player side files a clear by score >= 0.5, so track that line too.
      const storedStrong = new Set((stored.patterns ?? []).filter((h) => Number(h.score) >= 0.5).map((h) => h.id));
      const freshStrong = new Set(analysis.patterns.filter((h) => h.score >= 0.5).map((h) => h.id));
      for (const id of TILES) {
        const was = storedStrong.has(id), now = freshStrong.has(id);
        if (was !== now) { const k = `${id} ${was ? "lost" : "gained"} (>=0.5)`; tagFlow.set(k, (tagFlow.get(k) ?? 0) + 1); }
      }
      if (storedTags.join(",") === freshTags.join(",") && storedCategory === freshCategory) continue;
      changed += 1;
      const t = `${storedCategory} -> ${freshCategory}`;
      if (storedCategory !== freshCategory) transitions.set(t, (transitions.get(t) ?? 0) + 1);
      const patterns = analysis.patterns.map((hit) => ({ id: hit.id, label: hit.label, score: hit.score, confidence: hit.confidence }));
      await db.execute({
        sql: `update beatmap_chart_analysis set classification_json = json_set(classification_json, '$.patterns', json(?), '$.category', ?)
              where beatmap_id = ? and analysis_version = ? and status = 'ready'`,
        args: [JSON.stringify(patterns), freshCategory, beatmapId, CHART_ANALYSIS_VERSION],
      });
      const ids = [...new Set(patterns.filter((h) => h.score > 0).map((h) => h.id))];
      await db.execute({
        sql: `update map_search_index set pattern_tags = ?, primary_pattern = coalesce(?, primary_pattern) where beatmap_id = ?`,
        args: [ids.length > 0 ? ` ${ids.join(" ")} ` : "", analysis.primary?.id ?? null, beatmapId],
      });
    }
    process.stderr.write(`retag scanned ${scanned}, changed ${changed}\n`);
    if (rows.length < 500) break;
  }
  console.log(`\n=== chart re-tag: scanned ${scanned} stored 7K LN charts, ${changed} changed tags or category`);
  console.log("tag flow at the player-side 0.5 line:", Object.fromEntries([...tagFlow].sort()));
  console.log("category transitions:", Object.fromEntries([...transitions].sort((a, b) => b[1] - a[1]).slice(0, 12)));
}

function printUser(userId: number, before: SideSnap | undefined, after: SideSnap | undefined): void {
  console.log(`\n--- user ${userId}`);
  if (!before || !after) { console.log("  no 7K LN side", { before: Boolean(before), after: Boolean(after) }); return; }
  console.log(`  headline ${before.label} (${before.rawDan.toFixed(2)}) -> ${after.label} (${after.rawDan.toFixed(2)})${after.course ? " [course-floored]" : ""}`);
  for (const id of TILES) {
    const b = before.tiles[id], a = after.tiles[id];
    const fmt = (t?: SideSnap["tiles"][string]) => t ? `${t.label} (${t.rawDan.toFixed(2)}, ${t.clears} clears${t.capped ? ", capped" : ""})` : "absent";
    console.log(`  ${id.padEnd(10)} ${fmt(b)} -> ${fmt(a)}`);
  }
}

async function main(): Promise<void> {
  const db = createClient({ url: DB_URL });
  const detail = new Set([...argList("--detail"), ...argList("--rewrite")]);
  const rewrite = argList("--rewrite");

  console.log("phase 1: deriving stored-tag verdicts");
  const before = await deriveAll(db);
  console.log("phase 2: re-tagging 7K LN charts");
  await retag(db);
  console.log("phase 3: deriving re-tagged verdicts");
  const after = await deriveAll(db);

  console.log(`\n=== population: ${before.size} 7K LN sides before, ${after.size} after`);
  const headlineDeltas: number[] = [];
  const labelMoves = new Map<string, number>();
  const tileDeltas = new Map<string, number[]>();
  const tilePresence = new Map<string, [number, number]>();
  const moves: Array<{ userId: number; b: SideSnap; a: SideSnap }> = [];
  for (const [userId, b] of before) {
    const a = after.get(userId);
    if (!a) continue;
    for (const id of TILES) {
      const p = tilePresence.get(id) ?? [0, 0];
      if (b.tiles[id]) p[0] += 1;
      if (a.tiles[id]) p[1] += 1;
      tilePresence.set(id, p);
      if (b.tiles[id] && a.tiles[id]) (tileDeltas.get(id) ?? tileDeltas.set(id, []).get(id)!).push(a.tiles[id].rawDan - b.tiles[id].rawDan);
    }
    if (b.course || a.course) continue;
    headlineDeltas.push(a.rawDan - b.rawDan);
    if (a.label !== b.label) {
      const k = `${b.label} -> ${a.label}`;
      labelMoves.set(k, (labelMoves.get(k) ?? 0) + 1);
      moves.push({ userId, b, a });
    }
  }
  console.log("tile presence before -> after:", Object.fromEntries([...tilePresence].map(([id, [x, y]]) => [id, `${x} -> ${y}`])));
  for (const id of TILES) {
    const d = tileDeltas.get(id) ?? [];
    console.log(`tile ${id.padEnd(10)} delta (after - before): ${quantiles(d)}; moved ${d.filter((v) => Math.abs(v) >= 0.05).length}`);
  }
  console.log(`headline delta: ${quantiles(headlineDeltas)}; nonzero ${headlineDeltas.filter((v) => Math.abs(v) >= 0.05).length}, label moved ${moves.length}`);
  console.log("label transitions:", Object.fromEntries([...labelMoves].sort((x, y) => y[1] - x[1])));
  moves.sort((x, y) => Math.abs(y.a.rawDan - y.b.rawDan) - Math.abs(x.a.rawDan - x.b.rawDan));
  for (const m of moves.slice(0, 20)) console.log(`  ${m.userId} ${m.b.label} -> ${m.a.label} (${m.b.rawDan.toFixed(2)} -> ${m.a.rawDan.toFixed(2)}) ` + TILES.map((id) => `${id.replace("ln", "")}=${m.b.tiles[id]?.rawDan.toFixed(1) ?? "-"}>${m.a.tiles[id]?.rawDan.toFixed(1) ?? "-"}`).join(" "));

  for (const userId of detail) printUser(userId, before.get(userId), after.get(userId));

  for (const userId of rewrite) {
    // Local rows lag PLAYER_SKILLS_VERSION (workers are off), and the chunk
    // only rewrites current-version rows; lift the row so it qualifies.
    await db.execute({ sql: "update player_skill_ratings set analysis_version = ? where user_id = ? and status = 'ready'", args: [PLAYER_SKILLS_VERSION, userId] });
    const result = await recomputePlayerSkillDanChunk(db, userId - 1, 1);
    console.log(`rewrite ${userId}: scanned ${result.scanned}, rewritten ${result.rewritten}`);
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
