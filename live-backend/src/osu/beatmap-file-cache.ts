import type { Db } from "../db.js";
import { exec, execBatch, parseJson, type DbStatement } from "../db.js";
import { extractBeatmapOsuFileFromArchive } from "../audio/beatmap-archive.js";
import { isLikelyBeatmapFile, OsuApiClient } from "./client.js";
import { nowIso } from "../shared/score.js";
import { createHash, randomUUID } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { danSkillsetMatchStatement } from "../features/dan-skillset-identity.js";

// Durable cache for compressed .osu files. The dan estimator and activity
// analyzer both parse a chart's .osu text; keeping the chart text itself means a
// detector/cache-version bump can reprocess known maps without re-downloading
// every chart from osu.ppy.sh.
//
// Rows are keyed by beatmap id and never expire, so a map update (common while
// a set is qualified) would otherwise pin the pre-update chart forever. Callers
// that know the current checksum (osu!'s md5 of the .osu file, served on score
// and beatmap payloads) pass it as expectedChecksum; a mismatch refetches the
// chart directly, throttled by fetched_at so a checksum osu! never serves
// (propagation lag, a replay's older revision) can't hammer the API.

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const COMPRESSION = "gzip";
const TOUCH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECKSUM_REFRESH_MIN_INTERVAL_MS = 15 * 60 * 1000;
export const BEATMAP_FILE_CHANGE_JOB = "repair_changed_beatmap_file";

// Failed refresh attempts don't touch fetched_at (the stored content did not
// change), so an osu! outage would otherwise burn one API attempt per request
// once the row is old enough. Track failures in memory; this process is
// long-lived, and after a restart one extra attempt per map is harmless.
const checksumRefreshFailureAt = new Map<number, number>();
const CHECKSUM_REFRESH_FAILURE_MAX_ENTRIES = 2000;

export interface StoreCachedBeatmapFileOptions {
  beatmapsetId?: number | null;
  source?: string;
  /** Commit a repair job with a changed file, so old derived ratings cannot survive it. */
  repairDerivatives?: boolean;
}

export interface MarkCachedBeatmapFileUnavailableOptions {
  beatmapsetId?: number | null;
  error?: string;
  source?: string;
}

export interface CachedBeatmapFileOptions {
  allowArchive?: boolean;
  allowDirect?: boolean;
  /** osu!'s current md5 of the .osu file; a cached copy that doesn't match it
   *  is refetched (throttled) instead of served stale. */
  expectedChecksum?: string | null;
  /** Calculations must never accept a known wrong revision. Replay callers
   * may still opt into their existing best-effort fallback. */
  requireChecksumMatch?: boolean;
}

interface BeatmapArchiveMeta {
  beatmapsetId: number;
  version: string | null;
}

export async function getCachedBeatmapFile(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  beatmapId: number,
  caller: string,
  options: CachedBeatmapFileOptions = {},
): Promise<string> {
  const safeId = Math.floor(beatmapId);
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error("Invalid beatmap ID");

  // Computation callers use the latest observed revision automatically. An
  // explicit checksum is a replay's hint and retains its best-effort policy.
  const expectedChecksum = options.expectedChecksum === undefined
    ? await readCurrentBeatmapChecksum(db, safeId)
    : normalizeBeatmapFileChecksum(options.expectedChecksum);
  options = { ...options, expectedChecksum,
    requireChecksumMatch: options.requireChecksumMatch ?? options.expectedChecksum === undefined };
  const verified = (content: string): string => {
    if (options.requireChecksumMatch && expectedChecksum && beatmapFileMd5(content) !== expectedChecksum) {
      throw new Error(`Beatmap ${safeId} revision is pending checksum verification`);
    }
    return content;
  };
  const cached = await readCachedBeatmapFileEntry(db, safeId);
  if (cached) {
    if (!expectedChecksum || beatmapFileMd5(cached.content) === expectedChecksum) return cached.content;
    const bomRestored = await restoreCachedBeatmapBom(db, safeId, expectedChecksum, cached);
    if (bomRestored) return bomRestored;
    const refreshed = await refreshStaleCachedBeatmapFile(db, osu, safeId, caller, cached, options);
    return verified(refreshed ?? cached.content);
  }

  let archiveError: unknown = null;
  // Archives hold whatever revision was downloaded with the .osz, so when the
  // caller pinned a checksum a mismatching archive copy is only a fallback for
  // a failed direct fetch, not the answer.
  let mismatchedArchiveContent: string | null = null;
  const allowArchive = options.allowArchive ?? osu instanceof OsuApiClient;
  const archiveMeta = allowArchive ? await readBeatmapArchiveMeta(db, safeId).catch(() => null) : null;
  if (allowArchive) {
    if (archiveMeta) {
      try {
        const archiveContent = await readBeatmapFileFromArchive(archiveMeta, safeId);
        if (!expectedChecksum || beatmapFileMd5(archiveContent) === expectedChecksum || options.allowDirect === false) {
          verified(archiveContent);
          await storeCachedBeatmapFile(db, safeId, archiveContent, {
            beatmapsetId: archiveMeta.beatmapsetId,
            source: "beatmap_archive",
          }).catch(() => {});
          return archiveContent;
        }
        mismatchedArchiveContent = archiveContent;
      } catch (error) {
        archiveError = error;
      }
    }
  }

  if (options.allowDirect === false) {
    const suffix = archiveError instanceof Error ? `: ${archiveError.message}` : archiveError ? `: ${String(archiveError)}` : "";
    throw new Error(`Beatmap ${safeId} is not cached and could not be fetched from archives${suffix}`);
  }

  const beatmapsetId = archiveMeta?.beatmapsetId ?? await readKnownBeatmapsetId(db, safeId).catch(() => null);
  try {
    const content = await osu.getBeatmapFile(safeId, caller);
    verified(content);
    await storeCachedBeatmapFile(db, safeId, content, { beatmapsetId, source: "osu_api" }).catch(() => {});
    return content;
  } catch (error) {
    if (mismatchedArchiveContent != null && !options.requireChecksumMatch) {
      await storeCachedBeatmapFile(db, safeId, mismatchedArchiveContent, {
        beatmapsetId,
        source: "beatmap_archive",
      }).catch(() => {});
      return mismatchedArchiveContent;
    }
    throw error;
  }
}

export async function readCachedBeatmapFile(
  db: Db,
  beatmapId: number,
  options: { touch?: boolean } = {},
): Promise<string | null> {
  return (await readCachedBeatmapFileEntry(db, beatmapId, options))?.content ?? null;
}

interface CachedBeatmapFileEntry {
  content: string;
  fetchedAt: string | null;
}

async function readCachedBeatmapFileEntry(
  db: Db,
  beatmapId: number,
  options: { touch?: boolean } = {},
): Promise<CachedBeatmapFileEntry | null> {
  const safeId = Math.floor(beatmapId);
  if (!Number.isFinite(safeId) || safeId <= 0) return null;

  const row = (await exec(
    db,
    `select content, content_blob, compression, fetched_at, last_used_at, content_md5
     from beatmap_osu_files
     where beatmap_id = ?
     limit 1`,
    [safeId],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows[0];
  if (!row) return null;

  const fetchedAt = row.fetched_at == null ? null : String(row.fetched_at);
  const storedBlob = await readCompressedContent(row).catch(() => null);
  if (storedBlob) {
    if (options.touch !== false && row.content_md5 == null) await exec(db,
      "update beatmap_osu_files set content_md5 = ? where beatmap_id = ? and fetched_at = ? and content_blob = ?",
      [beatmapFileMd5(storedBlob), safeId, fetchedAt, toBuffer(row.content_blob)]);
    if (options.touch !== false) await touchCachedBeatmapFile(db, safeId, row).catch(() => {});
    return { content: storedBlob, fetchedAt };
  }

  const legacyContent = row.content == null ? "" : String(row.content);
  if (!legacyContent) return null;
  if (options.touch !== false) {
    const compressed = await gzipAsync(Buffer.from(legacyContent));
    await exec(db, `update beatmap_osu_files set content = '', content_blob = ?, compression = 'gzip',
      raw_bytes = ?, compressed_bytes = ?, content_md5 = ? where beatmap_id = ? and content = ?`,
    [compressed, Buffer.byteLength(legacyContent), compressed.byteLength, beatmapFileMd5(legacyContent), safeId, legacyContent]);
  }
  return { content: legacyContent, fetchedAt };
}

// The stored chart no longer matches the checksum osu! currently serves for
// this beatmap (the map was updated after we cached it). Stored archives hold
// the same stale revision, so go straight to the osu! API. Returns null when
// the refetch is throttled, disallowed, or fails; callers fall back to the
// stale copy. Storing the refetched content refreshes fetched_at, which is
// what bounds retries for a checksum the API never satisfies.
async function refreshStaleCachedBeatmapFile(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  beatmapId: number,
  caller: string,
  cached: CachedBeatmapFileEntry,
  options: CachedBeatmapFileOptions,
): Promise<string | null> {
  if (options.allowDirect === false) return null;
  const fetchedAtMs = Date.parse(cached.fetchedAt ?? "");
  if (Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs < CHECKSUM_REFRESH_MIN_INTERVAL_MS) return null;
  const lastFailureAt = checksumRefreshFailureAt.get(beatmapId);
  if (lastFailureAt != null && Date.now() - lastFailureAt < CHECKSUM_REFRESH_MIN_INTERVAL_MS) return null;

  try {
    const content = await osu.getBeatmapFile(beatmapId, caller);
    if (options.requireChecksumMatch && options.expectedChecksum && beatmapFileMd5(content) !== options.expectedChecksum) {
      throw new Error("osu! has not served the expected beatmap revision yet");
    }
    checksumRefreshFailureAt.delete(beatmapId);
    const beatmapsetId = await readKnownBeatmapsetId(db, beatmapId).catch(() => null);
    await storeCachedBeatmapFile(db, beatmapId, content, {
      beatmapsetId,
      source: "osu_api_checksum_refresh",
      repairDerivatives: beatmapFileMd5(content) !== beatmapFileMd5(cached.content),
    });
    return content;
  } catch {
    if (checksumRefreshFailureAt.size >= CHECKSUM_REFRESH_FAILURE_MAX_ENTRIES) {
      const oldestKey = checksumRefreshFailureAt.keys().next().value;
      if (oldestKey !== undefined) checksumRefreshFailureAt.delete(oldestKey);
    }
    checksumRefreshFailureAt.set(beatmapId, Date.now());
    return null;
  }
}

export function normalizeBeatmapFileChecksum(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const checksum = value.trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(checksum) ? checksum : null;
}

export function beatmapFileMd5(content: string): string {
  return createHash("md5").update(content, "utf8").digest("hex");
}

/** Old Response.text() downloads lost only the UTF-8 BOM. Restore it solely
 * when that exact byte change satisfies osu!'s checksum; notes never change. */
export async function restoreCachedBeatmapBom(
  db: Db, beatmapId: number, expectedChecksum: string, entry?: CachedBeatmapFileEntry,
): Promise<string | null> {
  const cached = entry ?? await readCachedBeatmapFileEntry(db, beatmapId, { touch: false });
  if (!cached || cached.content.startsWith("\uFEFF")) return null;
  const restored = `\uFEFF${cached.content}`;
  if (beatmapFileMd5(restored) !== expectedChecksum) return null;
  const blob = await gzipAsync(Buffer.from(restored));
  const result = await exec(db, `update beatmap_osu_files set content = '', compression = 'gzip', content_blob = ?,
    content_md5 = ?, raw_bytes = ?, compressed_bytes = ? where beatmap_id = ? and fetched_at = ?
    and (content_md5 is null or content_md5 = ?)`,
  [blob, expectedChecksum, Buffer.byteLength(restored), blob.byteLength, beatmapId, cached.fetchedAt, beatmapFileMd5(cached.content)]);
  if (Number(result.rowsAffected) !== 1) throw new Error("Beatmap changed during encoding repair; retry");
  return restored;
}

export async function readCurrentBeatmapChecksum(db: Db, beatmapId: number): Promise<string | null> {
  const row = (await exec(db, "select metadata_json from beatmaps where beatmap_id = ?", [beatmapId])).rows[0];
  return normalizeBeatmapFileChecksum(parseJson<Record<string, unknown>>(row?.metadata_json, {}).checksum);
}

async function readBeatmapFileFromArchive(archiveMeta: BeatmapArchiveMeta, beatmapId: number): Promise<string> {
  const file = await extractBeatmapOsuFileFromArchive(String(archiveMeta.beatmapsetId), beatmapId, {
    version: archiveMeta.version,
  });
  if (!isLikelyBeatmapFile(file.text)) throw new Error("archive returned an invalid .osu file");
  return file.text;
}

async function readBeatmapArchiveMeta(db: Db, beatmapId: number): Promise<BeatmapArchiveMeta | null> {
  const row = (await exec(
    db,
    `select beatmapset_id, version
     from beatmaps
     where beatmap_id = ?
     union all
     select beatmapset_id, version
     from maps_beatmaps
     where beatmap_id = ?
     limit 1`,
    [beatmapId, beatmapId],
  )).rows[0];
  if (!row) return null;

  const beatmapsetId = normalizeBeatmapsetId(row.beatmapset_id == null ? null : Number(row.beatmapset_id));
  if (beatmapsetId == null) return null;
  const version = typeof row.version === "string" && row.version.trim() ? row.version : null;
  return { beatmapsetId, version };
}

export async function storeCachedBeatmapFile(
  db: Db,
  beatmapId: number,
  content: string,
  options: StoreCachedBeatmapFileOptions = {},
): Promise<void> {
  if (!content) return;
  const safeId = Math.floor(beatmapId);
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error("Invalid beatmap ID");

  const raw = Buffer.from(content, "utf8");
  const compressed = await gzipAsync(raw);
  const now = nowIso();
  const statement: DbStatement = {
    sql: `insert into beatmap_osu_files (
       beatmap_id, beatmapset_id, compression, content_blob, content,
       raw_bytes, compressed_bytes, source, fetched_at, last_used_at, content_md5
     )
     values (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
     on conflict(beatmap_id) do update set
       beatmapset_id = coalesce(excluded.beatmapset_id, beatmap_osu_files.beatmapset_id),
       compression = excluded.compression,
       content_blob = excluded.content_blob,
       content = '',
       raw_bytes = excluded.raw_bytes,
       compressed_bytes = excluded.compressed_bytes,
       source = excluded.source,
       content_md5 = excluded.content_md5,
       error = null,
       fetched_at = excluded.fetched_at,
       last_used_at = excluded.last_used_at`,
    args: [
      safeId,
      normalizeBeatmapsetId(options.beatmapsetId),
      COMPRESSION,
      compressed,
      raw.byteLength,
      compressed.byteLength,
      normalizeSource(options.source),
      now,
      now,
      beatmapFileMd5(content),
    ],
  };
  if (options.repairDerivatives) {
    // The file and its repair obligation must commit together. This small,
    // non-sheddable job joins the existing serialized chart-analysis lane.
    const revision = `${safeId}:${randomUUID()}`;
    await execBatch(db, [statement, danSkillsetMatchStatement(safeId, content, now), {
      sql: `insert into jobs
        (type, dedupe_key, status, priority, run_after, attempts, payload_json, created_at, updated_at)
        values (?, ?, 'queued', 4, ?, 0, ?, ?, ?)`,
      args: [BEATMAP_FILE_CHANGE_JOB, `changed-osu-file:${revision}`, now,
        JSON.stringify({ beatmapIds: [safeId], revision }), now, now],
    }]);
  } else {
    await execBatch(db, [statement, danSkillsetMatchStatement(safeId, content, now)]);
  }
}

export async function markCachedBeatmapFileUnavailable(
  db: Db,
  beatmapId: number,
  options: MarkCachedBeatmapFileUnavailableOptions = {},
): Promise<void> {
  const safeId = Math.floor(beatmapId);
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error("Invalid beatmap ID");
  const now = nowIso();
  await execBatch(db, [{
    sql: `insert into beatmap_osu_files (
       beatmap_id, beatmapset_id, compression, content_blob, content,
       raw_bytes, compressed_bytes, source, error, fetched_at, last_used_at
     )
     values (?, ?, ?, null, '', 0, 0, ?, ?, ?, ?)
     on conflict(beatmap_id) do update set
       beatmapset_id = coalesce(excluded.beatmapset_id, beatmap_osu_files.beatmapset_id),
       content_blob = null,
       content_md5 = null,
       content = '',
       raw_bytes = 0,
       compressed_bytes = 0,
       source = excluded.source,
       error = excluded.error,
       fetched_at = excluded.fetched_at,
       last_used_at = excluded.last_used_at`,
    args: [
      safeId,
      normalizeBeatmapsetId(options.beatmapsetId),
      COMPRESSION,
      normalizeSource(options.source ?? "unavailable"),
      truncateError(options.error),
      now,
      now,
    ],
  }, { sql: "delete from dan_skillset_chart_matches where beatmap_id = ?", args: [safeId] }]);
}

async function readCompressedContent(row: Record<string, unknown>): Promise<string | null> {
  const blob = toBuffer(row.content_blob);
  if (!blob || blob.byteLength === 0) return null;
  const compression = String(row.compression ?? "");
  if (compression !== COMPRESSION) return null;
  const raw = await gunzipAsync(blob);
  const content = raw.toString("utf8");
  return content.length ? content : null;
}

async function touchCachedBeatmapFile(db: Db, beatmapId: number, row: Record<string, unknown>): Promise<void> {
  const lastUsedAt = Date.parse(String(row.last_used_at ?? row.fetched_at ?? ""));
  if (Number.isFinite(lastUsedAt) && Date.now() - lastUsedAt < TOUCH_INTERVAL_MS) return;
  await exec(db, "update beatmap_osu_files set last_used_at = ? where beatmap_id = ?", [nowIso(), beatmapId]);
}

async function readKnownBeatmapsetId(db: Db, beatmapId: number): Promise<number | null> {
  const row = (await exec(
    db,
    `select beatmapset_id
     from beatmaps
     where beatmap_id = ?
     union all
     select beatmapset_id
     from maps_beatmaps
     where beatmap_id = ?
     limit 1`,
    [beatmapId, beatmapId],
  )).rows[0];
  return normalizeBeatmapsetId(row?.beatmapset_id == null ? null : Number(row.beatmapset_id));
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function normalizeBeatmapsetId(value: number | null | undefined): number | null {
  if (value == null) return null;
  const safe = Math.floor(Number(value));
  return Number.isSafeInteger(safe) && safe > 0 ? safe : null;
}

function normalizeSource(value: string | undefined): string {
  const source = (value ?? "unknown").trim().replace(/[^a-zA-Z0-9:_-]+/g, "_").slice(0, 48);
  return source || "unknown";
}

function truncateError(value: string | undefined): string | null {
  if (value == null) return null;
  const error = value.trim();
  return error ? error.slice(0, 500) : null;
}
