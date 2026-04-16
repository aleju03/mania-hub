import { createFileRoute } from "@tanstack/react-router";

// osu!'s public CDN hosts a per-beatmapset cover generated from the default
// difficulty's background. We 302 there so the image bytes never transit
// Vercel Fast Origin Transfer. For multi-background sets this may not be
// pixel-identical to the .osu's referenced file, but it is always a visually
// faithful representation suitable for the replay viewer's atmosphere.
const OSU_COVER_BASE = "https://assets.ppy.sh/beatmaps";

export const Route = createFileRoute("/api/background")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const beatmapsetId = url.searchParams.get("beatmapsetId");

        if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
          return new Response("Invalid beatmapsetId", { status: 400 });
        }

        const target = `${OSU_COVER_BASE}/${beatmapsetId}/covers/cover@2x.jpg`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: target,
            // Cache the redirect itself for a long time so repeat navigations
            // don't even hit the function.
            "Cache-Control":
              "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
          },
        });
      },
    },
  },
});
