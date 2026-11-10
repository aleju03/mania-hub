import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// A bug report from the native client with its log attached. Auth is optional:
// with a DPoP token and proof the report belongs to that account.
export const Route = createFileRoute("/api/integrations/companella/v1/bug-reports")({
  server: {
    handlers: {
      POST: async ({ request }) => forwardNativeRequest(request, "bugReports"),
    },
  },
});
