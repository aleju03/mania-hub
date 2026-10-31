// Server handler for /api/supporter-frame: the files behind an avatar frame a
// supporter makes in the workshop. ?kind=still takes the frame's picture, ?kind=video
// its optional loop, ?kind=round its optional picture drawn round a round avatar
// (for lists). Kept out of the route file so it can be tested with plain
// Request objects.
//
// A still is never stored as sent: decoded, flattened to its first frame,
// fitted to the workshop template's square and re-encoded as PNG. The upload
// also measures how far the art reaches past the avatar (overhang, in avatar
// widths) and refuses art that covers the avatar itself. A video is stored as
// sent once it reads as WebM. Both go into the public bucket under frames/,
// content addressed; the backend only accepts a submission whose URLs have
// that shape. Hardening as for the companion upload: signed session,
// same-origin, per-viewer rate limit, size cap before buffering, magic-byte
// sniffing, and an active-supporter check against the live backend.

import { readViewerFromRequest } from "./auth-server";
import { sniffImageMime } from "./image-sniff";
import { getServerLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";
import { isSameOriginRequest } from "./origin";
import { storePublicImage } from "./public-image-store";
import { WORKSHOP_FRAME_TEMPLATE } from "./supporter-avatar-frames";
import { createFixedWindowLimiter, readCappedBody } from "./upload-guards";

export const SUPPORTER_FRAME_STILL_MAX_BYTES = 8 * 1024 * 1024;
export const SUPPORTER_FRAME_VIDEO_MAX_BYTES = 2 * 1024 * 1024;
const FRAME_PREFIX = "frames/";
const RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_LIMIT_PER_WINDOW = 8;
/* Art that leaves less than this share of the avatar see-through hides the player. */
const MIN_CLEAR_AVATAR = 0.6;
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

const rateLimiter = createFixedWindowLimiter(RATE_WINDOW_MS);

export interface SupporterFrameUploadSeams {
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

export type FrameStillResult =
  | { ok: true; png: Buffer; overhang: [number, number, number, number] }
  | { ok: false; error: string };

/* The still on the template: square, first frame, at the template's size, as
   PNG, with how far its art reaches past the avatar and whether it leaves the
   avatar showing. */
/* `round`: the art is drawn round a circle, so the clear area to keep is the circle. */
export async function convertFrameStill(buffer: Buffer, { round = false }: { round?: boolean } = {}): Promise<FrameStillResult> {
  const sharp = (await import("sharp")).default;
  const { size, avatar, inset } = WORKSHOP_FRAME_TEMPLATE;
  const meta = await sharp(buffer, { animated: false, limitInputPixels: 40_000_000 }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < size / 2 || height < size / 2) return { ok: false, error: `Draw it at least ${size / 2}px square (the template is ${size}px).` };
  if (Math.abs(width - height) > Math.max(width, height) * 0.01) return { ok: false, error: "The frame has to be square, like the template." };
  if (!meta.hasAlpha) return { ok: false, error: "The frame needs a transparent background (a PNG or WebP with alpha)." };
  const { data } = await sharp(buffer, { animated: false, limitInputPixels: 40_000_000 })
    .rotate()
    .resize(size, size, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // the art's bounds, and how much of the avatar it leaves clear
  let x0: number = size, y0: number = size, x1 = -1, y1 = -1, covered = 0;
  const centre = inset + avatar / 2, radius2 = (avatar / 2) ** 2;
  const inAvatar = (x: number, y: number) => round
    ? (x + 0.5 - centre) ** 2 + (y + 0.5 - centre) ** 2 <= radius2
    : x >= inset && x < inset + avatar && y >= inset && y < inset + avatar;
  const avatarArea = round ? Math.PI * radius2 : avatar * avatar;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = data[(y * size + x) * 4 + 3];
      if (alpha < 16) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (alpha > 200 && inAvatar(x, y)) covered++;
    }
  }
  if (x1 < 0) return { ok: false, error: "That picture is empty." };
  if (1 - covered / avatarArea < MIN_CLEAR_AVATAR) return { ok: false, error: "The frame covers too much of the avatar; keep the middle see-through." };
  const reach = (n: number) => Math.round(Math.max(0, n) / avatar * 10_000) / 10_000;
  const overhang: [number, number, number, number] = [reach(inset - x0), reach(inset - y0), reach(x1 + 1 - (inset + avatar)), reach(y1 + 1 - (inset + avatar))];
  const png = await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
  return { ok: true, png, overhang };
}

export async function handleSupporterFrameUpload(
  request: Request,
  { store = storePublicImage, isSupporter = isActiveSupporter }: SupporterFrameUploadSeams = {},
): Promise<Response> {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Forbidden." }, { status: 403 });
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind !== "still" && kind !== "video" && kind !== "round") return Response.json({ error: "Say whether this is the still, the round still or the video." }, { status: 400 });
  const viewer = await readViewerFromRequest(request);
  if (!viewer) return Response.json({ error: "Sign in to make a frame." }, { status: 401 });
  if (rateLimiter.isRateLimited(`user:${viewer.id}`, UPLOAD_RATE_LIMIT_PER_WINDOW)) {
    return Response.json({ error: "Too many uploads; try again in a minute." }, { status: 429 });
  }
  const picture = kind !== "video";
  const buffer = await readCappedBody(request, picture ? SUPPORTER_FRAME_STILL_MAX_BYTES : SUPPORTER_FRAME_VIDEO_MAX_BYTES);
  if (!buffer) return Response.json({ error: picture ? "That picture is over 8 MB." : "That video is over 2 MB." }, { status: 413 });
  if (picture ? !sniffImageMime(buffer) : !WEBM_MAGIC.every((byte, i) => buffer[i] === byte)) {
    return Response.json({ error: picture ? "That is not a picture." : "The loop has to be a WebM video." }, { status: 415 });
  }
  if (!(await isSupporter(viewer.id).catch(() => false))) {
    return Response.json({ error: "Only supporters can make frames." }, { status: 403 });
  }
  if (kind === "video") {
    try {
      const { url } = await store(buffer, "video/webm", `user:${viewer.id}`, FRAME_PREFIX);
      return Response.json({ url });
    } catch {
      return Response.json({ error: "Could not save the file." }, { status: 503 });
    }
  }
  let still: FrameStillResult;
  try {
    still = await convertFrameStill(buffer, { round: kind === "round" });
  } catch {
    return Response.json({ error: "Could not read that picture." }, { status: 415 });
  }
  if (!still.ok) return Response.json({ error: still.error }, { status: 422 });
  try {
    const { url } = await store(still.png, "image/png", `user:${viewer.id}`, FRAME_PREFIX);
    return Response.json({ url, overhang: still.overhang });
  } catch {
    return Response.json({ error: "Could not save the file." }, { status: 503 });
  }
}
