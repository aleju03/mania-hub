import crypto from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db, ensureCacheSchema } from "./db";

const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const REPLAY_CACHE_PREFIX = "replay-cache/";
const SIGNED_URL_EXPIRES_SECONDS = 6 * 60 * 60;
const DEFAULT_MAX_CACHE_BYTES = 2.5 * 1024 * 1024 * 1024;
const BEATMAP_ASSET_CACHE_STATS_ID = 1;

export type BeatmapAssetKind = "audio" | "background";
export type ReplayEndpointKind = "legacy" | "modern";

type CachedAsset = {
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  signedUrl: string;
};

type CachedReplay = {
  scoreId: number;
  storageKey: string;
  endpointKind: ReplayEndpointKind;
  sizeBytes: number;
  mimeType: string;
  buffer: Buffer;
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

export function getReplayStorageKey(scoreId: number): string {
  return `${REPLAY_CACHE_PREFIX}replays/${scoreId}.osr`;
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

async function touchReplayRow(scoreId: number, now: number): Promise<void> {
  if (!db) return;
  await ensureCacheSchema();
  await db.execute({
    sql: "UPDATE replay_cache SET last_accessed_at = ? WHERE score_id = ?",
    args: [now, scoreId],
  });
}

async function adjustBeatmapAssetCacheTotal(deltaBytes: number, now: number): Promise<void> {
  if (!db || !Number.isFinite(deltaBytes)) return;
  await db.execute({
    sql: `
      INSERT INTO beatmap_asset_cache_stats (id, total_size_bytes, updated_at)
      VALUES (?, MAX(0, ?), ?)
      ON CONFLICT(id) DO UPDATE SET
        total_size_bytes = MAX(0, total_size_bytes + ?),
        updated_at = excluded.updated_at
    `,
    args: [BEATMAP_ASSET_CACHE_STATS_ID, deltaBytes, now, deltaBytes],
  });
}

async function rebuildBeatmapAssetCacheTotal(now: number): Promise<number> {
  if (!db) return 0;
  const totalResult = await db.execute(`
    SELECT
      (SELECT COALESCE(SUM(size_bytes), 0) FROM beatmap_asset_cache)
      + (SELECT COALESCE(SUM(size_bytes), 0) FROM replay_cache)
      AS total_bytes
  `);
  const totalBytes = Number(totalResult.rows[0]?.total_bytes ?? 0);
  const safeTotalBytes = Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : 0;
  await db.execute({
    sql: `
      INSERT INTO beatmap_asset_cache_stats (id, total_size_bytes, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_size_bytes = excluded.total_size_bytes,
        updated_at = excluded.updated_at
    `,
    args: [BEATMAP_ASSET_CACHE_STATS_ID, safeTotalBytes, now],
  });
  return safeTotalBytes;
}

async function readBeatmapAssetCacheTotal(now: number): Promise<number> {
  if (!db) return 0;
  const totalResult = await db.execute({
    sql: "SELECT total_size_bytes FROM beatmap_asset_cache_stats WHERE id = ? LIMIT 1",
    args: [BEATMAP_ASSET_CACHE_STATS_ID],
  });
  const totalBytes = Number(totalResult.rows[0]?.total_size_bytes);
  if (Number.isFinite(totalBytes)) return Math.max(0, totalBytes);
  return rebuildBeatmapAssetCacheTotal(now);
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

async function readObjectBody(body: GetObjectCommandOutput["Body"]): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const maybeTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybeTransform.transformToByteArray === "function") {
    return Buffer.from(await maybeTransform.transformToByteArray());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getCachedReplay(scoreId: number): Promise<CachedReplay | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getReplayStorageKey(scoreId);
  assertReplayCacheKey(storageKey);

  try {
    const object = await r2.send(new GetObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const buffer = await readObjectBody(object.Body);
    if (buffer.length === 0) return null;

    const now = Date.now();
    const sizeBytes = object.ContentLength ?? buffer.length;
    const mimeType = object.ContentType ?? "application/octet-stream";
    let endpointKind: ReplayEndpointKind = "modern";

    if (db) {
      await ensureCacheSchema();
      const row = await db.execute({
        sql: "SELECT endpoint_kind FROM replay_cache WHERE score_id = ? LIMIT 1",
        args: [scoreId],
      });
      const storedEndpoint = String(row.rows[0]?.endpoint_kind ?? "");
      if (storedEndpoint === "legacy" || storedEndpoint === "modern") {
        endpointKind = storedEndpoint;
      }
      await touchReplayRow(scoreId, now);
    }

    return {
      scoreId,
      storageKey,
      endpointKind,
      sizeBytes,
      mimeType,
      buffer,
    };
  } catch {
    return null;
  }
}

export async function getCachedReplayEndpointKind(scoreId: number): Promise<ReplayEndpointKind | null> {
  if (!db) return null;
  try {
    await ensureCacheSchema();
    const row = await db.execute({
      sql: "SELECT endpoint_kind FROM replay_cache WHERE score_id = ? LIMIT 1",
      args: [scoreId],
    });
    const endpointKind = String(row.rows[0]?.endpoint_kind ?? "");
    return endpointKind === "legacy" || endpointKind === "modern" ? endpointKind : null;
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
    const existing = await db.execute({
      sql: "SELECT size_bytes FROM beatmap_asset_cache WHERE storage_key = ? LIMIT 1",
      args: [storageKey],
    });
    const previousSizeBytes = Number(existing.rows[0]?.size_bytes ?? 0);
    const deltaBytes = buffer.length - (Number.isFinite(previousSizeBytes) ? previousSizeBytes : 0);

    await db.batch([
      {
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
      },
      {
        sql: `
          INSERT INTO beatmap_asset_cache_stats (id, total_size_bytes, updated_at)
          VALUES (?, MAX(0, ?), ?)
          ON CONFLICT(id) DO UPDATE SET
            total_size_bytes = MAX(0, total_size_bytes + ?),
            updated_at = excluded.updated_at
        `,
        args: [BEATMAP_ASSET_CACHE_STATS_ID, deltaBytes, now, deltaBytes],
      },
    ]);

    void runReplayCacheCleanup();
  }

  return {
    storageKey,
    sizeBytes: buffer.length,
    mimeType,
    signedUrl: await signGetUrl(storageKey, mimeType),
  };
}

export async function putCachedReplay(
  scoreId: number,
  endpointKind: ReplayEndpointKind,
  buffer: Buffer,
): Promise<CachedReplay | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getReplayStorageKey(scoreId);
  assertReplayCacheKey(storageKey);
  const mimeType = "application/octet-stream";

  await r2.send(new PutObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: storageKey,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: "private, max-age=31536000, immutable",
  }));

  const now = Date.now();
  if (db) {
    await ensureCacheSchema();
    const existing = await db.execute({
      sql: "SELECT size_bytes FROM replay_cache WHERE score_id = ? LIMIT 1",
      args: [scoreId],
    });
    const previousSizeBytes = Number(existing.rows[0]?.size_bytes ?? 0);
    const deltaBytes = buffer.length - (Number.isFinite(previousSizeBytes) ? previousSizeBytes : 0);

    await db.batch([
      {
        sql: `
          INSERT INTO replay_cache (
            score_id, storage_key, endpoint_kind, mime_type, size_bytes, last_accessed_at, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(score_id) DO UPDATE SET
            storage_key = excluded.storage_key,
            endpoint_kind = excluded.endpoint_kind,
            mime_type = excluded.mime_type,
            size_bytes = excluded.size_bytes,
            last_accessed_at = excluded.last_accessed_at
        `,
        args: [scoreId, storageKey, endpointKind, mimeType, buffer.length, now, now],
      },
      {
        sql: `
          INSERT INTO beatmap_asset_cache_stats (id, total_size_bytes, updated_at)
          VALUES (?, MAX(0, ?), ?)
          ON CONFLICT(id) DO UPDATE SET
            total_size_bytes = MAX(0, total_size_bytes + ?),
            updated_at = excluded.updated_at
        `,
        args: [BEATMAP_ASSET_CACHE_STATS_ID, deltaBytes, now, deltaBytes],
      },
    ]);

    void runReplayCacheCleanup();
  }

  return {
    scoreId,
    storageKey,
    endpointKind,
    sizeBytes: buffer.length,
    mimeType,
    buffer,
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
  const totalBytes = await readBeatmapAssetCacheTotal(Date.now());
  const maxBytes = getMaxCacheBytes();
  if (!Number.isFinite(totalBytes) || totalBytes <= maxBytes) return;

  let bytesToRemove = totalBytes - maxBytes;
  const rows = await db.execute({
    sql: `
      SELECT storage_key, size_bytes, cache_kind, score_id
      FROM (
        SELECT storage_key, size_bytes, last_accessed_at, 'asset' AS cache_kind, NULL AS score_id
        FROM beatmap_asset_cache
        UNION ALL
        SELECT storage_key, size_bytes, last_accessed_at, 'replay' AS cache_kind, score_id
        FROM replay_cache
      )
      ORDER BY last_accessed_at ASC
      LIMIT 200
    `,
    args: [],
  });

  for (const row of rows.rows) {
    if (bytesToRemove <= 0) break;
    const storageKey = String(row.storage_key ?? "");
    const sizeBytes = Number(row.size_bytes ?? 0);
    const cacheKind = String(row.cache_kind ?? "");
    if (!storageKey.startsWith(REPLAY_CACHE_PREFIX)) continue;

    await r2.send(new DeleteObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const deleteResult = cacheKind === "replay"
      ? await db.execute({
        sql: "DELETE FROM replay_cache WHERE score_id = ?",
        args: [Number(row.score_id)],
      })
      : await db.execute({
        sql: "DELETE FROM beatmap_asset_cache WHERE storage_key = ?",
        args: [storageKey],
      });
    if ((deleteResult.rowsAffected ?? 0) > 0) {
      await adjustBeatmapAssetCacheTotal(-sizeBytes, Date.now());
    }
    bytesToRemove -= Number.isFinite(sizeBytes) ? sizeBytes : 0;
  }
}
