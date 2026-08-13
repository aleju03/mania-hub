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
import {
  getPublicBucketBaseUrl,
  getPublicBucketClient,
  PUBLIC_IMAGE_BUCKET,
} from "./public-image-store";

// Cache growth is bounded by R2 lifecycle rules configured per prefix (Cloudflare
// dashboard or the S3 lifecycle API). As of 2026-08-04 the rules are: parsed/ 90d,
// uploaded-replay-desc/ 90d, maniacards/ 90d, blob/ 90d, og/ 30d, and the default
// multipart-abort (7d). Everything else (audio/, background/, replays/,
// community-beatmaps/, uploaded-replays/, videos/) never expires; audio/ and
// background/ are zero-byte pointers whose expired blobs read as misses and heal on
// the next put. uploaded-replays/, community-beatmaps/, and videos/ hold user data
// with no other durable copy and must NEVER get a lifecycle rule; the rest is
// re-derivable cache, so adding a rule later is safe (a miss re-uploads and
// refreshes the object's age). Replay endpoint kind rides on S3 object metadata.
// maniacards/ here is a leftover: the live pool moved to the public image
// bucket (pack-thumbnail-store.ts) on 2026-08-05, and the stranded copies just
// age out under the existing 90d rule.
const REPLAY_CACHE_BUCKET = "mania-hub-replay-cache";
const REPLAY_CACHE_PREFIX = "replay-cache/";
const SIGNED_URL_EXPIRES_SECONDS = 6 * 60 * 60;
const R2_ADMIN_LIST_LIMIT = 100;
const R2_ADMIN_DELETE_BATCH_SIZE = 1000;
const R2_ADMIN_SEARCH_SCAN_LIMIT = 5000;
const R2_ADMIN_FOLDER_STATS_SCAN_LIMIT = 5000;
const R2_ADMIN_FOLDER_STATS_CONCURRENCY = 4;
// One page of folder rows plus slack; the browser only ever asks for the rows
// it is rendering.
const R2_ADMIN_FOLDER_STATS_LIMIT = 32;
const R2_ADMIN_DESCRIBE_LIMIT = 32;
const R2_ADMIN_DESCRIBE_CONCURRENCY = 8;

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

// Folder rows come back without counts: summarizing a prefix costs a full
// paginated scan of it, so the browser lists first and asks for the numbers of
// the rows it actually renders (getR2AdminFolderStats).
export type R2AdminFolder = {
  prefix: string;
  name: string;
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
  bucketId: R2AdminBucketId;
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
  /** Name of the file that names the folder, per the root's folderLabelSuffix. */
  sampleName: string | null;
};

export type R2AdminSkinDownload = {
  key: string;
  name: string;
  sizeBytes: number;
  url: string;
};

export type R2AdminObjectUrl = {
  url: string;
  /** True when the URL is the bucket's public CDN address rather than a signed one. */
  isPublic: boolean;
};

export type R2AdminObjectDescription = R2AdminObjectUrl & {
  key: string;
  /** Value of the root's metadataLabelKey, when it declares one. */
  label: string | null;
};

export type R2AdminBucketId = "replay-cache" | "public";

export type R2AdminRoot = {
  prefix: string;
  label: string;
  /** Shown in the delete dialog for anything under this root. */
  deleteWarning: string | null;
  /**
   * Object metadata field worth reading for rows under this root, for prefixes
   * whose keys are content hashes and carry their only human-readable detail in
   * metadata. Costs one HeadObject per row, so it stays opt-in per root.
   */
  metadataLabelKey?: string;
  /**
   * Extension of the file that names a folder under this root (skins/<uuid>/
   * holds one <skin name>.osk). Picked up by the scan that counts the folder,
   * so naming the row costs nothing extra.
   */
  folderLabelSuffix?: string;
};

export type R2AdminBucketInfo = {
  id: R2AdminBucketId;
  label: string;
  bucket: string;
  configured: boolean;
  publicBaseUrl: string | null;
  roots: R2AdminRoot[];
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

const UPLOADED_REPLAY_PREFIX = `${REPLAY_CACHE_PREFIX}uploaded-replays/`;

export function getUploadedReplayStorageKey(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 64);
  if (!safeId) throw new Error("Invalid uploaded replay id.");
  return `${UPLOADED_REPLAY_PREFIX}${safeId}.osr`;
}

export type UploadedReplayObject = { key: string; uploadedAt: number };

// Every object under uploaded-replays/, with its upload time from LastModified.
// The prefix holds a few dozen small .osr files, so a full paginated LIST per
// call is fine; uploaded-replay-store turns keys into ids and callers cache the
// assembled result.
export async function listUploadedReplayObjects(): Promise<UploadedReplayObject[]> {
  const r2 = getClient();
  if (!r2) return [];

  const objects: UploadedReplayObject[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await r2.send(new ListObjectsV2Command({
      Bucket: REPLAY_CACHE_BUCKET,
      Prefix: UPLOADED_REPLAY_PREFIX,
      ContinuationToken: continuationToken,
    }));
    for (const object of response.Contents ?? []) {
      if (!object.Key) continue;
      objects.push({ key: object.Key, uploadedAt: object.LastModified?.getTime() ?? 0 });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
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

export async function getReplayVideoSignedUrl(id: string, filename: string): Promise<string | null> {
  const r2 = getClient();
  if (!r2) return null;
  const storageKey = getReplayVideoStorageKey(id, filename);
  assertReplayCacheKey(storageKey);
  const mimeType = filename.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/webm";
  return signGetUrl(storageKey, mimeType);
}

// Reads on a bucket with a custom domain go straight to the CDN address: it is
// the same URL the site hands out, it costs no signing round-trip, and it is
// the one an admin actually wants to copy out of the preview.
export async function getR2AdminObjectUrl(
  bucketId: string | undefined | null,
  keyInput: string,
  mimeType?: string,
): Promise<R2AdminObjectUrl> {
  const { def, client } = requireAdminBucket(bucketId);
  return buildAdminObjectUrl(def, client, normalizeR2AdminObjectKey(def.id, keyInput), mimeType);
}

async function buildAdminObjectUrl(
  def: AdminBucketDef,
  client: S3Client,
  key: string,
  mimeType?: string,
): Promise<R2AdminObjectUrl> {
  const publicBaseUrl = def.getPublicBaseUrl();
  if (publicBaseUrl) {
    const path = key.split("/").map(encodeURIComponent).join("/");
    return { url: `${publicBaseUrl}/${path}`, isPublic: true };
  }
  return {
    url: await signBucketGetUrl(client, def.bucket, key, mimeType),
    isPublic: false,
  };
}

// Rows the browser wants to show inline: a URL it can point an <img> at, plus
// whatever readable detail the root declares. Signing is local HMAC work and
// public URLs are pure string building, so the only R2 operations here are the
// metadata reads, and only for roots that ask for one.
export async function describeR2AdminObjects(options: {
  bucket?: string | null;
  keys: string[];
}): Promise<R2AdminObjectDescription[]> {
  const def = getAdminBucket(options.bucket);
  const client = resolveAdminClient(def);
  if (!client) return [];

  const keys = options.keys
    .slice(0, R2_ADMIN_DESCRIBE_LIMIT)
    .map((key) => normalizeR2AdminObjectKey(def.id, key));

  return mapWithConcurrency(keys, R2_ADMIN_DESCRIBE_CONCURRENCY, async (key) => {
    const metadataLabelKey = def.roots
      .find((root) => key.startsWith(root.prefix))?.metadataLabelKey;
    const label = metadataLabelKey
      ? await client.send(new HeadObjectCommand({ Bucket: def.bucket, Key: key }))
        .then((head) => head.Metadata?.[metadataLabelKey] ?? null, () => null)
      : null;

    return { key, label, ...await buildAdminObjectUrl(def, client, key) };
  });
}

export interface R2AdminScannedObject {
  key: string;
  sizeBytes: number;
  lastModified: string | null;
  contentType: string | null;
  metadata: Record<string, string>;
}

/**
 * Remembers the HEAD of an object that the LIST says has not changed.
 *
 * A put moves LastModified even when the bytes are identical, so size plus
 * timestamp is a sufficient version marker: a hit means nobody has written the
 * key since we read its metadata. Callers opt in, because "unchanged" here is
 * only as precise as R2's second-granularity timestamp - anything acting
 * destructively on the answer should ask for the real read instead.
 */
const adminMetadataMemo = new Map<
  string,
  { version: string; contentType: string | null; metadata: Record<string, string> }
>();
const ADMIN_METADATA_MEMO_LIMIT = 5000;

/**
 * Every object under `prefix`, with its user metadata read.
 *
 * Unlike the paginated browser listing this walks the whole prefix and HEADs
 * each object, which is one class B operation per file - fine for a small,
 * human-scale prefix that an admin tool needs a complete picture of, and not
 * something to point at a prefix with tens of thousands of keys in it. Pass
 * `useMetadataCache` to pay that cost only for objects the listing shows as
 * new or rewritten since the last scan.
 */
export async function scanR2AdminPrefixWithMetadata(options: {
  bucket?: string | null;
  prefix: string;
  maxObjects: number;
  useMetadataCache?: boolean;
}): Promise<{ configured: boolean; objects: R2AdminScannedObject[]; truncated: boolean }> {
  const def = getAdminBucket(options.bucket);
  const client = resolveAdminClient(def);
  if (!client) return { configured: false, objects: [], truncated: false };

  const prefix = normalizeR2AdminPrefix(def.id, options.prefix);
  const listed: Array<{ key: string; sizeBytes: number; lastModified: string | null }> = [];
  let continuationToken: string | undefined;
  let truncated = false;

  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: def.bucket,
      Prefix: prefix,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key || object.Key.endsWith("/")) continue;
      if (listed.length >= options.maxObjects) {
        truncated = true;
        break;
      }
      listed.push({
        key: object.Key,
        sizeBytes: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString() ?? null,
      });
    }
    continuationToken = !truncated && page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  const objects = await mapWithConcurrency(listed, R2_ADMIN_DESCRIBE_CONCURRENCY, async (entry) => {
    const memoKey = `${def.id}|${entry.key}`;
    const version = `${entry.sizeBytes}|${entry.lastModified ?? ""}`;
    if (options.useMetadataCache) {
      const hit = adminMetadataMemo.get(memoKey);
      if (hit?.version === version) {
        return { ...entry, contentType: hit.contentType, metadata: hit.metadata };
      }
    }

    const head = await client
      .send(new HeadObjectCommand({ Bucket: def.bucket, Key: entry.key }))
      .catch(() => null);
    const described = {
      contentType: head?.ContentType ?? null,
      metadata: head?.Metadata ?? {},
    };
    // Only a real read is worth remembering; a failed HEAD would memoize the
    // absence of metadata and make the next scan agree with it.
    if (head) {
      if (adminMetadataMemo.size >= ADMIN_METADATA_MEMO_LIMIT) adminMetadataMemo.clear();
      adminMetadataMemo.set(memoKey, { version, ...described });
    }
    return { ...entry, ...described };
  });

  return { configured: true, objects, truncated };
}

// The live backend writes exactly one <name>.osk per skins/<id>/ folder (see
// skinOskKey) alongside the preview/screenshot images, so the admin browser can
// resolve a skin's archive without paging into the folder first.
export async function getR2AdminSkinOskDownload(prefixInput: string): Promise<R2AdminSkinDownload | null> {
  const prefix = normalizeR2AdminPrefix("replay-cache", prefixInput);
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

// ── Admin bucket registry ──
// The two buckets the admin browser may read. Each declares the roots it may
// operate on: the private cache bucket exposes the evictable replay cache plus
// the durable skin uploads the live backend writes under skins/, and the public
// CDN bucket (cdn.mania-tracker.com) exposes the BBCode image store and the
// maniacard thumbnail pool. Cache eviction and every non-admin path stay locked
// to replay-cache/ in the private bucket only. A new top-level prefix is
// invisible here until it is listed as a root.
const SKINS_PREFIX = "skins/";

type AdminBucketDef = {
  id: R2AdminBucketId;
  label: string;
  bucket: string;
  roots: R2AdminRoot[];
  getClient: () => S3Client | null;
  /** Custom-domain base URL, for buckets served publicly. */
  getPublicBaseUrl: () => string | null;
};

const ADMIN_BUCKETS: AdminBucketDef[] = [
  {
    id: "replay-cache",
    label: "replay cache",
    bucket: REPLAY_CACHE_BUCKET,
    roots: [
      { prefix: REPLAY_CACHE_PREFIX, label: "replay-cache", deleteWarning: null },
      {
        prefix: SKINS_PREFIX,
        label: "skins",
        deleteWarning: "Skin files are indexed by the live backend database; deleting them here strands the skin page. Delete the skin from its own page instead, and keep this for orphan cleanup.",
        folderLabelSuffix: ".osk",
      },
    ],
    getClient,
    // Private bucket: no public domain is attached to it on purpose, so every
    // read here goes out as a signed URL.
    getPublicBaseUrl: () => null,
  },
  {
    id: "public",
    label: "public cdn",
    bucket: PUBLIC_IMAGE_BUCKET,
    roots: [
      {
        prefix: "bbcode/",
        label: "bbcode",
        deleteWarning: "These URLs are pasted into osu! profiles and there is no other copy of the file. Deleting one breaks every post that embeds it.",
        // storePublicImage stamps every upload with who sent it, which is the
        // only readable thing about a content-hash key.
        metadataLabelKey: "uploaded-by",
      },
      { prefix: "maniacards/", label: "maniacards", deleteWarning: null },
    ],
    getClient: getPublicBucketClient,
    getPublicBaseUrl: getPublicBucketBaseUrl,
  },
];

export function normalizeR2AdminBucketId(value: string | undefined | null): R2AdminBucketId {
  const match = ADMIN_BUCKETS.find((entry) => entry.id === value);
  return match ? match.id : "replay-cache";
}

function getAdminBucket(bucketId: string | undefined | null): AdminBucketDef {
  const id = normalizeR2AdminBucketId(bucketId);
  return ADMIN_BUCKETS.find((entry) => entry.id === id)!;
}

// Resolving a client can throw when the configured bucket name doesn't match
// what the store expects, which is a misconfiguration worth surfacing on the
// bucket itself rather than failing the whole page.
function resolveAdminClient(def: AdminBucketDef): S3Client | null {
  try {
    return def.getClient();
  } catch {
    return null;
  }
}

function requireAdminBucket(bucketId: string | undefined | null): { def: AdminBucketDef; client: S3Client } {
  const def = getAdminBucket(bucketId);
  const client = def.getClient();
  if (!client) throw new Error(`R2 bucket "${def.bucket}" is not configured`);
  return { def, client };
}

export function listR2AdminBuckets(): R2AdminBucketInfo[] {
  return ADMIN_BUCKETS.map((def) => ({
    id: def.id,
    label: def.label,
    bucket: def.bucket,
    configured: resolveAdminClient(def) !== null,
    publicBaseUrl: def.getPublicBaseUrl(),
    roots: def.roots,
  }));
}

function assertBucketKey(def: AdminBucketDef, storageKey: string): void {
  if (!def.roots.some((root) => storageKey.startsWith(root.prefix))) {
    const roots = def.roots.map((root) => root.prefix).join(" or ");
    throw new Error(`Refusing to touch R2 key "${storageKey}" outside ${roots}`);
  }
}

export function normalizeR2AdminPrefix(bucketId: string | undefined | null, prefix?: string | null): string {
  const def = getAdminBucket(bucketId);
  const raw = (prefix ?? "").trim().replace(/^\/+/, "");
  if (!raw) return def.roots[0]!.prefix;
  const normalized = raw.endsWith("/") ? raw : `${raw}/`;
  assertBucketKey(def, normalized);
  return normalized;
}

export function normalizeR2AdminObjectKey(bucketId: string | undefined | null, key: string): string {
  const def = getAdminBucket(bucketId);
  const normalized = key.trim().replace(/^\/+/, "");
  assertBucketKey(def, normalized);
  if (!normalized || normalized.endsWith("/")) {
    throw new Error("Choose a file key, not a folder prefix.");
  }
  return normalized;
}

function isAdminRootPrefix(def: AdminBucketDef, prefix: string): boolean {
  return def.roots.some((root) => root.prefix === prefix);
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

function signBucketGetUrl(
  r2: S3Client,
  bucket: string,
  storageKey: string,
  mimeType?: string,
  downloadFilename?: string,
): Promise<string> {
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      ResponseContentType: mimeType,
      ResponseContentDisposition: downloadFilename
        ? `attachment; filename="${sanitizeDispositionFilename(downloadFilename)}"`
        : undefined,
    }),
    { expiresIn: SIGNED_URL_EXPIRES_SECONDS },
  );
}

async function signGetUrl(
  storageKey: string,
  mimeType?: string,
  downloadFilename?: string,
): Promise<string> {
  // Read-only signing may reach any root of the private bucket; every mutating
  // cache path still asserts the stricter replay-cache/ guard itself.
  assertBucketKey(getAdminBucket("replay-cache"), storageKey);
  const r2 = getClient();
  if (!r2) throw new Error("R2 replay cache is not configured");

  return signBucketGetUrl(r2, REPLAY_CACHE_BUCKET, storageKey, mimeType, downloadFilename);
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
// CPU-heavy work on the frontend server (multiple seconds per image). The CDN caches
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

export interface UploadedReplayOwnerMetadata {
  uploaderId: number | null;
  originalFilename: string | null;
  uploadedAt: string | null;
}

// The uploader stamped on the object at upload time. Only the owner-index
// backfill reads this: every other caller goes through the index in the live
// backend, since a HEAD per upload is not a listing.
export async function headUploadedReplayOwner(id: string): Promise<UploadedReplayOwnerMetadata | null> {
  const r2 = getClient();
  if (!r2) return null;

  const storageKey = getUploadedReplayStorageKey(id);
  assertReplayCacheKey(storageKey);

  try {
    const head = await r2.send(new HeadObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: storageKey,
    }));
    const uploaderId = Number(head.Metadata?.uploaderid);
    return {
      uploaderId: Number.isSafeInteger(uploaderId) && uploaderId > 0 ? uploaderId : null,
      originalFilename: head.Metadata?.originalfilename ?? null,
      uploadedAt: head.Metadata?.uploadedat ?? head.LastModified?.toISOString() ?? null,
    };
  } catch {
    return null;
  }
}

// Deleting an upload for real: the .osr the share link serves, and the derived
// description artifact that would otherwise keep describing a file that is
// gone. Throws if the .osr delete fails, so a caller never reports a deletion
// that did not happen.
export async function deleteUploadedReplayObjects(id: string): Promise<void> {
  const r2 = getClient();
  if (!r2) return;

  const storageKey = getUploadedReplayStorageKey(id);
  assertReplayCacheKey(storageKey);
  await r2.send(new DeleteObjectCommand({
    Bucket: REPLAY_CACHE_BUCKET,
    Key: storageKey,
  }));

  const descKey = getUploadedReplayDescStorageKey(id);
  assertReplayCacheKey(descKey);
  try {
    await r2.send(new DeleteObjectCommand({
      Bucket: REPLAY_CACHE_BUCKET,
      Key: descKey,
    }));
  } catch {
    // Derived data: an orphaned description describes nothing anyone can reach,
    // and the next write of this id (there is none - ids are random) would
    // replace it anyway.
  }
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

export async function getR2AdminListing(options: {
  bucket?: string | null;
  prefix?: string | null;
  continuationToken?: string | null;
  query?: string | null;
}): Promise<R2AdminListing> {
  const def = getAdminBucket(options.bucket);
  const r2 = resolveAdminClient(def);
  const prefix = normalizeR2AdminPrefix(def.id, options.prefix);
  const query = normalizeR2AdminQuery(options.query);
  const continuationToken = options.continuationToken;
  const bucketName = def.bucket;
  if (!r2) {
    return {
      configured: false,
      bucketId: def.id,
      bucket: bucketName,
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
        Bucket: bucketName,
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
      bucketId: def.id,
      bucket: bucketName,
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
    Bucket: bucketName,
    Prefix: prefix,
    Delimiter: "/",
    MaxKeys: R2_ADMIN_LIST_LIMIT,
    ContinuationToken: continuationToken?.trim() || undefined,
  }));

  const folders = (response.CommonPrefixes ?? [])
    .map((entry) => entry.Prefix)
    .filter((entry): entry is string => !!entry && entry.startsWith(prefix))
    .map((folderPrefix) => ({
      prefix: folderPrefix,
      name: objectNameFromKey(folderPrefix.replace(/\/$/, ""), prefix),
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
    bucketId: def.id,
    bucket: bucketName,
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

// Counts and sizes for the folder rows the browser is showing. Each prefix
// costs a paginated scan of everything under it, which is why this is a
// separate call the page makes per visible page of rows instead of something
// the listing waits on.
export async function getR2AdminFolderStats(options: {
  bucket?: string | null;
  prefixes: string[];
}): Promise<R2AdminPrefixSummary[]> {
  const def = getAdminBucket(options.bucket);
  const r2 = resolveAdminClient(def);
  if (!r2) return [];

  const prefixes = options.prefixes
    .slice(0, R2_ADMIN_FOLDER_STATS_LIMIT)
    .map((prefix) => normalizeR2AdminPrefix(def.id, prefix));
  return mapWithConcurrency(
    prefixes,
    R2_ADMIN_FOLDER_STATS_CONCURRENCY,
    (prefix) => getR2PrefixSummaryInternal(r2, def, prefix, R2_ADMIN_FOLDER_STATS_SCAN_LIMIT),
  );
}

async function getR2PrefixSummaryInternal(
  r2: S3Client,
  def: AdminBucketDef,
  prefixInput: string,
  maxObjects?: number,
): Promise<R2AdminPrefixSummary> {
  const prefix = normalizeR2AdminPrefix(def.id, prefixInput);
  const labelSuffix = def.roots.find((root) => prefix.startsWith(root.prefix))?.folderLabelSuffix;
  let continuationToken: string | undefined;
  let objectCount = 0;
  let sizeBytes = 0;
  let truncated = false;
  let sampleName: string | null = null;

  do {
    const response = await r2.send(new ListObjectsV2Command({
      Bucket: def.bucket,
      Prefix: prefix,
      MaxKeys: R2_ADMIN_DELETE_BATCH_SIZE,
      ContinuationToken: continuationToken,
    }));

    for (const entry of response.Contents ?? []) {
      if (!entry.Key?.startsWith(prefix)) continue;
      objectCount += 1;
      const objectSize = Number(entry.Size ?? 0);
      if (Number.isFinite(objectSize) && objectSize > 0) sizeBytes += objectSize;
      if (labelSuffix && !sampleName && entry.Key.toLowerCase().endsWith(labelSuffix)) {
        sampleName = entry.Key.slice(prefix.length);
      }
      if (maxObjects != null && objectCount >= maxObjects) {
        truncated = Boolean(response.IsTruncated);
        break;
      }
    }

    if (maxObjects != null && objectCount >= maxObjects) break;
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return { prefix, objectCount, sizeBytes, truncated, sampleName };
}

export async function getR2AdminPrefixSummary(
  bucketId: string | undefined | null,
  prefixInput: string,
): Promise<R2AdminPrefixSummary> {
  const { def, client } = requireAdminBucket(bucketId);
  const prefix = normalizeR2AdminPrefix(def.id, prefixInput);
  if (isAdminRootPrefix(def, prefix)) {
    throw new Error("Refusing to summarize a root prefix for deletion.");
  }
  return getR2PrefixSummaryInternal(client, def, prefix);
}

export async function deleteR2AdminObject(
  bucketId: string | undefined | null,
  keyInput: string,
): Promise<R2AdminDeleteResult> {
  const { def, client: r2 } = requireAdminBucket(bucketId);

  const key = normalizeR2AdminObjectKey(def.id, keyInput);
  let sizeBytes: number | null = null;
  try {
    const head = await r2.send(new HeadObjectCommand({
      Bucket: def.bucket,
      Key: key,
    }));
    sizeBytes = Number(head.ContentLength ?? 0);
  } catch {
    sizeBytes = null;
  }

  await r2.send(new DeleteObjectCommand({
    Bucket: def.bucket,
    Key: key,
  }));

  return {
    ok: true,
    deletedCount: 1,
    deletedBytes: sizeBytes !== null && Number.isFinite(sizeBytes) ? sizeBytes : null,
  };
}

export async function deleteR2AdminPrefix(
  bucketId: string | undefined | null,
  prefixInput: string,
): Promise<R2AdminDeleteResult> {
  const { def, client: r2 } = requireAdminBucket(bucketId);

  const prefix = normalizeR2AdminPrefix(def.id, prefixInput);
  if (isAdminRootPrefix(def, prefix)) {
    throw new Error("Refusing to delete a root prefix.");
  }

  let continuationToken: string | undefined;
  let deletedCount = 0;
  let deletedBytes = 0;

  do {
    const listed = await r2.send(new ListObjectsV2Command({
      Bucket: def.bucket,
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
        Bucket: def.bucket,
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
