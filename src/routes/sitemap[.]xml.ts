import { createFileRoute } from "@tanstack/react-router";
import { getCanonicalOrigin } from "#/lib/origin";

// Paths that should be crawled and indexed. Keep in sync with robots.txt
// disallow rules: anything disallowed there must not appear here.
const STATIC_PATHS = [
  { path: "/", changefreq: "hourly", priority: "1.0" },
  { path: "/rankings", changefreq: "hourly", priority: "0.9" },
  { path: "/top-plays", changefreq: "hourly", priority: "0.9" },
  { path: "/maps", changefreq: "daily", priority: "0.8" },
  { path: "/replay", changefreq: "weekly", priority: "0.8" },
  { path: "/farm-helper", changefreq: "daily", priority: "0.7" },
  { path: "/packs", changefreq: "weekly", priority: "0.6" },
  { path: "/bbcode", changefreq: "monthly", priority: "0.5" },
] as const;

function buildSitemap(origin: string): string {
  const lastmod = new Date().toISOString().split("T")[0];
  const urls = STATIC_PATHS.map(({ path, changefreq, priority }) => {
    return `  <url>
    <loc>${origin}${path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = getCanonicalOrigin(request);
        const xml = buildSitemap(origin);
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
