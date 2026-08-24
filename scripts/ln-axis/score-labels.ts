// LN axis plan — Phase 3 blinded label join (freeze-file.md protocol).
//
// Consumes the cells JSON (fold-cells.ts, prod snapshot for the real run) and
// a label file:
//   { "positives": [{ "userId": 12345, "keymode": 7, "confidence": "high" }],
//     "negatives": [{ "userId": 67890, "keymode": 7, "confidence": "medium" }] }
// and prints aggregate statistics and the exclusion log only. No per-player
// discriminant values are emitted.
//
// The tested statistic is the frozen metric D (the skill-matched band
// percentile over the candidate's per-cell value), not the raw value.
//
// Usage: npx tsx scripts/ln-axis/score-labels.ts --labels <path> [--cells <path>] [--holdout-seed <n>]
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function argValue(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const cellsPath = resolve(argValue("--cells", resolve(import.meta.dirname, "out/cells.json")));
const labelsPath = resolve(argValue("--labels", ""));
const holdoutSeed = Number(argValue("--holdout-seed", "0")) || 0;
if (!labelsPath) {
  console.error("usage: score-labels.ts --labels <path> [--cells <path>] [--holdout-seed <n>]");
  process.exit(1);
}

interface Part {
  n: number; A: number; hA: number; hB: number;
  restN: number; restA: number;
  rl: number; rlN: number; restRl: number; restRlN: number;
}
interface Cell {
  u: number; k: number; N: number; O: number;
  newest: string | null; nTop: number; nTracked: number;
  rlAll: number; rlAllN: number;
  lnTopN: number; lnTrackedN: number;
  parts: Record<string, Part>;
}
interface LabelEntry { userId: number; keymode: number; confidence?: string }
interface LabelFile { positives: LabelEntry[]; negatives: LabelEntry[] }

const { meta, cells } = JSON.parse(await readFile(cellsPath, "utf8")) as { meta: { generatedAt: string }; cells: Cell[] };
const labels: LabelFile = JSON.parse(await readFile(labelsPath, "utf8"));
console.log(`labels file sha256: ${createHash("sha256").update(await readFile(labelsPath)).digest("hex")}`);
console.log(`cells snapshot: ${meta.generatedAt} (${cellsPath})`);

const BAND = 1.0;
const MIN_BAND = 10; // freeze-file amendment: D undefined below this band size
const RECENCY_DAYS = 365;
const snapshotMs = Date.parse(meta.generatedAt);
const KEYMODES = [7, 4];

// ---------- per-cell candidate values ----------
type Extractor = { name: string; kind: "candidate" | "baseline" | "control" | "placebo"; get: (cell: Cell) => number };
const ratioOf = (part: string): Extractor["get"] => (cell: Cell): number =>
  cell.parts[part].n >= 20 ? cell.parts[part].A / cell.O : NaN;
const meanRl = (getPart: (cell: Cell) => Part, minN: number): Extractor["get"] => (cell: Cell): number => {
  const part = getPart(cell);
  return part.rlN >= minN ? part.rl : NaN;
};
const extractors: Extractor[] = [
  { name: "incumbent_R_ln", kind: "candidate", get: ratioOf("ln") },
  { name: "baseline_share_ln", kind: "baseline", get: (c) => c.parts.ln.n / c.N },
  // lean_band is filled per keymode below (its value needs the population band fit).
  { name: "lean_band", kind: "candidate", get: () => NaN },
  { name: "release_load_ln", kind: "candidate", get: meanRl((c) => c.parts.ln, 5) },
  { name: "release_load_all", kind: "candidate", get: (c) => (c.rlAllN >= 5 ? c.rlAll : NaN) },
  { name: "release_load_contrast", kind: "candidate", get: (c) => (c.parts.ln.rlN >= 5 && c.parts.ln.restRlN >= 5 ? c.parts.ln.rl - c.parts.ln.restRl : NaN) },
  { name: "tag_0.7", kind: "candidate", get: ratioOf("ln70") },
  { name: "tag_0.8", kind: "candidate", get: ratioOf("ln80") },
  { name: "tag_and_lnRatio_0.3", kind: "candidate", get: ratioOf("lnr30") },
  { name: "tag_and_lnRatio_0.5", kind: "candidate", get: ratioOf("lnr50") },
  { name: "dan_verdict_lnRatio_0.5", kind: "candidate", get: ratioOf("ln_dan") },
  { name: "ctrl_R_tech", kind: "control", get: ratioOf("tech") },
  { name: "ctrl_R_chordjack", kind: "control", get: ratioOf("chordjack") },
  { name: "ctrl_R_jumpstream", kind: "control", get: ratioOf("jumpstream") },
  { name: "ctrl_R_chordstream", kind: "control", get: ratioOf("chordstream") },
  ...(["chordjack", "tech", "offrate", "oldmaps", "parity"] as const).flatMap((p): Extractor[] => [
    { name: `placebo_R_${p}`, kind: "placebo", get: ratioOf(p) },
    { name: `placebo_rl_${p}`, kind: "placebo", get: meanRl((c) => c.parts[p], 5) },
  ]),
];

function olsFit(x: number[], y: number[]): { predict: (x: number) => number } {
  const n = Math.min(x.length, y.length);
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i += 1) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { predict: (value: number): number => my - b * mx + b * value };
}
// lean_band: LN-pool aggregate residualised against the same player's non-LN
// pool with the OLS fit of the cell's own Overall band.
function leanBandValues(ref: Cell[], bands: Array<Array<number>>): Map<Cell, number> {
  const values = new Map<Cell, number>();
  ref.forEach((cell, index) => {
    const bandIndexes = bands[index];
    if (bandIndexes.length < MIN_BAND) {
      values.set(cell, NaN);
      return;
    }
    const fit = olsFit(
      bandIndexes.map((i) => ref[i].parts.ln.restA),
      bandIndexes.map((i) => ref[i].parts.ln.A),
    );
    values.set(cell, cell.parts.ln.A - fit.predict(cell.parts.ln.restA));
  });
  return values;
}

// ---------- stats ----------
function rankArray(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let t = i; t <= j; t += 1) ranks[indexed[t].index] = rank;
    i = j + 1;
  }
  return ranks;
}
function auc(pos: number[], neg: number[]): number {
  if (pos.length === 0 || neg.length === 0) return NaN;
  const ranks = rankArray([...pos, ...neg]);
  let sumPos = 0;
  for (let i = 0; i < pos.length; i += 1) sumPos += ranks[i];
  return (sumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}
// Deterministic xorshift PRNG (seeded, for permutation draws).
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}
function permutationP(pos: number[], neg: number[], rng: () => number): number {
  const observed = auc(pos, neg);
  const pooled = [...pos, ...neg];
  const n1 = pos.length;
  const total = pooled.length;
  let combos = 1;
  for (let i = 0; i < n1; i += 1) combos = (combos * (total - i)) / (i + 1);
  const draws = combos <= 250_000 ? Math.max(1, Math.round(combos)) : 200_000;
  let hits = 0;
  const scratch = [...pooled];
  for (let d = 0; d < draws; d += 1) {
    for (let i = 0; i < n1; i += 1) {
      const j = i + Math.floor(rng() * (total - i));
      const tmp = scratch[i]; scratch[i] = scratch[j]; scratch[j] = tmp;
    }
    if (auc(scratch.slice(0, n1), scratch.slice(n1)) >= observed - 1e-12) hits += 1;
  }
  return hits / draws;
}
function holm(pvalues: Array<{ name: string; p: number }>): Map<string, number> {
  const sorted = [...pvalues].sort((a, b) => a.p - b.p);
  const adjusted = new Map<string, number>();
  let running = 0;
  sorted.forEach((entry, index) => {
    running = Math.max(running, Math.min(1, entry.p * (sorted.length - index)));
    adjusted.set(entry.name, running);
  });
  return adjusted;
}

// ---------- eligibility funnel (before group reveal) ----------
const exclusions: Array<{ userId: number; keymode: number; group: string; reason: string }> = [];
function resolveLabel(entry: LabelEntry, group: string): Cell | null {
  const keymode = Number(entry.keymode);
  const cell = cells.find((c) => c.u === Number(entry.userId) && c.k === keymode) ?? null;
  if (!cell) {
    exclusions.push({ userId: entry.userId, keymode, group, reason: `no ready v16 cell at ${keymode}K` });
    return null;
  }
  if (cell.N < 20 || cell.parts.ln.n < 20) {
    exclusions.push({ userId: entry.userId, keymode, group, reason: `pool too thin (N=${cell.N}, n_ln=${cell.parts.ln.n})` });
    return null;
  }
  const newest = cell.newest ? Date.parse(cell.newest) : NaN;
  if (!Number.isFinite(newest) || snapshotMs - newest > RECENCY_DAYS * 86_400_000) {
    exclusions.push({ userId: entry.userId, keymode, group, reason: `stale (newest play ${cell.newest ?? "unknown"})` });
    return null;
  }
  return cell;
}
const seen = new Map<number, string>();
const resolvedPositives: Array<{ cell: Cell; confidence: string }> = [];
const resolvedNegatives: Array<{ cell: Cell; confidence: string }> = [];
for (const entry of labels.positives ?? []) {
  const cell = resolveLabel(entry, "positive");
  if (!cell) continue;
  if (seen.has(cell.u)) {
    exclusions.push({ userId: cell.u, keymode: cell.k, group: "positive", reason: "player already resolved (" + seen.get(cell.u) + ")" });
    continue;
  }
  seen.set(cell.u, "positive");
  resolvedPositives.push({ cell, confidence: String(entry.confidence ?? "medium") });
}
for (const entry of labels.negatives ?? []) {
  const cell = resolveLabel(entry, "negative");
  if (!cell) continue;
  if (seen.has(cell.u)) {
    exclusions.push({ userId: cell.u, keymode: cell.k, group: "negative", reason: "player already resolved (" + seen.get(cell.u) + ")" });
    continue;
  }
  seen.set(cell.u, "negative");
  resolvedNegatives.push({ cell, confidence: String(entry.confidence ?? "medium") });
}

console.log(`\n== exclusion log (${exclusions.length}) ==`);
for (const entry of exclusions) console.log(`  user ${entry.userId} ${entry.keymode}K [${entry.group}]: ${entry.reason}`);

// Optional seeded holdout: hide 40% of each side (only when >=10 per side).
function applyHoldout(list: Array<{ cell: Cell; confidence: string }>): Array<{ cell: Cell; confidence: string }> {
  if (!holdoutSeed || list.length < 10) return list;
  const rng = makeRng(holdoutSeed);
  const shuffled = [...list].sort((a, b) => a.cell.u - b.cell.u);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
  }
  return shuffled.slice(Math.floor(shuffled.length * 0.4));
}
const wavePositives = applyHoldout(resolvedPositives);
const waveNegatives = applyHoldout(resolvedNegatives);
if (holdoutSeed && (wavePositives.length < resolvedPositives.length || waveNegatives.length < resolvedNegatives.length)) {
  console.log(`holdout: wave A = ${wavePositives.length}v${waveNegatives.length} (held out ${resolvedPositives.length - wavePositives.length}+${resolvedNegatives.length - waveNegatives.length})`);
}

// ---------- the test ----------
function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4).padStart(8) : "     n/a";
}

for (const keymode of KEYMODES) {
  const pos = wavePositives.filter((entry) => entry.cell.k === keymode);
  const neg = waveNegatives.filter((entry) => entry.cell.k === keymode);
  console.log(`\n== ${keymode}K: ${pos.length} positives vs ${neg.length} negatives (eligible after exclusions) ==`);
  if (pos.length === 0 || neg.length === 0) continue;
  const gate = Math.min(pos.length, neg.length);
  if (gate < 5) {
    console.log("  fewer than 5 per side: the test does not run (3v3 cannot be significant by construction).");
    continue;
  }
  if (gate < 10) console.log("  5-9 per side: exploratory only.");

  const ref = cells.filter((c) => c.k === keymode && c.N >= 20 && c.parts.ln.n >= 20)
    .sort((a, b) => a.O - b.O);
  // Shared band structure: contiguous slice of the Overall-sorted ref per cell.
  const bands: Array<Array<number>> = ref.map((cell) => {
    const indexes: Array<number> = [];
    for (let i = 0; i < ref.length; i += 1) {
      if (Math.abs(ref[i].O - cell.O) <= BAND) indexes.push(i);
    }
    return indexes;
  });
  const lean = leanBandValues(ref, bands);

  // Raw per-cell values per extractor, then the frozen D transform, then the
  // share-adjusted variant of D (criterion 3).
  interface Scored { d: Map<Cell, number>; adjD: Map<Cell, number> }
  const scored = new Map<string, Scored>();
  for (const extractor of extractors) {
    const raw = new Map<Cell, number>();
    for (const cell of ref) {
      raw.set(cell, extractor.name === "lean_band" ? (lean.get(cell) ?? NaN) : extractor.get(cell));
    }
    const d = new Map<Cell, number>();
    ref.forEach((cell, index) => {
      const bandIndexes = bands[index];
      if (bandIndexes.length < MIN_BAND) {
        d.set(cell, NaN);
        return;
      }
      const value = raw.get(cell)!;
      if (!Number.isFinite(value)) {
        d.set(cell, NaN);
        return;
      }
      let below = 0;
      for (const i of bandIndexes) {
        const q = ref[i];
        if (q === cell) continue;
        const qv = raw.get(q);
        if (qv != null && qv < value) below += 1;
      }
      d.set(cell, (100 * below) / (bandIndexes.length - 1));
    });
    // Criterion 3: residualise D against share_ln within the band, using only
    // band members with a defined D on both axes.
    const adjD = new Map<Cell, number>();
    ref.forEach((cell, index) => {
      const bandIndexes = bands[index];
      const value = d.get(cell) ?? NaN;
      if (bandIndexes.length < MIN_BAND || !Number.isFinite(value)) {
        adjD.set(cell, NaN);
        return;
      }
      const xs: number[] = [];
      const ys: number[] = [];
      for (const i of bandIndexes) {
        const dv = d.get(ref[i]);
        if (Number.isFinite(dv)) {
          xs.push(ref[i].parts.ln.n / ref[i].N);
          ys.push(dv as number);
        }
      }
      if (xs.length < MIN_BAND) {
        adjD.set(cell, NaN);
        return;
      }
      const fit = olsFit(xs, ys);
      adjD.set(cell, value - fit.predict(cell.parts.ln.n / cell.N));
    });
    scored.set(extractor.name, { d, adjD });
  }

  const posCells = pos.map((entry) => entry.cell);
  const negCells = neg.map((entry) => entry.cell);
  const rng = makeRng(0x5eed ^ keymode);
  const results: Array<{
    name: string; kind: string; auc: number; p: number; pHolm: number;
    adjAuc: number; adjP: number; controlBreach: boolean; defined: number;
    posDefined: number; negDefined: number;
  }> = [];
  for (const extractor of extractors) {
    const entry = scored.get(extractor.name)!;
    const posD = posCells.map((cell) => entry.d.get(cell) ?? NaN);
    const negD = negCells.map((cell) => entry.d.get(cell) ?? NaN);
    const okPos = posD.filter((v) => Number.isFinite(v));
    const okNeg = negD.filter((v) => Number.isFinite(v));
    const defined = okPos.length + okNeg.length;
    if (okPos.length === 0 || okNeg.length === 0) {
      console.log(`  ${extractor.name.padEnd(26)} n/a (defined for ${defined} labelled cells)`);
      continue;
    }
    const observed = auc(okPos, okNeg);
    const p = permutationP(okPos, okNeg, rng);
    const adjPos = posCells.map((cell) => entry.adjD.get(cell) ?? NaN).filter((v) => Number.isFinite(v));
    const adjNeg = negCells.map((cell) => entry.adjD.get(cell) ?? NaN).filter((v) => Number.isFinite(v));
    const adjAuc = adjPos.length && adjNeg.length ? auc(adjPos, adjNeg) : NaN;
    const adjP = adjPos.length && adjNeg.length ? permutationP(adjPos, adjNeg, rng) : NaN;
    results.push({
      name: extractor.name, kind: extractor.kind, auc: observed, p, pHolm: NaN,
      adjAuc, adjP, controlBreach: false, defined,
      posDefined: okPos.length, negDefined: okNeg.length,
    });
  }
  const family = results.filter((r) => r.kind === "candidate");
  const adjusted = holm(family.map((r) => ({ name: r.name, p: r.p })));
  for (const r of results) r.pHolm = adjusted.get(r.name) ?? NaN;
  for (const candidate of family) {
    candidate.controlBreach = results.some((r) =>
      (r.kind === "control" || r.kind === "placebo") && Number.isFinite(r.auc) && r.auc >= candidate.auc - 0.05);
  }
  console.log("  discriminant                AUC       p  p_holm | share-adj AUC       p | ctrl-breach | n_def");
  for (const r of results) {
    const passed = r.kind === "candidate"
      && r.auc >= 0.8 && r.pHolm <= 0.05 && r.adjAuc >= 0.8 && r.adjP <= 0.05 && !r.controlBreach;
    console.log(
      `  ${r.name.padEnd(26)}${fmt(r.auc)} ${fmt(r.p)} ${fmt(r.pHolm)} |        ${fmt(r.adjAuc)} ${fmt(r.adjP)} | ${r.controlBreach ? "YES" : "no"}          | ${r.posDefined}v${r.negDefined}`
      + (r.kind === "candidate" ? (passed ? "  <= PASS" : "") : ""),
    );
  }
}
console.log("\n(done; aggregate statistics only — no per-player discriminant values are printed)");
