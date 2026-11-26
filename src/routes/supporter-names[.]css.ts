import { createFileRoute } from "@tanstack/react-router";
import { css, version } from "virtual:supporter-names-css";
import { ORIGIN_PLACEHOLDER } from "../../scripts/supporter-names-css";
import { getCanonicalOrigin } from "../lib/origin";

// Supporter name styles and fonts for names in lists, for apps that draw them
// outside the site (Hashi). Cut from styles.css at build time
// (scripts/supporter-names-css.ts), so it changes with every deploy that
// changes a style; the ETag is its content hash. Font URLs are absolute, and
// the fonts allow any origin (routeRules in vite.config.ts).
export const Route = createFileRoute("/supporter-names.css")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const etag = `"${version}"`;
        const headers = {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
          "Access-Control-Allow-Origin": "*",
          ETag: etag,
        };
        if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
        return new Response(css.replaceAll(ORIGIN_PLACEHOLDER, getCanonicalOrigin(request)), { headers });
      },
    },
  },
});
