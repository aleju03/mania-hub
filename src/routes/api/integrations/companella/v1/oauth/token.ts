import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// Authorization-code exchange and refresh. The proof travels in its own header
// from here on; a website cookie is never a fallback for either.
export const Route = createFileRoute("/api/integrations/companella/v1/oauth/token")({
  server: {
    handlers: {
      POST: async ({ request }) => forwardNativeRequest(request, "token"),
    },
  },
});
