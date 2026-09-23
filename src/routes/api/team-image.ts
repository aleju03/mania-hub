import { createFileRoute } from "@tanstack/react-router";
import { teamImages, TeamImageBusyError } from "../../lib/team-image-server";
import { TEAM_IMAGE_PATH_PATTERN } from "../../lib/team-image";

/* osu! team flags and headers for canvas callers (the team maniacard), which
   need CORS headers assets.ppy.sh does not send; same reason /api/avatar
   exists. Only osu!'s own content-hashed team paths pass, so a URL names one
   immutable image and the CDN can hold it for good. */
const IMAGE_CACHE_HEADER = "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable";
export const Route = createFileRoute("/api/team-image")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const path = new URL(request.url).searchParams.get("path") ?? "";
        if (!TEAM_IMAGE_PATH_PATTERN.test(path)) return new Response("invalid team image path", { status: 400 });
        try {
          const entry = await teamImages.get(path);
          return new Response(entry.buffer as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": entry.contentType,
              "Content-Length": String(entry.buffer.length),
              "Cache-Control": IMAGE_CACHE_HEADER,
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (err) {
          if (err instanceof TeamImageBusyError) return new Response(err.message, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
          return new Response(err instanceof Error ? err.message : "team image proxy failed", { status: 502 });
        }
      },
    },
  },
});
