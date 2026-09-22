import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// The durable receipt. A foreign id answers exactly like a missing one.
export const Route = createFileRoute("/api/integrations/companella/v1/submissions/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => forwardNativeRequest(request, "submissionRead", { id: params.id }),
    },
  },
});
