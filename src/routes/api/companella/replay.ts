import { createFileRoute } from "@tanstack/react-router";

import { readOwnedReplay } from "#/lib/companella-integration/manage-server";

// The owner's own imported replay. Authorization runs before any byte moves,
// and a score belonging to somebody else answers 404 rather than 403 - a
// distinct status would confirm that the score exists.
export const Route = createFileRoute("/api/companella/replay")({
  server: {
    handlers: {
      GET: async ({ request }) => readOwnedReplay(request, new URL(request.url).searchParams.get("scoreId") ?? ""),
    },
  },
});
