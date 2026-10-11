import { createFileRoute, redirect } from "@tanstack/react-router";

// Now a tab of /admin/players.
export const Route = createFileRoute("/admin/about-pages")({
  beforeLoad: () => { throw redirect({ to: "/admin/players", search: { tab: "about" }, replace: true }); },
});
