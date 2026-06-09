import { createFileRoute } from "@tanstack/react-router";
import { buildPlayerRouteHead } from "../$username";

const TAB = "recent";

export const Route = createFileRoute("/player/$username/recent")({
  head: ({ params, match }) => buildPlayerRouteHead({ username: params.username, origin: match.context.origin, tab: TAB }),
});
