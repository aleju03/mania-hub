import type { Readable } from "node:stream";
import { loadS3Module, type S3Module } from "../shared/lazy-s3.js";
import { logWarn } from "../logger.js";
import type { Config } from "../config.js";

const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const SKINS_PREFIX = "skins/";

// Narrow config surface so retention (which receives a Pick of Config) can
// clean up abandoned uploads without depending on the full config type.
// nodeEnv and livePublicOrigin are here for the destructive-op guard below.
export type SkinStorageConfig = Pick<Config, "r2Endpoint" | "r2AccessKeyId" | "r2SecretAccessKey" | "r2Bucket" | "r2PublicBaseUrl" | "nodeEnv" | "livePublicOrigin">;

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

// There is exactly one skins bucket, and local dev runs against it with prod
// credentials and (usually) a prod DB snapshot, so a delete or move issued
// from a dev machine removes objects the live site is still serving - the
// hourly retention sweep can even do it with no one at the keyboard, since an
// aged snapshot's "pending" skins may be published on prod by now. Only a
// process that is provably the live deployment (production build behind a
// non-loopback public origin, both true of the VPS env today) may destroy or
// relocate existing objects. Uploads are not gated: they only ever land on
// fresh keys, and gating them would break testing the upload flow.
export function skinObjectDeletesEnabled(config: SkinStorageConfig): boolean {
  return config.nodeEnv === "production" && !isLoopbackOrigin(config.livePublicOrigin);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    // An origin that does not parse cannot be the live site; stay disarmed.
    return true;
  }
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

// Where a private skin's objects go: the same key with the skin's secret as an
// extra folder. The bucket has a public base URL, so a key derivable from the
// skin id alone would be fetchable by anyone who learns the id from a replay;
// this makes the whole path unguessable, and the streaming endpoint still
// resolves it (it matches keys by their last segment, then checks the ?t=).
// A key that already carries a secret folder gets it replaced rather than
// nested: a skin can go private, public and private again, minting a new
// secret each time.
export function privateSkinKey(key: string, secret: string): string {
  const parts = key.split("/");
  const filename = parts.pop() ?? "";
  return [...parts.filter((part) => !isPrivateSegment(part)), `p-${safeSecret(secret)}`, filename].join("/");
}

// The filename is excluded: a skin genuinely called "p-something" must not read
// as a private object.
export function isPrivateSkinKey(key: string): boolean {
  return key.split("/").slice(0, -1).some(isPrivateSegment);
}

function isPrivateSegment(part: string): boolean {
  return part.startsWith("p-") && part.length > 2;
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
// private and makes local dev work with just the R2 credentials). A private
// skin's objects always take the streaming form, whatever the bucket offers:
// the public base serves anyone who holds the URL, and the whole point of the
// endpoint is the ?t= check in front of the bytes.
function skinObjectUrl(config: SkinStorageConfig, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const publicBase = config.r2PublicBaseUrl?.replace(/\/+$/, "");
  if (publicBase && !isPrivateSkinKey(key)) return `${publicBase}/${encodedKey}`;
  const origin = config.livePublicOrigin.replace(/\/+$/, "");
  const parts = key.split("/");
  const filename = parts[parts.length - 1] ?? "";
  const id = parts[1] ?? "";
  return `${origin}/api/skins/file/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;
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

// Reads a stored object into memory, refusing anything past the cap rather
// than letting a large .osk decide how much RSS the serving process takes.
export async function readSkinObject(
  config: SkinStorageConfig,
  key: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const object = await getSkinObject(config, key);
  if (!object) return null;
  if (object.contentLength != null && object.contentLength > maxBytes) {
    object.body.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of object.body) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        object.body.destroy();
        return null;
      }
      chunks.push(buffer);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

// Server-side copy, used when a skin turns private and its .osk has to move off
// the key a public URL already points at. Metadata is rewritten rather than
// inherited so the new object keeps the download filename the row expects.
export async function copySkinObject(
  config: SkinStorageConfig,
  fromKey: string,
  toKey: string,
  contentType: string,
  downloadFilename: string,
): Promise<UploadedSkinObject | null> {
  if (!fromKey.startsWith(SKINS_PREFIX) || !toKey.startsWith(SKINS_PREFIX)) return null;
  if (!isSkinStorageConfigured(config)) return null;
  // Copies only exist to move an object (the caller deletes the source next),
  // so they sit behind the same guard as deletes.
  if (!skinObjectDeletesEnabled(config)) {
    logWarn("skin_r2_copy_skipped_non_production", { fromKey, toKey });
    return null;
  }
  const s3 = await loadS3Module();
  const client = getClient(s3, config);
  const bucket = requireBucket(config);
  try {
    const copied = await client.send(new s3.CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${fromKey.split("/").map(encodeURIComponent).join("/")}`,
      Key: toKey,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
      ContentDisposition: `attachment; filename="${downloadFilename}"`,
      MetadataDirective: "REPLACE",
    }));
    if (!copied) return null;
  } catch {
    return null;
  }
  return { storageKey: toKey, sizeBytes: 0, url: skinObjectUrl(config, toKey) };
}

export async function deleteSkinObjects(config: SkinStorageConfig, keys: string[]): Promise<void> {
  const valid = keys.filter((key) => key.startsWith(SKINS_PREFIX));
  if (valid.length === 0 || !isSkinStorageConfigured(config)) return;
  if (!skinObjectDeletesEnabled(config)) {
    logWarn("skin_r2_delete_skipped_non_production", { keys: valid.length });
    return;
  }
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

// base64url already, but the secret becomes part of an object key, so anything
// outside the alphabet is dropped rather than escaped into the path.
function safeSecret(secret: string): string {
  return secret.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 64);
}
