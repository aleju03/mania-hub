import { createFileRoute } from "@tanstack/react-router";
import { buildPlayerRouteHead } from "../$username";

const TAB = "about";

export const Route = createFileRoute("/player/$username/about")({
  head: ({ params, match }) => buildPlayerRouteHead({ username: params.username, origin: match.context.origin, tab: TAB }),
});
