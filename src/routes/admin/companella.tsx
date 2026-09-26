import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback } from "react";

import { CompanellaFlagsPanel } from "../../components/admin/companella/CompanellaFlagsPanel";
import { CompanellaPlayersPanel } from "../../components/admin/companella/CompanellaPlayersPanel";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageTabs } from "../../components/layout/PageTabs";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import type { RateFlagFilter } from "../../lib/companella-rate-flags";

interface CompanellaAdminSearch {
  tab?: "flags";
  filter?: "blocked";
  q?: string;
  user?: number;
  page?: number;
  flag?: RateFlagFilter;
  flagPage?: number;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export const Route = createFileRoute("/admin/companella")({
  validateSearch: (search: Record<string, unknown>): CompanellaAdminSearch => ({
    tab: search.tab === "flags" ? "flags" : undefined,
    filter: search.filter === "blocked" ? "blocked" : undefined,
    q: typeof search.q === "string" ? search.q.trim().slice(0, 40) || undefined : undefined,
    user: positiveInteger(search.user),
    page: positiveInteger(search.page),
    flag: search.flag === "all" || search.flag === "unreadable" ? search.flag : undefined,
    flagPage: positiveInteger(search.flagPage),
  }),
  head: () => ({
    meta: [
      { title: "Companella - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) throw notFound();
    return undefined as never;
  },
  component: CompanellaAdminPage,
});

const TABS = [
  { id: "players", label: "Players" },
  { id: "flags", label: "Flagged plays" },
];

function CompanellaAdminPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab = search.tab ?? "players";
  const changeQuery = useCallback((q: string) => {
    void navigate({ search: (previous) => ({ ...previous, q: q || undefined, user: undefined, page: undefined }), replace: true });
  }, [navigate]);

  return (
    <div className="flex-1 bg-osu-b5">
      <PageHeader iconSrc="/images/icons/settings.svg" title="Companella" />
      <PageTabs
        items={TABS}
        value={tab}
        onChange={(next) => void navigate({ search: (previous) => ({ ...previous, tab: next === "flags" ? "flags" : undefined }) })}
      />
      <div className="max-w-[1200px] mx-auto px-3 sm:px-5 py-4 sm:py-5">
        {tab === "flags" ? (
          <CompanellaFlagsPanel
            filter={search.flag ?? "mismatch"}
            page={(search.flagPage ?? 1) - 1}
            onFilterChange={(flag) => void navigate({ search: (previous) => ({ ...previous, flag: flag === "mismatch" ? undefined : flag, flagPage: undefined }), replace: true })}
            onPageChange={(page) => void navigate({ search: (previous) => ({ ...previous, flagPage: page > 0 ? page + 1 : undefined }), replace: true })}
          />
        ) : (
          <CompanellaPlayersPanel
            filter={search.filter ?? "recent"}
            query={search.q ?? ""}
            page={(search.page ?? 1) - 1}
            userId={search.user}
            onQueryChange={changeQuery}
            onFilterChange={(filter) => void navigate({ search: (previous) => ({ ...previous, filter: filter === "blocked" ? "blocked" : undefined, user: undefined, page: undefined }), replace: true })}
            onPageChange={(page) => void navigate({ search: (previous) => ({ ...previous, page: page > 0 ? page + 1 : undefined, user: undefined }), replace: true })}
          />
        )}
      </div>
    </div>
  );
}
