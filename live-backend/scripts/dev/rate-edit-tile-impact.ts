/**
 * Measures what the rate-edit base length (applyRateEditBaseLengths) does to 4K
 * skill-tile filing, against the mapper-named pack corpora.
 *
 * Files each chart twice through the shipped danSkillsetBucketsForValues: once
 * with the length stored on the uploaded file, once with the base-rate length
 * the resolver recovers. Read-only.
 *
 * Run: npx tsx scripts/dev/rate-edit-tile-impact.ts
 */
import { createClient } from "@libsql/client";
import { danSkillsetBucketsForValues, loadChartSkillInfo } from "../../src/features/player-skills.js";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";

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
];
const PACKISH = /pack|practice|training|collection/i;

function labelFrom(text: string): string | null {
  for (const [re, label] of LABEL_WORDS) if (re.test(text)) return label;
  return null;
}

async function main() {
  const db = createClient({ url: DB_URL });

  // Only charts the resolver can possibly move: short files whose set holds a
  // longer same-keymode sibling. Everything else is filed identically twice.
  const rows = (await db.execute(`
    select m.beatmap_id, m.title, m.version, m.length as length_seconds
      from map_search_index m
     where m.key_count = 4 and m.length > 0 and m.length < 240
       and exists (select 1 from map_search_index c
                    where c.beatmapset_id = m.beatmapset_id and c.key_count = m.key_count
                      and c.ln_count = m.ln_count and c.beatmap_id <> m.beatmap_id
                      and c.length >= 240)
  `)).rows;

  const meta = new Map<number, { corpus: string; title: string; version: string; stored: number }>();
  for (const row of rows) {
    const title = String(row.title ?? "");
    const version = String(row.version ?? "");
    const label = PACKISH.test(title) ? labelFrom(version) ?? labelFrom(title) : "random";
    if (label == null || label === "ln") continue;
    meta.set(Number(row.beatmap_id), { corpus: label, title, version, stored: Number(row.length_seconds) });
  }

  const ids = [...meta.keys()];
  const info = await loadChartSkillInfo(db as never, ids);

  const msdById = new Map<number, Record<string, number>>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const msdRows = (await db.execute({
      sql: `select beatmap_id, msd_json from beatmap_chart_analysis
             where status = 'ready' and key_count = 4 and beatmap_id in (${placeholders})
             order by analysis_version`,
      args: chunk,
    })).rows;
    for (const row of msdRows) {
      const parsed = JSON.parse(String(row.msd_json ?? "null")) as { values?: Record<string, number> } | null;
      if (parsed?.values) msdById.set(Number(row.beatmap_id), parsed.values);
    }
  }

  const perCorpus = new Map<string, { candidates: number; resolved: number; moved: number; examples: string[] }>();
  for (const [beatmapId, entry] of meta) {
    const values = msdById.get(beatmapId);
    const chart = info.get(beatmapId);
    if (!values || !chart) continue;
    const bucket = perCorpus.get(entry.corpus)
      ?? { candidates: 0, resolved: 0, moved: 0, examples: [] };
    bucket.candidates += 1;
    const resolvedLength = chart.lengthSeconds;
    if (resolvedLength != null && resolvedLength > entry.stored) bucket.resolved += 1;
    const before = danSkillsetBucketsForValues(4, "rc", values, entry.stored, 1, chart).join("+");
    const after = danSkillsetBucketsForValues(4, "rc", values, resolvedLength, 1, chart).join("+");
    if (before !== after) {
      bucket.moved += 1;
      if (bucket.examples.length < 4) {
        bucket.examples.push(`${beatmapId} ${before}->${after} ${entry.stored}s->${resolvedLength}s ${entry.version}`);
      }
    }
    perCorpus.set(entry.corpus, bucket);
  }

  console.log("corpus            candidates  base-resolved  tile-moved");
  for (const [corpus, bucket] of [...perCorpus.entries()].sort()) {
    console.log(`  ${corpus.padEnd(16)} ${String(bucket.candidates).padStart(6)} ${String(bucket.resolved).padStart(12)} ${String(bucket.moved).padStart(11)}`);
  }
  console.log("\nexamples:");
  for (const [corpus, bucket] of [...perCorpus.entries()].sort()) {
    for (const example of bucket.examples) console.log(`  [${corpus}] ${example}`);
  }
  db.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
