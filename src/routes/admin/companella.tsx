import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { canUseAdminFeatures } from "../../lib/auth-shared";

export const Route = createFileRoute("/admin/companella")({
  beforeLoad: ({ context, search }) => {
    if (!canUseAdminFeatures(context.auth)) throw notFound();
    throw redirect({ to: "/admin/bridgers", search, replace: true });
  },
});
