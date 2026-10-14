import { createFileRoute, redirect } from "@tanstack/react-router";

// Now a tab of /admin/players.
export const Route = createFileRoute("/admin/supporters")({
  beforeLoad: () => { throw redirect({ to: "/admin/players", search: { tab: "supporters" }, replace: true }); },
});
