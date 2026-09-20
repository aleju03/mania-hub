import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { JobQueue } from "../jobs/queue.js";
import type { OscScore } from "../shared/types.js";
import { OsuApiError, type OsuApiClient } from "./client.js";
import { beatmapFileMd5, getCachedBeatmapFile, normalizeBeatmapFileChecksum, readCachedBeatmapFile, restoreCachedBeatmapBom } from "./beatmap-file-cache.js";

export const BEATMAP_REVISION_JOB = "verify_beatmap_revision";
export const BEATMAP_REVISION_AUDIT_JOB = "audit_beatmap_revisions";
const AUDIT_KEY = "beatmap_revision_audit:v1";

export interface BeatmapRevisionState {
  checksum: string;
  keyCount: number;
  fileChecksum: string | null;
  fetchedAt: string | null;
  updatedAt: string | null;
  mutable: boolean;
  ready: boolean;
  /** osu! no longer serves this beatmap id (API 404). Its expected revision
   * can never be fetched, so nothing waiting on it will settle. */
  deleted: boolean;
}

/** Current metadata is a freshness hint, not the checksum of an older play. */
export function observedScoreChecksum(score: OscScore): string | null {
  const retained = normalizeBeatmapFileChecksum(score.beatmapChecksum);
  if (retained) return retained;
  const checksum = normalizeBeatmapFileChecksum(score.beatmap?.checksum);
  const updated = Date.parse(score.beatmap?.last_updated ?? "");
  const played = Date.parse(score.started_at ?? score.ended_at ?? score.created_at ?? "");
  return checksum && Number.isFinite(updated) && played >= updated ? checksum : null;
}

export async function readBeatmapRevisionStates(db: Db, ids: number[]): Promise<Map<number, BeatmapRevisionState>> {
  const rows = (await exec(db, `select b.beatmap_id, b.status, b.cs, b.metadata_json,
      f.content_md5, f.fetched_at, a.computed_at, a.source_file_md5, a.status as analysis_status,
      a.updated_at as analysis_updated_at
    from beatmaps b left join beatmap_osu_files f using (beatmap_id)
    left join beatmap_chart_analysis a on a.beatmap_id = b.beatmap_id and a.analysis_version = (select max(analysis_version) from beatmap_chart_analysis where beatmap_id = b.beatmap_id)
    where b.beatmap_id in (select value from json_each(?))`,
  [JSON.stringify([...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))])])).rows;
  const states = new Map<number, BeatmapRevisionState>();
  for (const row of rows) {
    const meta = parseJson<Record<string, unknown>>(row.metadata_json, {});
    const checksum = normalizeBeatmapFileChecksum(meta.checksum);
    if (!checksum) continue;
    const id = Number(row.beatmap_id);
    let fileChecksum = normalizeBeatmapFileChecksum(row.content_md5);
    if (!fileChecksum && row.fetched_at) {
      // Lazy migration: only files actually used by this player (or the
      // bounded audit) are inflated, once, without a corpus-sized migration.
      const text = await readCachedBeatmapFile(db, id);
      if (text) fileChecksum = beatmapFileMd5(text);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (fileChecksum && fileChecksum !== checksum && await restoreCachedBeatmapBom(db, id, checksum)) {
      fileChecksum = checksum;
    }
    states.set(id, {
      checksum, fileChecksum, keyCount: Number(row.cs),
      fetchedAt: row.fetched_at == null ? null : String(row.fetched_at),
      updatedAt: typeof meta.last_updated === "string" ? meta.last_updated : null,
      mutable: !["ranked", "approved", "loved"].includes(String(row.status)),
      deleted: meta.deleted_at != null,
      ready: fileChecksum === checksum && (row.analysis_status === "unavailable"
        ? Date.parse(String(row.analysis_updated_at)) >= Date.parse(String(row.fetched_at))
        : row.source_file_md5 != null
        ? row.source_file_md5 === checksum
        : row.computed_at != null && Date.parse(String(row.computed_at)) >= Date.parse(String(row.fetched_at))),
    });
  }
  return states;
}

export function scoreMatchesRevision(state: BeatmapRevisionState | undefined, checksum: string | null | undefined, playedAt: string | null | undefined): boolean {
  if (!state) return true;
  if (checksum) return checksum === state.checksum;
  // Settled maps retain their historical evidence. For editable charts an
  // older timestamp cannot prove that the score played today's notes.
  if (!state.mutable || !state.updatedAt) return true;
  const updated = Date.parse(state.updatedAt);
  return !Number.isFinite(updated) || Date.parse(playedAt ?? "") >= updated;
}

export async function enqueueBeatmapRevisionCheck(db: Db, queue: JobQueue, beatmapId: number): Promise<void> {
  const row = (await exec(db, `select b.metadata_json, f.content_md5
    from beatmaps b join beatmap_osu_files f using (beatmap_id) where b.beatmap_id = ?`, [beatmapId])).rows[0];
  const checksum = normalizeBeatmapFileChecksum(parseJson<Record<string, unknown>>(row?.metadata_json, {}).checksum);
  if (!checksum || checksum === row?.content_md5) return;
  await queueRevisionCheck(db, queue, beatmapId, checksum);
}

export async function queueRevisionCheck(db: Db, queue: JobQueue, beatmapId: number, checksum: string): Promise<void> {
  const key = `beatmap-revision:${beatmapId}:${checksum}`;
  // Do not pull a failed job's retry forward on every score/profile read.
  const pending = (await exec(db, "select 1 from jobs where dedupe_key = ? and status != 'done'", [key])).rows[0];
  if (!pending) await queue.enqueue(BEATMAP_REVISION_JOB, key, { beatmapId }, { priority: 80, replaceDone: true });
}

/** Record that osu! no longer has this beatmap id. Same field the osu! API
 * uses; enrichment cannot overwrite it because the API 404s from now on. */
export async function markBeatmapDeleted(db: Db, beatmapId: number): Promise<void> {
  const now = new Date().toISOString();
  await exec(db, `update beatmaps set metadata_json = json_set(coalesce(metadata_json, '{}'), '$.deleted_at', ?), updated_at = ?
    where beatmap_id = ? and json_extract(metadata_json, '$.deleted_at') is null`, [now, now, beatmapId]);
}

export async function verifyBeatmapRevision(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile"> & Partial<Pick<OsuApiClient, "getBeatmap">>,
  queue: JobQueue,
  beatmapId: number,
): Promise<void> {
  // Read metadata when executing, never refresh backwards to an old job's hint.
  let state = (await readBeatmapRevisionStates(db, [beatmapId])).get(beatmapId);
  if (state?.deleted) return;
  try {
    await getCachedBeatmapFile(db, osu, beatmapId, `job:${BEATMAP_REVISION_JOB}`);
  } catch (error) {
    // A mapper who deletes a diff and re-uploads it under a new id leaves the
    // old id 404ing on the API and serving an empty file. The revision osu!
    // last reported for it is gone for good, so retrying is pointless: mark
    // the map deleted and let the plays parked on it be turned away.
    if (!osu.getBeatmap) throw error;
    try {
      await osu.getBeatmap(beatmapId, `job:${BEATMAP_REVISION_JOB}`);
    } catch (metaError) {
      if (metaError instanceof OsuApiError && metaError.status === 404) {
        await markBeatmapDeleted(db, beatmapId);
        return;
      }
    }
    throw error;
  }
  state = (await readBeatmapRevisionStates(db, [beatmapId])).get(beatmapId);
  const { enqueueChartAnalysis, enqueueChartAnalysisIfNeeded } = await import("../features/chart-analysis.js");
  if (state && !state.ready) await enqueueChartAnalysis(queue, beatmapId, { repair: true });
  else await enqueueChartAnalysisIfNeeded(db, queue, beatmapId);
}

export async function seedBeatmapRevisionAudit(db: Db, queue: JobQueue): Promise<void> {
  if ((await exec(db, "select 1 from live_meta where key = ?", [AUDIT_KEY])).rows.length) return;
  if ((await exec(db, "select 1 from jobs where type = ? and status != 'done' limit 1", [BEATMAP_REVISION_AUDIT_JOB])).rows.length) return;
  await queue.enqueue(BEATMAP_REVISION_AUDIT_JOB, `${AUDIT_KEY}:0`, { cursor: 0 }, { priority: -5, replaceDone: true });
}

export async function auditBeatmapRevisions(db: Db, queue: JobQueue, cursor: number): Promise<void> {
  const rows = (await exec(db, `select b.beatmap_id, b.status from beatmaps b
    join beatmap_osu_files f using (beatmap_id)
    where b.beatmap_id > ? and coalesce(b.status, '') not in ('ranked', 'approved', 'loved')
    order by b.beatmap_id limit 100`, [cursor])).rows;
  // Only the editable corpus needs the deployment repair. Ordinary ingest
  // and skill reads verify settled charts too when they carry a checksum.
  const ids = rows.map(row => Number(row.beatmap_id));
  const states = await readBeatmapRevisionStates(db, ids);
  for (const [id, state] of states) {
    if (state.mutable && state.fileChecksum && state.fileChecksum !== state.checksum) {
      await queueRevisionCheck(db, queue, id, state.checksum);
    }
  }
  if (rows.length === 100) {
    const next = ids[ids.length - 1];
    await queue.enqueue(BEATMAP_REVISION_AUDIT_JOB, `${AUDIT_KEY}:${next}`, { cursor: next },
      { priority: -5, replaceDone: true });
  } else {
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, '{}', ?)", [AUDIT_KEY, new Date().toISOString()]);
  }
}
