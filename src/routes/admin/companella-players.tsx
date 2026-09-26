import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { canUseAdminFeatures } from "../../lib/auth-shared";

export const Route = createFileRoute("/admin/companella-players")({
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) throw notFound();
    throw redirect({ to: "/admin/companella", search: {}, replace: true });
  },
});
