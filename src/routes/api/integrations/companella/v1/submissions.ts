import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// Reserve (or re-read) one idempotent submission. The manifest is metadata
// only; the files follow on their own endpoints.
export const Route = createFileRoute("/api/integrations/companella/v1/submissions")({
  server: {
    handlers: {
      POST: async ({ request }) => forwardNativeRequest(request, "submissions"),
    },
  },
});
