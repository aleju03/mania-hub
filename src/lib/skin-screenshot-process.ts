import { SKIN_SCREENSHOT_MAX_BYTES } from "./skins";

// Screenshots are normalised in the browser before upload: decoded, capped at
// 1920px wide, and re-encoded as WebP (PNG where the browser cannot), so the
// backend only ever stores predictable images. Shared between the single
// upload form and the bulk uploader's per-file editor.

export interface ProcessedScreenshot {
  blob: Blob;
  width: number;
  height: number;
  url: string;
}

export async function processScreenshot(file: File): Promise<ProcessedScreenshot | null> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await decodeImage(sourceUrl);
    const scale = Math.min(1, 1920 / Math.max(1, image.naturalWidth));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((webp) => {
        if (webp && webp.type === "image/webp") resolve(webp);
        else canvas.toBlob((png) => resolve(png), "image/png");
      }, "image/webp", 0.85);
    });
    if (!blob || blob.size > SKIN_SCREENSHOT_MAX_BYTES) return null;
    return { blob, width, height, url: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image."));
    image.src = src;
  });
}
