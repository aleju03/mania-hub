import { createFileRoute } from "@tanstack/react-router";
import { handleCatboxProxyGet, handleCatboxUploadPost } from "#/lib/catbox-upload-server";

// Server-side proxy for catbox.moe uploads used by the BBCode editor. The
// handler logic (auth, same-origin, rate limits, size caps, magic-byte
// checks, SSRF-pinned fetching) lives in src/lib/catbox-upload-server.ts so
// it can be tested with plain Request objects.

export const Route = createFileRoute("/api/catbox-upload")({
  server: {
    handlers: {
      POST: ({ request }) => handleCatboxUploadPost(request),
      GET: ({ request }) => handleCatboxProxyGet(request),
    },
  },
});
