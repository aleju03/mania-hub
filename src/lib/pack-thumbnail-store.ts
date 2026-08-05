// Maniacard thumbnails on the public image bucket, served straight from its
// custom domain (cdn.mania-tracker.com).
//
// They used to live in the private replay-cache bucket, which meant every read
// was a HeadObject plus a presigned GET against the S3 endpoint - URLs no CDN
// ever fronts and that rotate per signing, so neither Cloudflare nor the
// browser could cache a single byte. Thumbnails are public derived content
// (any client can re-render one from collection data), so they belong on the
// public bucket: the URL is a pure function of the cache key, reads cost zero
// R2 operations here, and the immutable cache header makes repeat views free.
//
// There is deliberately no existence check on the read path. A missing or
// lifecycle-expired object 404s at the <img>, and the client falls back to
// rendering the card locally and re-uploading it (cardThumbnailCache.ts), the
// same self-heal that always covered a miss. The maniacards/ prefix carries a
// 90-day R2 expiry rule scoped to it alone; bbcode/ in this bucket must stay
// ruleless (see public-image-store.ts).

import crypto from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  getPublicBucketBaseUrl,
  getPublicBucketClient,
  getPublicBucketName,
} from "./public-image-store";

const THUMBNAIL_PREFIX = "maniacards/";
const THUMBNAIL_CONTENT_TYPE = "image/webp";
const THUMBNAIL_KEY_PATTERN = /^(v\d+)-w\d+-u(\d+)-[a-f0-9]{16}$/;

export function getPackCardThumbnailStorageKey(cacheKey: string): string {
  const match = THUMBNAIL_KEY_PATTERN.exec(cacheKey);
  if (!match) throw new Error("Invalid maniacard thumbnail cache key.");
  const version = match[1]!;
  const userId = match[2]!;
  const hash = crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 40);
  // The layout mirrors what the replay-cache bucket used (minus its
  // replay-cache/ root), so the one-off backfill copy was a key-preserving
  // move: v1 objects predate the inspectable hierarchy and stay flat, every
  // newer renderer writes into its own removable namespace.
  if (version === "v1") return `${THUMBNAIL_PREFIX}${hash}.webp`;
  return `${THUMBNAIL_PREFIX}${version}/${userId}/${hash}.webp`;
}

/**
 * Public URL for a thumbnail, or null when the store is unconfigured. Costs
 * nothing: the object is not checked for existence (see module comment).
 */
export function getPackCardThumbnailUrl(cacheKey: string): string | null {
  const baseUrl = getPublicBucketBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl}/${getPackCardThumbnailStorageKey(cacheKey)}`;
}

/**
 * Stores a thumbnail and returns its public URL.
 *
 * Every pack reveal re-posts the thumbnails it rendered, so most arrivals
 * already exist. The key is content-addressed (CACHE_VERSION plus the render
 * inputs), which makes an existing object byte-equivalent to this upload:
 * answer with a Head instead of rewriting it, keeping the write (and its
 * lifecycle clock) untouched.
 */
export async function putPackCardThumbnail(cacheKey: string, buffer: Buffer): Promise<string | null> {
  const s3 = getPublicBucketClient();
  const bucket = getPublicBucketName();
  const baseUrl = getPublicBucketBaseUrl();
  if (!s3 || !bucket || !baseUrl || buffer.length === 0) return null;

  const storageKey = getPackCardThumbnailStorageKey(cacheKey);
  const exists = await s3.send(new HeadObjectCommand({
    Bucket: bucket,
    Key: storageKey,
  })).then(() => true, () => false);

  if (!exists) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: storageKey,
      Body: buffer,
      ContentType: THUMBNAIL_CONTENT_TYPE,
      CacheControl: "public, max-age=31536000, immutable",
    }));
  }
  return `${baseUrl}/${storageKey}`;
}
