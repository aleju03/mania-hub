import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AboutPagesPanel } from "../../components/admin/players/AboutPagesPanel";
import { AddPlaysPanel } from "../../components/admin/players/AddPlaysPanel";
import { AddVideoPanel } from "../../components/admin/players/AddVideoPanel";
import { BannedUsersPanel } from "../../components/admin/players/BannedUsersPanel";
import { RemovePlaysPanel } from "../../components/admin/players/RemovePlaysPanel";
import { SupportersPanel } from "../../components/admin/players/SupportersPanel";
import { TakedownsPanel } from "../../components/admin/players/TakedownsPanel";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageTabs } from "../../components/layout/PageTabs";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import type { BannedUsersFilter } from "../../lib/banned-users";
import { useBannedUsersAlert } from "../../lib/banned-users-alert";

/* One admin page for the per-player tools: banned accounts, removing and
 * adding plays, proof videos on plays, restricted players' About pages, supporters, and
 * takedowns players asked for. Each tab is
 * its own panel under components/admin/players/; the old one-tool URLs
 * (/admin/banned-users, /admin/scores, /admin/about-pages, /admin/supporters)
 * redirect here. */

type PlayersTab = "banned" | "remove" | "add" | "video" | "about" | "supporters" | "takedowns";

interface PlayersSearch {
  tab?: Exclude<PlayersTab, "banned">;
  filter?: BannedUsersFilter;
  page?: number;
}

const TAB_IDS: PlayersTab[] = ["banned", "remove", "add", "video", "about", "supporters", "takedowns"];

export const Route = createFileRoute("/admin/players")({
  validateSearch: (search: Record<string, unknown>): PlayersSearch => {
    const tab = TAB_IDS.includes(search.tab as PlayersTab) && search.tab !== "banned" ? search.tab as PlayersSearch["tab"] : undefined;
    const filter = search.filter === "restricted" || search.filter === "all" ? search.filter : undefined;
    const page = Number(search.page);
    return { tab, filter, page: Number.isInteger(page) && page > 1 ? page : undefined };
  },
  head: () => ({
    meta: [
      { title: "Players - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) throw notFound();
    return undefined as never;
  },
  component: PlayersAdminPage,
});

function PlayersAdminPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab: PlayersTab = search.tab ?? "banned";
  const bannedCount = useBannedUsersAlert(true);
  const tabs: { id: PlayersTab; label: ReactNode }[] = [
    {
      id: "banned",
      label: <>Banned users{bannedCount ? <span className="ml-1.5 tabular-nums text-osu-pink">{bannedCount}</span> : null}</>,
    },
    { id: "remove", label: "Remove plays" },
    { id: "add", label: "Add plays" },
    { id: "video", label: "Add video" },
    { id: "about", label: "About pages" },
    { id: "supporters", label: "Supporters" },
    { id: "takedowns", label: "Takedowns" },
  ];

  return (
    <div className="flex-1 bg-osu-b5">
      <PageHeader iconSrc="/images/icons/settings.svg" title="Players" />
      <PageTabs
        items={tabs}
        value={tab}
        onChange={(next) => void navigate({ search: { tab: next === "banned" ? undefined : next } })}
      />
      <div className="max-w-[1000px] mx-auto px-3 sm:px-5 py-4 sm:py-5">
        {tab === "banned" ? (
          <BannedUsersPanel
            filter={search.filter}
            page={search.page}
            onChange={(next) => void navigate({ search: { filter: next.filter, page: next.page }, replace: true })}
          />
        ) : tab === "remove" ? (
          <RemovePlaysPanel />
        ) : tab === "add" ? (
          <AddPlaysPanel />
        ) : tab === "video" ? (
          <AddVideoPanel />
        ) : tab === "about" ? (
          <AboutPagesPanel />
        ) : tab === "takedowns" ? (
          <TakedownsPanel />
        ) : (
          <SupportersPanel />
        )}
      </div>
    </div>
  );
}
