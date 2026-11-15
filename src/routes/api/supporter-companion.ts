import { createFileRoute } from "@tanstack/react-router";
import { handleSupporterCompanionUpload } from "#/lib/supporter-companion-upload-server";

// The file behind a companion a supporter submits. The handler (auth,
// same-origin, rate limit, size cap, model check, supporter check,
// conversion) lives in src/lib/supporter-companion-upload-server.ts so it can
// be tested directly.

export const Route = createFileRoute("/api/supporter-companion")({
  server: {
    handlers: {
      POST: ({ request }) => handleSupporterCompanionUpload(request),
    },
  },
});
