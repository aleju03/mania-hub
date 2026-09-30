import { createFileRoute, redirect } from "@tanstack/react-router";

// Old URL for Recommendations; kept as a redirect for bookmarks, shared links
// and Discord embeds posted before the rename. Covers the map pages too.
export const Route = createFileRoute("/farm-helper")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: location.href.replace(/^\/farm-helper/, "/recommendations"), replace: true });
  },
});
