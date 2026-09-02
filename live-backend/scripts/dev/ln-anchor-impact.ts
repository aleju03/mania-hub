/**
 * Measures 7K LN's four tiles against each other over the local corpus, and
 * what a General-anchored headline would do to the stored verdicts.
 *
 * Read-only. Run:
 *   npx tsx scripts/dev/ln-anchor-impact.ts [--limit N] [--user ID]
 */
import { createClient } from "@libsql/client";
import { MAX_RATE_PERCENT, MIN_RATE_PERCENT, loadStoredRateDanVerdicts } from "../../src/features/dan-estimates.js";
import {
  collectDanClearsForTest,
  danLabelForTest,
  danSideFromClearEvidenceForTest,
  loadChartSkillInfo,
  loadPlayerDanCourseClears,
} from "../../src/features/player-skills.js";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";
const CHUNK = 200;
const CLAMP = Number(process.env.ANCHOR_CLAMP ?? 2);
const PULL = Number(process.env.ANCHOR_PULL ?? 0.5);

function clearRatePercent(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return null;
  const percent = Math.round(rate * 100);
  if (percent === 100 || percent < MIN_RATE_PERCENT || percent > MAX_RATE_PERCENT) return null;
  return percent;
}
function parse<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; }
}
function quantiles(values: number[]): string {
  if (values.length === 0) return "n=0";
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
  return `n=${s.length} p10=${q(0.1)} p25=${q(0.25)} med=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} min=${s[0].toFixed(2)} max=${s[s.length - 1].toFixed(2)}`;
}
function anchored(skillsets: Record<string, { rawDan: number }>): number | null {
  const general = skillsets.lngeneral?.rawDan;
  if (general == null) return null;
  const others = Object.entries(skillsets).filter(([id]) => id !== "lngeneral").map(([, v]) => v.rawDan);
  if (others.length === 0) return general;
  const mean = others.reduce((sum, v) => sum + Math.max(-CLAMP, Math.min(CLAMP, v - general)), 0) / others.length;
  return Math.round((general + PULL * mean) * 100) / 100;
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit");
  const userLimit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Number.POSITIVE_INFINITY;
  const userArg = process.argv.indexOf("--user");
  const onlyUser = userArg >= 0 ? Number(process.argv[userArg + 1]) : null;
  const db = createClient({ url: DB_URL });

  let cursor = 0;
  let scanned = 0;
  let sides = 0;
  let withCourse = 0;
  let fallback = 0;
  const tileCount = new Map<string, number>();
  const tilePresence = new Map<string, number>();
  const gapByTile = new Map<string, number[]>();
  const gapByBand = new Map<string, number[]>();
  const lowestTile = new Map<string, number>();
  const releaseHave: number[] = [];
  const deltas: number[] = [];
  const transitions = new Map<string, number>();
  const moves: Array<{ userId: number; before: string; after: string; b: number; a: number; tiles: string }> = [];
  const band = (d: number) => d < 6 ? "00-06" : d < 9 ? "06-09" : d < 12 ? "09-12" : d < 15 ? "12-15" : d < 18 ? "15-18" : "18+";

  for (;;) {
    if (scanned >= userLimit) break;
    const rows = (await db.execute({
      sql: `select user_id, modes_json, plays_json from player_skill_ratings
            where user_id > ? and status = 'ready' ${onlyUser != null ? "and user_id = ?" : ""}
            order by user_id limit ?`,
      args: onlyUser != null ? [cursor, onlyUser, CHUNK] : [cursor, CHUNK],
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
    const info = await loadChartSkillInfo(db as any, beatmapIds);
    const pairs: Array<{ beatmapId: number; ratePercent: number }> = [];
    for (const entry of parsed) for (const play of entry.plays) {
      const percent = clearRatePercent(play.rate);
      if (percent != null) pairs.push({ beatmapId: play.beatmapId, ratePercent: percent });
    }
    const stored = await loadStoredRateDanVerdicts(db as any, pairs);
    const rateVerdicts = new Map<string, any>();
    for (const [key, verdict] of stored) {
      rateVerdicts.set(key, verdict ? { rawDan: verdict.rawDan, side: verdict.family === "ln" ? "ln" : "rc", displayName: verdict.displayName } : null);
    }
    for (const entry of parsed) {
      scanned += 1;
      const courseClears = await loadPlayerDanCourseClears(db as any, entry.userId);
      const clears = collectDanClearsForTest(7, entry.plays, info, rateVerdicts).filter((c) => c.side === "ln");
      const side = danSideFromClearEvidenceForTest(7, "ln", clears, info, courseClears);
      if (!side) continue;
      sides += 1;
      if (side.courseClear) withCourse += 1;
      const skillsets = side.skillsets ?? {};
      const ids = Object.keys(skillsets);
      tileCount.set(String(ids.length), (tileCount.get(String(ids.length)) ?? 0) + 1);
      for (const id of ids) tilePresence.set(id, (tilePresence.get(id) ?? 0) + 1);
      if (skillsets.lnrelease) releaseHave.push(skillsets.lnrelease.clearWindow?.have ?? 0);
      const general = skillsets.lngeneral?.rawDan;
      if (general == null || ids.length < 2) { fallback += 1; continue; }
      let lowest: string | null = null;
      for (const id of ids) {
        if (id === "lngeneral") continue;
        const gap = skillsets[id].rawDan - general;
        (gapByTile.get(id) ?? gapByTile.set(id, []).get(id)!).push(gap);
        if (id === "lnrelease") (gapByBand.get(band(general)) ?? gapByBand.set(band(general), []).get(band(general))!).push(gap);
        if (lowest == null || skillsets[id].rawDan < skillsets[lowest].rawDan) lowest = id;
      }
      if (lowest && skillsets[lowest].rawDan < general) lowestTile.set(lowest, (lowestTile.get(lowest) ?? 0) + 1);
      if (side.courseClear) continue;
      const after = anchored(skillsets);
      if (after == null) continue;
      // The plain mean the headline used before the anchor rule, so the delta
      // reads against the old rule whatever the shipped constants are.
      const tileValues = ids.map((id) => skillsets[id].rawDan);
      const before = Math.round((tileValues.reduce((sum, v) => sum + v, 0) / tileValues.length) * 100) / 100;
      const delta = after - before;
      deltas.push(delta);
      const bl = danLabelForTest(before, "ln", 7);
      const al = danLabelForTest(after, "ln", 7);
      if (bl !== al) {
        transitions.set(`${bl} -> ${al}`, (transitions.get(`${bl} -> ${al}`) ?? 0) + 1);
        moves.push({ userId: entry.userId, before: bl, after: al, b: before, a: after,
          tiles: ids.map((id) => `${id.replace("ln", "")}=${skillsets[id].rawDan.toFixed(1)}`).join(" ") });
      }
    }
    process.stderr.write(`scanned ${scanned}, sides ${sides}\n`);
    if (rows.length < CHUNK) break;
  }

  console.log(`clamp=${CLAMP} pull=${PULL}`);
  console.log(`7K players scanned ${scanned}, LN sides rated ${sides}, course-floored ${withCourse}, no-general-or-single-tile ${fallback}`);
  console.log("tiles per side:", Object.fromEntries([...tileCount].sort()));
  console.log("tile presence:", Object.fromEntries(tilePresence));
  console.log("release tile window have:", quantiles(releaseHave));
  for (const [id, gaps] of gapByTile) console.log(`gap ${id} - general: ${quantiles(gaps)}  under by 2+: ${(100 * gaps.filter((g) => g <= -2).length / gaps.length).toFixed(1)}%`);
  console.log("release gap by general band:");
  for (const [b, gaps] of [...gapByBand].sort()) console.log(`  ${b}: ${quantiles(gaps)}`);
  console.log("lowest tile under general:", Object.fromEntries(lowestTile));
  console.log(`headline delta (anchored - current): ${quantiles(deltas)}; moved label ${moves.length}/${deltas.length}`);
  console.log("transitions:", Object.fromEntries([...transitions].sort((a, b) => b[1] - a[1])));
  moves.sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));
  for (const m of moves.slice(0, 25)) console.log(`  ${m.userId} ${m.before} -> ${m.after} (${m.b.toFixed(2)} -> ${m.a.toFixed(2)}) ${m.tiles}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
