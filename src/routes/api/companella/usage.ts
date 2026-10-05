import { createFileRoute } from "@tanstack/react-router";

import { handleCompanellaUsageApi } from "#/lib/companella-usage";

// The /companella/usage numbers as JSON, for Companella's developer to pull
// with the usage API key.
export const Route = createFileRoute("/api/companella/usage")({
  server: {
    handlers: {
      GET: async ({ request }) => handleCompanellaUsageApi(request),
    },
  },
});
