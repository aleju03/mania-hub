import type { Readable } from "node:stream";
import { loadS3Module, type S3Module } from "../shared/lazy-s3.js";
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

export type SkinObjectStream = {
  body: Readable;
  contentType: string;
  contentLength: number | null;
  contentDisposition: string | null;
};

export function isSkinStorageConfigured(config: SkinStorageConfig): boolean {
  return !!(
    config.r2Endpoint &&
    config.r2AccessKeyId &&
    config.r2SecretAccessKey &&
    config.r2Bucket
  );
}

// The .osk is stored with the same immutable cache-control as the images, so
// an uploader shipping a newer build has to land on a key no cache has seen:
// revision 0 is the shape the publish flow has always written, later ones
// carry a suffix. The download keeps the clean filename either way (the
// content-disposition is written separately from the key).
export function skinOskKey(id: string, name: string, revision = 0): string {
  const filename = oskFilename(name);
  const suffix = revision > 0 ? `-r${Math.floor(revision)}` : "";
  return `${SKINS_PREFIX}${safeId(id)}/${filename.replace(/\.osk$/i, "")}${suffix}.osk`;
}

// The revision to write next given the key currently on the row, mirroring
// nextSkinPreviewRevision: an unversioned (or missing) key starts at 1.
export function nextSkinOskRevision(previousKey: string | null | undefined): number {
  const match = /-r(\d+)\.osk$/i.exec(previousKey ?? "");
  const current = match ? Number(match[1]) : 0;
  return Number.isFinite(current) && current > 0 ? current + 1 : 1;
}

export function skinPreviewKey(id: string, ext: string): string {
  return `${SKINS_PREFIX}${safeId(id)}/preview.${safeExt(ext)}`;
}

// Preview objects are written with an immutable cache-control, so a re-render
// of an already published keymode must land on a new key or every browser and
// edge cache keeps serving the old image. Revision 0 is the shape the upload
// flow has always written ("preview-4k.webp"); later revisions carry a suffix.
export function skinKeymodePreviewKey(id: string, keys: number, ext: string, revision = 0): string {
  const lane = Math.max(1, Math.min(10, Math.floor(keys)));
  const suffix = revision > 0 ? `-r${Math.floor(revision)}` : "";
  return `${SKINS_PREFIX}${safeId(id)}/preview-${lane}k${suffix}.${safeExt(ext)}`;
}

// The revision to write next given the key currently on the row. Unknown or
// missing keys start at 1, so an edit never reuses the original key.
export function nextSkinPreviewRevision(previousKey: string | null | undefined): number {
  const match = /-r(\d+)\.[a-z]+$/.exec(previousKey ?? "");
  const current = match ? Number(match[1]) : 0;
  return Number.isFinite(current) && current > 0 ? current + 1 : 1;
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
  config: SkinStorageConfig & Pick<Config, "livePublicOrigin">,
  key: string,
  buffer: Buffer,
  contentType: string,
  disposition: "attachment" | "inline",
  // What the browser saves the object as, when that should not follow the
  // storage key: a re-uploaded .osk lives under a versioned key but still
  // downloads under the skin's own name.
  downloadFilename?: string,
): Promise<UploadedSkinObject> {
  const s3 = await loadS3Module();
  const client = getClient(s3, config);
  const filename = downloadFilename || key.split("/").pop() || "file";
  await client.send(new s3.PutObjectCommand({
    Bucket: requireBucket(config),
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
    ContentDisposition: `${disposition}; filename="${filename}"`,
  }));
  return {
    storageKey: key,
    sizeBytes: buffer.length,
    url: skinObjectUrl(config, key),
  };
}

// Public R2 URL when a public base is configured, otherwise the backend's own
// /api/skins/file endpoint streams the object (keeps the shared bucket
// private and makes local dev work with just the R2 credentials).
function skinObjectUrl(config: SkinStorageConfig & Pick<Config, "livePublicOrigin">, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const publicBase = config.r2PublicBaseUrl?.replace(/\/+$/, "");
  if (publicBase) return `${publicBase}/${encodedKey}`;
  const origin = config.livePublicOrigin.replace(/\/+$/, "");
  const [, id, filename] = key.split("/");
  return `${origin}/api/skins/file/${encodeURIComponent(id ?? "")}/${encodeURIComponent(filename ?? "")}`;
}

export async function getSkinObject(config: SkinStorageConfig, key: string): Promise<SkinObjectStream | null> {
  if (!key.startsWith(SKINS_PREFIX) || !isSkinStorageConfigured(config)) return null;
  const s3 = await loadS3Module();
  const client = getClient(s3, config);
  try {
    const object = await client.send(new s3.GetObjectCommand({
      Bucket: requireBucket(config),
      Key: key,
    }));
    if (!object.Body) return null;
    return {
      body: object.Body as Readable,
      contentType: object.ContentType ?? "application/octet-stream",
      contentLength: object.ContentLength ?? null,
      contentDisposition: object.ContentDisposition ?? null,
    };
  } catch {
    return null;
  }
}

export async function deleteSkinObjects(config: SkinStorageConfig, keys: string[]): Promise<void> {
  const valid = keys.filter((key) => key.startsWith(SKINS_PREFIX));
  if (valid.length === 0 || !isSkinStorageConfigured(config)) return;
  const s3 = await loadS3Module();
  const client = getClient(s3, config);
  await client.send(new s3.DeleteObjectsCommand({
    Bucket: requireBucket(config),
    Delete: { Objects: valid.map((Key) => ({ Key })), Quiet: true },
  }));
}

function getClient(s3: S3Module, config: SkinStorageConfig): InstanceType<S3Module["S3Client"]> {
  if (!isSkinStorageConfigured(config)) throw new Error("R2 skin storage is not configured");
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
