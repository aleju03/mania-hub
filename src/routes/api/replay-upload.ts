import { createFileRoute } from "@tanstack/react-router";
import { handleReplayUploadGet, handleReplayUploadPost } from "#/lib/replay-upload-server";

// Thin wrapper: handler logic lives in src/lib/replay-upload-server.ts so it
// is testable with plain Request objects. Hardening (auth, rate limits, size
// caps, mania-replay validation) is documented there and in
// findings/README.md Phase 9.
export const Route = createFileRoute("/api/replay-upload")({
  server: {
    handlers: {
      POST: async ({ request }) => handleReplayUploadPost(request),
      GET: async ({ request }) => handleReplayUploadGet(request),
    },
  },
});
