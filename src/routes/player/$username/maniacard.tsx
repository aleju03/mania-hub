import { createFileRoute } from "@tanstack/react-router";
import { buildPlayerRouteHead } from "../$username";

const TAB = "card";

export const Route = createFileRoute("/player/$username/maniacard")({
  head: ({ params, match }) => buildPlayerRouteHead({ username: params.username, origin: match.context.origin, tab: TAB }),
});
