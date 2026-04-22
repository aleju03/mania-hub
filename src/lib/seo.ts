// Shared SEO helpers. Used by route `head` exports to produce consistent
// meta tags for search engines and social scrapers (OpenGraph, Twitter).
//
// Set `VITE_SITE_URL` in .env (e.g. "https://mania-hub.vercel.app") so
// canonical/og:url tags emit absolute URLs. Without it, those tags fall back
// to relative paths — Google accepts that, but most social scrapers require
// absolute URLs for og:image preview cards.

export const SITE_NAME = "o!mania tracker";

export const SITE_URL: string = (
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SITE_URL ?? "").replace(/\/+$/, "")
);

export const DEFAULT_DESCRIPTION =
  "Track osu!mania rankings, live scores, top plays, and replays by country. Country leaderboards, recent popoffs, player profiles, and a replay viewer for the osu!mania community.";

export const DEFAULT_OG_IMAGE_PATH = "/api/og";

export type MetaEntry =
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

export type LinkEntry = { rel: string; href: string };

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return SITE_URL ? `${SITE_URL}${normalized}` : normalized;
}

export interface PageSeoInput {
  title: string;
  description?: string;
  path: string;
  image?: string;
  type?: "website" | "article" | "profile";
  noindex?: boolean;
}

export interface PageSeo {
  meta: MetaEntry[];
  links: LinkEntry[];
}

export function pageSeo({
  title,
  description = DEFAULT_DESCRIPTION,
  path,
  image,
  type = "website",
  noindex = false,
}: PageSeoInput): PageSeo {
  const fullTitle = title === SITE_NAME ? SITE_NAME : `${title} · ${SITE_NAME}`;
  const url = absoluteUrl(path);
  const imageUrl = image ? absoluteUrl(image) : undefined;

  const meta: MetaEntry[] = [
    { title: fullTitle },
    { name: "description", content: description },
    { property: "og:type", content: type },
    { property: "og:title", content: fullTitle },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { name: "twitter:title", content: fullTitle },
    { name: "twitter:description", content: description },
  ];

  if (imageUrl) {
    meta.push(
      { property: "og:image", content: imageUrl },
      { name: "twitter:image", content: imageUrl },
    );
  }

  if (noindex) {
    meta.push({ name: "robots", content: "noindex, nofollow" });
  }

  return {
    meta,
    links: [{ rel: "canonical", href: url }],
  };
}
