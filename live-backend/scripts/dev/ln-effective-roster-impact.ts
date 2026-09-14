/* Roster-wide tag impact of the effective-LN model on the local DB: over every
   stored player_skill_ratings row, which 4K LN-tagged plays keep the LN tag
   at their own rate, and how many players' LN axis (min 3 plays) survives.
   No MinaCalc, so the SSR shift is not measured here (see
   ln-effective-player-impact.ts for one player). Read-only. Run from
   live-backend/:
     npx tsx scripts/dev/ln-effective-roster-impact.ts [--limit N] */
import { createDb, exec, parseJson } from "../../src/db.js";
import { parseManiaBeatmap } from "../../src/dan/beatmap-parser.js";
import { analyzeEffectiveLn, chartIsLn } from "../../src/dan/dan-estimator/ln-effective.js";

import { CHART_ANALYSIS_VERSION } from "../../src/features/chart-analysis.js";
import type { StoredPlaySsr } from "../../src/features/player-skills.js";
import { readCachedBeatmapFile } from "../../src/osu/beatmap-file-cache.js";

const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const LIMIT = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 0;
const DB_URL = process.env.DATABASE_URL ?? "file:./data/mania-hub-live.db";
const db = await createDb({ databaseUrl: DB_URL, sqliteCacheMb: 8, sqliteMmapMb: 0 });
const MIN_PLAYS = 3;

const rows = (await exec(
  db,
  `select user_id, plays_json from player_skill_ratings order by user_id ${LIMIT > 0 ? `limit ${Math.floor(LIMIT)}` : ""}`,
)).rows;

interface PlayerLn { userId: number; plays: Array<{ beatmapId: number; rate: number; od: number | null }> }
const players: PlayerLn[] = [];
const pairs = new Set<string>();
for (const row of rows) {
  const plays = (parseJson<{ plays?: StoredPlaySsr[] }>(String(row.plays_json ?? ""), {}).plays ?? [])
    .filter((play) => play.keyCount === 4 && !play.inverse && (play.patterns ?? []).includes("ln"))
    .map((play) => ({ beatmapId: play.beatmapId, rate: play.rate, od: play.odOverride ?? null }));
  players.push({ userId: Number(row.user_id), plays });
  for (const play of plays) pairs.add(`${play.beatmapId}:${play.rate}:${play.od ?? ""}`);
}
console.log(`${rows.length} skill rows, ${players.filter((p) => p.plays.length > 0).length} with 4K LN-tagged plays, ${pairs.size} distinct (chart, rate, OD) pairs`);

const holdShareRows = (await exec(
  db,
  `select beatmap_id, json_extract(classification_json, '$.lnRatio') as ln_ratio
   from beatmap_chart_analysis where analysis_version = ? and status = 'ready' and key_count = 4`,
  [CHART_ANALYSIS_VERSION],
)).rows;
const holdShare = new Map(holdShareRows.map((row) => [Number(row.beatmap_id), Number(row.ln_ratio)]));
const odRows = (await exec(db, "select beatmap_id, json_extract(metadata_json, '$.accuracy') as od from beatmaps where json_valid(metadata_json)")).rows;
const storedOd = new Map(odRows.map((row) => [Number(row.beatmap_id), Number(row.od)]));

const started = Date.now();
const keepsLn = new Map<string, boolean>();
const notesByBeatmap = new Map<number, { notes: ReturnType<typeof parseManiaBeatmap>["notes"]; od: number } | null>();
for (const key of pairs) {
  const [idRaw, rateRaw, odRaw] = key.split(":");
  const beatmapId = Number(idRaw);
  const rate = Number(rateRaw);
  if (!notesByBeatmap.has(beatmapId)) {
    const text = await readCachedBeatmapFile(db, beatmapId, { touch: false }).catch(() => null);
    let parsed: { notes: ReturnType<typeof parseManiaBeatmap>["notes"]; od: number } | null = null;
    if (text) {
      try {
        const map = parseManiaBeatmap(text);
        parsed = { notes: map.notes, od: map.od };
      } catch {
        parsed = null;
      }
    }
    notesByBeatmap.set(beatmapId, parsed);
  }
  const chart = notesByBeatmap.get(beatmapId);
  if (!chart) {
    // No file: the tag stays as stored.
    keepsLn.set(key, true);
    continue;
  }
  const od = odRaw !== "" ? Number(odRaw) : storedOd.get(beatmapId) ?? chart.od;
  const effective = analyzeEffectiveLn(chart.notes, { rate, od }).effectiveLnRatio;
  keepsLn.set(key, chartIsLn(4, {
    lnRatio: holdShare.get(beatmapId) ?? 1,
    lnEffectiveRatio: effective,
  }) === true);
}
console.log(`analysed ${notesByBeatmap.size} charts in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

let playsBefore = 0;
let playsAfter = 0;
const byRate = new Map<number, { before: number; after: number }>();
let axisBefore = 0;
let axisAfter = 0;
let axisLost = 0;
const lostShare: number[] = [];
for (const player of players) {
  const kept = player.plays.filter((play) => keepsLn.get(`${play.beatmapId}:${play.rate}:${play.od ?? ""}`) !== false);
  playsBefore += player.plays.length;
  playsAfter += kept.length;
  for (const play of player.plays) {
    const bucket = byRate.get(play.rate) ?? { before: 0, after: 0 };
    bucket.before += 1;
    if (keepsLn.get(`${play.beatmapId}:${play.rate}:${play.od ?? ""}`) !== false) bucket.after += 1;
    byRate.set(play.rate, bucket);
  }
  const hadAxis = player.plays.length >= MIN_PLAYS;
  const hasAxis = kept.length >= MIN_PLAYS;
  if (hadAxis) axisBefore += 1;
  if (hasAxis) axisAfter += 1;
  if (hadAxis && !hasAxis) axisLost += 1;
  if (hadAxis) lostShare.push(1 - kept.length / player.plays.length);
}
console.log(`LN-tagged 4K plays: ${playsBefore} -> ${playsAfter} keep the tag (${(100 * playsAfter / Math.max(1, playsBefore)).toFixed(0)}%)`);
for (const [rate, bucket] of [...byRate.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  at ${rate.toFixed(2)}x: ${bucket.before} -> ${bucket.after} (${(100 * bucket.after / Math.max(1, bucket.before)).toFixed(0)}%)`);
}
console.log(`players with an LN axis (>= ${MIN_PLAYS} plays): ${axisBefore} -> ${axisAfter} (${axisLost} lose it)`);
const sorted = [...lostShare].sort((a, b) => a - b);
const q = (p: number) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : 0);
console.log(`share of a player's LN plays that lose the tag: median ${(100 * q(0.5)).toFixed(0)}%  p75 ${(100 * q(0.75)).toFixed(0)}%  p90 ${(100 * q(0.9)).toFixed(0)}%`);
db.close();
