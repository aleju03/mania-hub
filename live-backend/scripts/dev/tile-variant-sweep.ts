/**
 * Measures 4K skill-tile filing variants against mapper-named pack corpora.
 *
 * Corpus method (see memory/jack-tile-and-detector): charts from beatmapsets
 * whose title reads pack/practice/training/collection, labelled by the pattern
 * word in the diff version (preferred) or the set title. Heavy-LN charts
 * (lnRatio >= 0.45) are dropped; the tiles under test are the rice side.
 *
 * V0 tracks the shipped logic in player-skills.ts (speed near-tie 1.25, tech
 * tiebreak at analyzer score >= 0.8, tech-lead arm at 0.35 MSD on a tech-tagged
 * chart, stamina 240s length gate held against the near-tie when Technical,
 * Jumpstream or Handstream is within 0.5 of Stream, Jumpstream arbitrated by
 * LeoBlack's label and then by its runner-up skillset, Handstream near-tie on a
 * handstream-labelled chart, jack cluster share vetoing every stamina entry
 * path). Keep the two in step or the sweep measures a fiction, and note that
 * the corpus pass rates a CHART's own MSD vector while production buckets each
 * PLAY's accuracy-scaled one - the near-tie rules only show up in the
 * play-level block at the end, which reads stored plays_json. The other variants are the rules it
 * replaced, or the constants either side of the shipped ones.
 *
 * NOTE: libsql rows are array-like, so a column literally named "length" is
 * shadowed by Array.length (the column count) - alias it, as len_seconds is.
 *
 * SUPERSEDED FOR SPEED/TECH as of v21: the shipped speed-versus-tech verdict
 * is no longer an MSD-lead bar but a reading of the notes (SPEED_TECH_MODEL in
 * player-skills.ts), and a chart between its bars files under BOTH tiles. The
 * variants below still model the pre-v21 arms, which are what a chart with no
 * stored motion block falls back to, so they measure the fallback rather than
 * the shipped verdict. For the shipped one run
 * `scripts/dev/speed-tech-model.ts --impact`, which walks the same corpora
 * through danSkillsetBucketsForValues itself instead of reimplementing it.
 * The jack, stamina and Jumpstream-arbitration variants here are unaffected.
 *
 * Read-only: nothing is written. Run:
 *   npx tsx scripts/dev/tile-variant-sweep.ts
 */
import { createClient } from "@libsql/client";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";

const SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"] as const;
const SPEED_NEAR_TIE_MSD = 1.25;
const TECH_NEAR_TIE_MIN_SCORE = 0.8;
const TECH_NEAR_TIE_MSD_LEAD = 0.35;
const STAMINA_TILE_MIN_LENGTH_SECONDS = 240;
const STAMINA_HOLD_BASE_BAND = 0.5;
const HANDSTREAM_NEAR_TIE_MSD = 0.95;
const TRILL_JACK_MIN_CHORDJACK = 0.60;
const TRILL_JACK_CORROBORATED_CHORDJACK = 0.55;
const TRILL_JACK_CORROBORATED_SHARE = 0.15;
const TRILL_RUNNER_UP_MIN_LENGTH_SECONDS = 240;
const STAMINA_TILE_JACK_VETO_SHARE = 0.30;
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
  /** LeoBlack's label reads trill / reads tech. Null when it stored no label. */
  clusterTrill: boolean | null;
  clusterTech: boolean | null;
  handstreamCluster: boolean;
  jackShare: number | null;
  jackDemand: boolean;
  /** Raw analyzer chordjack score, for the dense-trill jack arm. */
  chordjackScore: number;
  /** The rate the play was set at. 1 for the chart-level corpus pass. */
  rate: number;
  hasJackOverride: boolean;
  title: string;
  version: string;
}

interface Variant {
  id: string;
  /** How a Jumpstream argmax is filed.
   *  "cluster"  - LeoBlack's label: tech/trill keeps tech, anything else stamina
   *  "tech"     - the legacy Jumpstream-rides-with-tech pairing
   *  "runnerup" - the chart's strongest OTHER skillset picks the tile */
  jsRule: "tech" | "cluster" | "runnerup" | "trill" | "techlabel";
  /** Below this length the "cluster" rule keeps the tech pairing whatever the label says. */
  jsArbitrationMinLength: number;
  /** A Stamina argmax on a 240s+ chart holds the tile before the speed near-tie fires. */
  staminaHolds: boolean;
  /** The hold also demands Technical within this of Stream. */
  staminaHoldsTechBand: number;
  /** Read the band against the best non-Stream base skillset, not Technical alone. */
  staminaHoldsBestBase: boolean;
  /** A jack-contaminated chart cannot pick an endurance runner-up. */
  runnerUpJackVeto: boolean;
  /** Handstream within this of the top skillset holds the stamina tile (Infinity = argmax only). */
  handstreamNearTie: number;
  /** The Handstream near-tie also demands LeoBlack read the chart as handstream. */
  handstreamNearTieNeedsCluster: boolean;
  /** Technical takes a would-be speed verdict when it leads Stream by at least this (Infinity = arm off). */
  techLeadMin: number;
  /** Minimum analyzer tech score the lead arm also demands (0 = none). */
  techLeadMinScore: number;
  /** A trill-labelled chart at or above this chordjack score files jack
   *  instead of tech (Infinity = arm off). */
  trillJackMinChordjack: number;
  /** Second arm: a lower chordjack score still files jack when the chart
   *  carries this much jack-cluster importance (Infinity = arm off). */
  trillJackCorroboratedChordjack: number;
  trillJackCorroboratedShare: number;
  /** A trill under both arms defers to the runner-up instead of keeping tech. */
  trillRunnerUp: boolean;
  /** Run the trill-jack check on ANY argmax, not just a Jumpstream one. */
  trillJackOverride: boolean;
  /** The runner-up fallback only fires on a file this long (Infinity = never). */
  trillRunnerUpMinLength: number;
}

const JS_TECH_CLUSTER = /tech|trill/i;
const TRILL_CLUSTER_CATEGORY = /trill/i;
const HANDSTREAM_CLUSTER_CATEGORY = /handstream/i;

const SHIPPED: Omit<Variant, "id"> = {
  jsRule: "techlabel",
  jsArbitrationMinLength: 0,
  staminaHolds: true,
  staminaHoldsTechBand: STAMINA_HOLD_BASE_BAND,
  staminaHoldsBestBase: true,
  runnerUpJackVeto: true,
  handstreamNearTie: HANDSTREAM_NEAR_TIE_MSD,
  trillJackMinChordjack: TRILL_JACK_MIN_CHORDJACK,
  trillJackCorroboratedChordjack: TRILL_JACK_CORROBORATED_CHORDJACK,
  trillJackCorroboratedShare: TRILL_JACK_CORROBORATED_SHARE,
  trillRunnerUp: true,
  trillJackOverride: true,
  trillRunnerUpMinLength: TRILL_RUNNER_UP_MIN_LENGTH_SECONDS,
  handstreamNearTieNeedsCluster: true,
  techLeadMin: TECH_NEAR_TIE_MSD_LEAD,
  techLeadMinScore: PATTERN_TAG_MIN_SCORE,
};

/** The logic on main before 2026-08-30, as the before half of every delta. */
const V18: Omit<Variant, "id"> = {
  ...SHIPPED,
  jsRule: "cluster",
  jsArbitrationMinLength: 90,
  staminaHoldsBestBase: false,
  runnerUpJackVeto: false,
  handstreamNearTie: Infinity,
  handstreamNearTieNeedsCluster: false,
  techLeadMin: 0.6,
};

const VARIANTS: Variant[] = [
  { id: "V0 shipped", ...SHIPPED },
  { id: "B0 v18", ...V18 },
  // The rules the shipped filing replaced, each on its own.
  { id: "J0 js-tech", ...SHIPPED, jsRule: "tech" },
  { id: "J1 js-label", ...SHIPPED, jsRule: "cluster" },
  { id: "J2 js-floor90", ...SHIPPED, jsRule: "cluster", jsArbitrationMinLength: 90 },
  { id: "J3 runnerup", ...SHIPPED, jsRule: "runnerup" },
  { id: "J4 no-rveto", ...SHIPPED, runnerUpJackVeto: false },
  { id: "H0 no-hstie", ...SHIPPED, handstreamNearTie: Infinity },
  { id: "H1 hstie-free", ...SHIPPED, handstreamNearTieNeedsCluster: false },
  { id: "H2 hstie.50", ...SHIPPED, handstreamNearTie: 0.5 },
  { id: "H3 hstie2.0", ...SHIPPED, handstreamNearTie: 2.0 },
  { id: "S0 hold-tech", ...SHIPPED, staminaHoldsBestBase: false },
  { id: "S1 no-hold", ...SHIPPED, staminaHolds: false },
  { id: "T0 no-lead", ...SHIPPED, techLeadMin: Infinity },
  { id: "T1 lead.60", ...SHIPPED, techLeadMin: 0.6 },
  { id: "T2 lead.45", ...SHIPPED, techLeadMin: 0.45 },
  { id: "T3 lead.25", ...SHIPPED, techLeadMin: 0.25 },
  // The dense-trill jack arm, at candidate bars.
  { id: "M1 hs1.25", ...SHIPPED, handstreamNearTie: SPEED_NEAR_TIE_MSD },
  { id: "M2 hs.50", ...SHIPPED, handstreamNearTie: 0.5 },
  { id: "K0 no-trill", ...SHIPPED, trillJackMinChordjack: Infinity },
  { id: "K1 trill.70", ...SHIPPED, trillJackMinChordjack: 0.70 },
  { id: "P1 no-corrob", ...SHIPPED, trillJackCorroboratedChordjack: Infinity },
  { id: "P2 no-override", ...SHIPPED, trillJackOverride: false },
  { id: "P3 RU-ungated", ...SHIPPED, trillRunnerUpMinLength: 0 },
  { id: "P4 no-RU", ...SHIPPED, trillRunnerUp: false },
  { id: "P5 share.20", ...SHIPPED, trillJackCorroboratedShare: 0.20 },
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

function jackContaminated(chart: ChartRow): boolean {
  return chart.jackShare != null && chart.jackShare >= STAMINA_TILE_JACK_VETO_SHARE;
}

/**
 * The longer of the 1.0x drain and the played time, matching enduranceSeconds
 * in player-skills.ts. The corpus pass carries rate 1 so this is just the
 * drain; the play-level pass carries the rate the play was actually set at,
 * which is what makes a downrated 3:02 file clear the 4:00 stamina gate.
 */
function endurance(chart: ChartRow): number | null {
  if (chart.lengthSeconds == null) return null;
  const rate = Number.isFinite(chart.rate) && chart.rate > 0 ? chart.rate : 1;
  return Math.max(chart.lengthSeconds, chart.lengthSeconds / rate);
}

const RICE = SKILLSETS.filter((s) => s !== "Stamina" && s !== "Handstream");
const BASE = SKILLSETS.filter((s) => s !== "Stamina");

function bucketingSkillset(chart: ChartRow, variant: Variant, keep: readonly string[] = SKILLSETS): string | null {
  const values = chart.values;
  const top = dominant(values, keep);
  if (top == null) return top;
  const stream = Number(values.Stream ?? 0);
  const len = endurance(chart);
  const demandsEndurance = len != null && len >= STAMINA_TILE_MIN_LENGTH_SECONDS;
  const holdRival = variant.staminaHoldsBestBase
    ? Math.max(Number(values.Technical ?? 0), Number(values.Jumpstream ?? 0), Number(values.Handstream ?? 0))
    : Number(values.Technical ?? 0);
  if (variant.staminaHolds && top === "Stamina" && demandsEndurance
    && holdRival >= stream - variant.staminaHoldsTechBand
    && !jackContaminated(chart)) return top;
  const best = Number(values[top] ?? 0);
  // A Handstream near-tie holds the stamina tile: Handstream names a pattern
  // rather than riding on one, and at hundredths the argmax is noise.
  if (Number.isFinite(variant.handstreamNearTie) && keep.includes("Handstream") && top !== "Handstream") {
    const handstream = Number(values.Handstream ?? 0);
    const clusterOk = !variant.handstreamNearTieNeedsCluster || chart.handstreamCluster;
    if (handstream > 0 && clusterOk && handstream >= best - variant.handstreamNearTie && !jackContaminated(chart)) return "Handstream";
  }
  const nearTie = top === "Stream" || (stream > 0 && keep.includes("Stream") && stream >= best - SPEED_NEAR_TIE_MSD)
    ? "Stream"
    : top;
  if (nearTie === "Stream") {
    const technical = Number(values.Technical ?? 0);
    const scoreBacked = chart.techScore >= TECH_NEAR_TIE_MIN_SCORE && technical > 0 && technical >= stream - SPEED_NEAR_TIE_MSD;
    const leadBacked = Number.isFinite(variant.techLeadMin) && technical > 0
      && chart.techScore >= variant.techLeadMinScore
      && technical - stream >= variant.techLeadMin;
    return scoreBacked || leadBacked ? "Technical" : "Stream";
  }
  if (nearTie === "Handstream" && jackContaminated(chart)) {
    return bucketingSkillset(chart, variant, keep.filter((s) => RICE.includes(s as never)));
  }
  if (nearTie !== "Stamina" || chart.lengthSeconds == null) return nearTie;
  if (demandsEndurance && !jackContaminated(chart)) return nearTie;
  return bucketingSkillset(chart, variant, keep.filter((s) => BASE.includes(s as never)));
}

function runnerUpSkillset(chart: ChartRow, variant: Variant): string {
  const pool = SKILLSETS.filter((s) => s !== "Jumpstream"
    && !(variant.runnerUpJackVeto && jackContaminated(chart) && (s === "Stamina" || s === "Handstream")));
  return dominant(chart.values, pool) ?? "Jumpstream";
}

function tileForSkillset(skillset: string): string {
  if (skillset === "JackSpeed" || skillset === "Chordjack") return "jack";
  if (skillset === "Technical") return "tech";
  if (skillset === "Stream") return "speed";
  return "stamina"; // Handstream, Stamina
}

/** Whether a trill-labelled chart's wrist demand reads as jack. */
function trillIsJack(chart: ChartRow, variant: Variant): boolean {
  if (chart.clusterTrill !== true) return false;
  if (chart.chordjackScore >= variant.trillJackMinChordjack) return true;
  return chart.chordjackScore >= variant.trillJackCorroboratedChordjack
    && (chart.jackShare ?? 0) >= variant.trillJackCorroboratedShare;
}

function tileFor(chart: ChartRow, variant: Variant): string {
  if (chart.jackDemand || chart.hasJackOverride) return "jack";
  if (variant.trillJackOverride && trillIsJack(chart, variant)) return "jack";
  const top = bucketingSkillset(chart, variant);
  if (top == null) return "none";
  if (top !== "Jumpstream") return tileForSkillset(top);
  if (variant.jsRule === "tech") return "tech";
  if (variant.jsRule === "techlabel") {
    // Mirrors bucketsForClear: a missing label keeps the legacy tech pairing,
    // a trill label keeps tech, a tech-suffixed label defers to the runner-up,
    // and a plain label files stamina unless the jack veto reaches it.
    if (chart.clusterTrill == null) return "tech";
    if (chart.clusterTrill) {
      // A trill is hit by oscillating the wrist, the same motion a chordjack
      // asks for, so a DENSE one is a jack demand rather than a tech one - as
      // is a lighter one that actually carries jack clusters.
      if (trillIsJack(chart, variant)) return "jack";
      const long = (endurance(chart) ?? 0) >= variant.trillRunnerUpMinLength;
      return variant.trillRunnerUp && long ? tileForSkillset(runnerUpSkillset(chart, variant)) : "tech";
    }
    if (chart.clusterTech === true) return tileForSkillset(runnerUpSkillset(chart, variant));
    return jackContaminated(chart) ? "tech" : "stamina";
  }
  if (variant.jsRule === "trill" && chart.clusterRaw != null && /trill/i.test(chart.clusterRaw)) return "tech";
  if (variant.jsRule === "runnerup" || variant.jsRule === "trill") {
    return tileForSkillset(runnerUpSkillset(chart, variant));
  }
  // The v18 rule: a missing label kept the tech pairing, as did a tech-or-trill
  // label, a file under the length floor, and a jack-contaminated chart.
  if (chart.clusterTrill == null) return "tech";
  if (JS_TECH_CLUSTER.test(chart.clusterRaw ?? "")) return "tech";
  const len = endurance(chart);
  if (len != null && len < variant.jsArbitrationMinLength) return "tech";
  return jackContaminated(chart) ? "tech" : "stamina";
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

// Charts named in the 2026-08-30 feedback, with the tile a 4K dan player says
// each should carry. "-" means no verdict was given.
const SPOT: Array<[number, string, string]> = [
  [4766898, "stamina", "daddy can change [men] 54s, JS 31.1 / Stamina 29.2"],
  [2134877, "stamina", "Gate Openerz [Christina] 256s, played DT"],
  [1297386, "-", "Grimm [Extra] - reporter unsure"],
  [1624796, "speed", "Finixe [Another] 222BPM jumpstream/stream"],
  [5339691, "stamina", "Hold Angel [Worship] handstream"],
  [3084903, "tech", "Matusa Bomber 0.95"],
  [3084904, "tech", "Matusa Bomber 1.05"],
  [3084905, "tech", "Matusa Bomber 1.1"],
  [3084906, "tech", "Matusa Bomber 1.15"],
  [4189254, "tech", "Matusa Bomber 1.2"],
  [4189255, "tech", "Matusa Bomber 1.25"],
  [4189256, "tech", "Matusa Bomber 2mnd"],
  [1021312, "jack", "NANO DEATH!!!!! [DEATH] 240BPM jumptrill, chordjack 0.71"],
  [4152216, "jack", "QZKago Requiem [NYARMAGEDDON] 257BPM jumptrill, chordjack 0.65"],
  [4983215, "stamina", "WACCA ULTRA DREAM MEGAMIX [FANTASY] 5:48 chordstream"],
  [2031389, "jack", "Perfect Neglect [Lyz's Another] cj 0.57 jackShare 0.33"],
  [1170750, "jack", "M1917 [Maximum] cj 0.58 jackShare 0.21"],
  [3468306, "tech", "FIN4LE [HEAVENLY] cj 0.59 jackShare 0.00 - too jumpstream for jack"],
  [1912526, "stamina", "Villain Virus [Music Virus] cj 0.55 jackShare 0.08"],
  [4602664, "stamina", "Gamma Hard Bags [Frenzied] 5:06"],
  [770127, "tech", "Blastix Riotz [GRAVITY] jumptrill, chordjack 0.50"],
  [789784, "tech", "Blastix Riotz [Jinjin's INFINITE]"],
  [2117613, "tech", "Blastix Riotz [GRAVITY Lv.16]"],
  [421066, "-", "AiAe [Wafles' SHD] jack-contaminated"],
  [3090568, "-", "Crescent Moon Island [Kuro 1.05x]"],
  [777348, "-", "PEACE BREAKER [FINAL PUNISHMENT]"],
  [3264851, "-", "Demiourgos"],
];

const PLAY_SPOT_IDS = new Set([5339691, 4766898, 1624796, 2134877, 3084904, 4189256]);

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

  const SPOT_IDS = SPOT.map(([id]) => id);
  const ids = [...new Set([...corpusById.keys(), ...SPOT_IDS])];
  const chartById = new Map<number, ChartRow>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = (await db.execute({
      sql: `select beatmap_id, msd_json, classification_json,
                   json_extract(classification_json, '$.lnRatio') as ln_ratio,
                   json_extract(classification_json, '$.clusterCategory') as cluster_category,
                   json_extract(classification_json, '$.jackDemand.detected') as jack_demand
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
      let cls: { patterns?: Array<{ id?: string; score?: number }>; clusters?: Array<{ pattern?: unknown; importance?: unknown }> } | null = null;
      try { msd = JSON.parse(String(row.msd_json ?? "null")); } catch { /* skip */ }
      try { cls = JSON.parse(String(row.classification_json ?? "null")); } catch { /* skip */ }
      const values = msd?.values;
      if (!values || !Number.isFinite(Number(values.Overall))) continue;
      const scores = new Map<string, number>();
      for (const hit of Array.isArray(cls?.patterns) ? cls!.patterns! : []) {
        const id = String(hit?.id ?? "");
        if (id) scores.set(id, Math.max(scores.get(id) ?? 0, Number(hit?.score ?? 0)));
      }
      let total = 0;
      let jack = 0;
      for (const cluster of Array.isArray(cls?.clusters) ? cls!.clusters! : []) {
        const importance = Number(cluster?.importance);
        if (!Number.isFinite(importance) || importance <= 0) continue;
        total += importance;
        if (/jack/i.test(String(cluster?.pattern ?? ""))) jack += importance;
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
        clusterTrill: clusterCategory == null || clusterCategory.trim() === ""
          ? null
          : TRILL_CLUSTER_CATEGORY.test(clusterCategory),
        clusterTech: clusterCategory == null || clusterCategory.trim() === ""
          ? null
          : TECH_CLUSTER_CATEGORY.test(clusterCategory),
        handstreamCluster: clusterCategory != null && HANDSTREAM_CLUSTER_CATEGORY.test(clusterCategory),
        jackShare: total > 0 ? jack / total : null,
        jackDemand: Number(row.jack_demand) === 1,
        chordjackScore: chordjack,
        rate: 1,
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

  // Play-level spot checks. The corpus above rates a chart's own MSD vector,
  // but production buckets the PLAY's accuracy-scaled SSR vector, and the two
  // disagree exactly where the near-ties live - so a chart-level spot check
  // cannot exercise the Handstream near-tie at all. These read the vectors
  // players actually stored.
  const playSpots = await db.execute({
    sql: `select user_id, plays_json from player_skill_ratings
           where status = 'ready' and plays_json is not null`,
    args: [],
  });
  const byBeatmap = new Map<number, Array<{ rate: number; values: Record<string, number> }>>();
  for (const row of playSpots.rows) {
    let parsed: { plays?: Array<Record<string, unknown>> } | null = null;
    try { parsed = JSON.parse(String(row.plays_json)); } catch { continue; }
    for (const play of parsed?.plays ?? []) {
      const beatmapId = Number(play?.beatmapId);
      if (!PLAY_SPOT_IDS.has(beatmapId)) continue;
      const values = play?.values as Record<string, number> | undefined;
      if (!values) continue;
      const list = byBeatmap.get(beatmapId) ?? [];
      list.push({ rate: Number(play?.rate ?? 1), values });
      byBeatmap.set(beatmapId, list);
    }
  }
  console.log("\n== stored plays per named chart (share landing on the wanted tile) ==");
  for (const [id, want, note] of SPOT) {
    const plays = byBeatmap.get(id);
    if (!plays || want === "-") continue;
    const chart = charts.find((c) => c.beatmapId === id);
    if (!chart) continue;
    const line = VARIANTS.map(({ id, ...variant }) => {
      const label = id;
      const hits = plays.filter((play) =>
        tileFor({ ...chart, values: play.values, rate: play.rate }, { id: label, ...variant }) === want).length;
      return `${label.split(" ")[0]} ${hits}`;
    }).join(" ");
    console.log(`  ${id} want=${want.padEnd(7)} ${line}   (${note})`);
  }

  console.log("\n== spot charts (want -> variant verdicts) ==");
  for (const [id, want, note] of SPOT) {
    const chart = charts.find((c) => c.beatmapId === id);
    if (!chart) { console.log(`  ${id}: no ready analysis`); continue; }
    const tiles = VARIANTS.map((v) => {
      const tile = tileFor(chart, v);
      const mark = want === "-" ? " " : tile === want ? "+" : "!";
      return `${v.id.split(" ")[0]}=${tile}${mark}`;
    }).join(" ");
    console.log(`  ${id} want=${want.padEnd(7)} ${tiles}   (${note})`);
  }
  db.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
