import { createFileRoute } from "@tanstack/react-router";
import { getCanonicalOrigin } from "#/lib/origin";
import { fetchPlayerSitemapEntries, type PlayerSitemapEntry } from "#/lib/player-sitemap";
import { fetchSkinSitemapEntries, type SkinSitemapEntry } from "#/lib/skins";

// Paths that should be crawled and indexed. Keep in sync with robots.txt
// disallow rules: anything disallowed there must not appear here.
const STATIC_PATHS = [
  { path: "/", changefreq: "hourly", priority: "1.0" },
  { path: "/rankings", changefreq: "hourly", priority: "0.9" },
  { path: "/top-plays", changefreq: "hourly", priority: "0.9" },
  { path: "/maps", changefreq: "daily", priority: "0.8" },
  { path: "/replay", changefreq: "weekly", priority: "0.8" },
  { path: "/farm-helper", changefreq: "daily", priority: "0.7" },
  { path: "/skins", changefreq: "daily", priority: "0.7" },
  { path: "/communities", changefreq: "daily", priority: "0.7" },
  { path: "/packs", changefreq: "weekly", priority: "0.6" },
  { path: "/packs/collections", changefreq: "daily", priority: "0.6" },
  { path: "/bbcode", changefreq: "monthly", priority: "0.5" },
  { path: "/dan-estimates", changefreq: "monthly", priority: "0.5" },
] as const;

// A skin slug comes from an uploader-chosen name, so it reaches this file as
// untrusted text even though the generator keeps it tame. Escaping the <loc>
// is what keeps one odd name from invalidating the whole document.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// W3C datetime at date precision. An absent or unparseable stamp drops the
// hint rather than emitting a lastmod a crawler would reject.
function lastmodDate(value: string | null): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

function urlEntry(
  loc: string,
  changefreq: string,
  priority: string,
  lastmod?: string | null,
): string {
  return `  <url>
    <loc>${escapeXml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

export function buildSitemap(
  origin: string,
  skins: SkinSitemapEntry[],
  players: PlayerSitemapEntry[] = [],
): string {
  const urls = [
    ...STATIC_PATHS.map(({ path, changefreq, priority }) =>
      urlEntry(`${origin}${path}`, changefreq, priority)),
    // Every public skin page, also reachable through /skins pagination.
    ...skins.map((skin) =>
      urlEntry(`${origin}${skin.path}`, "monthly", "0.6", lastmodDate(skin.lastmod))),
    // Ranked player profiles. No page links to one in its server HTML (every
    // player list fills in the browser), so without these a crawler only
    // finds a profile by running the page's JavaScript.
    ...players.map((player) =>
      urlEntry(`${origin}${player.path}`, "weekly", "0.5", lastmodDate(player.lastmod))),
  ].join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

// Cloudflare passes the sitemap through uncached (cf-cache-status DYNAMIC),
// and every build spends the backend rate bucket this server's SSR reads share,
// so each instance builds it once an hour. A build whose player list failed is
// retried after a few minutes instead.
const SITEMAP_TTL_MS = 60 * 60_000;
const SITEMAP_RETRY_TTL_MS = 5 * 60_000;
const sitemapCache = new Map<string, { xml: string; expiresAt: number }>();
const sitemapInflight = new Map<string, Promise<string>>();

function getSitemapXml(origin: string): Promise<string> {
  const cached = sitemapCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.xml);
  const pending = sitemapInflight.get(origin);
  if (pending) return pending;
  const build = (async () => {
    let playersFailed = false;
    // An unreachable backend serves the static paths alone: a short sitemap
    // beats a 500.
    const [skins, players] = await Promise.all([
      fetchSkinSitemapEntries().catch(() => []),
      fetchPlayerSitemapEntries().catch(() => {
        playersFailed = true;
        return [];
      }),
    ]);
    const xml = buildSitemap(origin, skins, players);
    sitemapCache.set(origin, {
      xml,
      expiresAt: Date.now() + (playersFailed ? SITEMAP_RETRY_TTL_MS : SITEMAP_TTL_MS),
    });
    return xml;
  })().finally(() => sitemapInflight.delete(origin));
  sitemapInflight.set(origin, build);
  return build;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const xml = await getSitemapXml(getCanonicalOrigin(request));
        return new Response(xml, {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control":
              "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          },
        });
      },
    },
  },
});
