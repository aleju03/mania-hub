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

export interface ImageSize {
  width: number;
  height: number;
}

function readUint16BE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    buffer[offset] * 0x1000000 + ((buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3])
  );
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16) + buffer[offset + 3] * 0x1000000
  );
}

/* Pixel dimensions from a header, without decoding the image.

   Needed anywhere an image has to be laid out before a browser has seen it -
   the OG renderer scatters a card's motif at the image's own aspect ratio, and
   satori will not measure a data URL for us. AVIF is deliberately absent: its
   size lives in a box tree deep enough that a parser for it would be a
   liability here, and a caller with no size falls back to a square. */
export function readImageSize(buffer: Uint8Array): ImageSize | null {
  const mime = sniffImageMime(buffer);
  if (mime === "image/png") {
    // IHDR is always the first chunk, so width and height sit at a fixed offset.
    if (buffer.length < 24) return null;
    return { width: readUint32BE(buffer, 16), height: readUint32BE(buffer, 20) };
  }
  if (mime === "image/gif") {
    if (buffer.length < 10) return null;
    return { width: readUint16LE(buffer, 6), height: readUint16LE(buffer, 8) };
  }
  if (mime === "image/bmp") {
    if (buffer.length < 26) return null;
    // Signed: a negative height means the rows are stored top-down.
    return { width: readUint32LE(buffer, 18), height: Math.abs(readUint32LE(buffer, 22) | 0) };
  }
  if (mime === "image/webp") {
    if (hasAscii(buffer, 12, "VP8X") && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
      return { width, height };
    }
    if (hasAscii(buffer, 12, "VP8 ") && buffer.length >= 30) {
      // Frame header: 3 bytes of tag, a 3-byte start code, then 14-bit sizes.
      return { width: readUint16LE(buffer, 26) & 0x3fff, height: readUint16LE(buffer, 28) & 0x3fff };
    }
    if (hasAscii(buffer, 12, "VP8L") && buffer.length >= 25) {
      // 14 bits of width then 14 of height, packed little-endian after the 0x2f signature.
      const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (mime === "image/jpeg") {
    // Walk the marker segments to the first start-of-frame, which is the only
    // place a JPEG states its size.
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0-SOF15, minus the three markers in that range that are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: readUint16BE(buffer, offset + 7), height: readUint16BE(buffer, offset + 5) };
      }
      // Standalone markers carry no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = readUint16BE(buffer, offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  return null;
}
