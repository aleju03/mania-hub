import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// A map's Scores board by the md5 of its file.
export const Route = createFileRoute("/api/integrations/companella/v1/charts/$md5/leaderboard")({
  server: {
    handlers: {
      GET: async ({ request, params }) => forwardNativeRequest(request, "chartLeaderboard", { md5: params.md5 }),
    },
  },
});
