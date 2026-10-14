import { createFileRoute, redirect } from "@tanstack/react-router";

// Now a tab of /admin/players.
export const Route = createFileRoute("/admin/scores")({
  beforeLoad: () => { throw redirect({ to: "/admin/players", search: { tab: "remove" }, replace: true }); },
});
