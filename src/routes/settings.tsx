import { createFileRoute } from "@tanstack/react-router";

import { SettingsPanel } from "../components/settings/SettingsPanel";
import { isSettingsTabId, type SettingsTabId } from "../components/settings/settings-tabs";

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
