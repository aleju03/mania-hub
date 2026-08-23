export interface OgPagePreviewMetadata {
  pageUrl: string;
  imageUrl: string;
  title: string;
  description: string;
  imageWidth: number | null;
  imageHeight: number | null;
}

const SITE_HOSTS = new Set([
  "mania-tracker.com",
  "www.mania-tracker.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/** Turns a local, production, or relative Mania Hub URL into the same route on
 * the current dev origin. Fetching only the current origin avoids CORS while
 * making the preview reflect the code that is actually being worked on. */
export function sitePreviewRequestUrl(rawUrl: string, currentOrigin: string): URL | null {
  const value = rawUrl.trim();
  if (!value || (!value.startsWith("/") && !/^https?:\/\//i.test(value))) return null;

  let current: URL;
  let source: URL;
  try {
    current = new URL(currentOrigin);
    source = new URL(value, current);
  } catch {
    return null;
  }

  const sourceHost = source.hostname.toLowerCase();
  if (source.origin !== current.origin && !SITE_HOSTS.has(sourceHost)) return null;
  return new URL(`${source.pathname}${source.search}`, current);
}

function metaContent(document: Document, property: string, name?: string): string {
  return document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`)?.content.trim()
    || (name ? document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim() : "")
    || "";
}

function positiveDimension(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseOgPagePreview(html: string, fetchedPageUrl: string): OgPagePreviewMetadata | null {
  const document = new DOMParser().parseFromString(html, "text/html");
  const rawImage = metaContent(document, "og:image", "twitter:image");
  if (!rawImage) return null;

  let imageUrl: string;
  let pageUrl = fetchedPageUrl;
  try {
    imageUrl = new URL(rawImage, fetchedPageUrl).toString();
  } catch {
    return null;
  }
  const rawPageUrl = metaContent(document, "og:url");
  if (rawPageUrl) {
    try {
      pageUrl = new URL(rawPageUrl, fetchedPageUrl).toString();
    } catch {
      // A malformed og:url should not hide an otherwise valid social card.
    }
  }

  return {
    pageUrl,
    imageUrl,
    title: metaContent(document, "og:title", "twitter:title") || document.title.trim(),
    description: metaContent(document, "og:description", "twitter:description"),
    imageWidth: positiveDimension(metaContent(document, "og:image:width")),
    imageHeight: positiveDimension(metaContent(document, "og:image:height")),
  };
}

export function cacheBustOgPreviewImage(imageUrl: string, currentOrigin: string, token: number): string {
  try {
    const current = new URL(currentOrigin);
    const image = new URL(imageUrl, current);
    image.searchParams.set("t", String(token));
    return image.origin === current.origin
      ? `${image.pathname}${image.search}`
      : image.toString();
  } catch {
    return imageUrl;
  }
}
