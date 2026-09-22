import { createFileRoute } from "@tanstack/react-router";

import { readOwnedChart } from "#/lib/companella-integration/manage-server";

// The exact .osu behind one of the owner's imported scores, so the replay
// viewer can draw the chart that was actually played.
export const Route = createFileRoute("/api/companella/chart")({
  server: {
    handlers: {
      GET: async ({ request }) => readOwnedChart(request, new URL(request.url).searchParams.get("scoreId") ?? ""),
    },
  },
});
