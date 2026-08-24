// LN axis plan (ln-axis-plan-2026-08-18.md) — Phase 1/3 offline population fold.
//
// Reads the live DB read-only and reduces every ready v16 player_skill_ratings
// row into per-(player, keymode) cells: the incumbent retention ratios, the
// candidate partitions, placebo partitions (each with its in-cell complement,
// so a candidate's own machinery can run on any partition), split-half halves
// for reliability, pp-source splits and release-load inputs. Emits one JSON
// blob consumed by report-tables.ts / score-labels.ts.
//
// Usage: npx tsx scripts/ln-axis/fold-cells.ts [--db <path>] [--out <path>]
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { aggregateSsrs } from "../../live-backend/src/features/player-skills.js";
import { blendLnTailValues } from "../../live-backend/src/dan/msd.js";

const REPO = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
function argValue(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const dbPath = resolve(argValue("--db", `${REPO}/live-backend/data/mania-hub-live.db`));
const outPath = resolve(argValue("--out", `${REPO}/scripts/ln-axis/out/cells.json`));
// Pre-declared sensitivity refolds (freeze-file.md): rate-1.0 only, top-sourced
// plays only, and depth truncation to the cell's best LN / overall plays.
const rate1Only = args.includes("--rate-1");
const topOnly = args.includes("--top-only");
const truncateLn = Number(argValue("--truncate-ln", "0"));
const truncateN = Number(argValue("--truncate-n", "0"));

const PLAYER_SKILLS_VERSION = 16;
// Mirrors player-skills.ts PATTERN_TAG_MIN_SCORE / TECH_TAG_CHORDJACK_VETO.
const TAG_MIN_SCORE = 0.5;
const TECH_VETO_CHORDJACK = 0.8;
const LN_TAIL_MIN_RATIO = 0.02;

// The value-agnostic MinaCalc poison signature (player-skills.ts isPoisonedPlayValues).
function isPoisonedValues(values: Record<string, number> | undefined | null): boolean {
  const stream = Number(values?.Stream ?? 0);
  return stream > 0 && stream === Number(values?.Technical ?? 0) && stream === Number(values?.Chordjack ?? 0);
}

interface ChartEntry {
  keyCount: number;
  lnTag: number;
  techTag: number;
  cjTag: number;
  jsTag: number;
  csTag: number;
  stTag: number;
  lnRatio: number;
  relDelta: number; // blended tail lift on Overall, exactly as the SSR path applies it
}

// Chart-tag partitions (membership via the chart map) and play-derived
// placebos. Every partition also carries its in-cell complement so the
// LN-Lean-style residual machinery can be run on it as a placebo.
const PARTITION_KEYS = [
  "ln", "ln70", "ln80", "lnr30", "lnr50", "ln_dan",
  "tech", "chordjack", "jumpstream", "chordstream", "stream",
  "offrate", "oldmaps", "parity",
] as const;
type PartitionKey = (typeof PARTITION_KEYS)[number];

interface PartAcc {
  v: number[]; // Overall SSRs of member plays
  rv: number[]; // Overall SSRs of the complement (non-member plays)
  rl: number[]; // release-load deltas of member plays (charts with tail data)
  rrl: number[]; // release-load deltas of complement plays
}

interface CellOut {
  u: number;
  k: number;
  N: number;
  O: number;
  newest: string | null;
  nTop: number;
  nTracked: number;
  OHa: number;
  OHb: number;
  rlAll: number;
  rlAllN: number;
  lnTopN: number;
  lnTrackedN: number;
  parts: Record<string, {
    n: number; A: number; hA: number; hB: number;
    restN: number; restA: number; restHA: number; restHB: number;
    rl: number; rlN: number; rlHA: number; rlHB: number;
    restRl: number; restRlN: number;
  }>;
}

function r6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
function halfOf(values: number[]): [number[], number[]] {
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < values.length; i += 1) (i % 2 === 0 ? a : b).push(values[i]);
  return [a, b];
}
function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

console.log(`opening ${dbPath} read-only`);
const db = new DatabaseSync(dbPath, { readOnly: true });

// --- chart map -------------------------------------------------------------
console.log("building chart map...");
const chartMap = new Map<number, ChartEntry>();
let chartRows = 0;
for (const row of db.prepare(
  `select beatmap_id, key_count, classification_json, msd_json, msd_ln_json
   from beatmap_chart_analysis where status = 'ready' and classification_json is not null`,
).iterate() as IterableIterator<Record<string, unknown>>) {
  chartRows += 1;
  let classification: { lnRatio?: unknown; patterns?: Array<{ id?: unknown; score?: unknown }> } | null = null;
  try {
    classification = JSON.parse(String(row.classification_json ?? ""));
  } catch {
    continue;
  }
  const tags: Record<string, number> = {};
  for (const hit of Array.isArray(classification?.patterns) ? classification.patterns : []) {
    const id = typeof hit.id === "string" ? hit.id : null;
    const score = Number(hit.score);
    if (id && Number.isFinite(score)) tags[id] = score;
  }
  if (Object.keys(tags).length === 0) continue;
  let msd: { values?: Record<string, number> } = {};
  try {
    msd = JSON.parse(String(row.msd_json ?? "{}"));
  } catch {
    // no base MSD -> no release-load input for this chart
  }
  const baseOverall = Number(msd.values?.Overall ?? 0);
  let relDelta = 0;
  const tailsRaw = String(row.msd_ln_json ?? "");
  const lnRatio = Number(classification?.lnRatio);
  const keyCount = Number(row.key_count);
  if (
    tailsRaw && baseOverall > 0
    && [4, 6, 7].includes(keyCount)
    && Number.isFinite(lnRatio) && lnRatio >= LN_TAIL_MIN_RATIO
    && !isPoisonedValues(msd.values)
  ) {
    try {
      const tails = JSON.parse(tailsRaw) as { values?: Record<string, number> };
      const tailOverall = Number(tails.values?.Overall ?? 0);
      if (Number.isFinite(tailOverall) && tailOverall > baseOverall && !isPoisonedValues(tails.values)) {
        relDelta = blendLnTailValues({ Overall: baseOverall }, { Overall: tailOverall }, keyCount).Overall - baseOverall;
      }
    } catch {
      // unreadable tails column: leave relDelta at 0
    }
  }
  chartMap.set(Number(row.beatmap_id), {
    keyCount,
    lnTag: tags.ln ?? 0,
    techTag: tags.tech ?? 0,
    cjTag: tags.chordjack ?? 0,
    jsTag: tags.jumpstream ?? 0,
    csTag: tags.chordstream ?? 0,
    stTag: tags.stream ?? 0,
    lnRatio: Number.isFinite(lnRatio) ? lnRatio : 0,
    relDelta,
  });
}
console.log(`chart map: ${chartMap.size} entries from ${chartRows} ready rows`);

// --- population fold -------------------------------------------------------
console.log("folding player_skill_ratings...");
const cells = new Map<string, CellOut>();
let rowCount = 0;
let playCount = 0;
let poisonDropped = 0;

type StoredPlay = {
  beatmapId?: unknown;
  keyCount?: unknown;
  rate?: unknown;
  source?: unknown;
  endedAt?: unknown;
  values?: Record<string, number>;
};

function newPartAcc(): PartAcc {
  return { v: [], rv: [], rl: [], rrl: [] };
}

for (const row of db.prepare(
  `select user_id, plays_json from player_skill_ratings
   where analysis_version = ? and status = 'ready' and plays_json is not null`,
).iterate(PLAYER_SKILLS_VERSION) as IterableIterator<Record<string, unknown>>) {
  rowCount += 1;
  let stored: { plays?: StoredPlay[] } | null = null;
  try {
    stored = JSON.parse(String(row.plays_json ?? ""));
  } catch {
    continue;
  }
  const plays = Array.isArray(stored?.plays) ? stored.plays : [];
  if (plays.length === 0) continue;
  const byMode = new Map<number, {
    N: number;
    overall: number[];
    newest: string | null;
    nTop: number;
    nTracked: number;
    rlAll: number[];
    lnTopN: number;
    lnTrackedN: number;
    parts: Record<PartitionKey, PartAcc>;
  }>();
  for (const play of plays) {
    if (!play || typeof play !== "object") continue;
    const keyCount = Number(play.keyCount);
    const beatmapId = Number(play.beatmapId);
    if (![4, 6, 7].includes(keyCount) || !Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    const values = play.values;
    if (isPoisonedValues(values)) {
      poisonDropped += 1;
      continue;
    }
    const overall = Number(values?.Overall);
    if (!Number.isFinite(overall) || overall <= 0) continue;
    const rate = Number(play.rate);
    if (rate1Only && !(Number.isFinite(rate) && Math.abs(rate - 1) <= 1e-9)) continue;
    if (topOnly && play.source !== "top") continue;
    playCount += 1;
    let cell = byMode.get(keyCount);
    if (!cell) {
      cell = {
        N: 0,
        overall: [],
        newest: null,
        nTop: 0,
        nTracked: 0,
        rlAll: [],
        lnTopN: 0,
        lnTrackedN: 0,
        parts: Object.fromEntries(PARTITION_KEYS.map((key) => [key, newPartAcc()])) as Record<PartitionKey, PartAcc>,
      };
      byMode.set(keyCount, cell);
    }
    cell.N += 1;
    cell.overall.push(overall);
    const endedAt = typeof play.endedAt === "string" ? play.endedAt : null;
    if (endedAt && (cell.newest === null || endedAt > cell.newest)) cell.newest = endedAt;
    const isTop = play.source === "top";
    if (isTop) cell.nTop += 1;
    else cell.nTracked += 1;

    const chart = chartMap.get(beatmapId);
    const chartApplies = chart != null && chart.keyCount === keyCount;
    const hits: Partial<Record<PartitionKey, boolean>> = {
      offrate: Number.isFinite(rate) && Math.abs(rate - 1) > 1e-9,
      oldmaps: beatmapId < 2_000_000,
      parity: beatmapId % 2 === 0,
    };
    if (chartApplies) {
      const c = chart!;
      hits.ln = c.lnTag >= TAG_MIN_SCORE;
      hits.ln70 = c.lnTag >= 0.7;
      hits.ln80 = c.lnTag >= 0.8;
      hits.lnr30 = c.lnTag >= TAG_MIN_SCORE && c.lnRatio >= 0.3;
      hits.lnr50 = c.lnTag >= TAG_MIN_SCORE && c.lnRatio >= 0.5;
      hits.ln_dan = c.lnRatio >= 0.5;
      hits.tech = c.techTag >= TAG_MIN_SCORE && c.cjTag < TECH_VETO_CHORDJACK;
      hits.chordjack = c.cjTag >= TAG_MIN_SCORE;
      hits.jumpstream = c.jsTag >= TAG_MIN_SCORE;
      hits.chordstream = c.csTag >= TAG_MIN_SCORE;
      hits.stream = c.stTag >= TAG_MIN_SCORE;
      if (c.relDelta > 0) cell.rlAll.push(c.relDelta);
    }
    for (const key of PARTITION_KEYS) {
      const acc = cell.parts[key];
      const member = hits[key] === true;
      (member ? acc.v : acc.rv).push(overall);
      if (chartApplies) {
        const delta = chart!.relDelta;
        if (delta > 0) (member ? acc.rl : acc.rrl).push(delta);
      }
    }
    if (hits.ln === true) {
      if (isTop) cell.lnTopN += 1;
      else cell.lnTrackedN += 1;
    }
  }

  for (const [keyCount, cell] of byMode) {
    // Truncation sensitivity: cap each cell at its best (highest-Overall) plays
    // before aggregating. The complement of a partition is capped at the
    // remaining budget so pool and subset stay coherent.
    const cap = (values: number[], capSize: number): number[] => {
      if (capSize <= 0 || values.length <= capSize) return values;
      return [...values].sort((a, b) => b - a).slice(0, capSize);
    };
    const cappedOverall = cap(cell.overall, truncateN);
    const [oa, ob] = halfOf(cappedOverall);
    const out: CellOut = {
      u: Number(row.user_id),
      k: keyCount,
      N: cell.N,
      O: r6(aggregateSsrs(cappedOverall)),
      newest: cell.newest,
      nTop: cell.nTop,
      nTracked: cell.nTracked,
      OHa: r6(aggregateSsrs(oa)),
      OHb: r6(aggregateSsrs(ob)),
      rlAll: r6(mean(cell.rlAll)),
      rlAllN: cell.rlAll.length,
      lnTopN: cell.lnTopN,
      lnTrackedN: cell.lnTrackedN,
      parts: {},
    };
    for (const key of PARTITION_KEYS) {
      const acc = cell.parts[key];
      const lnBudget = truncateLn > 0 ? Math.min(truncateLn, Math.floor(truncateN / 2)) : 0;
      const v = cap(acc.v, lnBudget);
      const rv = cap(acc.rv, truncateN > 0 ? truncateN - v.length : 0);
      const rlCapped = truncateLn > 0 ? acc.rl.slice(0, lnBudget) : acc.rl;
      const rrlCapped = truncateLn > 0 ? acc.rrl.slice(0, Math.max(0, truncateN - lnBudget)) : acc.rrl;
      const [ha, hb] = halfOf(v);
      const [rha, rhb] = halfOf(rv);
      const [rla, rlb] = halfOf(rlCapped);
      out.parts[key] = {
        n: acc.v.length,
        A: r6(aggregateSsrs(v)),
        hA: r6(aggregateSsrs(ha)),
        hB: r6(aggregateSsrs(hb)),
        restN: acc.rv.length,
        restA: r6(aggregateSsrs(rv)),
        restHA: r6(aggregateSsrs(rha)),
        restHB: r6(aggregateSsrs(rhb)),
        rl: r6(mean(rlCapped)),
        rlN: rlCapped.length,
        rlHA: r6(mean(rla)),
        rlHB: r6(mean(rlb)),
        restRl: r6(mean(rrlCapped)),
        restRlN: rrlCapped.length,
      };
    }
    cells.set(`${out.u}:${out.k}`, out);
  }
  if (rowCount % 2000 === 0) console.log(`  rows=${rowCount} cells=${cells.size}`);
}

console.log(`folded ${rowCount} rows, ${playCount} clean plays (${poisonDropped} poison dropped), ${cells.size} cells`);

const meta = {
  generatedAt: new Date().toISOString(),
  dbPath,
  playerSkillsVersion: PLAYER_SKILLS_VERSION,
  tagMinScore: TAG_MIN_SCORE,
  techVetoChordjack: TECH_VETO_CHORDJACK,
  partitions: PARTITION_KEYS,
  flags: { rate1Only, topOnly, truncateLn, truncateN },
  rows: rowCount,
  plays: playCount,
  poisonDropped,
  cells: cells.size,
};
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({ meta, cells: [...cells.values()] }));
console.log(`wrote ${outPath}`);
db.close();
