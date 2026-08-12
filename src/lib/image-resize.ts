// Client-side image encoder for the BBCode editor's drag-to-resize handle.
//
// osu! lays a profile [img] out at the file's own pixel width and caps it at
// the "me!" column with max-width: 100%, so a file's pixels are its size on the
// page. Re-encoding a picture smaller therefore leaves exactly one stored pixel
// per CSS pixel, which is soft on any display that is not at 1x/100% - and it
// throws away the very pixels that made a wide screenshot look sharp there,
// since a file wider than the column was being supersampled into it.
//
// So a drag does not shrink the picture. It pads the canvas: the source pixels
// are kept (as far as MAX_ENCODED_FILE_WIDTH allows), transparent margins take
// the file out past the column, and osu!'s own fit-to-column downscale lands
// the picture at the width that was asked for, with as many stored pixels
// behind every CSS pixel as the file has room for.
//
// Everything works on a Blob (a staged local image, or a remote one re-fetched
// through our proxy) so the canvas is never tainted by cross-origin pixels.

import { OSU_PROFILE_COLUMN_WIDTH } from "./bbcode-layout";

/**
 * Widest file the padding may build.
 *
 * A padded file is the column times the pixel density it carries, so this is
 * also the density cap: 2560/890 is about 2.9 stored pixels per CSS pixel,
 * past what any display asks for, and it keeps the canvas and the upload small
 * enough to be uneventful.
 */
export const MAX_ENCODED_FILE_WIDTH = 2560;

/** Ceiling on the canvas a padded encode may allocate, in pixels. */
const MAX_ENCODED_AREA = 40_000_000;

/** Alpha at or under this counts as an empty pixel when measuring margins. */
const EMPTY_ALPHA = 4;

/** Margins under this share of a file are somebody's own art, not our padding. */
const MIN_MARGIN_SHARE = 0.02;

export type ImageAlign = "left" | "center" | "right";

/** A horizontal slice of a file: the picture inside it, ignoring margins. */
export interface ImageContentRect {
  left: number;
  width: number;
}

export interface EncodePlan {
  /** Intrinsic size of the file to write, which is what osu! lays out. */
  fileWidth: number;
  fileHeight: number;
  /** Where the picture sits inside that file. */
  contentLeft: number;
  contentWidth: number;
  /** CSS px the picture occupies once osu! has fit the file to the column. */
  displayWidth: number;
  /** True when margins were added, so the file is wider than the picture. */
  padded: boolean;
}

export interface EncodedImage extends EncodePlan {
  blob: Blob;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function encodeType(sourceType: string | undefined, needsAlpha: boolean): { mime: string; quality?: number } {
  const mime = (sourceType ?? "").split(";")[0]?.trim().toLowerCase();
  if (mime === "image/webp") return { mime: "image/webp", quality: 0.95 };
  if (mime === "image/jpeg") {
    // JPEG has no way to store the transparent margins, and re-encoding a photo
    // as PNG would multiply its size. Lossy WebP keeps both. A browser that
    // can't write WebP falls back to PNG inside toBlob on its own.
    return needsAlpha ? { mime: "image/webp", quality: 0.92 } : { mime: "image/jpeg", quality: 0.92 };
  }
  // gif/bmp/avif and anything else fall back to png (a gif loses animation).
  return { mime: "image/png" };
}

/**
 * Works out the file to write so `source` shows up `requestedDisplayWidth` CSS
 * px wide in the column.
 *
 * Pure geometry, so the arithmetic that decides how sharp a profile image ends
 * up is testable without a canvas.
 */
export function planImageEncode(
  source: { width: number; height: number },
  requestedDisplayWidth: number,
  options: { align?: ImageAlign; pad?: boolean } = {},
): EncodePlan {
  const { align = "left", pad = true } = options;
  const sourceWidth = Math.max(1, Math.round(source.width));
  const sourceHeight = Math.max(1, Math.round(source.height));
  const aspect = sourceHeight / sourceWidth;
  const displayWidth = clamp(Math.round(requestedDisplayWidth) || 1, 1, OSU_PROFILE_COLUMN_WIDTH);

  // How many source pixels there are for every CSS pixel of the target size.
  // At or under 1 there is nothing spare to protect, so the file is the picture.
  const nativeDensity = sourceWidth / displayWidth;
  if (!pad || nativeDensity <= 1) {
    return {
      fileWidth: displayWidth,
      fileHeight: Math.max(1, Math.round(displayWidth * aspect)),
      contentLeft: 0,
      contentWidth: displayWidth,
      displayWidth,
      padded: false,
    };
  }

  const widthCapDensity = MAX_ENCODED_FILE_WIDTH / OSU_PROFILE_COLUMN_WIDTH;
  // fileWidth * contentHeight, written in terms of density, is
  // (COLUMN * d) * (displayWidth * d * aspect), so the area cap is a cap on d.
  const areaCapDensity = Math.sqrt(MAX_ENCODED_AREA / (OSU_PROFILE_COLUMN_WIDTH * displayWidth * aspect));
  const density = Math.max(1, Math.min(nativeDensity, widthCapDensity, areaCapDensity));

  // Only a capped density resamples; at native density the source is copied
  // pixel for pixel and the margins do all the shrinking.
  let contentWidth = density >= nativeDensity ? sourceWidth : Math.max(1, Math.round(displayWidth * density));
  let contentHeight = Math.max(1, Math.round(contentWidth * aspect));
  let fileWidth = Math.max(contentWidth, Math.round(OSU_PROFILE_COLUMN_WIDTH * density));
  // Rounding can carry the canvas a hair past the cap; take that back by
  // flooring, which can only land under it.
  if (fileWidth * contentHeight > MAX_ENCODED_AREA) {
    const back = Math.sqrt(MAX_ENCODED_AREA / (fileWidth * contentHeight));
    contentWidth = Math.max(1, Math.floor(contentWidth * back));
    contentHeight = Math.max(1, Math.floor(contentHeight * back));
    fileWidth = Math.max(contentWidth, Math.floor(fileWidth * back));
  }
  const margin = fileWidth - contentWidth;
  const contentLeft = align === "left" ? 0 : align === "right" ? margin : Math.round(margin / 2);

  return {
    fileWidth,
    fileHeight: contentHeight,
    contentLeft,
    contentWidth,
    displayWidth,
    padded: margin > 0,
  };
}

/**
 * The columns of RGBA pixel data holding the picture, margins trimmed off.
 *
 * Each row is scanned only as far as it can improve the bounds, so a picture
 * that starts near the edges costs a few pixels a row rather than the width.
 * Margins narrower than MIN_MARGIN_SHARE are left in: those are somebody's own
 * artwork, not the margins this module writes.
 */
export function findPictureColumns(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): ImageContentRect {
  const full = { left: 0, width };
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < left; x += 1) {
      if (data[row + x * 4 + 3] > EMPTY_ALPHA) {
        left = x;
        break;
      }
    }
    for (let x = width - 1; x > right; x -= 1) {
      if (data[row + x * 4 + 3] > EMPTY_ALPHA) {
        right = x;
        break;
      }
    }
  }
  if (right < left) return full; // nothing opaque anywhere; treat it as itself
  const contentWidth = right - left + 1;
  if (width - contentWidth < width * MIN_MARGIN_SHARE) return full;
  return { left, width: contentWidth };
}

/**
 * Finds the picture inside a file that may already carry margins of ours.
 *
 * A file this module padded reads back as one wide image with empty sides, and
 * padding that again would inset the picture twice, so a drag on a file we had
 * to re-download measures it first. Fully transparent edge columns are the
 * tell; anything narrower than MIN_MARGIN_SHARE is left alone as somebody's own
 * artwork.
 */
export async function measureImageContent(
  blob: Blob,
): Promise<{ width: number; height: number; content: ImageContentRect }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const full = { width, height, content: { left: 0, width } };
    if (width < 2 || height < 1) return full;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return full;
    ctx.drawImage(bitmap, 0, 0);

    // Both outer columns have to be empty before the whole image is worth
    // reading: that is one narrow strip each instead of megapixels of alpha.
    const leftEdge = ctx.getImageData(0, 0, 1, height).data;
    const rightEdge = ctx.getImageData(width - 1, 0, 1, height).data;
    for (let i = 3; i < leftEdge.length; i += 4) {
      if (leftEdge[i] > EMPTY_ALPHA || rightEdge[i] > EMPTY_ALPHA) return full;
    }

    const { data } = ctx.getImageData(0, 0, width, height);
    return { width, height, content: findPictureColumns(data, width, height) };
  } catch {
    // A tainted or undecodable source measures as itself; the encode still runs.
    return { width: 0, height: 0, content: { left: 0, width: 0 } };
  } finally {
    bitmap.close?.();
  }
}

/**
 * Writes the file that puts `blob`'s picture `displayWidth` CSS px wide in the
 * column, padding rather than shrinking wherever there are pixels to keep.
 *
 * `sourceRect` names the picture inside `blob` when that file has margins of
 * its own, so they are re-cut rather than compounded.
 */
export async function encodeImageAtDisplayWidth(
  blob: Blob,
  displayWidth: number,
  options: { align?: ImageAlign; pad?: boolean; sourceRect?: ImageContentRect } = {},
): Promise<EncodedImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const rect = options.sourceRect ?? { left: 0, width: bitmap.width };
    const plan = planImageEncode({ width: rect.width, height: bitmap.height }, displayWidth, options);
    // The file already is the picture at this width: hand back the bytes it was
    // decoded from rather than re-encoding a copy of them.
    if (!plan.padded && rect.left === 0 && rect.width === bitmap.width && plan.contentWidth === bitmap.width) {
      return { ...plan, fileHeight: bitmap.height, blob };
    }

    const canvas = document.createElement("canvas");
    canvas.width = plan.fileWidth;
    canvas.height = plan.fileHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      bitmap,
      rect.left,
      0,
      rect.width,
      bitmap.height,
      plan.contentLeft,
      0,
      plan.contentWidth,
      plan.fileHeight,
    );
    const { mime, quality } = encodeType(blob.type, plan.padded);
    const out = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (encoded) => (encoded ? resolve(encoded) : reject(new Error("Could not encode the resized image."))),
        mime,
        quality,
      ),
    );
    return { ...plan, blob: out };
  } finally {
    bitmap.close?.();
  }
}
