/**
 * Measures 4K skill-tile filing variants against mapper-named pack corpora.
 *
 * Corpus method (see memory/jack-tile-and-detector): charts from beatmapsets
 * whose title reads pack/practice/training/collection, labelled by the pattern
 * word in the diff version (preferred) or the set title. Heavy-LN charts
 * (lnRatio >= 0.45) are dropped; the tiles under test are the rice side.
 *
 * Variants:
 *   V0 shipped   - shipped logic (speed near-tie 1.25, tech tiebreak at
 *                  analyzer score >= 0.8, tech-lead arm at 0.5 MSD on a
 *                  tech-tagged chart at 0.6 MSD, stamina 240s length gate held against
 *                  the near-tie when Technical outranks Stream, Jumpstream
 *                  arbitrated by LeoBlack's label)
 *   J0 js-tech   - the pre-arbitration Jumpstream-rides-with-tech pairing
 *   S0 no-hold   - drops the stamina hold (the pre-2026-08-29 near-tie order)
 *   T0 no-lead   - drops the tech-lead arm
 *   T4/T6/T5     - tech-lead arm at other leads / without the tech tag
 *
 * NOTE: libsql rows are array-like, so a column literally named "length" is
 * shadowed by Array.length (the column count) - alias it, as len_seconds is.
 *
 * Read-only: nothing is written. Run:
 *   npx tsx scripts/dev/tile-variant-sweep.ts
 */
import { createClient } from "@libsql/client";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";

const SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"] as const;
const SPEED_NEAR_TIE_MSD = 1.25;
const TECH_NEAR_TIE_MIN_SCORE = 0.8;
const TECH_NEAR_TIE_MSD_LEAD = 0.6;
const STAMINA_TILE_MIN_LENGTH_SECONDS = 240;
const CHORDJACK_TAG_MIN_SCORE = 0.8;
const PATTERN_TAG_MIN_SCORE = 0.5;
const TECH_CLUSTER_CATEGORY = /tech/i;
const LN_MIN_RATIO = 0.45;

interface ChartRow {
  beatmapId: number;
  corpus: string;
  lengthSeconds: number | null;
  values: Record<string, number>;
  techScore: number;
  techCategory: boolean | null;
  clusterRaw: string | null;
  hasJackOverride: boolean;
  title: string;
  version: string;
}

interface Variant {
  id: string;
  clusterTechArm: boolean;
  /** Minimum in-house tech score the cluster arm also demands (0 = none). */
  clusterMinTechScore: number;
  clusterBand: number;
  /** "cluster": Jumpstream files tech when the cluster label reads tech/trill, stamina otherwise. */
  jsTile: "tech" | "stamina" | "cluster";
  /** A Stamina argmax on a 240s+ chart holds the tile before the speed near-tie fires. */
  staminaHolds: boolean;
  /** The hold also demands Technical within this of Stream (0 = Technical must outrank Stream; Infinity = no demand). */
  staminaHoldsTechBand: number;
  /** Past this length the hold fires with no Technical demand at all (Infinity = never). */
  staminaHoldsFreeLength: number;
  /** Technical takes a would-be speed verdict when it leads Stream by at least this (Infinity = arm off). */
  techLeadMin: number;
  /** Minimum analyzer tech score the lead arm also demands (0 = none). */
  techLeadMinScore: number;
}

const JS_TECH_CLUSTER = /tech|trill/i;

const SHIPPED = {
  clusterTechArm: false,
  clusterMinTechScore: 0,
  clusterBand: SPEED_NEAR_TIE_MSD,
  jsTile: "cluster" as const,
  staminaHolds: true,
  staminaHoldsTechBand: 0,
  techLeadMin: TECH_NEAR_TIE_MSD_LEAD,
  techLeadMinScore: PATTERN_TAG_MIN_SCORE,
  staminaHoldsFreeLength: Infinity,
};

const VARIANTS: Variant[] = [
  { id: "V0 shipped", ...SHIPPED },
  { id: "J0 js-tech", ...SHIPPED, jsTile: "tech" },
  { id: "S0 no-hold", ...SHIPPED, staminaHolds: false },
  { id: "T0 no-lead", ...SHIPPED, techLeadMin: Infinity },
  { id: "T4 lead.75", ...SHIPPED, techLeadMin: 0.75 },
  { id: "T6 lead.25", ...SHIPPED, techLeadMin: 0.25 },
  { id: "T5 lead.50 ts0", ...SHIPPED, techLeadMinScore: 0 },
  // Widening the hold's Technical demand, and length-scaled arms that drop it
  // entirely past a longer gate (Demiourgos 3264851 is 6:27 with Technical
  // 0.34 under Stream, so it needs band >= 0.35 or a free length <= 387).
  { id: "H1 band.50", ...SHIPPED, staminaHoldsTechBand: 0.5 },
  { id: "H2 band1.25", ...SHIPPED, staminaHoldsTechBand: SPEED_NEAR_TIE_MSD },
  { id: "H3 no-techdem", ...SHIPPED, staminaHoldsTechBand: Infinity },
  { id: "H4 free@300", ...SHIPPED, staminaHoldsFreeLength: 300 },
  { id: "H5 free@360", ...SHIPPED, staminaHoldsFreeLength: 360 },
  { id: "H6 free@420", ...SHIPPED, staminaHoldsFreeLength: 420 },
];

function dominant(values: Record<string, number>, keep: readonly string[]): string | null {
  let best: string | null = null;
  let bestValue = 0;
  for (const s of keep) {
    const v = Number(values[s] ?? 0);
    if (Number.isFinite(v) && v > bestValue) { best = s; bestValue = v; }
  }
  return best;
}

function bucketingSkillset(chart: ChartRow, variant: Variant, keep: readonly string[] = SKILLSETS): string | null {
  const values = chart.values;
  const top = dominant(values, keep);
  if (top == null) return top;
  if (variant.staminaHolds && top === "Stamina" && chart.lengthSeconds != null
    && chart.lengthSeconds >= STAMINA_TILE_MIN_LENGTH_SECONDS && keep.includes("Stamina")
    && (chart.lengthSeconds >= variant.staminaHoldsFreeLength
      || Number(values.Technical ?? 0) >= Number(values.Stream ?? 0) - variant.staminaHoldsTechBand)) return top;
  const stream = Number(values.Stream ?? 0);
  const best = Number(values[top] ?? 0);
  const nearTie = top === "Stream" || (stream > 0 && keep.includes("Stream") && stream >= best - SPEED_NEAR_TIE_MSD) ? "Stream" : top;
  if (nearTie === "Stream") {
    const technical = Number(values.Technical ?? 0);
    const scoreBacked = chart.techScore >= TECH_NEAR_TIE_MIN_SCORE && technical > 0 && technical >= stream - SPEED_NEAR_TIE_MSD;
    const clusterBacked = variant.clusterTechArm && chart.techCategory === true
      && chart.techScore >= variant.clusterMinTechScore
      && technical > 0 && technical >= stream - variant.clusterBand;
    const leadBacked = Number.isFinite(variant.techLeadMin) && technical > 0
      && chart.techScore >= variant.techLeadMinScore
      && technical - stream >= variant.techLeadMin;
    return scoreBacked || clusterBacked || leadBacked ? "Technical" : "Stream";
  }
  if (nearTie !== "Stamina" || chart.lengthSeconds == null) return nearTie;
  if (chart.lengthSeconds >= STAMINA_TILE_MIN_LENGTH_SECONDS) return nearTie;
  return bucketingSkillset(chart, variant, keep.filter((s) => s !== "Stamina"));
}

function tileFor(chart: ChartRow, variant: Variant): string {
  if (chart.hasJackOverride) return "jack";
  const top = bucketingSkillset(chart, variant);
  if (top == null) return "none";
  if (top === "JackSpeed" || top === "Chordjack") return "jack";
  if (top === "Technical") return "tech";
  if (top === "Jumpstream") {
    if (variant.jsTile !== "cluster") return variant.jsTile;
    return chart.clusterRaw != null && JS_TECH_CLUSTER.test(chart.clusterRaw) ? "tech" : "stamina";
  }
  if (top === "Stream") return "speed";
  return "stamina"; // Handstream, Stamina
}

// Longest/most-specific first so "speedjack" never reads as "speed" and
// "jumpstream" never reads as "stream".
const LABEL_WORDS: Array<[RegExp, string]> = [
  [/speed\s*jack/i, "jack"],
  [/chord\s*jack/i, "jack"],
  [/mini\s*jack/i, "jack"],
  [/hand\s*stream/i, "handstream"],
  [/jump\s*stream|\bjs\b/i, "jumpstream"],
  [/jump\s*trill/i, "jumptrill"],
  [/stamina|endurance|marathon/i, "stamina"],
  [/\bln\b|long\s*note|invers|release/i, "ln"],
  [/stream/i, "stream"],
  [/speed/i, "speed"],
  [/tech/i, "tech"],
  [/jack/i, "jack"],
  [/vibro/i, "skip"],
];

function labelFrom(text: string): string | null {
  for (const [re, label] of LABEL_WORDS) if (re.test(text)) return label;
  return null;
}

const PACKISH = /pack|practice|training|collection/i;

async function main() {
  const db = createClient({ url: DB_URL });
  const index = await db.execute({
    sql: `select m.beatmap_id, m.title, m.version, m.length as len_seconds
            from map_search_index m where m.key_count = 4`,
    args: [],
  });

  const lengthById = new Map<number, number>();
  for (const row of index.rows) {
    const l = Number(row.len_seconds);
    if (Number.isFinite(l) && l > 0) lengthById.set(Number(row.beatmap_id), l);
  }
  const corpusById = new Map<number, { corpus: string; title: string; version: string; length: number | null }>();
  for (const row of index.rows) {
    const title = String(row.title ?? "");
    const version = String(row.version ?? "");
    if (!PACKISH.test(title)) continue;
    const label = labelFrom(version) ?? labelFrom(title);
    if (label == null || label === "ln" || label === "skip") continue;
    const length = Number(row.len_seconds);
    corpusById.set(Number(row.beatmap_id), {
      corpus: label,
      title,
      version,
      length: Number.isFinite(length) && length > 0 ? length : null,
    });
  }

  // Random corpus: every other 4K chart, sampled.
  const nonCorpus = index.rows.filter((row) => !corpusById.has(Number(row.beatmap_id)));
  for (let i = nonCorpus.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nonCorpus[i], nonCorpus[j]] = [nonCorpus[j], nonCorpus[i]];
  }
  for (const row of nonCorpus.slice(0, 4000)) {
    const length = Number(row.len_seconds);
    corpusById.set(Number(row.beatmap_id), {
      corpus: "random",
      title: String(row.title ?? ""),
      version: String(row.version ?? ""),
      length: Number.isFinite(length) && length > 0 ? length : null,
    });
  }

  const SPOT_IDS = [4670645, 3208141, 3208148, 3090568, 3148376, 777348, 4189256, 3264851];
  const ids = [...new Set([...corpusById.keys(), ...SPOT_IDS])];
  const chartById = new Map<number, ChartRow>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = (await db.execute({
      sql: `select beatmap_id, msd_json, classification_json,
                   json_extract(classification_json, '$.lnRatio') as ln_ratio,
                   json_extract(classification_json, '$.clusterCategory') as cluster_category
              from beatmap_chart_analysis
             where status = 'ready' and key_count = 4 and beatmap_id in (${placeholders})
             order by analysis_version`,
      args: chunk,
    })).rows;
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      const meta = corpusById.get(beatmapId);
      const lnRatio = Number(row.ln_ratio);
      if (Number.isFinite(lnRatio) && lnRatio >= LN_MIN_RATIO) continue;
      let msd: { values?: Record<string, number> } | null = null;
      let cls: { patterns?: Array<{ id?: string; score?: number }> } | null = null;
      try { msd = JSON.parse(String(row.msd_json ?? "null")); } catch { /* skip */ }
      try { cls = JSON.parse(String(row.classification_json ?? "null")); } catch { /* skip */ }
      const values = msd?.values;
      if (!values || !Number.isFinite(Number(values.Overall))) continue;
      const scores = new Map<string, number>();
      for (const hit of Array.isArray(cls?.patterns) ? cls!.patterns! : []) {
        const id = String(hit?.id ?? "");
        if (id) scores.set(id, Math.max(scores.get(id) ?? 0, Number(hit?.score ?? 0)));
      }
      const chordjack = scores.get("chordjack") ?? 0;
      const speedjack = scores.get("speedjack") ?? 0;
      const vetoesTech = chordjack >= CHORDJACK_TAG_MIN_SCORE;
      const clusterCategory = row.cluster_category == null ? null : String(row.cluster_category);
      const chart: ChartRow = {
        beatmapId,
        corpus: meta?.corpus ?? "spot",
        lengthSeconds: meta?.length ?? lengthById.get(beatmapId) ?? null,
        values,
        techScore: vetoesTech ? 0 : (scores.get("tech") ?? 0),
        techCategory: clusterCategory == null ? null : TECH_CLUSTER_CATEGORY.test(clusterCategory),
        clusterRaw: clusterCategory,
        hasJackOverride: chordjack >= CHORDJACK_TAG_MIN_SCORE || speedjack >= PATTERN_TAG_MIN_SCORE,
        title: meta?.title ?? "",
        version: meta?.version ?? "",
      };
      // Latest analysis_version wins: rows arrive version-ascending, keep last.
      chartById.set(beatmapId, chart);
    }
  }
  const charts = [...chartById.values()];

  const TILES = ["jack", "tech", "speed", "stamina", "none"];
  const corpora = [...new Set(charts.map((c) => c.corpus))].sort();
  for (const corpus of corpora) {
    if (corpus === "spot") continue;
    const members = charts.filter((c) => c.corpus === corpus);
    console.log(`\n== ${corpus} (${members.length} charts) ==`);
    for (const variant of VARIANTS) {
      const counts = new Map<string, number>(TILES.map((t) => [t, 0]));
      let flips = 0;
      for (const chart of members) {
        const tile = tileFor(chart, variant);
        counts.set(tile, (counts.get(tile) ?? 0) + 1);
        if (variant.id !== VARIANTS[0].id && tile !== tileFor(chart, VARIANTS[0])) flips++;
      }
      const parts = TILES
        .filter((t) => (counts.get(t) ?? 0) > 0)
        .map((t) => `${t} ${(100 * (counts.get(t) ?? 0) / members.length).toFixed(1)}%`);
      console.log(`  ${variant.id.padEnd(12)} ${parts.join("  ")}${variant.id !== VARIANTS[0].id ? `  [moved ${flips}]` : ""}`);
    }
  }

  if (process.env.DUMP_FLIPS) {
    const [corpusName, variantId] = String(process.env.DUMP_FLIPS).split(":");
    const variant = VARIANTS.find((v) => v.id.startsWith(variantId));
    if (variant) {
      console.log(`\n== ${corpusName} charts moved under ${variant.id} ==`);
      for (const chart of charts.filter((c) => c.corpus === corpusName)) {
        const before = tileFor(chart, VARIANTS[0]);
        const after = tileFor(chart, variant);
        if (before === after) continue;
        console.log(`  ${chart.beatmapId} ${before}->${after} ts=${chart.techScore.toFixed(2)} cl="${chart.clusterRaw}" ${chart.title} | ${chart.version}`);
      }
    }
  }

  console.log("\n== spot charts ==");
  for (const id of SPOT_IDS) {
    const chart = charts.find((c) => c.beatmapId === id);
    if (!chart) { console.log(`  ${id}: no ready analysis`); continue; }
    const tiles = VARIANTS.map((v) => `${v.id.split(" ")[0]}=${tileFor(chart, v)}`).join(" ");
    console.log(`  ${id} techScore=${chart.techScore.toFixed(2)} cluster=${chart.techCategory} ${tiles}`);
  }
  db.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
