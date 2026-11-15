// Server handler for /api/supporter-motif: a supporter's own image for the
// motif that floats on every copy of their card. Kept out of the route file so
// it can be tested with plain Request objects.
//
// The image is never stored as sent. It is decoded, flattened to its first
// frame, fitted inside 256px and re-encoded as WebP, so what lands in the
// bucket is small, has no metadata and is a format every card surface draws.
// It goes into the public image bucket under supporter-motifs/, content
// addressed like the BBCode uploads; the backend only accepts a look whose URL
// has that exact shape, and the /api/card-motif proxy allowlists it from there.
// Admins can take an image down from /admin/supporters.
//
// Hardening mirrors catbox-upload-server: signed session, same-origin,
// per-viewer rate limit, size cap before buffering, magic-byte sniffing, and
// on top of that an active-supporter check against the live backend.

import { readViewerFromRequest } from "./auth-server";
import { sniffImageMime } from "./image-sniff";
import { getServerLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";
import { isSameOriginRequest } from "./origin";
import { storePublicImage } from "./public-image-store";
import { createFixedWindowLimiter, readCappedBody } from "./upload-guards";

export const SUPPORTER_MOTIF_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const OUTPUT_SIZE = 256;
const MOTIF_PREFIX = "supporter-motifs/";
const RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_LIMIT_PER_WINDOW = 6;

const rateLimiter = createFixedWindowLimiter(RATE_WINDOW_MS);

export interface SupporterMotifUploadSeams {
  store?: typeof storePublicImage;
  isSupporter?: (userId: number) => Promise<boolean>;
}

async function isActiveSupporter(userId: number): Promise<boolean> {
  const base = getServerLiveBackendUrl();
  if (!base) return false;
  const response = await fetch(`${base}/api/supporters/self/look?userId=${userId}`, { headers: bridgeAuthHeaders() });
  if (!response.ok) return false;
  const body = await response.json().catch(() => null) as { supporter?: unknown } | null;
  return body?.supporter === true;
}

/* First frame, upright, fitted inside the output square, WebP with alpha. */
export async function convertSupporterMotif(buffer: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(buffer, { animated: false, limitInputPixels: 40_000_000 })
    .rotate()
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 86, alphaQuality: 90 })
    .toBuffer();
}

export async function handleSupporterMotifUpload(
  request: Request,
  { store = storePublicImage, isSupporter = isActiveSupporter }: SupporterMotifUploadSeams = {},
): Promise<Response> {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Forbidden." }, { status: 403 });
  const viewer = await readViewerFromRequest(request);
  if (!viewer) return Response.json({ error: "Sign in to upload an image." }, { status: 401 });
  if (rateLimiter.isRateLimited(`user:${viewer.id}`, UPLOAD_RATE_LIMIT_PER_WINDOW)) {
    return Response.json({ error: "Too many uploads; try again in a minute." }, { status: 429 });
  }
  const buffer = await readCappedBody(request, SUPPORTER_MOTIF_MAX_UPLOAD_BYTES);
  if (!buffer) return Response.json({ error: "That image is over 5 MB." }, { status: 413 });
  if (buffer.length === 0 || !sniffImageMime(buffer)) {
    return Response.json({ error: "That file is not an image." }, { status: 415 });
  }
  if (!(await isSupporter(viewer.id).catch(() => false))) {
    return Response.json({ error: "Only supporters can use their own image." }, { status: 403 });
  }
  let converted: Buffer;
  try {
    converted = await convertSupporterMotif(buffer);
  } catch {
    return Response.json({ error: "Could not read that image." }, { status: 415 });
  }
  try {
    const { url } = await store(converted, "image/webp", `user:${viewer.id}`, MOTIF_PREFIX);
    return Response.json({ url });
  } catch {
    return Response.json({ error: "Could not save the image." }, { status: 503 });
  }
}
