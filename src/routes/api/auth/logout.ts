import { createFileRoute } from "@tanstack/react-router";
import { handleAuthLogoutGet, handleAuthLogoutPost } from "#/lib/auth-logout-server";

// Thin wrapper: handler logic lives in src/lib/auth-logout-server.ts so it is
// testable with plain Request objects. Logout is POST-only and same-origin
// checked; the reasoning is documented there.
export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => handleAuthLogoutPost(request),
      GET: async () => handleAuthLogoutGet(),
    },
  },
});
