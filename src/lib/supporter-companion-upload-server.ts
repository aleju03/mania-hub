// Server handler for /api/supporter-companion: the file behind a companion a
// supporter submits, a 3D model (.glb) or an image. Kept out of the route file
// so it can be tested with plain Request objects.
//
// An image is never stored as sent: decoded, fitted inside 512px and
// re-encoded as WebP, an animated one with all its frames. A model is stored as sent once
// checkGlb passes it (self-contained binary glTF, no codec the site lacks, a
// triangle cap) and is not a copy of one of the site's own models. Both go into the public bucket under companions/, content
// addressed; the backend only accepts a submission whose URL has that shape.
// Hardening as for the card motif upload: signed session, same-origin,
// per-viewer rate limit, size cap before buffering, magic-byte sniffing, and
// an active-supporter check against the live backend.

import { createHash } from "node:crypto";
import { readViewerFromRequest } from "./auth-server";
import { BUILT_IN_COMPANION_GEOMETRY, BUILT_IN_COMPANION_SOURCES } from "./companion-builtin-models";
import { checkGlb } from "./glb-validate";
import { sniffImageMime } from "./image-sniff";
import { getServerLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";
import { isSameOriginRequest } from "./origin";
import { storePublicImage } from "./public-image-store";
import { createFixedWindowLimiter, readCappedBody } from "./upload-guards";

export const SUPPORTER_COMPANION_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_SIZE = 512;
const COMPANION_PREFIX = "companions/";
const RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_LIMIT_PER_WINDOW = 4;

const rateLimiter = createFixedWindowLimiter(RATE_WINDOW_MS);

export interface SupporterCompanionUploadSeams {
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

/* Upright, fitted inside the output square, WebP with alpha. An animated GIF
   or WebP keeps every frame and its timing, so it plays wherever it shows. */
export async function convertCompanionImage(buffer: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { pages = 1 } = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
  const animated = pages > 1;
  const image = sharp(buffer, { animated, limitInputPixels: 40_000_000 });
  return (animated ? image : image.rotate())
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: animated ? 80 : 88, alphaQuality: 90 })
    .toBuffer();
}

const GLB_ERRORS = {
  not_glb: "That file is not a .glb model or an image.",
  external_files: "That model points at files outside itself. Export it as a single .glb with its textures inside.",
  unsupported_extension: "That model is compressed in a way the site can't read (Draco, Meshopt or KTX2). Export it without compression.",
  too_many_triangles: "That model has too many triangles; keep it under 100,000.",
  already_listed: "That model is already in the list.",
} as const;

/* The same geometry as one of the site's own models, or downloaded from the
   same page, whatever its textures were saved as. */
export function isBuiltInModel(model: { geometry: string; source: string | null }): boolean {
  const geometry = createHash("sha256").update(model.geometry).digest("hex").slice(0, 16);
  return BUILT_IN_COMPANION_GEOMETRY.has(geometry) || (model.source !== null && BUILT_IN_COMPANION_SOURCES.has(model.source));
}

export async function handleSupporterCompanionUpload(
  request: Request,
  { store = storePublicImage, isSupporter = isActiveSupporter }: SupporterCompanionUploadSeams = {},
): Promise<Response> {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Forbidden." }, { status: 403 });
  const viewer = await readViewerFromRequest(request);
  if (!viewer) return Response.json({ error: "Sign in to submit a companion." }, { status: 401 });
  if (rateLimiter.isRateLimited(`user:${viewer.id}`, UPLOAD_RATE_LIMIT_PER_WINDOW)) {
    return Response.json({ error: "Too many uploads; try again in a minute." }, { status: 429 });
  }
  const buffer = await readCappedBody(request, SUPPORTER_COMPANION_MAX_UPLOAD_BYTES);
  if (!buffer) return Response.json({ error: "That file is over 10 MB." }, { status: 413 });
  if (buffer.length === 0) return Response.json({ error: GLB_ERRORS.not_glb }, { status: 415 });
  const image = sniffImageMime(buffer);
  const model = image ? null : checkGlb(buffer);
  if (model && !model.ok) return Response.json({ error: GLB_ERRORS[model.error] }, { status: 415 });
  if (model && isBuiltInModel(model)) return Response.json({ error: GLB_ERRORS.already_listed }, { status: 409 });
  if (!(await isSupporter(viewer.id).catch(() => false))) {
    return Response.json({ error: "Only supporters can submit companions." }, { status: 403 });
  }
  let stored: Buffer = buffer;
  if (image) {
    try {
      stored = await convertCompanionImage(buffer);
    } catch {
      return Response.json({ error: "Could not read that image." }, { status: 415 });
    }
  }
  try {
    const { url } = await store(stored, image ? "image/webp" : "model/gltf-binary", `user:${viewer.id}`, COMPANION_PREFIX);
    return Response.json({ url, kind: image ? "image" : "model" });
  } catch {
    return Response.json({ error: "Could not save the file." }, { status: 503 });
  }
}
