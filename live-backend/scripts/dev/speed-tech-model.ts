/**
 * Fits and audits the 4K speed/tech model in player-skills.ts (SPEED_TECH_MODEL).
 *
 * The model reads dan/motion-features.ts alongside the MSD lead and the
 * analyzer's tech score, and decides which of the speed and tech tiles a chart
 * files under - or files it under both when it cannot tell. This script is how
 * those weights and the two dual-file bars were set, and re-running it is how
 * you check that a change to the features, the corpus or the thresholds still
 * holds up.
 *
 * Corpus method (see memory/jack-tile-and-detector): charts from beatmapsets
 * whose title reads pack/practice/training/collection, labelled by the pattern
 * word in the diff version (preferred) or the set title.
 *
 * Everything is fitted with WHOLE PACKS held out - a chart never scores against
 * a model that saw another diff from its own pack - because diffs from one pack
 * share a mapper and a style and would otherwise leak the answer.
 *
 * Read-only; nothing is written. Run:
 *   npx tsx scripts/dev/speed-tech-model.ts            # fit + diagnostics
 *   npx tsx scripts/dev/speed-tech-model.ts --impact   # also run the shipped
 *                                                      # code over the corpora
 */
import { createClient } from "@libsql/client";
import { gunzipSync } from "node:zlib";
import { parseManiaBeatmap } from "../../src/dan/beatmap-parser.js";
import { motionFeatures, type MotionFeatures } from "../../src/dan/motion-features.js";
import { danSkillsetBucketsForValues, type ChartSkillInfo } from "../../src/features/player-skills.js";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";
const WITH_IMPACT = process.argv.includes("--impact");
const RANDOM_SAMPLE = 6000;

const PACKISH = /pack|practice|training|collection/i;
// Longest/most-specific first so "speedjack" never reads as "speed".
const LABEL_WORDS: Array<[RegExp, string]> = [
  [/speed\s*jack/i, "jack"], [/chord\s*jack/i, "jack"], [/mini\s*jack/i, "jack"],
  [/hand\s*stream/i, "handstream"], [/jump\s*stream|\bjs\b/i, "jumpstream"],
  [/jump\s*trill/i, "jumptrill"], [/stamina|endurance|marathon/i, "stamina"],
  [/\bln\b|long\s*note|invers|release/i, "ln"], [/stream/i, "stream"],
  [/speed/i, "speed"], [/tech/i, "tech"], [/jack/i, "jack"], [/vibro/i, "skip"],
];
const labelFrom = (text: string): string | null => LABEL_WORDS.find(([re]) => re.test(text))?.[1] ?? null;

// The tile each corpus should land on, for the impact pass.
const CORPUS_TILE: Record<string, string> = {
  jack: "jack", stamina: "stamina", speed: "speed", tech: "tech",
  stream: "speed", jumpstream: "stamina", handstream: "stamina", jumptrill: "jack",
};

// Charts a 4K dan player labelled by hand on 2026-08-30. Held out of every fit
// and never used to choose a threshold: they are the external check.
const HAND: Array<[number, string]> = [
  [3084903, "tech"], [3084904, "tech"], [3084905, "tech"], [3084906, "tech"],
  [4189254, "tech"], [4189255, "tech"], [4189256, "tech"],
  [1624796, "speed"], [3468306, "tech"],
  [770127, "tech"], [789784, "tech"], [2117613, "tech"],
];

interface Chart {
  id: number;
  corpus: string;
  hand: string | null;
  title: string;
  version: string;
  lengthSeconds: number | null;
  values: Record<string, number>;
  techScore: number;
  chordjackScore: number;
  speedjackScore: number;
  jackShare: number;
  streamShare: number;
  clusterCategory: string | null;
  jackDemand: boolean;
  motion: MotionFeatures;
}

const FEATURES = ["rhythmBreak", "crossHandTrill", "miniJack", "sameHand", "techLead", "techScore"] as const;
type FeatureName = (typeof FEATURES)[number];
const FEATURE_OF: Record<FeatureName, (chart: Chart) => number> = {
  rhythmBreak: (chart) => chart.motion.rhythmBreak,
  crossHandTrill: (chart) => chart.motion.crossHandTrill,
  miniJack: (chart) => chart.motion.miniJack,
  sameHand: (chart) => chart.motion.sameHand,
  techLead: (chart) => Number(chart.values.Technical ?? 0) - Number(chart.values.Stream ?? 0),
  // The same reading ChartSkillInfo carries: the jack veto zeroes it.
  techScore: (chart) => (chart.chordjackScore >= 0.8 ? 0 : chart.techScore),
};

// The near-tie the model was fitted on: Stream at or beside the argmax, the
// analyzer not already sure it is tech, and the two ratings within a point and
// a half. Outside it the shipped code still consults the model, but this is the
// population whose labels can settle the weights.
const MSD_SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"];
function contested(chart: Chart): boolean {
  const top = Math.max(...MSD_SKILLSETS.map((key) => Number(chart.values[key] ?? 0)));
  const stream = Number(chart.values.Stream ?? 0);
  const technical = Number(chart.values.Technical ?? 0);
  return stream >= top - 1.25 && chart.techScore < 0.8 && Math.abs(technical - stream) < 1.5;
}

async function loadCorpus(db: ReturnType<typeof createClient>): Promise<{ pack: Chart[]; random: Chart[] }> {
  const index = await db.execute("select beatmap_id, title, version, length as len_seconds from map_search_index where key_count = 4");
  const meta = new Map<number, { corpus: string; title: string; version: string; length: number | null }>();
  const others: number[] = [];
  for (const row of index.rows) {
    const id = Number(row.beatmap_id);
    const title = String(row.title ?? "");
    const version = String(row.version ?? "");
    const rawLength = Number(row.len_seconds);
    const length = Number.isFinite(rawLength) && rawLength > 0 ? rawLength : null;
    const label = PACKISH.test(title) ? labelFrom(version) ?? labelFrom(title) : null;
    const named = HAND.some(([handId]) => handId === id);
    if (label != null && label !== "ln" && label !== "skip") meta.set(id, { corpus: label, title, version, length });
    else if (named) meta.set(id, { corpus: "spot", title, version, length });
    else others.push(id);
  }
  // Deterministic sample of everything else, so the "how often does this happen
  // in the wild" number is reproducible run to run.
  let seed = 1234;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const randomIds = new Set(others.slice(0, RANDOM_SAMPLE));
  for (const id of randomIds) {
    const row = index.rows.find((entry) => Number(entry.beatmap_id) === id)!;
    const rawLength = Number(row.len_seconds);
    meta.set(id, {
      corpus: "random",
      title: String(row.title ?? ""),
      version: String(row.version ?? ""),
      length: Number.isFinite(rawLength) && rawLength > 0 ? rawLength : null,
    });
  }

  const ids = [...meta.keys()];
  const pack: Chart[] = [];
  const randomCharts: Chart[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await db.execute({
      sql: `select a.beatmap_id, a.msd_json, a.classification_json,
                   json_extract(a.classification_json, '$.clusterCategory') as cluster_category,
                   json_extract(a.classification_json, '$.jackDemand.detected') as jack_demand,
                   f.content, f.content_blob, f.compression
              from beatmap_chart_analysis a
              left join beatmap_osu_files f on f.beatmap_id = a.beatmap_id
             where a.status = 'ready' and a.key_count = 4 and a.beatmap_id in (${placeholders})
             order by a.analysis_version`,
      args: chunk,
    })).rows;
    for (const row of rows) {
      const id = Number(row.beatmap_id);
      let msd: { values?: Record<string, number> } | null = null;
      let classification: { patterns?: Array<{ id?: unknown; score?: unknown }>; clusters?: Array<{ pattern?: unknown; importance?: unknown }> } | null = null;
      try { msd = JSON.parse(String(row.msd_json ?? "null")); } catch { /* skip */ }
      try { classification = JSON.parse(String(row.classification_json ?? "null")); } catch { /* skip */ }
      const values = msd?.values;
      if (!values || !Number.isFinite(Number(values.Overall))) continue;
      let text: string | null = null;
      if (row.content_blob) {
        try {
          const buffer = Buffer.from(row.content_blob as never);
          text = String(row.compression) === "gzip" ? gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
        } catch { text = null; }
      }
      if (!text && row.content) text = String(row.content);
      if (!text) continue;
      let motion: MotionFeatures | null = null;
      try {
        const map = parseManiaBeatmap(text);
        motion = motionFeatures(map.notes, map.keyCount);
      } catch { motion = null; }
      if (!motion) continue;
      const scores = new Map<string, number>();
      for (const hit of classification?.patterns ?? []) {
        const patternId = String(hit?.id ?? "");
        if (patternId) scores.set(patternId, Math.max(scores.get(patternId) ?? 0, Number(hit?.score ?? 0)));
      }
      let total = 0, jack = 0, stream = 0;
      for (const cluster of classification?.clusters ?? []) {
        const importance = Number(cluster?.importance);
        if (!Number.isFinite(importance) || importance <= 0) continue;
        total += importance;
        const pattern = String(cluster?.pattern ?? "");
        if (/jack/i.test(pattern)) jack += importance;
        if (/stream/i.test(pattern)) stream += importance;
      }
      const entry = meta.get(id)!;
      const chart: Chart = {
        id,
        corpus: entry.corpus,
        hand: HAND.find(([handId]) => handId === id)?.[1] ?? null,
        title: entry.title,
        version: entry.version,
        lengthSeconds: entry.length,
        values,
        techScore: scores.get("tech") ?? 0,
        chordjackScore: scores.get("chordjack") ?? 0,
        speedjackScore: scores.get("speedjack") ?? 0,
        jackShare: total > 0 ? jack / total : 0,
        streamShare: total > 0 ? stream / total : 0,
        clusterCategory: row.cluster_category == null ? null : String(row.cluster_category),
        jackDemand: Number(row.jack_demand) === 1,
        motion,
      };
      if (entry.corpus === "random") randomCharts.push(chart);
      else pack.push(chart);
    }
  }
  return { pack, random: randomCharts };
}

// ── the model ───────────────────────────────────────────────────────────────

interface Fit { weights: number[]; bias: number; mean: number[]; sd: number[] }

function fit(charts: Chart[], labels: number[], l2 = 1, iterations = 4000, step = 0.3): Fit {
  const mean = FEATURES.map((key) => charts.reduce((sum, chart) => sum + FEATURE_OF[key](chart), 0) / charts.length);
  const sd = FEATURES.map((key, index) => Math.sqrt(
    charts.reduce((sum, chart) => sum + (FEATURE_OF[key](chart) - mean[index]) ** 2, 0) / charts.length,
  ) || 1);
  const rows = charts.map((chart) => FEATURES.map((key, index) => (FEATURE_OF[key](chart) - mean[index]) / sd[index]));
  const weights = new Array(FEATURES.length).fill(0);
  let bias = 0;
  const positives = labels.reduce((sum, label) => sum + label, 0);
  // Class-balanced, so the fit is not just "say speed" on a 3:1 corpus.
  const positiveWeight = rows.length / (2 * Math.max(1, positives));
  const negativeWeight = rows.length / (2 * Math.max(1, rows.length - positives));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = new Array(FEATURES.length).fill(0);
    let biasGradient = 0, mass = 0;
    for (let i = 0; i < rows.length; i++) {
      let z = bias;
      for (let j = 0; j < rows[i].length; j++) z += weights[j] * rows[i][j];
      const weight = labels[i] === 1 ? positiveWeight : negativeWeight;
      const error = (1 / (1 + Math.exp(-z)) - labels[i]) * weight;
      for (let j = 0; j < rows[i].length; j++) gradient[j] += error * rows[i][j];
      biasGradient += error;
      mass += weight;
    }
    for (let j = 0; j < weights.length; j++) weights[j] -= step * (gradient[j] / mass + (l2 * weights[j]) / rows.length);
    bias -= step * (biasGradient / mass);
  }
  return { weights, bias, mean, sd };
}

function score(model: Fit, chart: Chart): number {
  let z = model.bias;
  FEATURES.forEach((key, index) => { z += model.weights[index] * ((FEATURE_OF[key](chart) - model.mean[index]) / model.sd[index]); });
  return 1 / (1 + Math.exp(-z));
}

function auc(scores: number[], labels: number[]): number {
  const sorted = scores.map((value, index) => [value, labels[index]]).sort((a, b) => a[0] - b[0]);
  const positives = labels.reduce((sum, label) => sum + label, 0);
  let rankSum = 0, i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (sorted[k][1] === 1) rankSum += rank;
    i = j + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * (labels.length - positives));
}

/** Fold assignment by PACK, so a pack is never split across train and test. */
function packFolds(packs: string[], folds: number, seed: number): number[] {
  const unique = [...new Set(packs)];
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  const byPack = new Map(unique.map((pack, index) => [pack, index % folds]));
  return packs.map((pack) => byPack.get(pack)!);
}

function outOfFold(charts: Chart[], labels: number[], packs: string[], seed = 91): number[] {
  const folds = packFolds(packs, 5, seed);
  const predictions = new Array(charts.length).fill(0);
  for (let fold = 0; fold < 5; fold++) {
    const train = charts.map((_, index) => index).filter((index) => folds[index] !== fold);
    const model = fit(train.map((index) => charts[index]), train.map((index) => labels[index]));
    for (const index of charts.map((_, i) => i).filter((i) => folds[i] === fold)) {
      predictions[index] = score(model, charts[index]);
    }
  }
  return predictions;
}

// ── the shipped code, for the impact pass ───────────────────────────────────

function asChartSkillInfo(chart: Chart, withMotion: boolean): ChartSkillInfo {
  const category = chart.clusterCategory;
  const labelled = category != null && category.trim() !== "";
  return {
    patterns: [],
    jackDemand: chart.jackDemand,
    jackShare: chart.jackShare,
    streamShare: chart.streamShare,
    techCategory: labelled ? /tech/i.test(category!) : null,
    clusterTrill: labelled ? /trill/i.test(category!) : null,
    handstreamCluster: labelled ? /handstream/i.test(category!) : null,
    techScore: chart.chordjackScore >= 0.8 ? 0 : chart.techScore,
    chordjackScore: chart.chordjackScore,
    motion: withMotion ? chart.motion : null,
    lnRatio: 0,
    vibro: false,
    danEligible: true,
    rcRawDan: 10,
    lnRawDan: null,
    rcDanLabel: null,
    lnDanLabel: null,
    dtRawDan: null,
    dtFamily: null,
    dtDanLabel: null,
    htRawDan: null,
    htFamily: null,
    htDanLabel: null,
    lengthSeconds: chart.lengthSeconds,
    od: null,
  };
}
const shippedTiles = (chart: Chart, withMotion = true): string[] =>
  danSkillsetBucketsForValues(4, "rc", chart.values, chart.lengthSeconds, 1, asChartSkillInfo(chart, withMotion));

async function main() {
  const db = createClient({ url: DB_URL });
  const { pack, random } = await loadCorpus(db);
  const band = pack.filter((chart) => (chart.corpus === "tech" || chart.corpus === "speed") && contested(chart));
  const labels: number[] = band.map((chart) => (chart.corpus === "tech" ? 1 : 0));
  const packs = band.map((chart) => chart.title);
  const positives = labels.reduce((sum, label) => sum + label, 0);
  console.log(`corpus: ${pack.length} pack-labelled 4K charts, ${random.length} random`);
  console.log(`fit band: ${band.length} charts (${positives} tech / ${band.length - positives} speed) from ${new Set(packs).size} packs`);
  console.log(`baseline, always speed: ${(((band.length - positives) / band.length) * 100).toFixed(1)}%\n`);

  // What each input is worth on its own, before any fitting.
  console.log("single-input separation (AUC, tech against speed, in-band):");
  for (const key of FEATURES) {
    console.log(`  ${key.padEnd(16)} ${auc(band.map((chart) => FEATURE_OF[key](chart)), labels).toFixed(3)}`);
  }

  const predictions = outOfFold(band, labels, packs);
  console.log(`\nout-of-fold, whole packs held out: AUC ${auc(predictions, labels).toFixed(3)}`);

  // Does the split of the folds matter? If AUC swings with the seed, the fit is
  // reading the split rather than the charts.
  const repeats = Array.from({ length: 10 }, (_, index) => auc(outOfFold(band, labels, packs, index * 13 + 1), labels));
  const repeatMean = repeats.reduce((sum, value) => sum + value, 0) / repeats.length;
  const repeatSd = Math.sqrt(repeats.reduce((sum, value) => sum + (value - repeatMean) ** 2, 0) / repeats.length);
  console.log(`  over 10 fold splits: ${repeatMean.toFixed(3)} +/- ${repeatSd.toFixed(3)}`);

  // Flat learning curve = the model is not data-starved and is not memorising.
  console.log("\nlearning curve (train on a share of the packs, test on packs it never saw):");
  const uniquePacks = [...new Set(packs)];
  for (const share of [0.25, 0.5, 0.75, 1]) {
    let total = 0, runs = 0;
    for (let seed = 1; seed <= 6; seed++) {
      let state = seed * 31 + 7;
      const random01 = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      const shuffled = [...uniquePacks];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random01() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const heldOut = new Set(shuffled.slice(0, Math.floor(uniquePacks.length * 0.25)));
      const pool = shuffled.slice(Math.floor(uniquePacks.length * 0.25));
      const training = new Set(pool.slice(0, Math.max(2, Math.floor(pool.length * share))));
      const trainIndices = band.map((_, index) => index).filter((index) => training.has(packs[index]));
      const testIndices = band.map((_, index) => index).filter((index) => heldOut.has(packs[index]));
      if (trainIndices.length < 20 || testIndices.length < 20) continue;
      const model = fit(trainIndices.map((index) => band[index]), trainIndices.map((index) => labels[index]));
      total += auc(testIndices.map((index) => score(model, band[index])), testIndices.map((index) => labels[index]));
      runs++;
    }
    console.log(`  ${(share * 100).toFixed(0).padStart(3)}% of packs: ${(total / runs).toFixed(3)}`);
  }

  const full = fit(band, labels);
  console.log("\nfitted weights (standardised inputs):");
  FEATURES.forEach((key, index) => {
    console.log(`  ${key.padEnd(16)} weight ${full.weights[index].toFixed(4).padStart(8)}  mean ${full.mean[index].toFixed(4).padStart(9)}  sd ${full.sd[index].toFixed(4)}`);
  });
  console.log(`  bias ${full.bias.toFixed(4)}`);

  console.log("\ndual-file bars, out-of-fold: low / high -> share filed under both, accuracy of the rest");
  for (const [low, high] of [[0.35, 0.65], [0.35, 0.75], [0.30, 0.75], [0.25, 0.75], [0.25, 0.80]]) {
    let shared = 0, right = 0, decided = 0;
    predictions.forEach((probability, index) => {
      if (probability > low && probability < high) { shared++; return; }
      decided++;
      if ((probability >= high ? 1 : 0) === labels[index]) right++;
    });
    console.log(`  ${low.toFixed(2)} / ${high.toFixed(2)}   shared ${((shared / predictions.length) * 100).toFixed(1).padStart(5)}%   decided ${((right / Math.max(1, decided)) * 100).toFixed(1)}%`);
  }

  console.log("\nhand-labelled charts, never in any fit:");
  for (const chart of pack.filter((entry) => entry.hand)) {
    const probability = score(full, chart);
    const verdict = probability >= 0.75 ? "tech" : probability <= 0.35 ? "speed" : "both";
    console.log(`  ${String(chart.id).padEnd(8)} p ${probability.toFixed(2)} -> ${verdict.padEnd(5)} want ${chart.hand!.padEnd(5)} ${verdict === chart.hand || verdict === "both" ? "ok" : "MISS"}  ${chart.title.slice(0, 34)}`);
  }

  if (!WITH_IMPACT) {
    console.log("\n(--impact runs the shipped tile code over every corpus)");
    return;
  }
  console.log("\nSHIPPED CODE over the pack corpora\ncorpus       n     motion off  motion on   two tiles");
  for (const corpus of Object.keys(CORPUS_TILE)) {
    const set = pack.filter((chart) => chart.corpus === corpus);
    if (set.length === 0) continue;
    let off = 0, on = 0, shared = 0;
    for (const chart of set) {
      if (shippedTiles(chart, false).includes(CORPUS_TILE[corpus])) off++;
      const tiles = shippedTiles(chart);
      if (tiles.includes(CORPUS_TILE[corpus])) on++;
      if (tiles.length > 1) shared++;
    }
    console.log(`${corpus.padEnd(11)} ${String(set.length).padStart(5)}   ${((off / set.length) * 100).toFixed(1).padStart(6)}%     ${((on / set.length) * 100).toFixed(1).padStart(6)}%     ${((shared / set.length) * 100).toFixed(1).padStart(5)}%`);
  }
  // Where the library actually moves: the old single tile against the new set.
  const moves = new Map<string, number>();
  for (const chart of random) {
    const before = shippedTiles(chart, false).join("+") || "none";
    const after = shippedTiles(chart).join("+") || "none";
    const key = `${before} -> ${after}`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
  }
  console.log(`\nrandom library sample, n=${random.length}: how every chart's tiles change`);
  let unchanged = 0;
  for (const [key, count] of [...moves].sort((a, b) => b[1] - a[1])) {
    const [before, after] = key.split(" -> ");
    if (before === after) { unchanged += count; continue; }
    console.log(`  ${before.padEnd(9)} -> ${after.padEnd(14)} ${((count / random.length) * 100).toFixed(1).padStart(5)}%  (${count})`);
  }
  console.log(`  ${"unchanged".padEnd(9)}    ${"".padEnd(14)} ${((unchanged / random.length) * 100).toFixed(1).padStart(5)}%  (${unchanged})`);

  // And what that costs a real player: every stored play of a chart in the
  // sample, filed the old way against the new one.
  const byBeatmap = new Map<number, Chart>(random.map((chart) => [chart.id, chart]));
  const stored = await db.execute("select plays_json from player_skill_ratings where status = 'ready' and plays_json is not null");
  let plays = 0, movedPlays = 0, gainedTile = 0;
  for (const row of stored.rows) {
    let parsed: { plays?: Array<Record<string, unknown>> } | null = null;
    try { parsed = JSON.parse(String(row.plays_json)); } catch { continue; }
    for (const play of parsed?.plays ?? []) {
      const chart = byBeatmap.get(Number(play?.beatmapId));
      const values = play?.values as Record<string, number> | undefined;
      if (!chart || !values) continue;
      const rate = Number(play?.rate ?? 1) || 1;
      const before = danSkillsetBucketsForValues(4, "rc", values, chart.lengthSeconds, rate, asChartSkillInfo(chart, false));
      const after = danSkillsetBucketsForValues(4, "rc", values, chart.lengthSeconds, rate, asChartSkillInfo(chart, true));
      plays++;
      if (after.length > before.length) gainedTile++;
      else if (before.join("+") !== after.join("+")) movedPlays++;
    }
  }
  if (plays > 0) {
    console.log(`\nstored plays of those charts, n=${plays}: ${((movedPlays / plays) * 100).toFixed(1)}% change tile,`
      + ` ${((gainedTile / plays) * 100).toFixed(1)}% gain a second one,`
      + ` ${(((plays - movedPlays - gainedTile) / plays) * 100).toFixed(1)}% unchanged`);
  }
}

main();
