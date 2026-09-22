import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// Disconnects the requesting installation. It has no authority over any other
// installation, including others on the same account.
export const Route = createFileRoute("/api/integrations/companella/v1/oauth/revoke")({
  server: {
    handlers: {
      POST: async ({ request }) => forwardNativeRequest(request, "revoke"),
    },
  },
});
