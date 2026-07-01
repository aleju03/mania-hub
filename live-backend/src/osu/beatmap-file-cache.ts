import type { Db } from "../db.js";
import { exec } from "../db.js";
import type { OsuApiClient } from "./client.js";
import { nowIso } from "../shared/score.js";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

// Durable cache for compressed .osu files. The dan estimator and activity
// analyzer both parse a chart's .osu text; keeping the chart text itself means a
// detector/cache-version bump can reprocess known maps without re-downloading
// every chart from osu.ppy.sh.

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const COMPRESSION = "gzip";
const TOUCH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoreCachedBeatmapFileOptions {
  beatmapsetId?: number | null;
  source?: string;
}

export interface MarkCachedBeatmapFileUnavailableOptions {
  beatmapsetId?: number | null;
  error?: string;
  source?: string;
}

export async function getCachedBeatmapFile(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  beatmapId: number,
  caller: string,
): Promise<string> {
  const safeId = Math.floor(beatmapId);
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error("Invalid beatmap ID");

  const cached = await readCachedBeatmapFile(db, safeId);
  if (cached) return cached;

  const content = await osu.getBeatmapFile(safeId, caller);
  const beatmapsetId = await readKnownBeatmapsetId(db, safeId).catch(() => null);
  await storeCachedBeatmapFile(db, safeId, content, { beatmapsetId, source: "osu_api" }).catch(() => {});
  return content;
}

export async function readCachedBeatmapFile(db: Db, beatmapId: number): Promise<string | null> {
  const safeId = Math.floor(beatmapId);
  if (!Number.isFinite(safeId) || safeId <= 0) return null;

  const row = (await exec(
    db,
    `select content, content_blob, compression, fetched_at, last_used_at
     from beatmap_osu_files
     where beatmap_id = ?
     limit 1`,
    [safeId],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows[0];
  if (!row) return null;

  const storedBlob = await readCompressedContent(row).catch(() => null);
  if (storedBlob) {
    await touchCachedBeatmapFile(db, safeId, row).catch(() => {});
    return storedBlob;
  }

  const legacyContent = row.content == null ? "" : String(row.content);
  if (!legacyContent) return null;
  await storeCachedBeatmapFile(db, safeId, legacyContent, { source: "legacy_raw" }).catch(() => {});
  return legacyContent;
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
  await exec(
    db,
    `insert into beatmap_osu_files (
       beatmap_id, beatmapset_id, compression, content_blob, content,
       raw_bytes, compressed_bytes, source, fetched_at, last_used_at
     )
     values (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
     on conflict(beatmap_id) do update set
       beatmapset_id = coalesce(excluded.beatmapset_id, beatmap_osu_files.beatmapset_id),
       compression = excluded.compression,
       content_blob = excluded.content_blob,
       content = '',
       raw_bytes = excluded.raw_bytes,
       compressed_bytes = excluded.compressed_bytes,
       source = excluded.source,
       error = null,
       fetched_at = excluded.fetched_at,
       last_used_at = excluded.last_used_at`,
    [
      safeId,
      normalizeBeatmapsetId(options.beatmapsetId),
      COMPRESSION,
      compressed,
      raw.byteLength,
      compressed.byteLength,
      normalizeSource(options.source),
      now,
      now,
    ],
  );
}

export async function markCachedBeatmapFileUnavailable(
  db: Db,
  beatmapId: number,
  options: MarkCachedBeatmapFileUnavailableOptions = {},
): Promise<void> {
  const safeId = Math.floor(beatmapId);
  if (!Number.isFinite(safeId) || safeId <= 0) throw new Error("Invalid beatmap ID");
  const now = nowIso();
  await exec(
    db,
    `insert into beatmap_osu_files (
       beatmap_id, beatmapset_id, compression, content_blob, content,
       raw_bytes, compressed_bytes, source, error, fetched_at, last_used_at
     )
     values (?, ?, ?, null, '', 0, 0, ?, ?, ?, ?)
     on conflict(beatmap_id) do update set
       beatmapset_id = coalesce(excluded.beatmapset_id, beatmap_osu_files.beatmapset_id),
       content_blob = null,
       content = '',
       raw_bytes = 0,
       compressed_bytes = 0,
       source = excluded.source,
       error = excluded.error,
       fetched_at = excluded.fetched_at,
       last_used_at = excluded.last_used_at`,
    [
      safeId,
      normalizeBeatmapsetId(options.beatmapsetId),
      COMPRESSION,
      normalizeSource(options.source ?? "unavailable"),
      truncateError(options.error),
      now,
      now,
    ],
  );
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
