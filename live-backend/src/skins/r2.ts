import { DeleteObjectsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";

const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const SKINS_PREFIX = "skins/";

// Narrow config surface so retention (which receives a Pick of Config) can
// clean up abandoned uploads without depending on the full config type.
export type SkinStorageConfig = Pick<Config, "r2Endpoint" | "r2AccessKeyId" | "r2SecretAccessKey" | "r2Bucket" | "r2PublicBaseUrl">;

export type UploadedSkinObject = {
  storageKey: string;
  sizeBytes: number;
  url: string;
};

export function isSkinStorageConfigured(config: SkinStorageConfig): boolean {
  return !!(
    config.r2Endpoint &&
    config.r2AccessKeyId &&
    config.r2SecretAccessKey &&
    config.r2Bucket &&
    config.r2PublicBaseUrl
  );
}

export function skinOskKey(id: string, name: string): string {
  return `${SKINS_PREFIX}${safeId(id)}/${oskFilename(name)}`;
}

export function skinPreviewKey(id: string, ext: string): string {
  return `${SKINS_PREFIX}${safeId(id)}/preview.${safeExt(ext)}`;
}

export function skinScreenshotKey(id: string, index: number, ext: string): string {
  return `${SKINS_PREFIX}${safeId(id)}/shot-${Math.max(0, Math.floor(index))}.${safeExt(ext)}`;
}

export function oskFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "skin";
  const safe = base.replace(/\.osk$/i, "").replace(/[^a-zA-Z0-9._ -]+/g, "_").trim().replace(/^_+|_+$/g, "").slice(0, 64) || "skin";
  return `${safe}.osk`;
}

export async function uploadSkinObject(
  config: SkinStorageConfig,
  key: string,
  buffer: Buffer,
  contentType: string,
  disposition: "attachment" | "inline",
): Promise<UploadedSkinObject> {
  const client = getClient(config);
  const filename = key.split("/").pop() ?? "file";
  await client.send(new PutObjectCommand({
    Bucket: requireBucket(config),
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
    ContentDisposition: `${disposition}; filename="${filename}"`,
  }));
  const publicBase = config.r2PublicBaseUrl!.replace(/\/+$/, "");
  return {
    storageKey: key,
    sizeBytes: buffer.length,
    url: `${publicBase}/${key.split("/").map(encodeURIComponent).join("/")}`,
  };
}

export async function deleteSkinObjects(config: SkinStorageConfig, keys: string[]): Promise<void> {
  const valid = keys.filter((key) => key.startsWith(SKINS_PREFIX));
  if (valid.length === 0 || !isSkinStorageConfigured(config)) return;
  const client = getClient(config);
  await client.send(new DeleteObjectsCommand({
    Bucket: requireBucket(config),
    Delete: { Objects: valid.map((Key) => ({ Key })), Quiet: true },
  }));
}

function getClient(config: SkinStorageConfig): S3Client {
  if (!isSkinStorageConfigured(config)) throw new Error("R2 skin storage is not configured");
  requireBucket(config);
  return new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.r2AccessKeyId!,
      secretAccessKey: config.r2SecretAccessKey!,
    },
  });
}

function requireBucket(config: SkinStorageConfig): string {
  if (config.r2Bucket !== REPLAY_CACHE_BUCKET) {
    throw new Error(`Refusing to use unexpected R2 bucket "${config.r2Bucket ?? ""}"`);
  }
  return config.r2Bucket;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 48);
}

function safeExt(ext: string): string {
  return /^(png|jpg|jpeg|webp)$/.test(ext) ? ext : "png";
}
