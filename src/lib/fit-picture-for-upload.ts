/* The picture uploads (theme pictures, frame pictures) take up to 8 MB, and
   every one of them is resized on the server to 2048 px or less. A screenshot
   or a pasted clipboard image often arrives as a huge PNG, so anything over
   the cap is redrawn here at 2048 px and re-encoded (WebP keeps transparency)
   before it is sent. Smaller files go up untouched. */

export const PICTURE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

const SIDES = [2048, 1600, 1200];

export async function fitPictureForUpload<T extends Blob>(file: T, maxBytes = PICTURE_UPLOAD_MAX_BYTES): Promise<T | Blob> {
  if (file.size <= maxBytes || !file.type.startsWith("image/") || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    for (const side of SIDES) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return file;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // a browser without a WebP encoder hands back PNG, which the smaller
      // sides bring under the cap
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.92));
      if (blob && blob.size <= maxBytes) return blob;
    }
    return file;
  } finally {
    bitmap.close();
  }
}
