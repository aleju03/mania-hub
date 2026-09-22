import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// Who this installation is connected as, from the server's point of view.
export const Route = createFileRoute("/api/integrations/companella/v1/me")({
  server: {
    handlers: {
      GET: async ({ request }) => forwardNativeRequest(request, "me"),
    },
  },
});
