import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LiveBackendRequired } from "../components/LiveDataEmptyState";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { PageTabs } from "../components/layout/PageTabs";
import { CollectorDirectory } from "../components/packs/collections/CollectorDirectory";
import { CollectorShelf } from "../components/packs/collections/CollectorShelf";
import {
  CommunityStatsHeader,
  CommunityStatsSkeleton,
} from "../components/packs/collections/CommunityStatsHeader";
import { RecordBoards, RecordBoardsSkeleton } from "../components/packs/collections/RecordBoards";
import { ShowcaseTab } from "../components/packs/collections/ShowcaseTab";
import {
  fetchLivePackCommunityStats,
  isLiveBackendConfigured,
  type LivePackCommunityStats,
} from "../lib/live-backend";
import { canUseAdminFeatures } from "../lib/auth-shared";
import { pageSeo } from "../lib/seo";
import { useScrollRestoreRef } from "../lib/use-scroll-restore";
import { track } from "../lib/analytics";

/* The community side of /packs: the cards people put up, everybody else's
   shelves, and how the whole card game has gone.
 *
 * Tabs rather than one long scroll, because the three are read for different
 * reasons: the showcase is browsing, the stats are a readout, the collector
 * list is a lookup. `?collector=` overrides all three and opens one shelf,
 * which is what every name on the page links to. */

const TABS = [
  { id: "showcase" as const, label: "Showcase" },
  { id: "stats" as const, label: "Stats" },
  { id: "collectors" as const, label: "Collectors" },
];

type CollectionsTab = (typeof TABS)[number]["id"];

export const Route = createFileRoute("/packs_/collections")({
  /* Admin-gated while the page is still being built out. Same shape the other
     unreleased surfaces use: a 404 rather than a refusal, so an unreleased
     page is indistinguishable from one that does not exist. The nav entry is
     hidden behind the same flag (isLeafVisible in Nav.tsx), and the backend
     reads behind it stay public, since everything they serve was already
     readable one card at a time through the pull ticker. */
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  validateSearch: (search: Record<string, unknown>): { collector?: string; tab?: CollectionsTab } => {
    /* An osu! username or id. Trimmed and length-capped here so the value that
       reaches the backend (which looks it up in two tables) is already the
       shape a name has; anything longer was not a name. */
    const collector = typeof search.collector === "string" ? search.collector.trim().slice(0, 60) : "";
    const tab = TABS.find((item) => item.id === search.tab)?.id;
    return {
      ...(collector ? { collector } : {}),
      // The default tab is not written to the URL, so the plain path stays the
      // link people share.
      ...(tab && tab !== "showcase" ? { tab } : {}),
    };
  },
  head: ({ match }) => {
    const seo = pageSeo({
      title: "Collections",
      description:
        "Show off your maniacards, browse anyone else's collection, and see how the whole card game has gone.",
      path: "/packs/collections",
      origin: match.context.origin,
      imageKind: "packs",
    });
    return { ...seo, meta: [...(seo.meta ?? []), { name: "robots", content: "noindex, nofollow" }] };
  },
  component: CollectionsPage,
});

function CollectionsPage() {
  const { collector, tab } = Route.useSearch();
  const navigate = useNavigate();
  const scrollRestoreRef = useScrollRestoreRef();
  const activeTab: CollectionsTab = tab ?? "showcase";

  if (!isLiveBackendConfigured()) {
    return (
      <div>
        <PageHeader iconSrc="/images/icons/packs.svg" title="Collections" />
        <LiveBackendRequired />
      </div>
    );
  }

  return (
    <div ref={scrollRestoreRef}>
      <PageHeader
        iconSrc="/images/icons/packs.svg"
        title={collector ? `${collector}'s collection` : "Collections"}
      />
      {!collector && (
        <PageTabs
          items={TABS}
          value={activeTab}
          onChange={(next) => navigate({ to: "/packs/collections", search: next === "showcase" ? {} : { tab: next } })}
        />
      )}
      <div className="relative">
        <OsuTriangleBackdrop />
        <div className="relative mx-auto max-w-[1200px] px-4 py-6 sm:px-5">
          {collector ? (
            <CollectorShelf collector={collector} tab={tab} />
          ) : activeTab === "showcase" ? (
            <ShowcaseTab />
          ) : activeTab === "stats" ? (
            <StatsTab />
          ) : (
            <CollectorDirectory />
          )}
        </div>
      </div>
    </div>
  );
}

function StatsTab() {
  const [stats, setStats] = useState<LivePackCommunityStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    track("packs_collections_stats");
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchLivePackCommunityStats()
      .then((next) => {
        if (!cancelled) setStats(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <div className="py-16 text-center text-[12px] text-osu-f1">Could not load the pack stats.</div>;
  }

  /* Skeletons shaped like the panels they become, so the page does not jump
     when the numbers land. The first read after a backend restart rebuilds the
     whole snapshot and can take a few seconds. */
  if (!stats) {
    return (
      <div className="space-y-10">
        <CommunityStatsSkeleton />
        <RecordBoardsSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <CommunityStatsHeader totals={stats.totals} />
      <RecordBoards stats={stats} />
    </div>
  );
}
