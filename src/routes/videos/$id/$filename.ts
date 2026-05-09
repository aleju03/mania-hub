import { createFileRoute } from "@tanstack/react-router";
import { getReplayVideoSignedUrl } from "#/lib/r2-cache";

function redirectToVideo(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "public, max-age=60, s-maxage=300",
    },
  });
}

export const Route = createFileRoute("/videos/$id/$filename")({
  server: {
    handlers: {
      HEAD: async ({ params }) => {
        const url = await getReplayVideoSignedUrl(params.id, params.filename);
        if (!url) return new Response(null, { status: 404 });
        return redirectToVideo(url);
      },
      GET: async ({ params }) => {
        const url = await getReplayVideoSignedUrl(params.id, params.filename);
        if (!url) return new Response("Replay video not found", { status: 404 });
        return redirectToVideo(url);
      },
    },
  },
});
