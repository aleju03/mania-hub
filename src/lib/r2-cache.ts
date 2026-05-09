import crypto from "node:crypto";
import {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  ListObjectsV2Command,
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
const R2_ADMIN_LIST_LIMIT = 100;
const R2_ADMIN_DELETE_BATCH_SIZE = 1000;
const R2_ADMIN_SEARCH_SCAN_LIMIT = 5000;
const R2_ADMIN_FOLDER_STATS_SCAN_LIMIT = 5000;
const R2_ADMIN_FOLDER_STATS_CONCURRENCY = 4;

export type BeatmapAssetKind = "audio" | "background";
export type ReplayEndpointKind = "legacy" | "modern";

type CachedAsset = {
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  signedUrl: string;
};

type UploadedReplayVideo = {
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  url: string;
  signed: boolean;
};

type CachedReplay = {
  scoreId: number;
  storageKey: string;
  endpointKind: ReplayEndpointKind;
  sizeBytes: number;
  mimeType: string;
  buffer: Buffer;
};

export type R2AdminFolder = {
  prefix: string;
  name: string;
  objectCount: number;
  sizeBytes: number;
  statsTruncated: boolean;
};

export type R2AdminObject = {
  key: string;
  name: string;
  sizeBytes: number;
  lastModified: string | null;
  etag: string | null;
};

export type R2AdminListing = {
  configured: boolean;
  bucket: string;
  prefix: string;
  query: string;
  folders: R2AdminFolder[];
  objects: R2AdminObject[];
  nextContinuationToken: string | null;
  totalObjectsShown: number;
  totalBytesShown: number;
  scannedObjects: number;
  searchTruncated: boolean;
};

export type R2AdminDeleteResult = {
  ok: true;
  deletedCount: number;
  deletedBytes: number | null;
};

export type R2AdminPrefixSummary = {
  prefix: string;
  objectCount: number;
  sizeBytes: number;
  truncated: boolean;
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

function getPublicReplayCacheBaseUrl(): string | null {
  const raw = process.env.R2_PUBLIC_BASE_URL
    || process.env.R2_PUBLIC_URL
    || process.env.CLOUDFLARE_R2_PUBLIC_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export function getBeatmapAssetStorageKey(kind: BeatmapAssetKind, beatmapsetId: string, filename: string): string {
  const hash = crypto.createHash("sha256").update(filename).digest("hex").slice(0, 16);
  return `${REPLAY_CACHE_PREFIX}${kind}/${beatmapsetId}/${hash}-${sanitizeFilename(filename)}`;
}

export function getReplayStorageKey(scoreId: number): string {
  return `${REPLAY_CACHE_PREFIX}replays/${scoreId}.osr`;
}

export function getReplayVideoStorageKey(id: string, filename: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 48) || crypto.randomBytes(6).toString("base64url");
  return `${REPLAY_CACHE_PREFIX}videos/${safeId}/${sanitizeFilename(filename)}`;
}

export async function getReplayVideoSignedUrl(id: string, filename: string): Promise<string | null> {
  const r2 = getClient();
  if (!r2) return null;
  const storageKey = getReplayVideoStorageKey(id, filename);
  assertReplayCacheKey(storageKey);
  const mimeType = filename.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/webm";
  return signGetUrl(storageKey, mimeType);
}

export async function getR2AdminSignedUrl(keyInput: string, mimeType?: string): Promise<string> {
  const key = normalizeR2AdminObjectKey(keyInput);
  return signGetUrl(key, mimeType);
}

function assertReplayCacheKey(storageKey: string): void {
  if (!storageKey.startsWith(REPLAY_CACHE_PREFIX)) {
    throw new Error(`Refusing to touch non replay-cache R2 key "${storageKey}"`);
  }
}

export function normalizeR2AdminPrefix(prefix: string | undefined | null): string {
  const raw = (prefix ?? "").trim().replace(/^\/+/, "");
  if (!raw) return REPLAY_CACHE_PREFIX;
  const normalized = raw.endsWith("/") ? raw : `${raw}/`;
  assertReplayCacheKey(normalized);
  return normalized;
}

export function normalizeR2AdminObjectKey(key: string): string {
  const normalized = key.trim().replace(/^\/+/, "");
  assertReplayCacheKey(normalized);
  if (!normalized || normalized.endsWith("/")) {
    throw new Error("Choose a file key, not a folder prefix.");
  }
  return normalized;
}

function objectNameFromKey(key: string, prefix: string): string {
  const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return relative || key.split("/").filter(Boolean).at(-1) || key;
}

function normalizeR2AdminQuery(query: string | undefined | null): string {
  return (query ?? "").trim().slice(0, 120);
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
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

export async function putReplayVideoAndGetUrl(
  id: string,
  filename: string,
  mimeType: string,
  buffer: Buffer,
): Promise<UploadedReplayVideo | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getReplayVideoStorageKey(id, filename);
  assertReplayCacheKey(storageKey);
  const safeMimeType = mimeType === "video/mp4" || mimeType === "video/webm" ? mimeType : "video/webm";

  await r2.send(new PutObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: storageKey,
    Body: buffer,
    ContentType: safeMimeType,
    CacheControl: "public, max-age=31536000, immutable",
    ContentDisposition: `inline; filename="${sanitizeFilename(filename)}"`,
  }));

  const publicBaseUrl = getPublicReplayCacheBaseUrl();
  return {
    storageKey,
    sizeBytes: buffer.length,
    mimeType: safeMimeType,
    url: publicBaseUrl
      ? `${publicBaseUrl}/${storageKey.split("/").map(encodeURIComponent).join("/")}`
      : await signGetUrl(storageKey, safeMimeType),
    signed: !publicBaseUrl,
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

async function deleteCacheRowsForKeys(keys: string[]): Promise<number> {
  if (!db || keys.length === 0) return 0;
  await ensureCacheSchema();

  let deletedBytes = 0;
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const placeholders = chunk.map(() => "?").join(",");
    const [assetRows, replayRows] = await Promise.all([
      db.execute({
        sql: `SELECT size_bytes FROM beatmap_asset_cache WHERE storage_key IN (${placeholders})`,
        args: chunk,
      }),
      db.execute({
        sql: `SELECT size_bytes FROM replay_cache WHERE storage_key IN (${placeholders})`,
        args: chunk,
      }),
    ]);

    for (const row of [...assetRows.rows, ...replayRows.rows]) {
      const sizeBytes = Number(row.size_bytes ?? 0);
      if (Number.isFinite(sizeBytes) && sizeBytes > 0) deletedBytes += sizeBytes;
    }

    await db.batch([
      {
        sql: `DELETE FROM beatmap_asset_cache WHERE storage_key IN (${placeholders})`,
        args: chunk,
      },
      {
        sql: `DELETE FROM replay_cache WHERE storage_key IN (${placeholders})`,
        args: chunk,
      },
    ]);
  }

  if (deletedBytes > 0) {
    await adjustBeatmapAssetCacheTotal(-deletedBytes, Date.now());
  }
  return deletedBytes;
}

export async function getR2AdminListing(
  prefixInput?: string | null,
  continuationToken?: string | null,
  queryInput?: string | null,
): Promise<R2AdminListing> {
  const r2 = getClient();
  const prefix = normalizeR2AdminPrefix(prefixInput);
  const query = normalizeR2AdminQuery(queryInput);
  if (!r2) {
    return {
      configured: false,
      bucket: REPLAY_CACHE_BUCKET,
      prefix,
      query,
      folders: [],
      objects: [],
      nextContinuationToken: null,
      totalObjectsShown: 0,
      totalBytesShown: 0,
      scannedObjects: 0,
      searchTruncated: false,
    };
  }

  if (query) {
    const queryLower = query.toLowerCase();
    const objects: R2AdminObject[] = [];
    let token = continuationToken?.trim() || undefined;
    let nextContinuationToken: string | null = null;
    let scannedObjects = 0;
    let searchTruncated = false;

    do {
      const response = await r2.send(new ListObjectsV2Command({
        Bucket: REPLAY_CACHE_BUCKET,
        Prefix: prefix,
        MaxKeys: R2_ADMIN_LIST_LIMIT,
        ContinuationToken: token,
      }));

      for (const entry of response.Contents ?? []) {
        const key = String(entry.Key ?? "");
        if (!key || key === prefix) continue;
        scannedObjects += 1;
        const name = objectNameFromKey(key, prefix);
        if (key.toLowerCase().includes(queryLower) || name.toLowerCase().includes(queryLower)) {
          objects.push({
            key,
            name,
            sizeBytes: Number(entry.Size ?? 0),
            lastModified: entry.LastModified ? entry.LastModified.toISOString() : null,
            etag: entry.ETag ?? null,
          });
        }
        if (objects.length >= R2_ADMIN_LIST_LIMIT || scannedObjects >= R2_ADMIN_SEARCH_SCAN_LIMIT) break;
      }

      if (objects.length >= R2_ADMIN_LIST_LIMIT || scannedObjects >= R2_ADMIN_SEARCH_SCAN_LIMIT) {
        nextContinuationToken = response.IsTruncated ? response.NextContinuationToken ?? null : null;
        searchTruncated = scannedObjects >= R2_ADMIN_SEARCH_SCAN_LIMIT && Boolean(response.IsTruncated);
        break;
      }

      token = response.IsTruncated ? response.NextContinuationToken : undefined;
      nextContinuationToken = token ?? null;
    } while (token);

    return {
      configured: true,
      bucket: REPLAY_CACHE_BUCKET,
      prefix,
      query,
      folders: [],
      objects,
      nextContinuationToken,
      totalObjectsShown: objects.length,
      totalBytesShown: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
      scannedObjects,
      searchTruncated,
    };
  }

  const response = await r2.send(new ListObjectsV2Command({
    Bucket: REPLAY_CACHE_BUCKET,
    Prefix: prefix,
    Delimiter: "/",
    MaxKeys: R2_ADMIN_LIST_LIMIT,
    ContinuationToken: continuationToken?.trim() || undefined,
  }));

  const folderPrefixes = (response.CommonPrefixes ?? [])
    .map((entry) => entry.Prefix)
    .filter((entry): entry is string => !!entry && entry.startsWith(prefix));
  const folderSummaries = await mapWithConcurrency(
    folderPrefixes,
    R2_ADMIN_FOLDER_STATS_CONCURRENCY,
    (folderPrefix) => getR2PrefixSummaryInternal(r2, folderPrefix, R2_ADMIN_FOLDER_STATS_SCAN_LIMIT),
  );
  const folders = folderPrefixes.map((folderPrefix, index) => ({
      prefix: folderPrefix,
      name: objectNameFromKey(folderPrefix.replace(/\/$/, ""), prefix),
      objectCount: folderSummaries[index]?.objectCount ?? 0,
      sizeBytes: folderSummaries[index]?.sizeBytes ?? 0,
      statsTruncated: folderSummaries[index]?.truncated ?? false,
    }));

  const objects = (response.Contents ?? [])
    .filter((entry) => !!entry.Key && entry.Key !== prefix)
    .map((entry) => {
      const key = String(entry.Key);
      return {
        key,
        name: objectNameFromKey(key, prefix),
        sizeBytes: Number(entry.Size ?? 0),
        lastModified: entry.LastModified ? entry.LastModified.toISOString() : null,
        etag: entry.ETag ?? null,
      };
    });

  return {
    configured: true,
    bucket: REPLAY_CACHE_BUCKET,
    prefix,
    query,
    folders,
    objects,
    nextContinuationToken: response.NextContinuationToken ?? null,
    totalObjectsShown: objects.length,
    totalBytesShown: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
    scannedObjects: response.KeyCount ?? objects.length + folders.length,
    searchTruncated: false,
  };
}

async function getR2PrefixSummaryInternal(
  r2: S3Client,
  prefixInput: string,
  maxObjects?: number,
): Promise<R2AdminPrefixSummary> {
  const prefix = normalizeR2AdminPrefix(prefixInput);
  let continuationToken: string | undefined;
  let objectCount = 0;
  let sizeBytes = 0;
  let truncated = false;

  do {
    const response = await r2.send(new ListObjectsV2Command({
      Bucket: REPLAY_CACHE_BUCKET,
      Prefix: prefix,
      MaxKeys: R2_ADMIN_DELETE_BATCH_SIZE,
      ContinuationToken: continuationToken,
    }));

    for (const entry of response.Contents ?? []) {
      if (!entry.Key?.startsWith(prefix)) continue;
      objectCount += 1;
      const objectSize = Number(entry.Size ?? 0);
      if (Number.isFinite(objectSize) && objectSize > 0) sizeBytes += objectSize;
      if (maxObjects != null && objectCount >= maxObjects) {
        truncated = Boolean(response.IsTruncated);
        break;
      }
    }

    if (maxObjects != null && objectCount >= maxObjects) break;
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return { prefix, objectCount, sizeBytes, truncated };
}

export async function getR2AdminPrefixSummary(prefixInput: string): Promise<R2AdminPrefixSummary> {
  const r2 = getClient();
  if (!r2) throw new Error("R2 replay cache is not configured");
  const prefix = normalizeR2AdminPrefix(prefixInput);
  if (prefix === REPLAY_CACHE_PREFIX) {
    throw new Error("Refusing to summarize the replay-cache root prefix for deletion.");
  }
  return getR2PrefixSummaryInternal(r2, prefix);
}

export async function deleteR2AdminObject(keyInput: string): Promise<R2AdminDeleteResult> {
  const r2 = getClient();
  if (!r2) throw new Error("R2 replay cache is not configured");

  const key = normalizeR2AdminObjectKey(keyInput);
  let sizeBytes: number | null = null;
  try {
    const head = await r2.send(new HeadObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: key,
    }));
    sizeBytes = Number(head.ContentLength ?? 0);
  } catch {
    sizeBytes = null;
  }

  await r2.send(new DeleteObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: key,
  }));

  const cacheBytes = await deleteCacheRowsForKeys([key]);
  return {
    ok: true,
    deletedCount: 1,
    deletedBytes: Number.isFinite(sizeBytes) ? sizeBytes : cacheBytes || null,
  };
}

export async function deleteR2AdminPrefix(prefixInput: string): Promise<R2AdminDeleteResult> {
  const r2 = getClient();
  if (!r2) throw new Error("R2 replay cache is not configured");

  const prefix = normalizeR2AdminPrefix(prefixInput);
  if (prefix === REPLAY_CACHE_PREFIX) {
    throw new Error("Refusing to delete the replay-cache root prefix.");
  }

  let continuationToken: string | undefined;
  let deletedCount = 0;
  let deletedBytes = 0;

  do {
    const listed = await r2.send(new ListObjectsV2Command({
      Bucket: REPLAY_CACHE_BUCKET,
      Prefix: prefix,
      MaxKeys: R2_ADMIN_DELETE_BATCH_SIZE,
      ContinuationToken: continuationToken,
    }));
    const objects = (listed.Contents ?? [])
      .map((entry) => ({
        key: entry.Key ?? "",
        sizeBytes: Number(entry.Size ?? 0),
      }))
      .filter((entry) => entry.key.startsWith(prefix));

    if (objects.length > 0) {
      const response = await r2.send(new DeleteObjectsCommand({
        Bucket: REPLAY_CACHE_BUCKET,
        Delete: {
          Objects: objects.map((object) => ({ Key: object.key })),
          Quiet: true,
        },
      }));
      if (response.Errors?.length) {
        const first = response.Errors[0];
        throw new Error(`R2 delete failed for ${first.Key ?? prefix}: ${first.Message ?? first.Code ?? "unknown error"}`);
      }

      deletedCount += objects.length;
      deletedBytes += objects.reduce((sum, object) => (
        Number.isFinite(object.sizeBytes) ? sum + object.sizeBytes : sum
      ), 0);
      await deleteCacheRowsForKeys(objects.map((object) => object.key));
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return {
    ok: true,
    deletedCount,
    deletedBytes,
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
