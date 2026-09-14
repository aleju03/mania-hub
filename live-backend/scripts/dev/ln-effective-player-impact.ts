/* What the effective-LN model does to one player's stored 4K skill row on the
   local DB: every 4K play re-rated through the current tail pass (free holds
   demoted), the LN tag re-read at the play's own rate, and the LN axis, the
   Overall axis and their percentiles (against the stored baseline curves)
   before and after. Read-only; nothing is written. Run from live-backend/:
     npx tsx scripts/dev/ln-effective-player-impact.ts <username|user id> [--all-plays] */
import { createDb, exec, parseJson } from "../../src/db.js";
import { parseManiaBeatmap } from "../../src/dan/beatmap-parser.js";
import { analyzeEffectiveLn } from "../../src/dan/dan-estimator/ln-effective.js";

import { CHART_ANALYSIS_VERSION } from "../../src/features/chart-analysis.js";
import { aggregateSsrs, computePlaySsrValues, loadBeatmapOds, type StoredPlaySsr } from "../../src/features/player-skills.js";
import { percentileFromCurve, readExactSkillCurves } from "../../src/features/skill-baseline.js";
import { readCachedBeatmapFile } from "../../src/osu/beatmap-file-cache.js";

const args = process.argv.slice(2);
const who = args.find((arg) => !arg.startsWith("--"));
if (!who) {
  console.error("usage: npx tsx scripts/dev/ln-effective-player-impact.ts <username|user id> [--all-plays]");
  process.exit(1);
}
const ALL_PLAYS = args.includes("--all-plays");
const DB_URL = process.env.DATABASE_URL ?? "file:./data/mania-hub-live.db";
const db = await createDb({ databaseUrl: DB_URL, sqliteCacheMb: 8, sqliteMmapMb: 0 });

const userRow = (await exec(
  db,
  /^\d+$/.test(who) ? "select user_id, username from users where user_id = ?" : "select user_id, username from users where lower(username) = lower(?)",
  [who],
)).rows[0];
if (!userRow) {
  console.error(`no user ${who} in the local DB`);
  process.exit(1);
}
const userId = Number(userRow.user_id);
const skillRow = (await exec(db, "select analysis_version, plays_json, modes_json from player_skill_ratings where user_id = ? limit 1", [userId])).rows[0];
if (!skillRow) {
  console.error(`no player_skill_ratings row for ${String(userRow.username)}`);
  process.exit(1);
}
const plays = (parseJson<{ plays?: StoredPlaySsr[] }>(String(skillRow.plays_json ?? ""), {}).plays ?? [])
  .filter((play) => play.keyCount === 4 && !play.inverse);
const modes = parseJson<{ modes?: Array<{ keyCount: number; ratings: Record<string, number>; patterns: Array<{ id: string; rating: number; plays: number }> }> }>(String(skillRow.modes_json ?? ""), {}).modes ?? [];
const mode4 = modes.find((mode) => mode.keyCount === 4);
console.log(`${String(userRow.username)} (${userId}), stored row v${String(skillRow.analysis_version)}: ${plays.length} rated 4K plays`);

const ods = await loadBeatmapOds(db, plays.map((play) => play.beatmapId));
const analysisRows = (await exec(
  db,
  `select beatmap_id, json_extract(classification_json, '$.lnRatio') as ln_ratio
   from beatmap_chart_analysis where analysis_version = ? and status = 'ready'
     and beatmap_id in (${plays.map(() => "?").join(",")})`,
  [CHART_ANALYSIS_VERSION, ...plays.map((play) => play.beatmapId)],
)).rows;
const holdShareByBeatmap = new Map(analysisRows.map((row) => [Number(row.beatmap_id), Number(row.ln_ratio)]));

interface Rerated { play: StoredPlaySsr; before: number; after: number; lnAfter: number; wasLn: boolean; isLn: boolean; effective: number; name: string }
const rerated: Rerated[] = [];
const started = Date.now();
for (const play of plays) {
  const wasLn = (play.patterns ?? []).includes("ln");
  const holdShare = holdShareByBeatmap.get(play.beatmapId) ?? 0;
  // Rice charts build the same rows either way; skip their calc unless asked.
  if (!ALL_PLAYS && !wasLn && !(holdShare > 0.02)) {
    rerated.push({ play, before: Number(play.values.Overall ?? 0), after: Number(play.values.Overall ?? 0), lnAfter: 0, wasLn, isLn: false, effective: 0, name: "" });
    continue;
  }
  const osuText = await readCachedBeatmapFile(db, play.beatmapId, { touch: false }).catch(() => null);
  if (!osuText) {
    rerated.push({ play, before: Number(play.values.Overall ?? 0), after: Number(play.values.Overall ?? 0), lnAfter: 0, wasLn, isLn: false, effective: Number.NaN, name: "(no cached .osu; LN pending)" });
    continue;
  }
  const map = parseManiaBeatmap(osuText);
  const od = play.odOverride ?? ods.get(play.beatmapId) ?? map.od;
  const effective = analyzeEffectiveLn(map.notes, { rate: play.rate, od }).effectiveLnRatio;
  const ssr = await computePlaySsrValues(osuText, { rate: play.rate, keyCount: 4, goal: play.goal, od });
  const isLn = ssr?.lnSkill?.eligible === true;
  rerated.push({
    play,
    before: Number(play.values.Overall ?? 0),
    after: Number(ssr?.values.Overall ?? play.values.Overall ?? 0),
    lnAfter: Number(ssr?.values.LN ?? 0),
    wasLn,
    isLn,
    effective,
    name: `${map.title} [${map.version}]`,
  });
}
console.log(`re-rated in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

const curves = await readExactSkillCurves(db);
const curveFor = (axis: string) => curves?.curves?.["4"]?.[axis]?.curve ?? null;
const pct = (axis: string, value: number) => {
  const curve = curveFor(axis);
  return curve ? `top ${(100 - percentileFromCurve(curve, value)).toFixed(1)}%` : "no curve";
};

const lnBefore = rerated.filter((r) => r.wasLn);
const lnAfter = rerated.filter((r) => r.isLn);
const lnRatingBefore = aggregateSsrs(lnBefore.map((r) => r.play.lnSkill ? Number(r.play.values.LN ?? 0) : r.before));
const lnRatingAfter = aggregateSsrs(lnAfter.map((r) => r.lnAfter));
const overallBefore = aggregateSsrs(rerated.map((r) => r.before));
const overallAfter = aggregateSsrs(rerated.map((r) => r.after));
console.log(`LN axis:      before ${lnRatingBefore.toFixed(2)} over ${lnBefore.length} plays (stored model)  ->  independent LN ${lnRatingAfter.toFixed(2)} over ${lnAfter.length} plays (${pct("pattern:ln", lnRatingAfter)})`);
if (mode4) console.log(`              stored row says LN ${mode4.patterns.find((p) => p.id === "ln")?.rating ?? "-"} / Overall ${mode4.ratings.Overall}`);
console.log(`Overall axis: before ${overallBefore.toFixed(2)} (${pct("Overall", overallBefore)})  ->  after ${overallAfter.toFixed(2)} (${pct("Overall", overallAfter)})`);

console.log("\nLN-tagged plays, by stored SSR:");
for (const r of [...lnBefore].sort((a, b) => b.before - a.before)) {
  const tag = r.isLn ? "LN  " : "rice";
  console.log(`  ${tag}  ${r.play.rate.toFixed(2)}x  goal ${r.play.goal.toFixed(3)}  eff ${Number.isFinite(r.effective) ? r.effective.toFixed(2) : "  ? "}  Overall ${r.before.toFixed(2)} -> ${r.after.toFixed(2)}  LN ${r.lnAfter.toFixed(2)}  ${r.play.beatmapId}  ${r.name.slice(0, 60)}`);
}
db.close();
