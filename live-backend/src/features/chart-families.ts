import { createHash } from "node:crypto";
import type { ManiaBeatmap, ManiaNote } from "../dan/beatmap-parser.js";
import { parseManiaBeatmap } from "../dan/beatmap-parser.js";
import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { nowIso } from "../shared/score.js";

// This is player-evidence identity, never an input to chart difficulty. A
// topology hash only finds candidates; every head and hold tail must also
// agree after one uniform time scale and offset. Names and declared rates
// play no part, and integer-ms rounding in rate reuploads is tolerated.
export const CHART_FAMILY_VERSION = 1;
export const CHART_FAMILY_SWEEP_JOB = "recompute_chart_family_sweep";
export const CHART_FAMILY_META_KEY = "chart_family_sweep_done:v1";

function orderedNotes(map: ManiaBeatmap): ManiaNote[] {
  return [...map.notes].sort((a, b) => a.time - b.time || a.column - b.column || a.endTime - b.endTime);
}

function hasComparableNotes(map: ManiaBeatmap): boolean {
  return Number.isInteger(map.keyCount) && map.keyCount > 0 && map.notes.length >= 2
    && map.notes.every((note) => Number.isInteger(note.column) && note.column >= 0 && note.column < map.keyCount
      && Number.isFinite(note.time) && Number.isFinite(note.endTime) && note.endTime >= note.time);
}

export function chartTopologyKey(map: ManiaBeatmap): string | null {
  if (!hasComparableNotes(map)) return null;
  const hash = createHash("sha256").update(`${map.keyCount}:`);
  for (const note of orderedNotes(map)) hash.update(`${note.column},${Number(note.isHold)};`);
  return hash.digest("hex");
}

export function sameChartAtDifferentRate(left: ManiaBeatmap, right: ManiaBeatmap): boolean {
  if (left.keyCount !== right.keyCount || left.notes.length !== right.notes.length
    || !hasComparableNotes(left) || !hasComparableNotes(right)) return false;
  const a = orderedNotes(left);
  const b = orderedNotes(right);
  const startA = a[0].time;
  const startB = b[0].time;
  const spanA = a.reduce((end, note) => Math.max(end, note.endTime), startA) - startA;
  const spanB = b.reduce((end, note) => Math.max(end, note.endTime), startB) - startB;
  if (!(spanA > 0) || !(spanB > 0)) return false;
  const scale = spanB / spanA;
  // Both files can have rounded timestamps, including the two anchors.
  const tolerance = 2 * (1 + scale);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].column !== b[i].column || a[i].isHold !== b[i].isHold) return false;
    if (Math.abs((a[i].time - startA) * scale - (b[i].time - startB)) > tolerance) return false;
    if (Math.abs((a[i].endTime - startA) * scale - (b[i].endTime - startB)) > tolerance) return false;
  }
  return true;
}

export async function storeChartFamily(db: Db, beatmapId: number, osuText: string, map = parseManiaBeatmap(osuText)): Promise<void> {
  const topology = chartTopologyKey(map);
  if (!topology) {
    await exec(db, "delete from beatmap_chart_families where beatmap_id = ?", [beatmapId]);
    return;
  }
  const checksum = createHash("sha256").update(osuText).digest("hex");
  const current = (await exec(db,
    "select file_hash from beatmap_chart_families where beatmap_id = ? and version = ?",
    [beatmapId, CHART_FAMILY_VERSION],
  )).rows[0];
  if (current?.file_hash === checksum) return;
  const candidates = (await exec(db,
    `select beatmap_id, family_key, file_hash from beatmap_chart_families
     where topology_key = ? and version = ? and beatmap_id != ? order by beatmap_id`,
    [topology, CHART_FAMILY_VERSION, beatmapId],
  )).rows;
  // The key is immutable content identity, not a representative beatmap id:
  // editing the first upload must not relabel its older siblings as the edit.
  let familyKey = checksum;
  for (const candidate of candidates) {
    const text = await readCachedBeatmapFile(db, Number(candidate.beatmap_id), { touch: false });
    if (!text || createHash("sha256").update(text).digest("hex") !== candidate.file_hash) continue;
    if (sameChartAtDifferentRate(map, parseManiaBeatmap(text))) {
      familyKey = String(candidate.family_key);
      break;
    }
  }
  await exec(db,
    `insert into beatmap_chart_families (beatmap_id, version, topology_key, family_key, file_hash)
     values (?, ?, ?, ?, ?) on conflict(beatmap_id) do update set
       version = excluded.version, topology_key = excluded.topology_key,
       family_key = excluded.family_key, file_hash = excluded.file_hash`,
    [beatmapId, CHART_FAMILY_VERSION, topology, familyKey, checksum],
  );
}

export async function recomputeChartFamilyChunk(db: Db, cursor: number, limit = 50): Promise<{ nextCursor: number; done: boolean }> {
  const rows = (await exec(db,
    `select beatmap_id from beatmap_osu_files where beatmap_id > ?
     and (compressed_bytes > 0 or length(content) > 0) order by beatmap_id limit ?`,
    [cursor, limit],
  )).rows;
  let nextCursor = cursor;
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = beatmapId;
    const text = await readCachedBeatmapFile(db, beatmapId, { touch: false });
    if (text && /^Mode\s*:\s*3\s*$/m.test(text)) await storeChartFamily(db, beatmapId, text);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { nextCursor, done: rows.length < limit };
}

export async function ensureChartFamilySweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  if ((await exec(db, "select 1 from live_meta where key = ?", [CHART_FAMILY_META_KEY])).rows.length) return;
  if ((await exec(db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [CHART_FAMILY_SWEEP_JOB],
  )).rows.length) return;
  await queue.enqueue(CHART_FAMILY_SWEEP_JOB, `${CHART_FAMILY_SWEEP_JOB}:0`, { cursor: 0 }, { priority: -9, replaceDone: true });
}

export async function runChartFamilySweepJob(db: Db, queue: JobQueue, payload: { cursor?: number } | undefined): Promise<void> {
  const result = await recomputeChartFamilyChunk(db, Math.max(0, Math.floor(Number(payload?.cursor) || 0)));
  if (result.done) {
    const now = nowIso();
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [CHART_FAMILY_META_KEY, json({ finishedAt: now }), now]);
    const { ensurePlayerSkillDanSweepSeeded } = await import("./player-skills.js");
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    return;
  }
  await queue.enqueue(CHART_FAMILY_SWEEP_JOB, `${CHART_FAMILY_SWEEP_JOB}:${result.nextCursor}`,
    { cursor: result.nextCursor }, { priority: -9, replaceDone: true });
}
