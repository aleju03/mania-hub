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

const PENDING_IMG_PATTERN = /\[img\](blob:[^\[\]]+)\[\/img\]/g;
const PENDING_IMAGEMAP_PATTERN = /\[imagemap\]\s*\n\s*(blob:\S+)[\s\S]*?\[\/imagemap\]/g;

/** Every distinct staged blob URL in `value`, in no particular order. */
export function pendingBlobUrls(value: string): string[] {
  return Array.from(new Set([
    ...Array.from(value.matchAll(PENDING_IMG_PATTERN), (match) => match[1]),
    ...Array.from(value.matchAll(PENDING_IMAGEMAP_PATTERN), (match) => match[1]),
  ]));
}

/** Drops the whole tag around every staged blob URL, leaving no dead reference. */
export function stripPendingImages(value: string): string {
  return value.replace(PENDING_IMG_PATTERN, "").replace(PENDING_IMAGEMAP_PATTERN, "");
}
