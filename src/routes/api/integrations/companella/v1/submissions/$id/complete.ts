import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// Finalizes the assets and queues validation. A 202 means "accepted for
// processing", never "analyzed".
export const Route = createFileRoute("/api/integrations/companella/v1/submissions/$id/complete")({
  server: {
    handlers: {
      POST: async ({ request, params }) => forwardNativeRequest(request, "submissionComplete", { id: params.id }),
    },
  },
});
