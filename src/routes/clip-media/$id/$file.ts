import { createFileRoute } from "@tanstack/react-router";
import { getSharedClipSignedUrl } from "#/lib/r2-cache";
import { lookupSharedClip } from "#/lib/shared-clips";

/* A shared clip's video or poster (lib/shared-clips.ts): checks the clip is
   still within its 24 hours, then redirects to a short-lived signed R2 URL,
   which answers the Range requests a player and Discord's proxy make. */
async function redirectToClipMedia(id: string, file: string, head: boolean): Promise<Response> {
  if (file !== "video" && file !== "poster") return new Response(null, { status: 404 });
  const lookup = await lookupSharedClip(id);
  if (lookup.state !== "ready" || (file === "poster" && !lookup.clip.hasPoster)) {
    return new Response(head ? null : "Clip not found", { status: lookup.state === "expired" ? 410 : 404 });
  }
  const url = await getSharedClipSignedUrl(id, file, lookup.clip.contentType);
  if (!url) return new Response(null, { status: 503 });
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": "public, max-age=60" },
  });
}

export const Route = createFileRoute("/clip-media/$id/$file")({
  server: {
    handlers: {
      HEAD: ({ params }) => redirectToClipMedia(params.id, params.file, true),
      GET: ({ params }) => redirectToClipMedia(params.id, params.file, false),
    },
  },
});
