import { createFileRoute, redirect } from "@tanstack/react-router";

// The theme maker's pages before they moved into the workshop (/workshop/themes).
// Shared links to a theme, the gallery or the spec still open these addresses.
export const Route = createFileRoute("/supporter_/themes/$")({
  beforeLoad: ({ location }) => {
    const rest = location.pathname.replace(/^\/supporter\/themes/, "");
    throw redirect({ href: `/workshop/themes${rest}${location.searchStr}`, replace: true });
  },
});
