import { createFileRoute } from "@tanstack/react-router";

import { MANIA_BRIDGE_VERSION } from "../lib/mania-bridge";

// The Mania Bridge update check. Answered directly with no redirect, since the app's client does not follow
// them, and kept short-lived so a bumped version reaches it on its next check.
export const Route = createFileRoute("/bridge_/latest.json")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify({ version: MANIA_BRIDGE_VERSION }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        }),
    },
  },
});
