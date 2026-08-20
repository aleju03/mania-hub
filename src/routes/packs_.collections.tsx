import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useEffect, useState } from "react";
import { LiveBackendRequired } from "../components/LiveDataEmptyState";
import { PageHeader } from "../components/layout/PageHeader";
import { PageTabs } from "../components/layout/PageTabs";
import { CollectionsBackdrop } from "../components/packs/collections/CollectionsBackdrop";
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
  fetchLivePackRecentPulls,
  isLiveBackendConfigured,
  openLiveEventSource,
  type LivePackCommunityStats,
  type LivePackPullFeedEntry,
} from "../lib/live-backend";
import { canUseAdminFeatures } from "../lib/auth-shared";
import { parsePackShowcaseSlots, readPackShowcaseSlotsClient } from "../lib/pack-showcase-slots";
import { DEFAULT_COUNTRY_CODE } from "../lib/country";
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

/* How many cards to hold space for on the viewer's own shelf while it loads.
   Resolved here rather than inside the component because the frame that needs
   it is the server-rendered one: the shelf is read browser-direct after mount,
   and until then the row is either card-height or nothing, so the server has
   to be told which. The browser writes the cookie; see lib/pack-showcase-slots.

   Isomorphic rather than a server function: both sides are reading the same
   cookie off whatever they have (a request header, document.cookie), so this
   needs no round trip and no RPC endpoint standing open for a value the caller
   sent us in the first place. The plugin drops the server half from the
   browser bundle, which is what keeps getRequest out of it. */
const readShowcaseSlots = createIsomorphicFn()
  .server((userId: number) => parsePackShowcaseSlots(getRequest().headers.get("cookie"), userId))
  .client((userId: number) => readPackShowcaseSlotsClient(userId));

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
    const userId = context.auth?.viewer?.id ?? 0;
    return { showcaseSlots: userId > 0 ? readShowcaseSlots(userId) : 0 };
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
  const { showcaseSlots } = Route.useRouteContext();
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
    <div ref={scrollRestoreRef} className="flex min-h-screen flex-col">
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
      <div className="relative flex-1">
        <CollectionsBackdrop />
        <div className="relative mx-auto max-w-[1200px] px-4 py-6 sm:px-5">
          {collector ? (
            <CollectorShelf collector={collector} tab={tab} />
          ) : activeTab === "showcase" ? (
            <ShowcaseTab shelfSlots={showcaseSlots} />
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

/* How often the snapshot itself is re-read while the tab is open. Matched to
   the backend's collector lifetime: asking faster returns the same numbers,
   and the pull stream below already carries everything that happened since. */
const STATS_REFRESH_MS = 2 * 60_000;
/* Pulls kept in hand for the delta. The list is trimmed to what the snapshot
   has not counted yet every time one lands, so what it really has to span is
   one refresh interval plus however stale that snapshot was: about four
   minutes. The cap is only a backstop against a stream nobody is trimming, and
   is set above what the busiest minute the site has seen (245 packs, five
   cards each) would put through that window. */
const PULL_BUFFER = 6_000;

interface CountedPull {
  id: number;
  ownerUserId: number;
  pulledAt: number;
  isNew: boolean;
}

/* What the totals should read right now, rather than as of the last snapshot.
 *
 * Only the three a pull moves exactly are advanced. Cards minted is one copy
 * per card dealt, holdings gain a row only where the card was new to that
 * collector, and a pack is a whole hand: every card in one shares an owner and
 * a pull stamp, so counting events rather than hands would call a five-card
 * pack five packs. Collectors and players carded are left to the snapshot -
 * both can be inferred from a pull only approximately, and a number that is
 * confidently wrong is worse than one that is two minutes old.
 *
 * Anything at or before the snapshot's computedAt is already counted in it,
 * which is what keeps a refresh from double counting the pulls it just baked
 * in. */
export function withLivePulls(stats: LivePackCommunityStats, pulls: CountedPull[]): LivePackCommunityStats {
  const fresh = pulls.filter((pull) => pull.pulledAt > stats.computedAt);
  if (fresh.length === 0) return stats;
  const hands = new Set(fresh.map((pull) => `${pull.ownerUserId}:${pull.pulledAt}`));
  return {
    ...stats,
    totals: {
      ...stats.totals,
      packsOpened: stats.totals.packsOpened + hands.size,
      cardsMinted: stats.totals.cardsMinted + fresh.length,
      distinctHoldings: stats.totals.distinctHoldings + fresh.filter((pull) => pull.isNew).length,
    },
  };
}

/* The pulls the server's totals do not know about yet, read on load.
 *
 * The SSE stream only carries what happens while the page is open, so a reload
 * used to throw away every delta it had counted and drop back to whatever the
 * totals were computed at. The public pull feed is the same events with a
 * history, so a fresh mount starts level instead. Deduped by event id, since
 * the stream and the feed overlap by design. */
const PULL_CATCHUP_LIMIT = 50;

export function mergePulls(
  current: CountedPull[],
  entries: LivePackPullFeedEntry[],
  computedAt: number,
): CountedPull[] {
  const seen = new Set(current.map((pull) => pull.id));
  const added: CountedPull[] = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry?.id) || !Number.isFinite(entry?.pulledAt)) continue;
    if (entry.pulledAt <= computedAt || seen.has(entry.id)) continue;
    seen.add(entry.id);
    added.push({ id: entry.id, ownerUserId: entry.ownerUserId, pulledAt: entry.pulledAt, isNew: entry.isNew });
  }
  return added.length === 0 ? current : [...current, ...added].slice(-PULL_BUFFER);
}

function StatsTab() {
  const [stats, setStats] = useState<LivePackCommunityStats | null>(null);
  const [pulls, setPulls] = useState<CountedPull[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    track("packs_collections_stats");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      Promise.all([
        fetchLivePackCommunityStats(),
        // Best effort: without it the page is merely as live as it was before.
        fetchLivePackRecentPulls(PULL_CATCHUP_LIMIT, { includeAll: true }).catch(() => []),
      ])
        .then(([next, recent]) => {
          if (cancelled) return;
          setStats(next);
          // Everything these totals already count stops being a delta, which is
          // what keeps the list to the window it is actually needed for.
          setPulls((current) =>
            mergePulls(current.filter((pull) => pull.pulledAt > next.computedAt), recent, next.computedAt),
          );
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const interval = window.setInterval(() => {
      // A backgrounded tab is not being read, and its numbers are re-read on
      // the way back in anyway.
      if (!document.hidden) load();
    }, STATS_REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  /* The live half. Every pull lands on the shared /api/live stream as a
     country-less event the moment the backend logs it, which is the same feed
     the pull rail on /packs reads. The country here is only the connection
     anchor the endpoint requires; observe keeps a visit to this page from
     touching the country registry. */
  useEffect(() => {
    const source = openLiveEventSource(DEFAULT_COUNTRY_CODE, { observe: true });
    if (!source) return;
    const onPackPull = (event: MessageEvent) => {
      try {
        const pull = JSON.parse(event.data) as LivePackPullFeedEntry;
        if (!Number.isFinite(pull?.id) || !Number.isFinite(pull?.pulledAt)) return;
        setPulls((current) =>
          current.some((seen) => seen.id === pull.id)
            ? current
            : [
                ...current,
                { id: pull.id, ownerUserId: pull.ownerUserId, pulledAt: pull.pulledAt, isNew: pull.isNew },
              ].slice(-PULL_BUFFER),
        );
      } catch {
        // Malformed frame: the next snapshot carries this pull instead.
      }
    };
    source.addEventListener("pack_pull", onPackPull);
    return () => {
      source.removeEventListener("pack_pull", onPackPull);
      source.close();
    };
  }, []);

  /* A refresh that fails keeps whatever is already on screen; only never
     having had an answer at all is worth saying out loud. */
  if (failed && !stats) {
    return <div className="py-16 text-center text-[12px] text-osu-f1">Could not load the pack stats.</div>;
  }

  /* Skeletons shaped like the panels they become, so the page does not jump
     when the numbers land. The backend serves this off a snapshot it keeps warm
     on a timer, including across a restart, so this is normally one round trip
     rather than a wait on a rebuild. */
  if (!stats) {
    return (
      <div className="space-y-10">
        <CommunityStatsSkeleton />
        <RecordBoardsSkeleton />
      </div>
    );
  }

  const live = withLivePulls(stats, pulls);

  return (
    <div className="space-y-10">
      <CommunityStatsHeader totals={live.totals} />
      <RecordBoards stats={live} />
    </div>
  );
}
