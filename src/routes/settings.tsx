import { createFileRoute } from "@tanstack/react-router";

import { SettingsPanel } from "../components/settings/SettingsPanel";
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
  component: SettingsPage,
});

function SettingsPage() {
  return <SettingsPanel variant="page" />;
}
