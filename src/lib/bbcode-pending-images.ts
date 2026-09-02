/**
 * Finding the images the BBCode editor has staged but not uploaded yet.
 *
 * Pasted/dropped images live as local blob: URLs until Copy BBCode, which
 * uploads them and swaps the URLs. Those URLs belong to one tab and one
 * session, so anything that leaves the editor - the clipboard, the saved draft
 * - has to have them resolved or removed first. An image can also be turned
 * into an [imagemap], which carries its source on its own first line rather
 * than inside [img], so both shapes have to be recognised here.
 */

// Blob URLs inherit the page origin. An IPv6 local-dev origin therefore
// contains brackets (`blob:http://[::1]:3000/...`), so stopping at any `[` made
// the editor overlook every image pasted on that host. The lazy non-whitespace
// capture is bounded by the literal closing tag instead.
const PENDING_IMG_PATTERN = /\[img\](blob:\S+?)\[\/img\]/g;
const PENDING_IMAGEMAP_PATTERN = /\[imagemap\]\s*\n\s*(blob:\S+)[\s\S]*?\[\/imagemap\]/g;

/** Every distinct staged blob URL in `value`, in no particular order. */
export function pendingBlobUrls(value: string): string[] {
  return Array.from(new Set([
    ...Array.from(value.matchAll(PENDING_IMG_PATTERN), (match) => match[1]),
    ...Array.from(value.matchAll(PENDING_IMAGEMAP_PATTERN), (match) => match[1]),
  ]));
}

/**
 * Resolves every staged URL before BBCode is allowed to leave the editor.
 *
 * The resolver intentionally has to answer every URL. Silently skipping a
 * missing Blob is indistinguishable from a successful copy until the user
 * pastes the result somewhere else, and stripping that unresolved tag would
 * make the image disappear from the copied page altogether.
 */
export async function resolvePendingBlobUrls(
  value: string,
  resolve: (blobUrl: string) => Promise<string>,
): Promise<string> {
  let resolved = value;
  for (const blobUrl of pendingBlobUrls(value)) {
    const uploadedUrl = await resolve(blobUrl);
    resolved = resolved.split(blobUrl).join(uploadedUrl);
  }
  return resolved;
}

/** Drops the whole tag around every staged blob URL, leaving no dead reference. */
export function stripPendingImages(value: string): string {
  return value.replace(PENDING_IMG_PATTERN, "").replace(PENDING_IMAGEMAP_PATTERN, "");
}
