import crypto from "node:crypto";
import type { GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { loadS3Module, type S3Module } from "../shared/lazy-s3.js";
import type { Config } from "../config.js";

const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const REPLAY_CACHE_PREFIX = "replay-cache/";

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
    return {
      storageKey,
      sizeBytes: head.ContentLength ?? 0,
      mimeType: head.ContentType ?? "application/octet-stream",
      publicUrl: getPublicObjectUrl(config, storageKey),
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
    const object = await client.send(new s3.GetObjectCommand({
      Bucket: requireBucket(config),
      Key: storageKey,
    }));
    const buffer = await readObjectBody(object.Body);
    if (buffer.length === 0) return null;
    return {
      storageKey,
      buffer,
      sizeBytes: object.ContentLength ?? buffer.length,
      mimeType: object.ContentType ?? "application/octet-stream",
      publicUrl: getPublicObjectUrl(config, storageKey),
    };
  } catch {
    return null;
  }
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
  assertReplayCacheKey(storageKey);

  await client.send(new s3.PutObjectCommand({
    Bucket: requireBucket(config),
    Key: storageKey,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: "public, max-age=86400, immutable",
    ContentDisposition: `inline; filename="${getAudioPlaybackObjectName(filename)}"`,
  }));

  return {
    storageKey,
    sizeBytes: buffer.length,
    mimeType,
    publicUrl: getPublicObjectUrl(config, storageKey),
  };
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
