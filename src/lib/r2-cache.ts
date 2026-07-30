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

// Cache growth is bounded by R2 lifecycle rules configured per prefix in the Cloudflare
// dashboard. As of 2026-07-30 the only rules are: parsed/ 90d, uploaded-replay-desc/ 90d,
// and the default multipart-abort (7d). Everything else (audio/, background/, blob/, og/,
// maniacards/, replays/, community-beatmaps/, uploaded-replays/, videos/) never expires.
// uploaded-replays/, community-beatmaps/, and videos/ hold user data with no other durable
// copy and must NEVER get a lifecycle rule; the rest is re-derivable cache, so adding a
// rule later is safe (a miss re-uploads and refreshes the object's age). Replay endpoint
// kind rides on S3 object metadata.
const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const REPLAY_CACHE_PREFIX = "replay-cache/";
const SIGNED_URL_EXPIRES_SECONDS = 6 * 60 * 60;
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

type UploadedReplay = {
  id: string;
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  buffer: Buffer;
  originalFilename?: string;
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

export type R2AdminSkinDownload = {
  key: string;
  name: string;
  sizeBytes: number;
  url: string;
};

let client: S3Client | null | undefined;

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

function getAudioPlaybackObjectName(filename: string): string {
  const safeSourceName = sanitizeFilename(filename);
  if (!safeSourceName.toLowerCase().endsWith(".mp3")) return safeSourceName;
  const baseName = safeSourceName.includes(".")
    ? safeSourceName.slice(0, safeSourceName.lastIndexOf("."))
    : safeSourceName;
  return `${baseName || "audio"}.mp4`;
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
  const objectName = kind === "audio" ? getAudioPlaybackObjectName(filename) : sanitizeFilename(filename);
  return `${REPLAY_CACHE_PREFIX}${kind}/${beatmapsetId}/${hash}-${objectName}`;
}

// Beatmap assets are content-addressed so identical files shared by several
// beatmapsets (tournament re-uploads, uprate packs) are stored once: the payload
// lives at blob/{kind}/{sha256}, and the per-set key holds a zero-byte pointer
// whose `blobkey` metadata names it. Per-set keys written before this scheme
// still hold the payload directly and are served as-is until the one-off
// migration script converts them (scripts/migrate-r2-asset-dedup.mjs). The live
// backend applies the same scheme to blob/audio/ (live-backend/src/audio/r2-assets.ts).
const BLOB_KEY_METADATA = "blobkey";

export function getBeatmapAssetBlobKey(kind: BeatmapAssetKind, buffer: Buffer, mimeType: string): string {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return `${REPLAY_CACHE_PREFIX}blob/${kind}/${hash}${getBlobExtension(mimeType)}`;
}

export function getPointerBlobKey(kind: BeatmapAssetKind, metadata: Record<string, string> | undefined): string | null {
  const blobKey = metadata?.[BLOB_KEY_METADATA];
  if (!blobKey || !blobKey.startsWith(`${REPLAY_CACHE_PREFIX}blob/${kind}/`)) return null;
  return blobKey;
}

function getBlobExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "audio/mp4": return ".mp4";
    case "audio/mpeg":
    case "audio/mp3": return ".mp3";
    case "audio/ogg": return ".ogg";
    case "audio/wav": return ".wav";
    case "audio/flac": return ".flac";
    default: return ".bin";
  }
}

export function getReplayStorageKey(scoreId: number): string {
  return `${REPLAY_CACHE_PREFIX}replays/${scoreId}.osr`;
}

export function getReplayVideoStorageKey(id: string, filename: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 48) || crypto.randomBytes(6).toString("base64url");
  return `${REPLAY_CACHE_PREFIX}videos/${safeId}/${sanitizeFilename(filename)}`;
}

export function getUploadedReplayStorageKey(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 64);
  if (!safeId) throw new Error("Invalid uploaded replay id.");
  return `${REPLAY_CACHE_PREFIX}uploaded-replays/${safeId}.osr`;
}

// Durable user-contributed .osu files for unsubmitted/deleted maps (see
// community-beatmap-store.ts). Content-addressed by MD5, so objects are
// immutable; nothing may evict this prefix (keep it out of any R2 lifecycle
// rule and out of LRU cleanup).
const COMMUNITY_BEATMAP_PREFIX = `${REPLAY_CACHE_PREFIX}community-beatmaps/`;

export function getCommunityBeatmapStorageKey(checksum: string): string {
  return `${COMMUNITY_BEATMAP_PREFIX}${checksum}.osu`;
}

export async function getCommunityBeatmapObject(checksum: string): Promise<string | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getCommunityBeatmapStorageKey(checksum);
  assertReplayCacheKey(storageKey);
  try {
    const object = await r2.send(new GetObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const buffer = await readObjectBody(object.Body);
    return buffer.length > 0 ? buffer.toString("utf8") : null;
  } catch {
    return null;
  }
}

export async function putCommunityBeatmapObject(checksum: string, content: string): Promise<boolean> {
  const r2 = getClient();
  if (!r2) return false;

  const storageKey = getCommunityBeatmapStorageKey(checksum);
  assertReplayCacheKey(storageKey);
  await r2.send(new PutObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: storageKey,
    Body: Buffer.from(content, "utf8"),
    ContentType: "text/plain; charset=utf-8",
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return true;
}

// ── Gzipped JSON artifacts ──
// Cross-instance cache tier for expensive server-side computations (parsed replays, uploaded-replay
// descriptions). Content is derived data: age-based lifecycle expiry is fine because a miss just
// recomputes. Stored gzipped; parsed replays are ~100 KB compressed.

const PARSED_REPLAY_PREFIX = `${REPLAY_CACHE_PREFIX}parsed/`;
const UPLOADED_REPLAY_DESC_PREFIX = `${REPLAY_CACHE_PREFIX}uploaded-replay-desc/`;

export function getParsedReplayStorageKey(version: number, scoreId: number, mode: string, keyCount: number): string {
  const safeMode = mode.replace(/[^a-z0-9_-]+/gi, "_") || "mania";
  return `${PARSED_REPLAY_PREFIX}v${version}/${scoreId}-${safeMode}-${keyCount}.json.gz`;
}

export function getUploadedReplayDescStorageKey(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 64);
  if (!safeId) throw new Error("Invalid uploaded replay id.");
  return `${UPLOADED_REPLAY_DESC_PREFIX}${safeId}.json.gz`;
}

async function getZlib(): Promise<typeof import("node:zlib")> {
  return import("node:zlib");
}

export async function getJsonArtifact<T>(storageKey: string): Promise<T | null> {
  const r2 = getClient();
  if (!r2) return null;

  assertReplayCacheKey(storageKey);
  try {
    const object = await r2.send(new GetObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const buffer = await readObjectBody(object.Body);
    if (buffer.length === 0) return null;
    const zlib = await getZlib();
    return JSON.parse(zlib.gunzipSync(buffer).toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function putJsonArtifact(storageKey: string, value: unknown): Promise<boolean> {
  const r2 = getClient();
  if (!r2) return false;

  assertReplayCacheKey(storageKey);
  try {
    const zlib = await getZlib();
    const body = zlib.gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
    await r2.send(new PutObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
      Body: body,
      ContentType: "application/gzip",
      CacheControl: "public, max-age=86400",
    }));
    return true;
  } catch {
    return false;
  }
}

const MANIACARD_THUMBNAIL_CACHE_PREFIX = `${REPLAY_CACHE_PREFIX}maniacards/`;
const MANIACARD_THUMBNAIL_CONTENT_TYPE = "image/webp";

function getPublicReplayCacheUrl(storageKey: string): string | null {
  const publicBaseUrl = getPublicReplayCacheBaseUrl();
  return publicBaseUrl
    ? `${publicBaseUrl}/${storageKey.split("/").map(encodeURIComponent).join("/")}`
    : null;
}

export function getManiaCardThumbnailStorageKey(cacheKey: string): string {
  const hash = crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 40);
  return `${MANIACARD_THUMBNAIL_CACHE_PREFIX}${hash}.webp`;
}

export async function getManiaCardThumbnailUrl(cacheKey: string): Promise<string | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getManiaCardThumbnailStorageKey(cacheKey);
  assertReplayCacheKey(storageKey);
  try {
    await r2.send(new HeadObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    return getPublicReplayCacheUrl(storageKey) ?? await signGetUrl(storageKey, MANIACARD_THUMBNAIL_CONTENT_TYPE);
  } catch {
    return null;
  }
}

export async function putManiaCardThumbnailAndGetUrl(cacheKey: string, buffer: Buffer): Promise<string | null> {
  const r2 = getClient();
  if (!r2 || buffer.length === 0) return null;

  const storageKey = getManiaCardThumbnailStorageKey(cacheKey);
  assertReplayCacheKey(storageKey);
  await r2.send(new PutObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: storageKey,
    Body: buffer,
    ContentType: MANIACARD_THUMBNAIL_CONTENT_TYPE,
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return getPublicReplayCacheUrl(storageKey) ?? await signGetUrl(storageKey, MANIACARD_THUMBNAIL_CONTENT_TYPE);
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

// The live backend writes exactly one <name>.osk per skins/<id>/ folder (see
// skinOskKey) alongside the preview/screenshot images, so the admin browser can
// resolve a skin's archive without paging into the folder first.
export async function getR2AdminSkinOskDownload(prefixInput: string): Promise<R2AdminSkinDownload | null> {
  const prefix = normalizeR2AdminPrefix(prefixInput);
  if (!prefix.startsWith(SKINS_PREFIX)) {
    throw new Error("Quick download is only available for skin folders.");
  }
  const r2 = getClient();
  if (!r2) throw new Error("R2 replay cache is not configured");

  const response = await r2.send(new ListObjectsV2Command({
    Bucket: REPLAY_CACHE_BUCKET,
    Prefix: prefix,
    Delimiter: "/",
    MaxKeys: R2_ADMIN_LIST_LIMIT,
  }));

  const entry = (response.Contents ?? []).find((item) => /\.osk$/i.test(item.Key ?? ""));
  if (!entry?.Key) return null;

  const key = String(entry.Key);
  const name = objectNameFromKey(key, prefix);
  return {
    key,
    name,
    sizeBytes: Number(entry.Size ?? 0),
    url: await signGetUrl(key, "application/octet-stream", name),
  };
}

function assertReplayCacheKey(storageKey: string): void {
  if (!storageKey.startsWith(REPLAY_CACHE_PREFIX)) {
    throw new Error(`Refusing to touch non replay-cache R2 key "${storageKey}"`);
  }
}

// Roots the admin bucket browser may operate on: the evictable replay cache
// plus durable skin uploads the live backend writes under skins/. Cache
// eviction and every non-admin path stay locked to replay-cache/ only.
const SKINS_PREFIX = "skins/";
const ADMIN_BROWSABLE_PREFIXES = [REPLAY_CACHE_PREFIX, SKINS_PREFIX];

function assertAdminBrowsableKey(storageKey: string): void {
  if (!ADMIN_BROWSABLE_PREFIXES.some((prefix) => storageKey.startsWith(prefix))) {
    throw new Error(`Refusing to touch R2 key "${storageKey}" outside replay-cache/ or skins/`);
  }
}

export function normalizeR2AdminPrefix(prefix: string | undefined | null): string {
  const raw = (prefix ?? "").trim().replace(/^\/+/, "");
  if (!raw) return REPLAY_CACHE_PREFIX;
  const normalized = raw.endsWith("/") ? raw : `${raw}/`;
  assertAdminBrowsableKey(normalized);
  return normalized;
}

export function normalizeR2AdminObjectKey(key: string): string {
  const normalized = key.trim().replace(/^\/+/, "");
  assertAdminBrowsableKey(normalized);
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

async function signGetUrl(
  storageKey: string,
  mimeType?: string,
  downloadFilename?: string,
): Promise<string> {
  // Read-only signing may reach any admin-browsable root; every mutating
  // cache path still asserts the stricter replay-cache/ guard itself.
  assertAdminBrowsableKey(storageKey);
  const r2 = getClient();
  if (!r2) throw new Error("R2 replay cache is not configured");

  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
      ResponseContentType: mimeType,
      ResponseContentDisposition: downloadFilename
        ? `attachment; filename="${sanitizeDispositionFilename(downloadFilename)}"`
        : undefined,
    }),
    { expiresIn: SIGNED_URL_EXPIRES_SECONDS },
  );
}

// Content-Disposition is a signed header, so anything that could break out of
// the quoted filename has to go before it reaches the signature.
function sanitizeDispositionFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._ -]+/g, "_").slice(0, 96) || "download";
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

    const blobKey = getPointerBlobKey(kind, head.Metadata);
    if (!blobKey) {
      const sizeBytes = head.ContentLength ?? 0;
      const mimeType = head.ContentType ?? "application/octet-stream";
      return {
        storageKey,
        sizeBytes,
        mimeType,
        signedUrl: await signGetUrl(storageKey, mimeType),
      };
    }

    // A pointer whose blob is gone (manual delete via the admin UI) must read
    // as a miss so the next put re-uploads the blob and heals the cache.
    const blobHead = await r2.send(new HeadObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: blobKey,
    }));
    const mimeType = blobHead.ContentType ?? "application/octet-stream";
    return {
      storageKey: blobKey,
      sizeBytes: blobHead.ContentLength ?? 0,
      mimeType,
      signedUrl: await signGetUrl(blobKey, mimeType),
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

    const sizeBytes = object.ContentLength ?? buffer.length;
    const mimeType = object.ContentType ?? "application/octet-stream";
    return {
      scoreId,
      storageKey,
      // Pre-migration .osr objects carry no metadata; "modern" was always the
      // default and self-heals on the next putCachedReplay.
      endpointKind: parseEndpointKindMetadata(object.Metadata) ?? "modern",
      sizeBytes,
      mimeType,
      buffer,
    };
  } catch {
    return null;
  }
}

function parseEndpointKindMetadata(metadata: Record<string, string> | undefined): ReplayEndpointKind | null {
  // S3 lowercases user metadata keys on the wire.
  const value = metadata?.endpointkind;
  return value === "legacy" || value === "modern" ? value : null;
}

export async function getCachedReplayEndpointKind(scoreId: number): Promise<ReplayEndpointKind | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getReplayStorageKey(scoreId);
  assertReplayCacheKey(storageKey);
  try {
    const head = await r2.send(new HeadObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    return parseEndpointKindMetadata(head.Metadata);
  } catch {
    return null;
  }
}

// ----- Rendered OG image cache -----------------------------------------------
// OG cards (`/api/og`) are produced by Satori + resvg rasterization, the most
// CPU-heavy work on the Vercel side (multiple seconds per image). The CDN caches
// each URL for a day, but every miss/revalidation re-rasterizes from scratch. We
// persist the rendered PNG in R2 keyed by the card identity plus the server's OG
// version so a miss becomes a cheap object read instead of a full re-render.
// These objects are deliberately kept out of the LRU/size accounting used for
// beatmap assets and replays.
const OG_IMAGE_CACHE_PREFIX = `${REPLAY_CACHE_PREFIX}og/`;
const OG_IMAGE_CONTENT_TYPE = "image/png";
const DEFAULT_OG_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getOgImageCacheTtlMs(): number {
  const raw = process.env.OG_R2_CACHE_TTL_MS;
  const parsed = raw ? Number(raw) : DEFAULT_OG_IMAGE_CACHE_TTL_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_OG_IMAGE_CACHE_TTL_MS;
  return Math.floor(parsed);
}

function getOgImageStorageKey(cacheKey: string): string {
  const hash = crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 32);
  return `${OG_IMAGE_CACHE_PREFIX}${hash}.png`;
}

export async function getCachedOgImage(cacheKey: string): Promise<Buffer | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getOgImageStorageKey(cacheKey);
  assertReplayCacheKey(storageKey);

  try {
    const head = await r2.send(new HeadObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const lastModified = head.LastModified ? head.LastModified.getTime() : 0;
    // Treat aged entries as a miss so the caller re-renders and overwrites,
    // keeping the card's stats roughly as fresh as the CDN's daily TTL.
    if (!lastModified || Date.now() - lastModified > getOgImageCacheTtlMs()) {
      return null;
    }

    const object = await r2.send(new GetObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const buffer = await readObjectBody(object.Body);
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

export async function putOgImage(cacheKey: string, buffer: Buffer): Promise<void> {
  const r2 = getClient();
  if (!r2 || buffer.length === 0) return;

  const storageKey = getOgImageStorageKey(cacheKey);
  assertReplayCacheKey(storageKey);

  try {
    await r2.send(new PutObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
      Body: buffer,
      ContentType: OG_IMAGE_CONTENT_TYPE,
      CacheControl: "public, max-age=86400, immutable",
    }));
  } catch {
    // Best-effort: a failed store just means the next miss re-renders.
  }
}

export async function getUploadedReplay(id: string): Promise<UploadedReplay | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getUploadedReplayStorageKey(id);
  assertReplayCacheKey(storageKey);

  try {
    const object = await r2.send(new GetObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const buffer = await readObjectBody(object.Body);
    if (buffer.length === 0) return null;

    return {
      id,
      storageKey,
      sizeBytes: object.ContentLength ?? buffer.length,
      mimeType: object.ContentType ?? "application/octet-stream",
      buffer,
      originalFilename: object.Metadata?.originalfilename,
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
  const blobKey = getBeatmapAssetBlobKey(kind, buffer, mimeType);
  assertReplayCacheKey(storageKey);
  assertReplayCacheKey(blobKey);

  const blobExists = await r2.send(new HeadObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: blobKey,
  })).then(() => true, () => false);
  if (!blobExists) {
    await r2.send(new PutObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: blobKey,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: "public, max-age=31536000, immutable",
    }));
  }

  await r2.send(new PutObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: storageKey,
    Body: Buffer.alloc(0),
    ContentType: mimeType,
    Metadata: { [BLOB_KEY_METADATA]: blobKey },
  }));

  return {
    storageKey: blobKey,
    sizeBytes: buffer.length,
    mimeType,
    signedUrl: await signGetUrl(blobKey, mimeType),
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

export interface UploadedReplayPutMetadata {
  originalFilename?: string;
  uploaderId?: number | null;
  uploadedAt?: string;
}

export async function putUploadedReplay(id: string, buffer: Buffer, metadata: UploadedReplayPutMetadata = {}): Promise<UploadedReplay | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getUploadedReplayStorageKey(id);
  assertReplayCacheKey(storageKey);
  const mimeType = "application/octet-stream";
  const { originalFilename, uploaderId, uploadedAt } = metadata;

  await r2.send(new PutObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: storageKey,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: "private, max-age=31536000, immutable",
    ContentDisposition: `attachment; filename="${sanitizeFilename(originalFilename || `${id}.osr`)}"`,
    Metadata: {
      ...(originalFilename ? { originalfilename: sanitizeFilename(originalFilename) } : {}),
      ...(uploaderId != null && Number.isFinite(uploaderId) ? { uploaderid: String(uploaderId) } : {}),
      uploadedat: uploadedAt ?? new Date().toISOString(),
    },
  }));

  return {
    id,
    storageKey,
    sizeBytes: buffer.length,
    mimeType,
    buffer,
    originalFilename: originalFilename ? sanitizeFilename(originalFilename) : undefined,
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
    // Which osu! replay endpoint produced this .osr (legacy vs modern timing quirks);
    // read back by getCachedReplay / getCachedReplayEndpointKind.
    Metadata: { endpointkind: endpointKind },
  }));

  return {
    scoreId,
    storageKey,
    endpointKind,
    sizeBytes: buffer.length,
    mimeType,
    buffer,
  };
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
  if (ADMIN_BROWSABLE_PREFIXES.includes(prefix)) {
    throw new Error("Refusing to summarize a root prefix for deletion.");
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

  return {
    ok: true,
    deletedCount: 1,
    deletedBytes: sizeBytes !== null && Number.isFinite(sizeBytes) ? sizeBytes : null,
  };
}

export async function deleteR2AdminPrefix(prefixInput: string): Promise<R2AdminDeleteResult> {
  const r2 = getClient();
  if (!r2) throw new Error("R2 replay cache is not configured");

  const prefix = normalizeR2AdminPrefix(prefixInput);
  if (ADMIN_BROWSABLE_PREFIXES.includes(prefix)) {
    throw new Error("Refusing to delete a root prefix.");
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
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return {
    ok: true,
    deletedCount,
    deletedBytes,
  };
}

