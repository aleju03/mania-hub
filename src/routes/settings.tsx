import { createFileRoute } from "@tanstack/react-router";

import { SettingsPanel } from "../components/settings/SettingsPanel";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  return <SettingsPanel variant="page" />;
}
