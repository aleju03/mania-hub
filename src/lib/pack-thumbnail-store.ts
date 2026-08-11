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
import { buildPackThumbnailStorageKey } from "./pack-thumbnail-shared";

const THUMBNAIL_CONTENT_TYPE = "image/webp";

export function getPackCardThumbnailStorageKey(cacheKey: string): string {
  const hash = crypto.createHash("sha256").update(cacheKey).digest("hex");
  return buildPackThumbnailStorageKey(cacheKey, hash);
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
 * already exist and the write has to be skipped: the key is content-addressed
 * (CACHE_VERSION plus the render inputs), so an existing object is
 * byte-equivalent to this upload and rewriting it would only reset its
 * lifecycle clock.
 *
 * Who decides that matters more than it looks. Answering it here with a Head
 * cost one Class B op per reveal - ~190k/day against ~3k/day of genuinely new
 * thumbnails, i.e. 98% of the Heads finding an object that was already there.
 * So the client checks instead, by loading the object's public URL, which the
 * CDN answers from its edge cache for free (cardThumbnailCache.ts). It only
 * calls this at all when that probe came back missing, and says so with
 * `probedMissing`, which lets the write go straight through. Callers that
 * cannot probe (no CDN configured, probe timed out) leave the flag off and get
 * the old Head-guarded behaviour.
 */
export async function putPackCardThumbnail(
  cacheKey: string,
  buffer: Buffer,
  options: { probedMissing?: boolean } = {},
): Promise<string | null> {
  const s3 = getPublicBucketClient();
  const bucket = getPublicBucketName();
  const baseUrl = getPublicBucketBaseUrl();
  if (!s3 || !bucket || !baseUrl || buffer.length === 0) return null;

  const storageKey = getPackCardThumbnailStorageKey(cacheKey);
  const exists = options.probedMissing
    ? false
    : await s3.send(new HeadObjectCommand({
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
