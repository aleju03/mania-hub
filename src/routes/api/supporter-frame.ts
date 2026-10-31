import { createFileRoute } from "@tanstack/react-router";
import { handleSupporterFrameUpload } from "#/lib/supporter-frame-upload-server";

// The files behind an avatar frame a supporter makes in the workshop. The
// handler (auth, same-origin, rate limit, size cap, sniffing, supporter check,
// conversion and measuring) lives in src/lib/supporter-frame-upload-server.ts
// so it can be tested directly.

export const Route = createFileRoute("/api/supporter-frame")({
  server: {
    handlers: {
      POST: ({ request }) => handleSupporterFrameUpload(request),
    },
  },
});
