/**
 * Measures the 2026-08-31 credit-window widening over the whole local corpus:
 * how many stored verdicts move, and which labels they move between.
 *
 * The "after" verdict is the shipped fold itself. The "before" verdict is
 * derived rather than reimplemented, which is exact here because the widening
 * added a knee at the old window's edge and kept the line above it: every
 * accuracy the old window credited credits the identical value today, so the
 * only difference between the two folds is the clears that sit inside the new
 * band and outside the old one. Dropping those from the same clear list IS the
 * old fold.
 *
 * Read-only. Run:
 *   npx tsx scripts/dev/dan-window-impact.ts [--limit N]
 */
import { createClient } from "@libsql/client";
import {
  MAX_RATE_PERCENT,
  MIN_RATE_PERCENT,
  loadStoredRateDanVerdicts,
  rateDanVerdictKey,
} from "../../src/features/dan-estimates.js";
import {
  collectDanClearsForTest,
  danSideFromClearEvidenceForTest,
  loadChartSkillInfo,
  loadPlayerDanCourseClears,
} from "../../src/features/player-skills.js";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";
const CHUNK = 200;
const EDGE = 1e-9;

/** The windows as they stood before the widening (dan-credit.ts). */
function oldBelowBarWindow(side: "rc" | "ln", keyCount: number): number {
  if (side !== "ln") return 0.04;
  return keyCount === 4 ? 0.025 : 0.01;
}

function clearRatePercent(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return null;
  const percent = Math.round(rate * 100);
  if (percent === 100 || percent < MIN_RATE_PERCENT || percent > MAX_RATE_PERCENT) return null;
  return percent;
}

function parse<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit");
  const userLimit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Number.POSITIVE_INFINITY;
  // One id, for asking what the widening alone did to a single player.
  const userArg = process.argv.indexOf("--user");
  const onlyUser = userArg >= 0 ? Number(process.argv[userArg + 1]) : null;
  const db = createClient({ url: DB_URL });

  let cursor = 0;
  let scanned = 0;
  let usersWithAnyMove = 0;
  let sidesMoved = 0;
  let sidesSeen = 0;
  let labelMoves = 0;
  let newSides = 0;
  const transitions = new Map<string, number>();
  const deltas: number[] = [];
  const examples: string[] = [];
  /** Rated sides and moved sides per level band, to see who the widening reaches. */
  const seenByBand = new Map<string, number>();
  const movedByBand = new Map<string, number>();
  const deltaByBand = new Map<string, number[]>();
  const band = (rawDan: number) => rawDan < 3 ? "00-03"
    : rawDan < 6 ? "03-06"
      : rawDan < 9 ? "06-09"
        : rawDan < 12 ? "09-12"
          : rawDan < 15 ? "12-15" : "15+";
  /** Every side that moved, so the extremes per keymode can be named. */
  const moves: Array<{
    userId: number; keyCount: number; side: "rc" | "ln";
    before: string; after: string; beforeDan: number; afterDan: number; delta: number;
  }> = [];

  for (;;) {
    if (scanned >= userLimit) break;
    const rows = (await db.execute({
      sql: `select user_id, modes_json, plays_json from player_skill_ratings
            where user_id > ? and status = 'ready' ${onlyUser != null ? "and user_id = ?" : ""}
            order by user_id limit ?`,
      args: onlyUser != null ? [cursor, onlyUser, CHUNK] : [cursor, CHUNK],
    })).rows;
    if (rows.length === 0) break;

    const parsed: Array<{ userId: number; keyCounts: number[]; plays: any[] }> = [];
    const beatmapIds: number[] = [];
    for (const row of rows) {
      cursor = Math.max(cursor, Number(row.user_id));
      const summary = parse<{ modes?: Array<{ keyCount: number }> } | null>(row.modes_json, null);
      const stored = parse<{ plays?: any[] } | null>(row.plays_json, null);
      const plays = (Array.isArray(stored?.plays) ? stored!.plays : [])
        .filter((play) => play && Number.isInteger(play.beatmapId) && play.beatmapId > 0);
      if (!summary?.modes?.length || plays.length === 0) continue;
      parsed.push({ userId: Number(row.user_id), keyCounts: summary.modes.map((mode) => mode.keyCount), plays });
      for (const play of plays) beatmapIds.push(play.beatmapId);
    }

    const info = await loadChartSkillInfo(db as any, beatmapIds);
    const pairs: Array<{ beatmapId: number; ratePercent: number }> = [];
    for (const entry of parsed) {
      for (const play of entry.plays) {
        const percent = clearRatePercent(play.rate);
        if (percent != null) pairs.push({ beatmapId: play.beatmapId, ratePercent: percent });
      }
    }
    const stored = await loadStoredRateDanVerdicts(db as any, pairs);
    const rateVerdicts = new Map<string, any>();
    for (const [key, verdict] of stored) {
      rateVerdicts.set(key, verdict
        ? { rawDan: verdict.rawDan, side: verdict.family === "ln" ? "ln" : "rc", displayName: verdict.displayName }
        : null);
    }
    void rateDanVerdictKey;

    for (const entry of parsed) {
      scanned += 1;
      const courseClears = await loadPlayerDanCourseClears(db as any, entry.userId);
      let moved = false;
      for (const keyCount of new Set(entry.keyCounts)) {
        const modePlays = entry.plays.filter((play) => play.keyCount === keyCount);
        if (modePlays.length === 0) continue;
        const clears = collectDanClearsForTest(keyCount, modePlays, info, rateVerdicts);
        for (const side of ["rc", "ln"] as const) {
          const sideClears = clears.filter((clear) => clear.side === side);
          const window = oldBelowBarWindow(side, keyCount);
          const oldClears = sideClears.filter((clear) =>
            clear.accuracy == null || clear.bar == null || clear.accuracy >= clear.bar - window - EDGE);
          const after = danSideFromClearEvidenceForTest(keyCount, side, sideClears, info, courseClears);
          if (after) {
            sidesSeen += 1;
            const key = `${keyCount}K ${side} ${band(after.rawDan)}`;
            seenByBand.set(key, (seenByBand.get(key) ?? 0) + 1);
          }
          if (sideClears.length === oldClears.length) continue;
          const before = danSideFromClearEvidenceForTest(keyCount, side, oldClears, info, courseClears);
          if (!after && !before) continue;
          if (!before && after) {
            newSides += 1;
            moved = true;
            if (examples.length < 25) examples.push(`${entry.userId} ${keyCount}K ${side}: (none) -> ${after.label}`);
            continue;
          }
          if (!after || !before) continue;
          if (Math.abs(after.rawDan - before.rawDan) < 1e-9 && after.label === before.label) continue;
          sidesMoved += 1;
          moved = true;
          deltas.push(after.rawDan - before.rawDan);
          const bandKey = `${keyCount}K ${side} ${band(before.rawDan)}`;
          movedByBand.set(bandKey, (movedByBand.get(bandKey) ?? 0) + 1);
          const bandDeltas = deltaByBand.get(bandKey) ?? [];
          bandDeltas.push(after.rawDan - before.rawDan);
          deltaByBand.set(bandKey, bandDeltas);
          moves.push({
            userId: entry.userId,
            keyCount,
            side,
            before: before.label,
            after: after.label,
            beforeDan: before.rawDan,
            afterDan: after.rawDan,
            delta: after.rawDan - before.rawDan,
          });
          if (after.label !== before.label) {
            labelMoves += 1;
            const key = `${keyCount}K ${side}: ${before.label} -> ${after.label}`;
            transitions.set(key, (transitions.get(key) ?? 0) + 1);
            if (examples.length < 25) {
              examples.push(`${entry.userId} ${key} (${before.rawDan.toFixed(2)} -> ${after.rawDan.toFixed(2)})`);
            }
          }
        }
      }
      if (moved) usersWithAnyMove += 1;
    }
    process.stderr.write(`scanned ${scanned}, moved ${usersWithAnyMove}\n`);
    if (rows.length < CHUNK) break;
  }

  // Name the extremes: the fold works off ids, the report is for people.
  const names = new Map<number, string>();
  const movers = [...new Set(moves.map((move) => move.userId))];
  for (let index = 0; index < movers.length; index += 400) {
    const batch = movers.slice(index, index + 400);
    const rows = (await db.execute({
      sql: `select user_id, username from users where user_id in (${batch.map(() => "?").join(",")})`,
      args: batch,
    })).rows;
    for (const row of rows) names.set(Number(row.user_id), String(row.username ?? ""));
  }
  const describe = (move: typeof moves[number]) =>
    `${names.get(move.userId) ?? move.userId} (${move.userId}) ${move.keyCount}K ${move.side}: `
    + `${move.before} -> ${move.after} (${move.beforeDan.toFixed(2)} -> ${move.afterDan.toFixed(2)}, ${move.delta >= 0 ? "+" : ""}${move.delta.toFixed(2)})`;
  const extremes: Record<string, unknown> = {};
  for (const keyCount of [4, 7]) {
    const forMode = moves.filter((move) => move.keyCount === keyCount).sort((a, b) => b.delta - a.delta);
    extremes[`${keyCount}K`] = {
      moved: forMode.length,
      mostGained: forMode.slice(0, 10).map(describe),
      mostLost: forMode.slice(-10).reverse().map(describe),
    };
  }

  deltas.sort((a, b) => a - b);
  const mean = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
  console.log(JSON.stringify({
    scannedUsers: scanned,
    sidesSeen,
    usersWithAnyMove,
    sidesWithRawDanMove: sidesMoved,
    sidesWithLabelMove: labelMoves,
    sidesThatDidNotRateBefore: newSides,
    rawDanDelta: deltas.length ? {
      mean: Number(mean.toFixed(4)),
      median: Number(deltas[Math.floor(deltas.length / 2)].toFixed(4)),
      max: Number(deltas[deltas.length - 1].toFixed(4)),
      min: Number(deltas[0].toFixed(4)),
    } : null,
    extremes,
    byBand: [...seenByBand.entries()].sort().map(([key, seen]) => {
      const moved = movedByBand.get(key) ?? 0;
      const values = deltaByBand.get(key) ?? [];
      const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      const absMean = values.length ? values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length : 0;
      return {
        band: key,
        sides: seen,
        moved,
        movedPct: Number(((moved / Math.max(1, seen)) * 100).toFixed(1)),
        meanDelta: Number(mean.toFixed(3)),
        meanAbsDelta: Number(absMean.toFixed(3)),
        maxAbsDelta: Number((values.length ? Math.max(...values.map(Math.abs)) : 0).toFixed(2)),
      };
    }),
    transitions: [...transitions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
    examples,
  }, null, 2));
}

await main();
