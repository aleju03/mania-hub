// Client side of the catbox image proxy used by the BBCode editor.
// All requests go to our own /api/catbox-upload route (see that file for why a
// direct browser->catbox upload can't work).

const ENDPOINT = "/api/catbox-upload";

const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
]);

export function isUploadableImage(file: { type: string }): boolean {
  return ALLOWED_IMAGE_MIME.has(file.type.split(";")[0]?.trim().toLowerCase());
}

/** Uploads image bytes to catbox via our proxy; resolves to the hosted URL. */
export async function uploadImageToCatbox(file: Blob): Promise<string> {
  const type = file.type && isUploadableImage(file) ? file.type : "image/png";
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": type },
    body: file,
  });
  let payload: { url?: string; error?: string } = {};
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body; fall through to the generic error below.
  }
  if (!res.ok || !payload.url) {
    throw new Error(payload.error || `Upload failed (${res.status})`);
  }
  return payload.url;
}

/**
 * Fetches a remote image through our origin so a <canvas> can read its pixels
 * without tainting (catbox and most image hosts send no CORS headers).
 */
export async function fetchImageBlobViaProxy(url: string): Promise<Blob> {
  const res = await fetch(`${ENDPOINT}?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`Could not load image (${res.status})`);
  return res.blob();
}
