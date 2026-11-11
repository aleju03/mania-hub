import { createFileRoute } from "@tanstack/react-router";
import { finishAccountDeletion } from "#/lib/account-deletion-server";

// Thin wrapper: the handler lives in src/lib/account-deletion-server.ts, so
// its server-only imports never reach the client bundle.
export const Route = createFileRoute("/api/internal/account-deletion")({
  server: {
    handlers: {
      POST: async ({ request }) => finishAccountDeletion(request),
    },
  },
});
