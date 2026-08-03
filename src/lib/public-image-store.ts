// Server-only storage for the images the BBCode editor uploads, on R2 behind
// cdn.mania-tracker.com.
//
// These live in their own bucket rather than the replay cache. Connecting a
// public domain to an R2 bucket exposes every key in it, and the replay cache
// holds users' replays, uploaded .osr files and videos at keys as guessable as
// replay-cache/replays/{scoreId}.osr - so the two must not share a bucket.
//
// Objects are content-addressed: the same picture uploaded twice is stored
// once, and a URL always names exactly one set of bytes, which is what makes
// the immutable year-long cache header true rather than a hope. Nothing under
// this prefix may be given an R2 lifecycle rule - these URLs get pasted into
// osu! profiles and have to outlive anything the site itself remembers.

import crypto from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { imageMimeExtension, type SniffedImageMime } from "./image-sniff";

const IMAGE_PREFIX = "bbcode/";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Guard against a typo or a copied .env pointing uploads at the private cache
// bucket, where they would be written but never publicly readable.
const EXPECTED_BUCKET = "mania-hub-public";

let client: S3Client | null | undefined;

function getBucket(): string | null {
  return process.env.R2_IMAGE_BUCKET?.trim() || null;
}

function getClient(): S3Client | null {
  if (client !== undefined) return client;

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = getBucket();

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    client = null;
    return client;
  }
  if (bucket !== EXPECTED_BUCKET) {
    throw new Error(`Refusing to store public images in unexpected R2 bucket "${bucket}"`);
  }

  client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

/** Public base URL of the image bucket's custom domain, without a trailing slash. */
function getBaseUrl(): string | null {
  const raw = process.env.R2_IMAGE_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function isPublicImageStoreConfigured(): boolean {
  return getClient() !== null && getBaseUrl() !== null;
}

/** Content-addressed key for an image, identical for identical bytes. */
export function getPublicImageKey(buffer: Buffer, mime: SniffedImageMime): string {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return `${IMAGE_PREFIX}${hash}.${imageMimeExtension(mime)}`;
}

export interface StoredImage {
  url: string;
  key: string;
}

/**
 * Stores image bytes and returns their public URL.
 *
 * Re-uploading known bytes overwrites the object with an identical copy rather
 * than checking first: a HEAD round-trip per upload buys nothing when the
 * write is idempotent by construction.
 */
export async function storePublicImage(
  buffer: Buffer,
  mime: SniffedImageMime,
  uploadedBy: string,
): Promise<StoredImage> {
  const s3 = getClient();
  const bucket = getBucket();
  const baseUrl = getBaseUrl();
  if (!s3 || !bucket || !baseUrl) {
    throw new Error("Image storage is not configured.");
  }

  const key = getPublicImageKey(buffer, mime);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mime,
      CacheControl: IMMUTABLE_CACHE_CONTROL,
      // These are permanent, public, and served under our own domain, so a
      // takedown needs to be able to answer "who uploaded this".
      Metadata: { "uploaded-by": uploadedBy },
    }),
  );
  return { url: `${baseUrl}/${key}`, key };
}
