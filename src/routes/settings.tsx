import { createFileRoute } from "@tanstack/react-router";

import { SettingsPanel, isSettingsTabId, type SettingsTabId } from "../components/settings/SettingsPanel";

export const Route = createFileRoute("/settings")({
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTabId } => ({
    tab: isSettingsTabId(search.tab) ? search.tab : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Settings" },
      { name: "description", content: "" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { tab } = Route.useSearch();
  return <SettingsPanel variant="page" initialTab={tab} />;
}
