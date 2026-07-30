import crypto from "node:crypto";
import type { GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { loadS3Module, type S3Module } from "../shared/lazy-s3.js";
import type { Config } from "../config.js";

const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const REPLAY_CACHE_PREFIX = "replay-cache/";
// Nothing this module uploads can exceed the extraction caps (60 MiB for one
// audio file, 24 MiB for a hitsound bundle), so a larger object is either
// corrupt or not ours; re-preparing it is cheaper than holding it in the heap.
const MAX_CACHED_OBJECT_BYTES = 64 * 1024 * 1024;

// Storage is content-addressed so identical audio shared by several beatmapsets
// (tournament re-uploads, uprate packs with untouched mp3s) is stored once: the
// payload lives at blob/audio/{sha256}, and the per-set key holds a zero-byte
// pointer whose `blobkey` metadata names it. Per-set keys written before this
// scheme still hold the payload directly and are served as-is until the one-off
// migration script converts them (scripts/migrate-r2-asset-dedup.mjs at repo root).
const AUDIO_BLOB_PREFIX = `${REPLAY_CACHE_PREFIX}blob/audio/`;
const BLOB_KEY_METADATA = "blobkey";

export type BeatmapAudioAsset = {
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  publicUrl: string | null;
};

export type BeatmapAudioObject = BeatmapAudioAsset & {
  buffer: Buffer;
};

let cachedClient: S3Client | null = null;
let cachedClientKey = "";

export function isBeatmapAudioStorageConfigured(config: Config): boolean {
  return !!(config.r2Endpoint && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Bucket);
}

export async function getCachedBeatmapAudioAsset(
  config: Config,
  beatmapsetId: string,
  filename: string,
): Promise<BeatmapAudioAsset | null> {
  if (!isBeatmapAudioStorageConfigured(config)) return null;
  const s3 = await loadS3Module();
  const client = getClient(s3, config);
  const storageKey = getBeatmapAudioStorageKey(beatmapsetId, filename);
  assertReplayCacheKey(storageKey);

  try {
    const head = await client.send(new s3.HeadObjectCommand({
      Bucket: requireBucket(config),
      Key: storageKey,
    }));

    const blobKey = getPointerBlobKey(head.Metadata);
    if (!blobKey) {
      return {
        storageKey,
        sizeBytes: head.ContentLength ?? 0,
        mimeType: head.ContentType ?? "application/octet-stream",
        publicUrl: getPublicObjectUrl(config, storageKey),
      };
    }

    // A pointer whose blob is gone (manual delete via the admin UI) must read
    // as a miss so the next prepare re-uploads the blob and heals the cache.
    const blobHead = await client.send(new s3.HeadObjectCommand({
      Bucket: requireBucket(config),
      Key: blobKey,
    }));
    return {
      storageKey: blobKey,
      sizeBytes: blobHead.ContentLength ?? 0,
      mimeType: blobHead.ContentType ?? "application/octet-stream",
      publicUrl: getPublicObjectUrl(config, blobKey),
    };
  } catch {
    return null;
  }
}

export async function readCachedBeatmapAudioAsset(
  config: Config,
  beatmapsetId: string,
  filename: string,
): Promise<BeatmapAudioObject | null> {
  if (!isBeatmapAudioStorageConfigured(config)) return null;
  const s3 = await loadS3Module();
  const client = getClient(s3, config);
  const storageKey = getBeatmapAudioStorageKey(beatmapsetId, filename);
  assertReplayCacheKey(storageKey);

  try {
    const object = await getObjectWithinCap(s3, client, config, storageKey);
    const blobKey = getPointerBlobKey(object.Metadata);
    if (!blobKey) {
      const buffer = await readObjectBody(object.Body, MAX_CACHED_OBJECT_BYTES);
      if (buffer.length === 0) return null;
      return {
        storageKey,
        buffer,
        sizeBytes: object.ContentLength ?? buffer.length,
        mimeType: object.ContentType ?? "application/octet-stream",
        publicUrl: getPublicObjectUrl(config, storageKey),
      };
    }

    await readObjectBody(object.Body, MAX_CACHED_OBJECT_BYTES);
    const blob = await getObjectWithinCap(s3, client, config, blobKey);
    const buffer = await readObjectBody(blob.Body, MAX_CACHED_OBJECT_BYTES);
    if (buffer.length === 0) return null;
    return {
      storageKey: blobKey,
      buffer,
      sizeBytes: blob.ContentLength ?? buffer.length,
      mimeType: blob.ContentType ?? "application/octet-stream",
      publicUrl: getPublicObjectUrl(config, blobKey),
    };
  } catch {
    return null;
  }
}

async function getObjectWithinCap(
  s3: S3Module,
  client: S3Client,
  config: Config,
  storageKey: string,
): Promise<GetObjectCommandOutput> {
  const object = await client.send(new s3.GetObjectCommand({
    Bucket: requireBucket(config),
    Key: storageKey,
  }));
  if ((object.ContentLength ?? 0) > MAX_CACHED_OBJECT_BYTES) {
    throw new Error(`Cached audio object is too large (${object.ContentLength} bytes)`);
  }
  return object;
}

export async function uploadBeatmapAudioAsset(
  config: Config,
  beatmapsetId: string,
  filename: string,
  mimeType: string,
  buffer: Buffer,
): Promise<BeatmapAudioAsset> {
  const s3 = await loadS3Module();
  const client = getClient(s3, config);
  const storageKey = getBeatmapAudioStorageKey(beatmapsetId, filename);
  const blobKey = getAudioBlobKey(buffer, mimeType);
  assertReplayCacheKey(storageKey);
  assertReplayCacheKey(blobKey);

  const blobExists = await client.send(new s3.HeadObjectCommand({
    Bucket: requireBucket(config),
    Key: blobKey,
  })).then(() => true, () => false);
  if (!blobExists) {
    await client.send(new s3.PutObjectCommand({
      Bucket: requireBucket(config),
      Key: blobKey,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: "public, max-age=31536000, immutable",
      ContentDisposition: `inline; filename="${getAudioPlaybackObjectName(filename)}"`,
    }));
  }

  await client.send(new s3.PutObjectCommand({
    Bucket: requireBucket(config),
    Key: storageKey,
    Body: Buffer.alloc(0),
    ContentType: mimeType,
    Metadata: { [BLOB_KEY_METADATA]: blobKey },
  }));

  return {
    storageKey: blobKey,
    sizeBytes: buffer.length,
    mimeType,
    publicUrl: getPublicObjectUrl(config, blobKey),
  };
}

export function getPointerBlobKey(metadata: Record<string, string> | undefined): string | null {
  const blobKey = metadata?.[BLOB_KEY_METADATA];
  if (!blobKey || !blobKey.startsWith(AUDIO_BLOB_PREFIX)) return null;
  return blobKey;
}

export function getAudioBlobKey(buffer: Buffer, mimeType: string): string {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return `${AUDIO_BLOB_PREFIX}${hash}${getBlobExtension(mimeType)}`;
}

function getBlobExtension(mimeType: string): string {
  switch (mimeType) {
    case "audio/mp4": return ".mp4";
    case "audio/mpeg":
    case "audio/mp3": return ".mp3";
    case "audio/ogg": return ".ogg";
    case "audio/wav": return ".wav";
    case "audio/flac": return ".flac";
    case "application/zip": return ".zip";
    default: return ".bin";
  }
}

function getClient(s3: S3Module, config: Config): S3Client {
  if (!isBeatmapAudioStorageConfigured(config)) throw new Error("R2 beatmap audio storage is not configured");
  requireBucket(config);
  const clientKey = [
    config.r2Endpoint,
    config.r2AccessKeyId,
    config.r2SecretAccessKey,
    config.r2Bucket,
  ].join("\0");
  if (cachedClient && cachedClientKey === clientKey) return cachedClient;
  cachedClientKey = clientKey;
  cachedClient = new s3.S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.r2AccessKeyId!,
      secretAccessKey: config.r2SecretAccessKey!,
    },
  });
  return cachedClient;
}

function requireBucket(config: Config): string {
  if (config.r2Bucket !== REPLAY_CACHE_BUCKET) {
    throw new Error(`Refusing to use unexpected R2 bucket "${config.r2Bucket ?? ""}"`);
  }
  return config.r2Bucket;
}

function getBeatmapAudioStorageKey(beatmapsetId: string, filename: string): string {
  const hash = crypto.createHash("sha256").update(filename).digest("hex").slice(0, 16);
  return `${REPLAY_CACHE_PREFIX}audio/${beatmapsetId}/${hash}-${getAudioPlaybackObjectName(filename)}`;
}

function getAudioPlaybackObjectName(filename: string): string {
  const safeSourceName = sanitizeFilename(filename);
  if (!safeSourceName.toLowerCase().endsWith(".mp3")) return safeSourceName;
  const baseName = safeSourceName.includes(".")
    ? safeSourceName.slice(0, safeSourceName.lastIndexOf("."))
    : safeSourceName;
  return `${baseName || "audio"}.mp4`;
}

function sanitizeFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "asset";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

function assertReplayCacheKey(storageKey: string): void {
  if (!storageKey.startsWith(REPLAY_CACHE_PREFIX)) {
    throw new Error(`Refusing to touch non replay-cache R2 key "${storageKey}"`);
  }
}

function getPublicObjectUrl(config: Config, storageKey: string): string | null {
  const publicBase = config.r2PublicBaseUrl?.replace(/\/+$/, "");
  if (!publicBase) return null;
  return `${publicBase}/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}

async function readObjectBody(body: GetObjectCommandOutput["Body"], maxBytes: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const maybeTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybeTransform.transformToByteArray === "function") {
    const bytes = await maybeTransform.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new Error(`Cached audio object is too large (${bytes.byteLength} bytes)`);
    return Buffer.from(bytes);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const part = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += part.length;
    if (total > maxBytes) throw new Error(`Cached audio object is too large (>${maxBytes} bytes)`);
    chunks.push(part);
  }
  return Buffer.concat(chunks, total);
}
