// Delay tag corpus check: the analyzer's off-grid row share and delay score
// per 7K chart across mapper-named packs plus a random sample, dumped to
// /tmp/delay-snap.jsonl for ramp iteration. Built 2026-09-03 when the delay
// score moved from density/entropy to offGridRowShare (features.ts).
// Run from live-backend/: npx tsx scripts/dev/delay-snap-measure.ts
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { parseManiaBeatmap } from "../../src/dan/beatmap-parser.ts";
import { extractDanFeatures } from "../../src/dan/dan-estimator/features.ts";
import { analyzeManiaPatterns } from "../../src/dan/dan-estimator/patterns.ts";

const db = new DatabaseSync("data/mania-hub-live.db", { readOnly: true });

const CORPORA: Record<string, string> = {
  delay: `(lower(title) like '%delay%pack%' or lower(title) like '%delaypack%' or lower(version) like '%delay%')`,
  speed: `(lower(title) like '%speed%pack%' or lower(title) like '%speed practice%' or lower(version) like '%speed%')`,
  jack: `(lower(title) like '%jack practice%' or lower(title) like '%jack pack%' or lower(title) like '%dan jack%')`,
  stream: `(lower(title) like '%chordstream%pack%' or lower(title) like '%stream practice%' or lower(title) like '%stream pack%')`,
  tech: `(lower(title) like '%tech%pack%' or lower(title) like '%tech practice%' or lower(title) like '%technical%pack%')`,
  random: `1=1 order by random() limit 700`,
};

const out: string[] = [];
for (const [corpus, where] of Object.entries(CORPORA)) {
  const rows = db.prepare(`select beatmap_id, title, version from map_search_index where key_count = 7 and ${where}`).all() as any[];
  let n = 0;
  for (const r of rows) {
    const f = db.prepare("select content, content_blob, compression from beatmap_osu_files where beatmap_id = ?").get(r.beatmap_id) as any;
    if (!f) continue;
    let text = f.content as string;
    if (!text && f.content_blob) { const b = Buffer.from(f.content_blob); text = (f.compression === "gzip" ? gunzipSync(b) : b).toString("utf8"); }
    if (!text) continue;
    try {
      const map = parseManiaBeatmap(text);
      if (map.keyCount !== 7 || map.notes.length < 100) continue;
      const input = { totalLength: map.totalLength > 0 ? map.totalLength / 1000 : undefined, version: map.version };
      const features = extractDanFeatures(map, input, 1);
      const analysis = analyzeManiaPatterns(map, input, features);
      const score = (id: string) => analysis.allPatterns.find((p) => p.id === id)?.score ?? 0;
      const stored = db.prepare("select classification_json from beatmap_chart_analysis where beatmap_id = ?").get(r.beatmap_id) as any;
      const storedDelay = stored?.classification_json
        ? (JSON.parse(stored.classification_json).patterns ?? []).find((p: any) => p.id === "delay")?.score ?? 0
        : null;
      out.push(JSON.stringify({
        corpus, beatmapId: r.beatmap_id, title: r.title, version: r.version,
        offGridRowShare: features.metrics.offGridRowShare, delay: score("delay"), chordjack: score("chordjack"), tech: score("tech"),
        storedDelay,
      }));
      n++;
    } catch { /* unparsable chart */ }
  }
  console.error(`${corpus}: ${n} charts`);
}
writeFileSync("/tmp/delay-snap.jsonl", out.join("\n") + "\n");
