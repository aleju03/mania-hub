import { createHash } from "node:crypto";
import type { ManiaBeatmap, ManiaNote } from "../dan/beatmap-parser.js";
import { parseManiaBeatmap } from "../dan/beatmap-parser.js";
import type { Db, DbStatement } from "../db.js";
import { exec, execBatch, json } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logInfo, logWarn } from "../logger.js";
import { readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import { nowIso } from "../shared/score.js";
import { danSkillsetFingerprint, danSkillsetMatchStatement, DAN_SKILLSET_BY_FINGERPRINT } from "./dan-skillset-identity.js";
import { DAN_SKILLSET_CHARTS } from "./dan-skillset-registry.js";

// This is player-evidence identity, never an input to chart difficulty. Edge
// hashes only find candidates; every head and hold tail must then agree after
// one uniform time scale and offset, and the longer chart may carry only a few
// extra notes (a reupload with a handful of notes slipped into the intro is
// still the same chart). Names and declared rates play no part, and integer-ms
// rounding in rate reuploads is tolerated.
export const CHART_FAMILY_VERSION = 2;
export const CHART_FAMILY_SWEEP_JOB = "recompute_chart_family_sweep";
// v3 also indexes strict note/timing/OD fingerprints for skillset credentials.
export const CHART_FAMILY_META_KEY = "chart_family_sweep_done:v3";
// The family structure the dan refold reads was complete at v2; v3 re-walks the
// corpus only for the fingerprints, so a v2 stamp plus the registry bootstrap
// below is enough structure for the refold to start on.
export const CHART_FAMILY_STRUCTURE_META_KEYS = ["chart_family_sweep_done:v2", CHART_FAMILY_META_KEY] as const;
// Canonical credential coverage: every registry chart whose .osu is cached is
// fingerprinted at boot, so the credentials do not wait ~20h for the corpus
// sweep to crawl past their beatmap ids. Bump when the registry changes shape.
export const DAN_SKILLSET_REGISTRY_META_KEY = `dan_skillset_registry_seeded:v1:${DAN_SKILLSET_CHARTS.length}`;

/** Notes hashed at each end for candidate lookup; padding one end leaves the other key intact. */
const EDGE_WINDOW = 64;
/** Most candidate rows checked per chart, so a degenerate ending cannot stall the sweep. */
const CANDIDATE_LIMIT = 200;

/** Extra notes the longer chart may carry and still be the same chart. */
export function paddingAllowance(noteCount: number): number {
  return Math.max(16, Math.ceil(noteCount / 100));
}

function orderedNotes(map: ManiaBeatmap): ManiaNote[] {
  return [...map.notes].sort((a, b) => a.time - b.time || a.column - b.column || a.endTime - b.endTime);
}

function hasComparableNotes(map: ManiaBeatmap): boolean {
  return Number.isInteger(map.keyCount) && map.keyCount > 0 && map.notes.length >= 2
    && map.notes.every((note) => Number.isInteger(note.column) && note.column >= 0 && note.column < map.keyCount
      && Number.isFinite(note.time) && Number.isFinite(note.endTime) && note.endTime >= note.time);
}

function topologyDigest(keyCount: number, notes: ManiaNote[]): string {
  const hash = createHash("sha256").update(`${keyCount}:`);
  for (const note of notes) hash.update(`${note.column},${Number(note.isHold)};`);
  return hash.digest("hex");
}

export function chartTopologyKey(map: ManiaBeatmap): string | null {
  if (!hasComparableNotes(map)) return null;
  return topologyDigest(map.keyCount, orderedNotes(map));
}

/** Column/hold hashes of the first and last notes, the lookup keys for padded reuploads. */
export function chartEdgeKeys(map: ManiaBeatmap): { head: string; tail: string } | null {
  if (!hasComparableNotes(map)) return null;
  const notes = orderedNotes(map);
  const window = Math.min(EDGE_WINDOW, notes.length);
  return {
    head: topologyDigest(map.keyCount, notes.slice(0, window)),
    tail: topologyDigest(map.keyCount, notes.slice(notes.length - window)),
  };
}

/**
 * Walks `long` once, matching every note of `short` in order under the given
 * time map and skipping at most `budget` unmatched notes of `long`.
 */
function matchesWithSkips(short: ManiaNote[], long: ManiaNote[], scale: number, shortOrigin: number, longOrigin: number, budget: number): boolean {
  // Both files can have rounded timestamps, including the two anchors.
  const tolerance = 2 * (1 + scale);
  const mapped = (time: number) => (time - shortOrigin) * scale + longOrigin;
  let p = 0;
  let skips = 0;
  for (const note of short) {
    const time = mapped(note.time);
    const endTime = mapped(note.endTime);
    while (p < long.length) {
      const candidate = long[p];
      if (candidate.column === note.column && candidate.isHold === note.isHold
        && Math.abs(time - candidate.time) <= tolerance && Math.abs(endTime - candidate.endTime) <= tolerance) break;
      // Padded notes sort before the row they were slipped into; once the walk
      // is past the mapped time nothing further can match this note.
      if (candidate.time > time + tolerance) return false;
      p += 1;
      skips += 1;
      if (skips > budget) return false;
    }
    if (p >= long.length) return false;
    p += 1;
  }
  return skips + (long.length - p) <= budget;
}

/**
 * True when both charts are the same notes at one uniform time scale, allowing
 * the longer one a small number of extra notes anywhere. Any changed, moved or
 * removed note is a different chart.
 */
export function sameChart(left: ManiaBeatmap, right: ManiaBeatmap): boolean {
  if (left.keyCount !== right.keyCount || !hasComparableNotes(left) || !hasComparableNotes(right)) return false;
  const [short, long] = left.notes.length <= right.notes.length
    ? [orderedNotes(left), orderedNotes(right)]
    : [orderedNotes(right), orderedNotes(left)];
  const extras = long.length - short.length;
  if (extras > paddingAllowance(short.length)) return false;
  const n = short.length;
  const m = long.length;
  const spanShort = short[n - 1].time - short[0].time;
  if (!(spanShort > 0)) return false;
  // The short chart's first and last notes each sit within `extras` notes of
  // the long chart's ends; every anchor pair tries one time map. A wrong map
  // fails within its skip budget, so the search stays cheap.
  for (let i = 0; i <= extras; i += 1) {
    for (let j = m - 1 - extras + i; j < m; j += 1) {
      const spanLong = long[j].time - long[i].time;
      if (!(spanLong > 0)) continue;
      if (matchesWithSkips(short, long, spanLong / spanShort, short[0].time, long[i].time, extras)) return true;
    }
  }
  return false;
}

export async function storeChartFamily(db: Db, beatmapId: number, osuText: string, map = parseManiaBeatmap(osuText)): Promise<void> {
  const topology = chartTopologyKey(map);
  const edges = chartEdgeKeys(map);
  if (!topology || !edges) {
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
     where version = ? and beatmap_id != ? and (head_key = ? or tail_key = ?) order by beatmap_id limit ?`,
    [CHART_FAMILY_VERSION, beatmapId, edges.head, edges.tail, CANDIDATE_LIMIT],
  )).rows;
  // The key is immutable content identity, not a representative beatmap id:
  // editing the first upload must not relabel its older siblings as the edit.
  // Two padded copies of one chart need not match each other, only the chart
  // they pad, so every matching family is checked and the ones this chart
  // bridges are merged under the first.
  const matched = new Set<string>();
  for (const candidate of candidates) {
    const key = String(candidate.family_key);
    if (matched.has(key)) continue;
    const text = await readCachedBeatmapFile(db, Number(candidate.beatmap_id), { touch: false });
    if (!text || createHash("sha256").update(text).digest("hex") !== candidate.file_hash) continue;
    if (sameChart(map, parseManiaBeatmap(text))) matched.add(key);
  }
  const [familyKey = checksum, ...bridged] = matched;
  if (bridged.length) {
    await exec(db,
      `update beatmap_chart_families set family_key = ? where version = ? and family_key in (${bridged.map(() => "?").join(", ")})`,
      [familyKey, CHART_FAMILY_VERSION, ...bridged],
    );
  }
  await exec(db,
    `insert into beatmap_chart_families (beatmap_id, version, topology_key, head_key, tail_key, family_key, file_hash)
     values (?, ?, ?, ?, ?, ?, ?) on conflict(beatmap_id) do update set
       version = excluded.version, topology_key = excluded.topology_key, head_key = excluded.head_key,
       tail_key = excluded.tail_key, family_key = excluded.family_key, file_hash = excluded.file_hash`,
    [beatmapId, CHART_FAMILY_VERSION, topology, edges.head, edges.tail, familyKey, checksum],
  );
}

export async function recomputeChartFamilyChunk(db: Db, cursor: number, limit = 50): Promise<{ nextCursor: number; done: boolean }> {
  const rows = (await exec(db,
    `select beatmap_id, fetched_at from beatmap_osu_files where beatmap_id > ?
     and (compressed_bytes > 0 or length(content) > 0) order by beatmap_id limit ?`,
    [cursor, limit],
  )).rows;
  let nextCursor = cursor;
  // Fingerprints are computed outside any write transaction and committed
  // once per chunk: one short write instead of one per row on the shared
  // SQLite writer. Each statement still carries the fetched_at guard, so a
  // concurrent file replacement wins over this sweep's older read.
  const matches: DbStatement[] = [];
  for (const row of rows) {
    const beatmapId = Number(row.beatmap_id);
    nextCursor = beatmapId;
    const text = await readCachedBeatmapFile(db, beatmapId, { touch: false });
    if (text) matches.push(danSkillsetMatchStatement(beatmapId, text, String(row.fetched_at)));
    if (text && /^Mode\s*:\s*3\s*$/m.test(text)) await storeChartFamily(db, beatmapId, text);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (matches.length) await execBatch(db, matches);
  return { nextCursor, done: rows.length < limit };
}

/**
 * Seeds `dan_skillset_chart_matches` for the registry's own beatmap ids from
 * cached files only: no osu! API, no change to the fingerprint rules, no
 * credit by id. A registry chart whose cached file is not the registry chart
 * (a later upload changed it) is reported, not matched; an uncached one is
 * indexed the moment its file is fetched. Stamped once per registry shape.
 */
export async function ensureDanSkillsetRegistrySeeded(db: Db, queue: JobQueue): Promise<void> {
  if ((await exec(db, "select 1 from live_meta where key = ?", [DAN_SKILLSET_REGISTRY_META_KEY])).rows.length) return;
  const ids = [...new Set(DAN_SKILLSET_CHARTS.map((chart) => chart.beatmapId))];
  const matched: number[] = [];
  const mismatched: number[] = [];
  const raced: number[] = [];
  let uncached = 0;
  for (let offset = 0; offset < ids.length; offset += 50) {
    const chunk = ids.slice(offset, offset + 50);
    const rows = (await exec(db,
      `select beatmap_id, fetched_at from beatmap_osu_files
       where beatmap_id in (${chunk.map(() => "?").join(", ")}) and (compressed_bytes > 0 or length(content) > 0)`,
      chunk,
    )).rows;
    uncached += chunk.length - rows.length;
    const statements: DbStatement[] = [];
    const expected: number[] = [];
    for (const row of rows) {
      const beatmapId = Number(row.beatmap_id);
      const text = await readCachedBeatmapFile(db, beatmapId, { touch: false });
      if (!text) { uncached += 1; continue; }
      const fingerprint = danSkillsetFingerprint(text);
      if (fingerprint && DAN_SKILLSET_BY_FINGERPRINT.has(fingerprint)) expected.push(beatmapId);
      else mismatched.push(beatmapId);
      statements.push(danSkillsetMatchStatement(beatmapId, text, String(row.fetched_at)));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (statements.length) await execBatch(db, statements);
    // A guard miss (the file was replaced between the read and the write) is
    // a skip, not a match; the replacement's own store indexed the new file.
    if (expected.length) {
      const present = new Set((await exec(db,
        `select beatmap_id from dan_skillset_chart_matches where beatmap_id in (${expected.map(() => "?").join(", ")})`,
        expected,
      )).rows.map((row) => Number(row.beatmap_id)));
      for (const beatmapId of expected) (present.has(beatmapId) ? matched : raced).push(beatmapId);
    }
  }
  const now = nowIso();
  const summary = { finishedAt: now, matched: matched.length, mismatched, raced, uncached };
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [DAN_SKILLSET_REGISTRY_META_KEY, json(summary), now]);
  (mismatched.length || raced.length ? logWarn : logInfo)("dan_skillset_registry_seeded", { registry: ids.length, ...summary });
  // Canonical coverage is what the stored-dan refold needs; let it start now
  // rather than after the corpus sweep.
  const { ensurePlayerSkillDanSweepSeeded } = await import("./player-skills.js");
  await ensurePlayerSkillDanSweepSeeded(db, queue);
}

export async function ensureChartFamilySweepSeeded(db: Db, queue: JobQueue): Promise<void> {
  if ((await exec(db, "select 1 from live_meta where key = ?", [CHART_FAMILY_META_KEY])).rows.length) return;
  if ((await exec(db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [CHART_FAMILY_SWEEP_JOB],
  )).rows.length) return;
  await queue.enqueue(CHART_FAMILY_SWEEP_JOB, `${CHART_FAMILY_SWEEP_JOB}:0`, { cursor: 0, sweepVersion: 3 }, { priority: -9, replaceDone: true });
}

export async function runChartFamilySweepJob(db: Db, queue: JobQueue, payload: { cursor?: number; sweepVersion?: number } | undefined): Promise<void> {
  // A queued v2 continuation did not index the prefix's skillset fingerprints.
  const cursor = payload?.sweepVersion === 3 ? Math.max(0, Math.floor(Number(payload.cursor) || 0)) : 0;
  const result = await recomputeChartFamilyChunk(db, cursor);
  if (result.done) {
    const now = nowIso();
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [CHART_FAMILY_META_KEY, json({ finishedAt: now }), now]);
    const { ensurePlayerSkillDanSweepSeeded } = await import("./player-skills.js");
    await ensurePlayerSkillDanSweepSeeded(db, queue);
    return;
  }
  await queue.enqueue(CHART_FAMILY_SWEEP_JOB, `${CHART_FAMILY_SWEEP_JOB}:${result.nextCursor}`,
    { cursor: result.nextCursor, sweepVersion: 3 }, { priority: -9, replaceDone: true });
}
