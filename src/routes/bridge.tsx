import { createFileRoute, redirect } from "@tanstack/react-router";

// Hashi's page before it moved to /hashi. Hashi 0.1.0's Download button still opens this address.
export const Route = createFileRoute("/bridge")({
  beforeLoad: () => { throw redirect({ to: "/hashi", replace: true }); },
});
