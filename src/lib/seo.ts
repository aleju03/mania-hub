export const SITE_NAME = "o!mania tracker";

export const DEFAULT_DESCRIPTION =
  "osu!mania rankings, score feeds, top plays, maps, profiles, and replays by country.";

const DEFAULT_OG_SUBTITLE = "Rankings, scores, top plays, maps, and replays by country.";

export function ogImagePath(title = SITE_NAME, subtitle = DEFAULT_OG_SUBTITLE): string {
  const params = new URLSearchParams({ title, subtitle });
  return `/api/og?${params.toString()}`;
}

export const DEFAULT_OG_IMAGE_PATH = ogImagePath();

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
  const imageUrl = absoluteUrl(image ?? ogImagePath(title, description), origin);

  const meta: MetaEntry[] = [
    { title: fullTitle },
    { name: "description", content: description },
    { property: "og:type", content: type },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:title", content: fullTitle },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: imageUrl },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: title },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: fullTitle },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: imageUrl },
  ];

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
