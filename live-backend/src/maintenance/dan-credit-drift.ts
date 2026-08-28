import { readConfig } from "../config.js";
import { createDb, exec, parseJson } from "../db.js";
import { loadStoredRateDanVerdicts } from "../features/dan-estimates.js";
import {
  PLAYER_SKILLS_VERSION,
  collectDanClearsForTest,
  danSideFromClearEvidenceForTest,
  loadChartSkillInfo,
} from "../features/player-skills.js";
import type { DanClearEvidence, StoredPlaySsr } from "../features/player-skills.js";

// Read-only report on how the accuracy credit curve (dan-credit.ts) moves the
// dan population: for a sample of ready player_skill_ratings rows it collects
// each side's clears once, aggregates them under the new rule (credited dans)
// and under the old rule (bar-gated clears at the chart's full dan), and
// prints per-ladder drift percentiles, the sides that appear or vanish, and
// the distribution of above-bar headroom (the share sitting at 100% is what
// would justify retuning the top anchor).
//
// Course clears are deliberately skipped: loading them costs per-user queries
// over score_events plus the activity archive, and the course floor can only
// ever raise a headline, so it masks drift rather than creating it.
//
// Usage: node --env-file-if-exists=.env --import tsx src/maintenance/dan-credit-drift.ts [--limit 2000]

const limitArg = process.argv.find((arg) => arg.startsWith("--limit"));
const limit = Math.max(1, Number(limitArg?.split("=")[1] ?? process.argv[process.argv.indexOf("--limit") + 1] ?? 2000) || 2000);

const config = readConfig();
const db = await createDb(config);

interface LadderStats {
  ratedOld: number;
  ratedNew: number;
  gained: number;
  lost: number;
  drifts: number[];
  beyondOld: number;
  beyondNew: number;
  headroomTs: number[];
  subBarShareOfWindows: number;
  windows: number;
}

const ladders = new Map<string, LadderStats>();
const statsFor = (key: string): LadderStats => {
  let stats = ladders.get(key);
  if (!stats) {
    stats = { ratedOld: 0, ratedNew: 0, gained: 0, lost: 0, drifts: [], beyondOld: 0, beyondNew: 0, headroomTs: [], subBarShareOfWindows: 0, windows: 0 };
    ladders.set(key, stats);
  }
  return stats;
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

// Same shape the clear rules use for rate lookups (clearRatePercent is
// private to player-skills.ts on purpose; this mirrors it for the report).
const ratePercentFor = (rate: number): number | null => {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return null;
  const percent = Math.round(rate * 100);
  return percent === 100 || percent < 50 || percent > 200 ? null : percent;
};

const rows = (await exec(
  db,
  `select user_id, plays_json from player_skill_ratings
   where status = 'ready' and analysis_version = ?
   order by user_id limit ?`,
  [PLAYER_SKILLS_VERSION, limit],
)).rows;

let users = 0;
for (const row of rows) {
  const stored = parseJson<{ plays?: StoredPlaySsr[] } | null>(String(row.plays_json ?? ""), null);
  const plays = (Array.isArray(stored?.plays) ? stored.plays : [])
    .filter((play) => play && Number.isInteger(play.beatmapId) && play.beatmapId > 0);
  if (plays.length === 0) continue;
  users += 1;

  const pairs = plays.flatMap((play) => {
    const ratePercent = ratePercentFor(play.rate);
    return ratePercent == null ? [] : [{ beatmapId: play.beatmapId, ratePercent }];
  });
  const storedVerdicts = await loadStoredRateDanVerdicts(db, pairs);
  const rateVerdicts = new Map(
    [...storedVerdicts].map(([key, verdict]) => [
      key,
      verdict ? { rawDan: verdict.rawDan, side: verdict.family === "ln" ? ("ln" as const) : ("rc" as const) } : null,
    ]),
  );

  const byKeyCount = new Map<number, StoredPlaySsr[]>();
  for (const play of plays) {
    const list = byKeyCount.get(play.keyCount) ?? [];
    list.push(play);
    byKeyCount.set(play.keyCount, list);
  }

  for (const [keyCount, keymodePlays] of byKeyCount) {
    const infoByBeatmap = await loadChartSkillInfo(db, keymodePlays.map((play) => play.beatmapId));
    if (infoByBeatmap.size === 0) continue;
    const clears = collectDanClearsForTest(keyCount, keymodePlays, infoByBeatmap, rateVerdicts);
    for (const side of ["rc", "ln"] as const) {
      const sideClears = clears.filter((clear) => clear.side === side);
      if (sideClears.length === 0) continue;
      const stats = statsFor(`${keyCount}K ${side}`);

      for (const clear of sideClears) {
        if (clear.accuracy >= clear.bar - 1e-9) {
          const headroom = 1 - clear.bar;
          stats.headroomTs.push(headroom > 0 ? Math.min(1, (clear.accuracy - clear.bar) / headroom) : 1);
        }
      }

      const oldClears: DanClearEvidence[] = sideClears
        .filter((clear) => clear.accuracy >= clear.bar - 1e-9)
        .map((clear) => ({ ...clear, creditedDan: clear.chartDan }));
      const oldSide = danSideFromClearEvidenceForTest(keyCount, side, oldClears, infoByBeatmap);
      const newSide = danSideFromClearEvidenceForTest(keyCount, side, sideClears, infoByBeatmap);

      if (oldSide) stats.ratedOld += 1;
      if (newSide) stats.ratedNew += 1;
      if (newSide && !oldSide) stats.gained += 1;
      if (oldSide && !newSide) stats.lost += 1;
      if (oldSide?.beyondTable) stats.beyondOld += 1;
      if (newSide?.beyondTable) stats.beyondNew += 1;
      if (oldSide && newSide) stats.drifts.push(Math.round((newSide.rawDan - oldSide.rawDan) * 100) / 100);

      if (newSide) {
        stats.windows += 1;
        const window = [...sideClears].sort((a, b) => b.creditedDan - a.creditedDan).slice(0, 5);
        if (window.some((clear) => clear.accuracy < clear.bar - 1e-9)) stats.subBarShareOfWindows += 1;
      }
    }
  }
}

console.log(`dan-credit drift over ${users} sampled players (limit ${limit}), analysis v${PLAYER_SKILLS_VERSION}, course floors skipped\n`);
for (const [ladder, stats] of [...ladders].sort(([a], [b]) => a.localeCompare(b))) {
  const d = stats.drifts;
  const t = stats.headroomTs;
  const maxedShare = t.length > 0 ? t.filter((value) => value >= 1 - 1e-9).length / t.length : 0;
  console.log(`${ladder}: rated ${stats.ratedOld} -> ${stats.ratedNew} (gained ${stats.gained}, lost ${stats.lost}), beyondTable ${stats.beyondOld} -> ${stats.beyondNew}`);
  console.log(
    `  drift (both rated, n=${d.length}): p1 ${percentile(d, 1)} p10 ${percentile(d, 10)} p50 ${percentile(d, 50)} p90 ${percentile(d, 90)} p99 ${percentile(d, 99)} mean ${
      d.length > 0 ? Math.round((d.reduce((sum, value) => sum + value, 0) / d.length) * 1000) / 1000 : Number.NaN
    }`,
  );
  console.log(
    `  above-bar headroom t (n=${t.length}): p50 ${percentile(t, 50).toFixed(3)} p75 ${percentile(t, 75).toFixed(3)} p90 ${percentile(t, 90).toFixed(3)} p99 ${percentile(t, 99).toFixed(3)}, share at t=1: ${(maxedShare * 100).toFixed(1)}%`,
  );
  console.log(
    `  windows containing a sub-bar credit: ${stats.subBarShareOfWindows}/${stats.windows} (${stats.windows > 0 ? ((stats.subBarShareOfWindows / stats.windows) * 100).toFixed(1) : "0"}%)\n`,
  );
}

db.close();
