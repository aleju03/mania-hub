// Server handler for /api/supporter-theme-asset: the images a supporter's own
// profile theme uses. Three kinds, picked by ?kind=:
// - texture: an image the shader samples (u_tex0..3), fitted inside 2048px;
// - still: the theme's frame for thumbnails, the gallery and every fallback,
//   1200x630;
// - row: its banner behind list rows, 320x200 with the fade the editor baked.
//
// Like the card motif upload (supporter-motif-upload-server.ts), nothing is
// stored as sent: it is decoded, flattened to one frame, sized and re-encoded
// as WebP, content addressed under theme-assets/, the only prefix the backend
// accepts in a theme. Same hardening: signed session, same origin, a
// per-viewer rate limit, a size cap before buffering, magic-byte sniffing and
// an active-supporter check. An admin takedown of a theme remembers its image
// URLs, so a taken-down image can't be saved into a theme again.

import { readViewerFromRequest } from "./auth-server";
import { sniffImageMime } from "./image-sniff";
import { getServerLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";
import { isSameOriginRequest } from "./origin";
import { storePublicImage } from "./public-image-store";
import { createFixedWindowLimiter, readCappedBody } from "./upload-guards";

export const THEME_ASSET_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export type ThemeAssetKind = "texture" | "still" | "row";
const THEME_ASSET_PREFIX = "theme-assets/";
const TEXTURE_MAX = 2048;
export const THEME_STILL_SIZE = { width: 1200, height: 630 } as const;
export const THEME_ROW_SIZE = { width: 320, height: 200 } as const;
const RATE_WINDOW_MS = 60_000;
// a save sends a still and a row, so this is ten saves, or a few with textures
const UPLOAD_RATE_LIMIT_PER_WINDOW = 20;

const rateLimiter = createFixedWindowLimiter(RATE_WINDOW_MS);

export interface ThemeAssetUploadSeams {
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

export function readThemeAssetKind(value: string | null): ThemeAssetKind | null {
  return value === "texture" || value === "still" || value === "row" ? value : null;
}

/* First frame, upright, sized for its kind, WebP with alpha. */
export async function convertThemeAsset(buffer: Buffer, kind: ThemeAssetKind): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const image = sharp(buffer, { animated: false, limitInputPixels: 40_000_000 }).rotate();
  const sized = kind === "texture"
    ? image.resize(TEXTURE_MAX, TEXTURE_MAX, { fit: "inside", withoutEnlargement: true })
    : image.resize(kind === "still" ? THEME_STILL_SIZE.width : THEME_ROW_SIZE.width, kind === "still" ? THEME_STILL_SIZE.height : THEME_ROW_SIZE.height, { fit: "cover" });
  return sized.webp({ quality: kind === "row" ? 82 : 86, alphaQuality: 90 }).toBuffer();
}

export async function handleThemeAssetUpload(
  request: Request,
  { store = storePublicImage, isSupporter = isActiveSupporter }: ThemeAssetUploadSeams = {},
): Promise<Response> {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Forbidden." }, { status: 403 });
  const kind = readThemeAssetKind(new URL(request.url).searchParams.get("kind"));
  if (!kind) return Response.json({ error: "Say which kind of image this is." }, { status: 400 });
  const viewer = await readViewerFromRequest(request);
  if (!viewer) return Response.json({ error: "Sign in to upload an image." }, { status: 401 });
  if (rateLimiter.isRateLimited(`user:${viewer.id}`, UPLOAD_RATE_LIMIT_PER_WINDOW)) {
    return Response.json({ error: "Too many uploads; try again in a minute." }, { status: 429 });
  }
  const buffer = await readCappedBody(request, THEME_ASSET_MAX_UPLOAD_BYTES);
  if (!buffer) return Response.json({ error: "That image is over 8 MB." }, { status: 413 });
  if (buffer.length === 0 || !sniffImageMime(buffer)) {
    return Response.json({ error: "That file is not an image." }, { status: 415 });
  }
  if (!(await isSupporter(viewer.id).catch(() => false))) {
    return Response.json({ error: "Only supporters can make themes." }, { status: 403 });
  }
  let converted: Buffer;
  try {
    converted = await convertThemeAsset(buffer, kind);
  } catch {
    return Response.json({ error: "Could not read that image." }, { status: 415 });
  }
  try {
    const { url } = await store(converted, "image/webp", `user:${viewer.id}`, THEME_ASSET_PREFIX);
    return Response.json({ url });
  } catch {
    return Response.json({ error: "Could not save the image." }, { status: 503 });
  }
}
