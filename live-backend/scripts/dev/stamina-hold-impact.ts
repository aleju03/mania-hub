/**
 * Measures the stamina hold (bucketingSkillset: a 240s+ Stamina argmax keeps
 * the tile when Technical also outranks Stream) over the whole local corpus,
 * chart-level and play-level, and lists the charts it moves.
 *
 * The "after" tile is the shipped function itself. The "before" tile is
 * derived rather than reimplemented: the hold can only fire when the argmax is
 * Stamina, the play demands endurance and Technical >= Stream, and it can only
 * CHANGE anything when Stream is also inside the near-tie band - otherwise the
 * old code reached the same Stamina verdict through the length gate. In that
 * one window the old result is the near-tie's: tech when the analyzer backed
 * it, speed otherwise, with the tag override (jack) unchanged either way.
 *
 * Read-only. Run:
 *   npx tsx scripts/dev/stamina-hold-impact.ts
 */
import { createClient } from "@libsql/client";
import { danSkillsetBucketsForValues, loadChartSkillInfo, type ChartSkillInfo } from "../../src/features/player-skills.js";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";
const SPEED_NEAR_TIE_MSD = 1.25;
const TECH_NEAR_TIE_MIN_SCORE = 0.8;
const STAMINA_TILE_MIN_LENGTH_SECONDS = 240;
const MSD_SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"] as const;

function argmax(values: Record<string, number>): string | null {
  let best: string | null = null;
  let bestValue = 0;
  for (const skillset of MSD_SKILLSETS) {
    const value = Number(values[skillset] ?? 0);
    if (Number.isFinite(value) && value > bestValue) { best = skillset; bestValue = value; }
  }
  return best;
}

/** Whether the hold fires AND changes the verdict (see the header). */
function holdChangesVerdict(values: Record<string, number>, lengthSeconds: number | null, rate: number): boolean {
  if (lengthSeconds == null) return false;
  const played = lengthSeconds / (Number.isFinite(rate) && rate > 0 ? rate : 1);
  if (Math.max(lengthSeconds, played) < STAMINA_TILE_MIN_LENGTH_SECONDS) return false;
  if (argmax(values) !== "Stamina") return false;
  const stream = Number(values.Stream ?? 0);
  const technical = Number(values.Technical ?? 0);
  if (technical < stream) return false;
  return stream > 0 && stream >= Number(values.Stamina ?? 0) - SPEED_NEAR_TIE_MSD;
}

/** The tile the near-tie would have handed this play before the hold existed. */
function tileBeforeHold(values: Record<string, number>, chart: ChartSkillInfo | undefined, after: string): string {
  if (after === "jack") return "jack"; // the tag override runs first, unmoved.
  const stream = Number(values.Stream ?? 0);
  const technical = Number(values.Technical ?? 0);
  const techBacked = (chart?.techScore ?? 0) >= TECH_NEAR_TIE_MIN_SCORE
    && technical > 0 && technical >= stream - SPEED_NEAR_TIE_MSD;
  return techBacked ? "tech" : "speed";
}

function tileAfter(values: Record<string, number>, lengthSeconds: number | null, rate: number, chart: ChartSkillInfo | undefined): string {
  const ids = danSkillsetBucketsForValues(4, "rc", values, lengthSeconds, rate, chart);
  return ids[0] ?? "none";
}

function pct(part: number, total: number): string {
  return total === 0 ? "0.0%" : `${(100 * part / total).toFixed(2)}%`;
}

function printDistribution(label: string, before: Map<string, number>, after: Map<string, number>, total: number) {
  console.log(`\n== ${label} (${total.toLocaleString("en-US")}) ==`);
  for (const tile of ["jack", "tech", "speed", "stamina", "none"]) {
    const b = before.get(tile) ?? 0;
    const a = after.get(tile) ?? 0;
    if (b === 0 && a === 0) continue;
    const delta = a - b;
    console.log(`  ${tile.padEnd(8)} ${pct(b, total).padStart(7)} -> ${pct(a, total).padStart(7)}  (${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-US")})`);
  }
}

async function main() {
  const db = createClient({ url: DB_URL });

  const idRows = (await db.execute("select beatmap_id from beatmap_chart_analysis where status = 'ready' and key_count = 4")).rows;
  const ids = idRows.map((row) => Number(row.beatmap_id));
  console.log(`ready 4K analyses: ${ids.length.toLocaleString("en-US")}`);
  const charts = await loadChartSkillInfo(db, ids);
  const msdRows = (await db.execute("select beatmap_id, msd_json from beatmap_chart_analysis where status = 'ready' and key_count = 4")).rows;
  const valuesById = new Map<number, Record<string, number>>();
  for (const row of msdRows) {
    try {
      const parsed = JSON.parse(String(row.msd_json ?? "null")) as { values?: Record<string, number> } | null;
      if (parsed?.values && Number.isFinite(Number(parsed.values.Overall))) valuesById.set(Number(row.beatmap_id), parsed.values);
    } catch { /* skip */ }
  }

  // Chart-level, every ready 4K chart at 1.0x.
  const chartBefore = new Map<string, number>();
  const chartAfter = new Map<string, number>();
  const moved: Array<{ beatmapId: number; before: string; after: string }> = [];
  for (const [beatmapId, values] of valuesById) {
    const chart = charts.get(beatmapId);
    const after = tileAfter(values, chart?.lengthSeconds ?? null, 1, chart);
    const before = holdChangesVerdict(values, chart?.lengthSeconds ?? null, 1)
      ? tileBeforeHold(values, chart, after)
      : after;
    chartAfter.set(after, (chartAfter.get(after) ?? 0) + 1);
    chartBefore.set(before, (chartBefore.get(before) ?? 0) + 1);
    if (before !== after) moved.push({ beatmapId, before, after });
  }
  printDistribution("charts, 1.0x", chartBefore, chartAfter, valuesById.size);
  console.log(`  moved: ${moved.length.toLocaleString("en-US")} (${pct(moved.length, valuesById.size)})`);

  // Play-level, every rated 4K play stored on a player row.
  const playBefore = new Map<string, number>();
  const playAfter = new Map<string, number>();
  const movedPlaysByMap = new Map<number, number>();
  let plays = 0;
  let movedPlays = 0;
  const RATED_TILE_MIN_CLEARS = 4;
  let usersWithAnyChange = 0;
  const tilesGained = new Map<string, number>();
  const tilesLost = new Map<string, number>();
  const userRows = (await db.execute("select user_id from player_skill_ratings where status = 'ready'")).rows;
  for (let offset = 0; offset < userRows.length; offset += 200) {
    const chunk = userRows.slice(offset, offset + 200).map((row) => Number(row.user_id));
    const rows = (await db.execute({
      sql: `select plays_json from player_skill_ratings
             where status = 'ready' and user_id in (${chunk.map(() => "?").join(", ")})`,
      args: chunk,
    })).rows;
    for (const row of rows) {
      let parsed: { plays?: Array<{ beatmapId?: number; keyCount?: number; rate?: number; values?: Record<string, number> }> } | null = null;
      try { parsed = JSON.parse(String(row.plays_json ?? "null")); } catch { continue; }
      const userBefore = new Map<string, number>();
      const userAfter = new Map<string, number>();
      for (const play of parsed?.plays ?? []) {
        if (Number(play?.keyCount) !== 4 || !play?.values) continue;
        const beatmapId = Number(play.beatmapId);
        const chart = charts.get(beatmapId);
        const rate = Number(play.rate) > 0 ? Number(play.rate) : 1;
        const after = tileAfter(play.values, chart?.lengthSeconds ?? null, rate, chart);
        const before = holdChangesVerdict(play.values, chart?.lengthSeconds ?? null, rate)
          ? tileBeforeHold(play.values, chart, after)
          : after;
        plays++;
        playAfter.set(after, (playAfter.get(after) ?? 0) + 1);
        playBefore.set(before, (playBefore.get(before) ?? 0) + 1);
        userBefore.set(before, (userBefore.get(before) ?? 0) + 1);
        userAfter.set(after, (userAfter.get(after) ?? 0) + 1);
        if (before !== after) {
          movedPlays++;
          movedPlaysByMap.set(beatmapId, (movedPlaysByMap.get(beatmapId) ?? 0) + 1);
        }
      }
      let changed = false;
      for (const tile of ["jack", "tech", "speed", "stamina"]) {
        const wasRated = (userBefore.get(tile) ?? 0) >= RATED_TILE_MIN_CLEARS;
        const isRated = (userAfter.get(tile) ?? 0) >= RATED_TILE_MIN_CLEARS;
        if (wasRated === isRated) continue;
        changed = true;
        const target = isRated ? tilesGained : tilesLost;
        target.set(tile, (target.get(tile) ?? 0) + 1);
      }
      if (changed) usersWithAnyChange++;
    }
  }
  printDistribution("rated 4K plays", playBefore, playAfter, plays);
  console.log(`  moved: ${movedPlays.toLocaleString("en-US")} (${pct(movedPlays, plays)}) across ${movedPlaysByMap.size} charts`);
  console.log(`  players whose rated-tile set changes (>= ${RATED_TILE_MIN_CLEARS} clears): ${usersWithAnyChange} of ${userRows.length} (${pct(usersWithAnyChange, userRows.length)})`);
  const fmt = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tile, count]) => `${tile} ${count}`).join(", ") || "none";
  console.log(`  rated tiles gained: ${fmt(tilesGained)}`);
  console.log(`  rated tiles lost:   ${fmt(tilesLost)}`);

  // What shapes the moved charts are, by LeoBlack's headline label: a moved
  // chart whose label reads pure stream is the misfire risk (a speed player
  // would still call it speed), one reading stamina/chordstream is the fix.
  if (moved.length > 0) {
    const labelRows = (await db.execute("select beatmap_id, json_extract(classification_json, '$.clusterCategory') as cluster from beatmap_chart_analysis where status = 'ready' and key_count = 4")).rows;
    const labelById = new Map(labelRows.map((row) => [Number(row.beatmap_id), row.cluster == null ? "(none)" : String(row.cluster)]));
    const byLabel = new Map<string, number>();
    for (const entry of moved) {
      const label = labelById.get(entry.beatmapId) ?? "(none)";
      byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    }
    console.log(`\n== moved charts by LeoBlack label (top 15 of ${byLabel.size}) ==`);
    for (const [label, count] of [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(count).padStart(4)}  ${pct(count, moved.length).padStart(7)}  ${label}`);
    }
    // The misfire class: a moved chart whose label names a pure stream shape.
    const PURE_STREAM_LABEL = /^(stream|minitrills|jumptrill)$/i;
    const suspects = moved
      .filter((entry) => PURE_STREAM_LABEL.test(labelById.get(entry.beatmapId) ?? ""))
      .map((entry) => ({ ...entry, plays: movedPlaysByMap.get(entry.beatmapId) ?? 0 }))
      .sort((a, b) => b.plays - a.plays);
    const suspectPlays = suspects.reduce((sum, entry) => sum + entry.plays, 0);
    console.log(`\n== moved charts labelled pure stream: ${suspects.length} charts, ${suspectPlays.toLocaleString("en-US")} plays (${pct(suspectPlays, plays)} of all plays) ==`);
    const suspectMeta = suspects.length === 0 ? [] : (await db.execute({
      sql: `select beatmap_id, title, version, length as len_seconds from map_search_index
             where beatmap_id in (${suspects.slice(0, 20).map(() => "?").join(", ")})`,
      args: suspects.slice(0, 20).map((entry) => entry.beatmapId),
    })).rows;
    const suspectMetaById = new Map(suspectMeta.map((row) => [Number(row.beatmap_id), row]));
    for (const entry of suspects.slice(0, 20)) {
      const meta = suspectMetaById.get(entry.beatmapId);
      const values = valuesById.get(entry.beatmapId);
      const gap = values ? (Number(values.Stamina ?? 0) - Number(values.Stream ?? 0)).toFixed(2) : "-";
      console.log(`  ${String(entry.plays).padStart(4)} plays  ${entry.beatmapId}  ${entry.before}->${entry.after}  len=${meta?.len_seconds ?? "?"}s  stam-str=${gap}  cl="${labelById.get(entry.beatmapId)}"  ${String(meta?.title ?? "")} | ${String(meta?.version ?? "")}`);
    }
  }

  // The charts the hold moves, most-played first: the misfire audit list.
  const top = [...movedPlaysByMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP ?? 40));
  const metaRows = top.length === 0 ? [] : (await db.execute({
    sql: `select beatmap_id, title, version, length as len_seconds
            from map_search_index where beatmap_id in (${top.map(() => "?").join(", ")})`,
    args: top.map(([beatmapId]) => beatmapId),
  })).rows;
  const metaById = new Map(metaRows.map((row) => [Number(row.beatmap_id), row]));
  console.log(`\n== charts the hold moves, by plays affected ==`);
  for (const [beatmapId, count] of top) {
    const meta = metaById.get(beatmapId);
    const values = valuesById.get(beatmapId);
    const chart = charts.get(beatmapId);
    const before = moved.find((entry) => entry.beatmapId === beatmapId)?.before ?? "-";
    const gap = values ? (Number(values.Stamina ?? 0) - Number(values.Stream ?? 0)).toFixed(2) : "-";
    const techGap = values ? (Number(values.Technical ?? 0) - Number(values.Stream ?? 0)).toFixed(2) : "-";
    console.log(`  ${String(count).padStart(4)} plays  ${beatmapId}  ${before}->stamina  len=${meta?.len_seconds ?? chart?.lengthSeconds ?? "?"}s  stam-str=${gap}  tech-str=${techGap}  ts=${(chart?.techScore ?? 0).toFixed(2)}  ${String(meta?.title ?? "")} | ${String(meta?.version ?? "")}`);
  }
  db.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
