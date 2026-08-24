// LN axis plan — Phase 1 population report + Phase 3 offline candidate scoring.
//
// Consumes the cells JSON produced by fold-cells.ts and prints:
//   A. reproduction of the plan §0 diagnostics (sanity check against drift)
//   B. the three Phase 1 tables (placebo partitions, exposure, pp-selection)
//   C. the frozen discriminant family scored on the population, with the
//      saturation gate and the exposure pseudo-label fingerprint
//
// Usage: npx tsx scripts/ln-axis/report-tables.ts [--cells <path>]
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function argValue(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const cellsPath = resolve(argValue("--cells", resolve(import.meta.dirname, "out/cells.json")));

interface Part {
  n: number; A: number; hA: number; hB: number;
  restN: number; restA: number; restHA: number; restHB: number;
  rl: number; rlN: number; rlHA: number; rlHB: number;
  restRl: number; restRlN: number;
}
interface Cell {
  u: number; k: number; N: number; O: number;
  newest: string | null; nTop: number; nTracked: number;
  OHa: number; OHb: number; rlAll: number; rlAllN: number;
  lnTopN: number; lnTrackedN: number;
  parts: Record<string, Part>;
}
interface CellsFile {
  meta: { generatedAt: string; dbPath: string; rows: number; plays: number; poisonDropped: number; cells: number };
  cells: Cell[];
}

const { meta, cells } = JSON.parse(await readFile(cellsPath, "utf8")) as CellsFile;
console.log(`# cells from ${cellsPath}`);
console.log(`# generated ${meta.generatedAt} from ${meta.dbPath}`);
console.log(`# rows=${meta.rows} plays=${meta.plays} poisonDropped=${meta.poisonDropped} cells=${meta.cells}`);

const KEYMODES = [4, 7, 6];
const LN_FAMILY = ["ln", "ln70", "ln80", "lnr30", "lnr50", "ln_dan"];
const CONTROLS = ["tech", "chordjack", "jumpstream", "chordstream", "offrate", "oldmaps", "parity"];
const PLACEBOS = ["chordjack", "tech", "offrate", "oldmaps", "parity"];
const BAND_HALF_WIDTH = 1.0;
const ELIGIBLE_N = 20;
const ELIGIBLE_LN = 20;

// ---------- stats helpers ----------
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
function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return NaN;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i += 1) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
function spearman(x: number[], y: number[]): number {
  return pearson(rankArray(x), rankArray(y));
}
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function ols(x: number[], y: number[]): { a: number; b: number } {
  const n = Math.min(x.length, y.length);
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i += 1) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}
function spearmanBrown(r: number): number {
  return Number.isFinite(r) ? (2 * r) / (1 + r) : NaN;
}
// Residual of A_part against A_rest within the cell's Overall band, using the
// band's own 2-parameter OLS fit. This is the "skill-matched" lean construction.
function bandResidual(ref: Cell[], cell: Cell, partKey = "ln"): number {
  const band = ref.filter((q) => Math.abs(q.O - cell.O) <= BAND_HALF_WIDTH);
  if (band.length < 8) return NaN;
  const { a, b } = ols(band.map((q) => q.parts[partKey].restA), band.map((q) => q.parts[partKey].A));
  return cell.parts[partKey].A - (a + b * cell.parts[partKey].restA);
}
function aucOf(positives: number[], negatives: number[]): number {
  if (positives.length === 0 || negatives.length === 0) return NaN;
  // Rank-sum formulation with mid-ranks for ties.
  const all = [...positives, ...negatives];
  const ranks = rankArray(all);
  let sumPos = 0;
  for (let i = 0; i < positives.length; i += 1) sumPos += ranks[i];
  const n1 = positives.length, n2 = negatives.length;
  return (sumPos - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}
const fmt = (value: number, digits = 3): string => Number.isFinite(value) ? value.toFixed(digits) : "n/a";
const pct = (value: number): string => Number.isFinite(value) ? `${(100 * value).toFixed(1)}%` : "n/a";

// ---------- per-keymode analysis ----------
for (const k of KEYMODES) {
  const pool = cells.filter((cell) => cell.k === k);
  const ref = pool.filter((cell) => cell.N >= ELIGIBLE_N && cell.parts.ln.n >= ELIGIBLE_LN);
  console.log(`\n=================== ${k}K ===================`);
  console.log(`cells with plays: ${pool.length}; Ref(k) (N>=${ELIGIBLE_N}, n_ln>=${ELIGIBLE_LN}): ${ref.length}`);
  if (ref.length < 10) continue;

  const Rln = ref.map((c) => c.parts.ln.A / c.O);
  const shareLn = ref.map((c) => c.parts.ln.n / c.N);
  const overall = ref.map((c) => c.O);
  console.log(`rho(R_ln, share_ln)=${fmt(spearman(Rln, shareLn))}  rho(R_ln, Overall)=${fmt(spearman(Rln, overall))}`);
  console.log(`share_ln p05/p50/p95 = ${fmt(quantile(shareLn, 0.05))} / ${fmt(quantile(shareLn, 0.5))} / ${fmt(quantile(shareLn, 0.95))}`);

  // Ceiling mass (saturation gate).
  for (const band of [26, 28, 29, 31, 32, 33]) {
    const inBand = ref.filter((c) => c.O >= band);
    if (inBand.length === 0) continue;
    const ceiling = inBand.filter((c) => c.parts.ln.A / c.O >= 0.995);
    const bandSizes = inBand.map((c) => ref.filter((q) => Math.abs(q.O - c.O) <= BAND_HALF_WIDTH).length);
    console.log(
      `Overall>=${band}: ${inBand.length} cells, R_ln>=0.995: ${ceiling.length} (${pct(ceiling.length / inBand.length)}),`
      + ` AUC ceiling ${fmt(1 - ceiling.length / inBand.length / 2)}, median band ${median(bandSizes)?.toFixed(0)}`,
    );
  }

  // --- B1: placebo-partition table (split-half reliability, two machineries) ---
  console.log(`\n-- B1 split-half reliability on Ref(k) (Spearman-Brown) --`);
  console.log("partition |  R-style | lean-style | n_cells");
  for (const p of ["ln", ...PLACEBOS, "jumpstream", "chordstream"]) {
    const part = ref.filter((c) => c.parts[p].n >= 4 && c.parts[p].restN >= 4);
    if (part.length < 30) continue;
    const rA = part.map((c) => (c.OHa > 0 ? c.parts[p].hA / c.OHa : NaN));
    const rB = part.map((c) => (c.OHb > 0 ? c.parts[p].hB / c.OHb : NaN));
    const ok = rA.map((v, i) => Number.isFinite(v) && Number.isFinite(rB[i]));
    const rR = spearman(ok.map((_, i) => rA[i]).filter((_) => true).length ? rA.filter((_, i) => ok[i]) : [], rB.filter((_, i) => ok[i]));
    // lean-style halves: residuals against the population lean fit on full values
    const fit = ols(part.map((c) => c.parts[p].restA), part.map((c) => c.parts[p].A));
    const lA = part.map((c) => c.parts[p].hA - (fit.a + fit.b * c.parts[p].restHA));
    const lB = part.map((c) => c.parts[p].hB - (fit.a + fit.b * c.parts[p].restHB));
    console.log(
      `${p.padEnd(12)} |   ${fmt(spearmanBrown(rR))}   |   ${fmt(spearmanBrown(spearman(lA, lB)))}   | ${part.length}`,
    );
  }

  // --- B2: exposure table ---
  console.log(`\n-- B2 rho(R_x, share_x), whole population and skill bands --`);
  console.log("axis       |   all | O>=26 | O>=29");
  for (const p of [...LN_FAMILY, ...CONTROLS]) {
    const rows = ref.filter((c) => c.parts[p].n >= 1);
    if (rows.length < 30) continue;
    const line = (list: typeof rows): number => {
      const rx = list.map((c) => (c.O > 0 ? c.parts[p].A / c.O : NaN));
      const sx = list.map((c) => c.parts[p].n / c.N);
      const ok = rx.map((v) => Number.isFinite(v));
      return spearman(rx.filter((_, i) => ok[i]), sx.filter((_, i) => ok[i]));
    };
    console.log(
      `${p.padEnd(10)} | ${fmt(line(rows))} | ${fmt(line(rows.filter((c) => c.O >= 26)))} | ${fmt(line(rows.filter((c) => c.O >= 29)))}`,
    );
  }

  // --- B3: pp-selection table ---
  const withBoth = ref.filter((c) => c.nTop >= 5 && c.nTracked >= 5 && c.lnTopN + c.lnTrackedN >= 10);
  if (withBoth.length >= 30) {
    const topShare = withBoth.map((c) => c.lnTopN / c.nTop);
    const trackedShare = withBoth.map((c) => c.lnTrackedN / c.nTracked);
    const diffs = withBoth.map((c) => c.lnTopN / c.nTop - c.lnTrackedN / c.nTracked);
    const topPlays = ref.reduce((sum, c) => sum + c.nTop, 0);
    const allPlays = ref.reduce((sum, c) => sum + c.N, 0);
    console.log(`\n-- B3 pp-selection (cells with >=5 top and >=5 tracked plays, n=${withBoth.length}) --`);
    console.log(`median share_ln top=${fmt(median(topShare))} tracked=${fmt(median(trackedShare))} within-player diff=${fmt(median(diffs))}`);
    console.log(`top-sourced play share of rated pool: ${pct(topPlays / allPlays)}`);
  }

  // --- C: discriminant family, population scoring ---
  console.log(`\n-- C discriminants (population side) --`);
  // leanRest: population OLS residual of A_ln against the same player's non-LN pool.
  const fitRest = ols(ref.map((c) => c.parts.ln.restA), ref.map((c) => c.parts.ln.A));
  const leanRest = ref.map((c) => c.parts.ln.A - (fitRest.a + fitRest.b * c.parts.ln.restA));
  // leanBand: the same residual computed inside each cell's Overall band (+-1 MSD),
  // i.e. the LN pool residualised against the non-LN pool among equally-skilled players.
  const leanBand = ref.map((cell) => {
    const band = ref.filter((q) => Math.abs(q.O - cell.O) <= BAND_HALF_WIDTH);
    if (band.length < 8) return NaN;
    return bandResidual(ref, cell);
  });
  const fitO = ols(overall, ref.map((c) => c.parts.ln.A));
  const leanO = ref.map((c) => c.parts.ln.A - (fitO.a + fitO.b * c.O));
  console.log(`leanRest fit: A_ln = ${fitRest.a.toFixed(4)} + ${fitRest.b.toFixed(5)} * A_rest`);
  console.log(`leanO fit:    A_ln = ${fitO.a.toFixed(4)} + ${fitO.b.toFixed(5)} * O`);
  const rlLn = ref.map((c) => (c.parts.ln.rlN >= 5 ? c.parts.ln.rl : NaN));
  const rlAll = ref.map((c) => (c.rlAllN >= 5 ? c.rlAll : NaN));
  const rlContrast = ref.map((c) => (c.parts.ln.rlN >= 5 && c.parts.ln.restRlN >= 5 ? c.parts.ln.rl - c.parts.ln.restRl : NaN));
  const okRlLn = rlLn.map((v) => Number.isFinite(v));
  const okRlAll = rlAll.map((v) => Number.isFinite(v));
  const okRlC = rlContrast.map((v) => Number.isFinite(v));
  console.log(`RL ln-partition: rho(RL, share_ln)=${fmt(spearman(rlLn.filter((_, i) => okRlLn[i]), shareLn.filter((_, i) => okRlLn[i])))} rho(RL, R_ln)=${fmt(spearman(rlLn.filter((_, i) => okRlLn[i]), Rln.filter((_, i) => okRlLn[i])))}`);
  console.log(`RL all plays:    rho(RL, share_ln)=${fmt(spearman(rlAll.filter((_, i) => okRlAll[i]), shareLn.filter((_, i) => okRlAll[i])))} rho(RL, R_ln)=${fmt(spearman(rlAll.filter((_, i) => okRlAll[i]), Rln.filter((_, i) => okRlAll[i])))}`);
  console.log(`RL contrast:     rho(RL, share_ln)=${fmt(spearman(rlContrast.filter((_, i) => okRlC[i]), shareLn.filter((_, i) => okRlC[i])))} rho(RL, R_ln)=${fmt(spearman(rlContrast.filter((_, i) => okRlC[i]), Rln.filter((_, i) => okRlC[i])))}`);
  console.log(`leanRest vs incumbent: rho=${fmt(spearman(leanRest, Rln))}  r(Overall)=${fmt(pearson(leanRest, overall))}`);
  const okLb = leanBand.map((v) => Number.isFinite(v));
  console.log(`leanBand vs incumbent: rho=${fmt(spearman(leanBand.filter((_, i) => okLb[i]), Rln.filter((_, i) => okLb[i])))}  r(Overall)=${fmt(pearson(leanBand.filter((_, i) => okLb[i]), overall.filter((_, i) => okLb[i])))}  n=${okLb.filter(Boolean).length}`);
  console.log(`leanO vs incumbent:    rho=${fmt(spearman(leanO, Rln))}  rho(leanO, leanRest)=${fmt(spearman(leanO, leanRest))}`);

  // D-metric machinery check: incumbent D_ln distribution + band sizes.
  const bandOf = (cell: Cell): Cell[] => ref.filter((q) => Math.abs(q.O - cell.O) <= BAND_HALF_WIDTH);
  const dLn = ref.map((cell) => {
    const band = bandOf(cell);
    if (band.length < 2) return NaN;
    const value = cell.parts.ln.A / cell.O;
    let below = 0;
    for (const q of band) {
      if (q === cell) continue;
      if (q.parts.ln.A / q.O < value) below += 1;
    }
    return (100 * below) / (band.length - 1);
  });
  console.log(`D_ln: median=${fmt(median(dLn.filter(Number.isFinite)), 1)} p10=${fmt(quantile(dLn.filter(Number.isFinite), 0.1), 1)} p90=${fmt(quantile(dLn.filter(Number.isFinite), 0.9), 1)}`);

  // Exposure pseudo-label fingerprint (plan weakness #3): labels built from
  // nothing but share_ln must NOT perfectly separate a valid skill axis.
  const hi = ref.filter((c) => c.parts.ln.n / c.N >= 0.85 && c.O >= 26);
  const lo = ref.filter((c) => c.parts.ln.n / c.N <= 0.3 && c.O >= 26);
  if (hi.length >= 10 && lo.length >= 10) {
    const leanRestHi = hi.map((c) => c.parts.ln.A - (fitRest.a + fitRest.b * c.parts.ln.restA));
    const leanRestLo = lo.map((c) => c.parts.ln.A - (fitRest.a + fitRest.b * c.parts.ln.restA));
    const rlnHi = hi.map((c) => c.parts.ln.A / c.O);
    const rlnLo = lo.map((c) => c.parts.ln.A / c.O);
    const rlHi = hi.map((c) => c.parts.ln.rl);
    const rlLo = lo.map((c) => c.parts.ln.rl);
    console.log(`exposure pseudo-labels (hi=${hi.length}, lo=${lo.length}): AUC leanRest=${fmt(aucOf(leanRestHi, leanRestLo))} R_ln=${fmt(aucOf(rlnHi, rlnLo))} RL=${fmt(aucOf(rlHi, rlLo))}`);
  }
}

console.log("\n(done)");
