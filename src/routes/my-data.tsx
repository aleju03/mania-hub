import { createFileRoute, redirect } from "@tanstack/react-router";

// Old URL for the My Stats page; kept as a redirect for bookmarks and stale links.
export const Route = createFileRoute("/my-data")({
  beforeLoad: () => {
    throw redirect({ to: "/my-stats", replace: true });
  },
});
