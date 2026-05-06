import { createFileRoute, notFound } from "@tanstack/react-router";

import { SettingsPanel } from "../components/settings/SettingsPanel";
import { canUseDevFeatures } from "../lib/auth-shared";
import { pageSeo } from "../lib/seo";

export const Route = createFileRoute("/settings")({
  head: ({ match }) =>
    pageSeo({
      title: "Settings",
      description: "Manage app and replay preferences.",
      path: "/settings",
      origin: match.context.origin,
      noindex: true,
    }),
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: SettingsPage,
});

function SettingsPage() {
  return <SettingsPanel variant="page" />;
}
