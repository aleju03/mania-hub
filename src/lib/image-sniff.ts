// Magic-byte image sniffing for the image upload/proxy route. Both handlers
// verify real bytes instead of trusting a client- or upstream-supplied
// Content-Type: uploads must be actual images before they are stored, and
// proxied downloads are re-labelled from their bytes.

export type SniffedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp"
  | "image/avif";

function hasBytes(buffer: Uint8Array, offset: number, bytes: number[]): boolean {
  if (offset + bytes.length > buffer.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function hasAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  return hasBytes(buffer, offset, [...text].map((ch) => ch.charCodeAt(0)));
}

const EXTENSION_BY_MIME: Record<SniffedImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/** File extension for a sniffed type, so stored names match their real bytes. */
export function imageMimeExtension(mime: SniffedImageMime): string {
  return EXTENSION_BY_MIME[mime];
}

/** Identifies a supported image format from its leading bytes, or null. */
export function sniffImageMime(buffer: Uint8Array): SniffedImageMime | null {
  if (hasBytes(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasBytes(buffer, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasAscii(buffer, 0, "GIF87a") || hasAscii(buffer, 0, "GIF89a")) return "image/gif";
  if (hasAscii(buffer, 0, "RIFF") && hasAscii(buffer, 8, "WEBP")) return "image/webp";
  // "BM" alone is weak; require at least a full BITMAPFILEHEADER.
  if (hasAscii(buffer, 0, "BM") && buffer.length >= 14) return "image/bmp";
  if (hasAscii(buffer, 4, "ftyp") && (hasAscii(buffer, 8, "avif") || hasAscii(buffer, 8, "avis"))) return "image/avif";
  return null;
}
