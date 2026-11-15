import { createFileRoute } from "@tanstack/react-router";
import { handleSupporterMotifUpload } from "#/lib/supporter-motif-upload-server";

// A supporter's own card motif image. The handler (auth, same-origin, rate
// limit, size cap, supporter check, conversion) lives in
// src/lib/supporter-motif-upload-server.ts so it can be tested directly.

export const Route = createFileRoute("/api/supporter-motif")({
  server: {
    handlers: {
      POST: ({ request }) => handleSupporterMotifUpload(request),
    },
  },
});
