import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// The one public document in the native API: protocol version, supported
// clients and mods, limits, and where the authorization and token endpoints
// are. No account data, so no credential is required to read it.
export const Route = createFileRoute("/api/integrations/companella/v1/capabilities")({
  server: {
    handlers: {
      GET: async ({ request }) => forwardNativeRequest(request, "capabilities"),
    },
  },
});
