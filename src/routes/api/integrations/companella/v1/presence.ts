import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// Live presence: PUT what the player is doing in osu!, DELETE when they stop.
export const Route = createFileRoute("/api/integrations/companella/v1/presence")({
  server: {
    handlers: {
      PUT: async ({ request }) => forwardNativeRequest(request, "presence"),
      DELETE: async ({ request }) => forwardNativeRequest(request, "presence"),
    },
  },
});
