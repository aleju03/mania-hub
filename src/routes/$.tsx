import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { salvageMangledPath } from "#/lib/mangled-link";

/* Catch-all for paths no other route claimed. Most of them are genuine 404s
   and fall through to the root's not-found page; a steady minority are a live
   route wearing chat-client junk ("/packs@Rush_FTK" and its many cousins),
   and those we can just forward instead of dead-ending. */
export const Route = createFileRoute("/$")({
  beforeLoad: ({ location }) => {
    const target = salvageMangledPath(location.pathname);
    if (target) throw redirect({ href: target, replace: true });
    throw notFound();
  },
});
