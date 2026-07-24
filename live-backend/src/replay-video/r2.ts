import crypto from "node:crypto";
import { loadS3Module, type S3Module } from "../shared/lazy-s3.js";
import type { Config } from "../config.js";

const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const REPLAY_CACHE_PREFIX = "replay-cache/";

export type UploadedReplayVideo = {
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  url: string;
  signed: boolean;
};

export function isReplayVideoStorageConfigured(config: Config): boolean {
  return !!(config.r2Endpoint && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Bucket);
}

export function getReplayVideoStorageKey(id: string, filename: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 48) || crypto.randomBytes(6).toString("base64url");
  return `${REPLAY_CACHE_PREFIX}videos/${safeId}/${sanitizeFilename(filename)}`;
}

export async function uploadReplayVideo(config: Config, id: string, filename: string, mimeType: string, buffer: Buffer): Promise<UploadedReplayVideo> {
  const s3 = await loadS3Module();
  const client = getClient(s3, config);
  const storageKey = getReplayVideoStorageKey(id, filename);
  const safeMimeType = mimeType === "video/mp4" || mimeType === "video/webm" ? mimeType : "video/mp4";

  await client.send(new s3.PutObjectCommand({
    Bucket: requireBucket(config),
    Key: storageKey,
    Body: buffer,
    ContentType: safeMimeType,
    CacheControl: "public, max-age=31536000, immutable",
    ContentDisposition: `inline; filename="${sanitizeFilename(filename)}"`,
  }));

  const publicBase = config.r2PublicBaseUrl?.replace(/\/+$/, "");
  return {
    storageKey,
    sizeBytes: buffer.length,
    mimeType: safeMimeType,
    url: publicBase
      ? `${publicBase}/${storageKey.split("/").map(encodeURIComponent).join("/")}`
      : getReplayVideoAppUrl(config, id, filename),
    signed: false,
  };
}

function getReplayVideoAppUrl(config: Config, id: string, filename: string): string {
  const origin = config.replayVideoPublicOrigin.replace(/\/+$/, "");
  return new URL(
    `/videos/${encodeURIComponent(id)}/${encodeURIComponent(sanitizeFilename(filename))}`,
    origin,
  ).toString();
}

function getClient(s3: S3Module, config: Config): InstanceType<S3Module["S3Client"]> {
  if (!isReplayVideoStorageConfigured(config)) throw new Error("R2 replay video storage is not configured");
  requireBucket(config);
  return new s3.S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.r2AccessKeyId!,
      secretAccessKey: config.r2SecretAccessKey!,
    },
  });
}

function requireBucket(config: Config): string {
  if (config.r2Bucket !== REPLAY_CACHE_BUCKET) {
    throw new Error(`Refusing to use unexpected R2 bucket "${config.r2Bucket ?? ""}"`);
  }
  return config.r2Bucket;
}

function sanitizeFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "replay.mp4";
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "replay.mp4";
  return safe.toLowerCase().endsWith(".mp4") ? safe : `${safe}.mp4`;
}
