// Client-side image downscaler for the BBCode editor's drag-to-resize handle.
// osu!'s [img] tag has no width/height, so making an image smaller on the
// profile means actually re-encoding the file at fewer pixels. Works on a Blob
// (a staged local image, or a remote one re-fetched through our proxy) so the
// canvas is never tainted by cross-origin pixels.

function encodeType(sourceType: string | undefined): { mime: string; quality?: number } {
  const mime = (sourceType ?? "").split(";")[0]?.trim().toLowerCase();
  if (mime === "image/jpeg") return { mime: "image/jpeg", quality: 0.92 };
  if (mime === "image/webp") return { mime: "image/webp", quality: 0.95 };
  // gif/bmp/avif and anything else fall back to png (a gif loses animation).
  return { mime: "image/png" };
}

/** Re-encodes `blob` scaled to `targetWidth` px wide, keeping aspect ratio. */
export async function resizeImageBlobToWidth(blob: Blob, targetWidth: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const w = Math.max(1, Math.round(targetWidth));
    const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { mime, quality } = encodeType(blob.type);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error("Could not encode the resized image."))),
        mime,
        quality,
      ),
    );
  } finally {
    bitmap.close?.();
  }
}
