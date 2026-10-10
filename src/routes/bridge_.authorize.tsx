import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateAuthorizeSearch } from "../components/companella/AuthorizePage";

// The consent page before it moved to /hashi/authorize, kept for a backend that still advertises this address.
export const Route = createFileRoute("/bridge_/authorize")({
  validateSearch: validateAuthorizeSearch,
  beforeLoad: ({ search }) => { throw redirect({ to: "/hashi/authorize", search, replace: true }); },
});
