import crypto from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db, ensureCacheSchema } from "./db";

const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const REPLAY_CACHE_PREFIX = "replay-cache/";
const SIGNED_URL_EXPIRES_SECONDS = 6 * 60 * 60;
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

export type BeatmapAssetKind = "audio" | "background";

type CachedAsset = {
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  signedUrl: string;
};

let client: S3Client | null | undefined;
let cleanupPromise: Promise<void> | null = null;

function getMaxCacheBytes(): number {
  const raw = process.env.R2_REPLAY_CACHE_MAX_BYTES;
  const parsed = raw ? Number(raw) : DEFAULT_MAX_CACHE_BYTES;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CACHE_BYTES;
  return Math.floor(parsed);
}

function getClient(): S3Client | null {
  if (client !== undefined) return client;

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    client = null;
    return client;
  }

  if (bucket !== REPLAY_CACHE_BUCKET) {
    throw new Error(`Refusing to use unexpected R2 bucket "${bucket}"`);
  }

  client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

export function isR2ReplayCacheConfigured(): boolean {
  return getClient() !== null;
}

function sanitizeFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "asset";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

export function getBeatmapAssetStorageKey(kind: BeatmapAssetKind, beatmapsetId: string, filename: string): string {
  const hash = crypto.createHash("sha256").update(filename).digest("hex").slice(0, 16);
  return `${REPLAY_CACHE_PREFIX}${kind}/${beatmapsetId}/${hash}-${sanitizeFilename(filename)}`;
}

function assertReplayCacheKey(storageKey: string): void {
  if (!storageKey.startsWith(REPLAY_CACHE_PREFIX)) {
    throw new Error(`Refusing to touch non replay-cache R2 key "${storageKey}"`);
  }
}

async function signGetUrl(storageKey: string, mimeType?: string): Promise<string> {
  assertReplayCacheKey(storageKey);
  const r2 = getClient();
  if (!r2) throw new Error("R2 replay cache is not configured");

  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
      ResponseContentType: mimeType,
    }),
    { expiresIn: SIGNED_URL_EXPIRES_SECONDS },
  );
}

async function touchAssetRow(storageKey: string, now: number): Promise<void> {
  if (!db) return;
  await ensureCacheSchema();
  await db.execute({
    sql: "UPDATE beatmap_asset_cache SET last_accessed_at = ? WHERE storage_key = ?",
    args: [now, storageKey],
  });
}

export async function getCachedBeatmapAssetUrl(
  kind: BeatmapAssetKind,
  beatmapsetId: string,
  filename: string,
): Promise<CachedAsset | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getBeatmapAssetStorageKey(kind, beatmapsetId, filename);
  assertReplayCacheKey(storageKey);

  try {
    const head = await r2.send(new HeadObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const now = Date.now();
    const sizeBytes = head.ContentLength ?? 0;
    const mimeType = head.ContentType ?? "application/octet-stream";
    await touchAssetRow(storageKey, now);
    return {
      storageKey,
      sizeBytes,
      mimeType,
      signedUrl: await signGetUrl(storageKey, mimeType),
    };
  } catch {
    return null;
  }
}

export async function putBeatmapAssetAndGetUrl(
  kind: BeatmapAssetKind,
  beatmapsetId: string,
  filename: string,
  mimeType: string,
  buffer: Buffer,
): Promise<CachedAsset | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getBeatmapAssetStorageKey(kind, beatmapsetId, filename);
  assertReplayCacheKey(storageKey);

  await r2.send(new PutObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: storageKey,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: "public, max-age=86400, immutable",
  }));

  const now = Date.now();
  if (db) {
    await ensureCacheSchema();
    await db.execute({
      sql: `
        INSERT INTO beatmap_asset_cache (
          storage_key, beatmapset_id, filename, kind, mime_type, size_bytes, last_accessed_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(storage_key) DO UPDATE SET
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          last_accessed_at = excluded.last_accessed_at
      `,
      args: [storageKey, beatmapsetId, filename, kind, mimeType, buffer.length, now, now],
    });

    void runReplayCacheCleanup();
  }

  return {
    storageKey,
    sizeBytes: buffer.length,
    mimeType,
    signedUrl: await signGetUrl(storageKey, mimeType),
  };
}

async function runReplayCacheCleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = cleanupReplayCacheByLru().finally(() => {
    cleanupPromise = null;
  });
  return cleanupPromise;
}

async function cleanupReplayCacheByLru(): Promise<void> {
  const r2 = getClient();
  if (!r2 || !db) return;

  await ensureCacheSchema();
  const totalResult = await db.execute("SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM beatmap_asset_cache");
  const totalBytes = Number(totalResult.rows[0]?.total_bytes ?? 0);
  const maxBytes = getMaxCacheBytes();
  if (!Number.isFinite(totalBytes) || totalBytes <= maxBytes) return;

  let bytesToRemove = totalBytes - maxBytes;
  const rows = await db.execute({
    sql: `
      SELECT storage_key, size_bytes
      FROM beatmap_asset_cache
      ORDER BY last_accessed_at ASC
      LIMIT 200
    `,
    args: [],
  });

  for (const row of rows.rows) {
    if (bytesToRemove <= 0) break;
    const storageKey = String(row.storage_key ?? "");
    const sizeBytes = Number(row.size_bytes ?? 0);
    if (!storageKey.startsWith(REPLAY_CACHE_PREFIX)) continue;

    await r2.send(new DeleteObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    await db.execute({
      sql: "DELETE FROM beatmap_asset_cache WHERE storage_key = ?",
      args: [storageKey],
    });
    bytesToRemove -= Number.isFinite(sizeBytes) ? sizeBytes : 0;
  }
}
