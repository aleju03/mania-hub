import { createFileRoute } from "@tanstack/react-router";
import { SITE_URL } from "#/lib/seo";

// Paths that should be crawled & indexed. Keep in sync with robots.txt
// disallow rules — anything disallowed there must not appear here.
const STATIC_PATHS = [
  { path: "/", changefreq: "hourly", priority: "1.0" },
  { path: "/rankings", changefreq: "hourly", priority: "0.9" },
  { path: "/top-plays", changefreq: "hourly", priority: "0.9" },
  { path: "/maps", changefreq: "daily", priority: "0.8" },
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

export const Route = createFileRoute("/api/sitemap")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = SITE_URL || `${url.protocol}//${url.host}`;
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
