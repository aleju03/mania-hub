export const SITE_NAME = "o!mania tracker";

export const DEFAULT_DESCRIPTION =
  "Track osu!mania rankings, live scores, top plays, and replays by country. Country leaderboards, recent popoffs, player profiles, and a replay viewer for the osu!mania community.";

export const DEFAULT_OG_IMAGE_PATH = "/api/og";

export type MetaEntry =
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

export type LinkEntry = { rel: string; href: string };

export function absoluteUrl(path: string, origin: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = origin.replace(/\/+$/, "");
  return base ? `${base}${normalized}` : normalized;
}

export interface PageSeoInput {
  title: string;
  description?: string;
  path: string;
  origin: string;
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
  origin,
  image,
  type = "website",
  noindex = false,
}: PageSeoInput): PageSeo {
  const fullTitle = title === SITE_NAME ? SITE_NAME : `${title} - ${SITE_NAME}`;
  const url = absoluteUrl(path, origin);
  const imageUrl = image ? absoluteUrl(image, origin) : undefined;

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

  const links: LinkEntry[] = [];
  if (!noindex) {
    links.push({ rel: "canonical", href: url });
  }

  return { meta, links };
}

/* Sitewide WebSite schema with SearchAction. The SearchAction unlocks the
   sitelinks search box in Google results: users can type a username and
   Google deep-links them straight to the player page. Returns undefined
   when no origin is available (target URL must be absolute). */
export function websiteJsonLd(origin: string): Record<string, unknown> | undefined {
  if (!origin) return undefined;
  const base = origin.replace(/\/+$/, "");
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: `${base}/`,
    description: DEFAULT_DESCRIPTION,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${base}/player/{search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}
