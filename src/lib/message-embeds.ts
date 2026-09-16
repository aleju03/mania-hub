import { linkify, type LinkifySegment } from "./linkify";

/** Image extensions worth showing inline; anything else stays a link. */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif)$/i;

/**
 * Pull the images out of a message so they can be shown under the words.
 *
 * The rule is the file name, not the host: a report links a screenshot from
 * whatever host the reporter uses that day, and an allow list would answer
 * "why is this one not showing" forever. Only https is embedded, the request
 * carries no referrer (see MessageText), and a link that turns out not to be
 * an image just leaves the anchor it already has.
 */
export function messageImageEmbeds(text: string): string[] {
  const seen = new Set<string>();
  for (const segment of linkify(text)) {
    if (segment.kind !== "link") continue;
    if (!isEmbeddableImage(segment.href)) continue;
    seen.add(segment.href);
  }
  return [...seen];
}

export function isEmbeddableImage(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return IMAGE_EXTENSION.test(url.pathname);
}

export type { LinkifySegment };
