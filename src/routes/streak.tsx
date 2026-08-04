import { createFileRoute, redirect } from "@tanstack/react-router";

/* The higher-or-lower game used to live here, and links to it are out in the
   world. It plays inside /packs now (the pull ticker, the charges and the
   shard count are half of why it belongs there), so this route only forwards
   to it. */
export const Route = createFileRoute("/streak")({
  beforeLoad: () => {
    throw redirect({ to: "/packs", search: { view: "streak" }, replace: true });
  },
});
