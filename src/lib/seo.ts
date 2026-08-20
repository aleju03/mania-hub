export const SITE_NAME = "Mania Tracker";
// 256px repack of images/discord/bot-favicon.png (the 1024px original is
// 372KB and shipped on every page as the tab icon).
export const SITE_FAVICON_URL = "/images/favicon-256.png";
export const SITE_FAVICON_VERSION = "6";
export const SITE_FAVICON_HREF = `${SITE_FAVICON_URL}?v=${SITE_FAVICON_VERSION}`;

export const DEFAULT_DESCRIPTION =
  "See what's happening in osu!mania with live scores, country rankings, top plays, map stats, player profiles, and replays.";

// 43: the replay card shows a stable play's accuracy on the stable scale,
// matching the replay page instead of osu!'s lazer-weighted field.
export const OG_IMAGE_VERSION = "43";

/* Builds the og:image URL. The image itself only needs title + country —
   the description stays in the HTML `<meta>` for social-card body text
   but we don't bake it into the image to avoid duplicating the same
   sentence both inside the graphic and below it in the embed. */
export function ogImagePath(
  title = SITE_NAME,
  options?: { country?: string | null; kind?: string | null },
): string {
  const params = new URLSearchParams({ v: OG_IMAGE_VERSION });
  // The title only appears in the rendered card on the country-scoreboard
  // fallback (country, no kind). Everywhere else it was dead weight in the
  // URL that forked one CDN cache entry per page title for the same image.
  if (options?.country && !options?.kind) {
    params.set("title", title);
  }
  if (options?.country) {
    params.set("country", options.country);
  }
  if (options?.kind) {
    params.set("kind", options.kind);
  }
  return `/api/og?${params.toString()}`;
}

/* Player OG uses a different render path: the endpoint fetches the user
   from the osu! API and composes a profile-card image (avatar, rank, PP,
   country). The `username` arrives raw so the endpoint can re-lookup it
   the same way the osu! API does (case-insensitive). */
/* The only title the site itself ever sends to the country-scoreboard OG card:
   every other country-scoped page passes a `kind` instead, and ogImagePath
   drops the title when it does. /api/og renders a title it does not recognise
   as the untitled country card and keys it as such, because the title is part
   of the R2 key and a caller-chosen one is a caller-chosen key. Change this and
   the card follows; invent a new titled country page and teach both sides. */
export function countryTopPlaysTitle(countryName: string): string {
  return `Top mania plays in ${countryName}`;
}

export function playerOgImagePath(username: string): string {
  const params = new URLSearchParams({
    kind: "player",
    username,
    v: OG_IMAGE_VERSION,
  });
  return `/api/og?${params.toString()}`;
}

function kindOgImagePath(kind: string, extra: Record<string, string | undefined>): string {
  const params = new URLSearchParams({ kind, v: OG_IMAGE_VERSION });
  for (const [k, val] of Object.entries(extra)) {
    if (val != null && val !== "") params.set(k, val);
  }
  return `/api/og?${params.toString()}`;
}

export function mapsOgImagePath(country: string): string {
  return kindOgImagePath("maps", { country });
}

export function replayOgImagePath(scoreId: number): string {
  return kindOgImagePath("replay", { scoreId: String(scoreId) });
}

/* Pull permalink OG: the pulled maniacard rendered at its minted tier with a
   "pulled by" footer. 720x1080 portrait, like the maniacard OG. */
export function pullOgImagePath(ownerId: number, cardKey: string | number): string {
  return kindOgImagePath("pull", { owner: String(ownerId), card: String(cardKey) });
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
  /* Pixel size of a custom `image`. The generated /api/og cards are always
     1200x630, so only pages passing their own image need these; declaring the
     wrong ratio makes scrapers crop or letterbox the embed. */
  imageWidth?: number | null;
  imageHeight?: number | null;
  imageCountry?: string;
  imageKind?: string;
  type?: "website" | "article" | "profile";
  social?: boolean;
  noindex?: boolean;
  appendSiteName?: boolean;
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
  imageWidth,
  imageHeight,
  imageCountry,
  imageKind,
  type = "website",
  social = true,
  noindex = false,
  appendSiteName = true,
}: PageSeoInput): PageSeo {
  const fullTitle = title === SITE_NAME || !appendSiteName ? title : `${title} - ${SITE_NAME}`;
  const url = absoluteUrl(path, origin);
  const imageUrl = absoluteUrl(
    image ?? ogImagePath(title, { country: imageCountry, kind: imageKind }),
    origin,
  );
  // A custom image of unknown size gets no dimension hints at all; that reads
  // better to a scraper than the generated card's 1200x630 asserted over it.
  const size = image
    ? (imageWidth && imageHeight ? { width: imageWidth, height: imageHeight } : null)
    : { width: 1200, height: 630 };

  const meta: MetaEntry[] = [
    { title: fullTitle },
    { name: "description", content: description },
  ];

  if (social) {
    meta.push(
      { property: "og:type", content: type },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:title", content: fullTitle },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:image", content: imageUrl },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: fullTitle },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: imageUrl },
    );
    if (size) {
      meta.push(
        { property: "og:image:width", content: String(size.width) },
        { property: "og:image:height", content: String(size.height) },
      );
    }
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
