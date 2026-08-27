import { Trans, useLingui } from "@lingui/react/macro";
import { useLocale } from "#/lib/locale-context";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { track } from "#/lib/analytics";
import { collectionsCardProperties, collectionsShelfProperties } from "#/lib/analytics-collections";
import { formatNumber, formatOrdinal, formatTimeAgo } from "#/lib/format";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { packCardKeyOf, type CollectedCard } from "#/lib/pack-collection";
import {
  fetchLivePackCollector,
  fetchLivePackCollectorCards,
  LiveBackendRequestError,
  packCollectorLabel,
  packCollectorLookupSpecs,
  type LivePackCollectorProfile,
  type LivePackCommunityCollectionPage,
} from "#/lib/live-backend";
import { CountryFlag } from "../../ui/CountryFlag";
import { CardSpotlight, type CardSpotlightTarget } from "../CardSpotlight";
import { CollectionCardPlaceholder, CollectionCardTile } from "../CardTile";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "../cardThumbnailCache";
import { useCardThumbnails } from "../useCardThumbnails";
import {
  HeadingCount,
  HeadingSkeleton,
  NoteSkeleton,
  Section,
  SectionHeading,
  SkeletonBlock,
  StatSkeleton,
} from "./chrome";
import { useDebounced } from "./useDebounced";
import { ShowcaseCards } from "./ShowcaseCards";

/* Somebody else's collection. Read-only by construction: the same tiles the
   owner sees, with none of the actions, since nothing here is yours to recycle
   or pin. The shelf they pinned comes first because it is the part they chose;
   everything they hold follows.

   Their cards are a public read, cached on the backend, so this page never
   goes near the owner-scoped collection routes. */

const PAGE_SIZE = 24;

/* Pages of somebody else's shelf, held for as long as the tab is open and
   warmed one page ahead of wherever the visitor is. Paging is the whole
   interaction on this page and every turn was a round trip you could feel:
   the grid kept showing the page you had just left until the next one landed.
   The read is public and the backend already serves it with a minute of
   cache-control, so keeping the pages that were walked costs a map and
   nothing else. Bounded because a long session with a search box can key a
   lot of them. */
const SHELF_PAGE_CACHE_LIMIT = 60;
const shelfPageCache = new Map<string, LivePackCommunityCollectionPage>();

function shelfPageKey(
  userId: number,
  page: number,
  tier: ManiaCardTier | "all",
  query: string,
) {
  return `${userId}:${page}:${tier}:${query}`;
}

/* Pages already on the wire, so a turn taken before the warm behind it lands
   joins that read instead of opening a second one for the same page. */
const shelfPageRequests = new Map<string, Promise<LivePackCommunityCollectionPage>>();

function loadShelfPage(
  userId: number,
  page: number,
  tier: ManiaCardTier | "all",
  query: string,
): Promise<LivePackCommunityCollectionPage> {
  const key = shelfPageKey(userId, page, tier, query);
  const held = shelfPageCache.get(key);
  if (held) return Promise.resolve(held);
  const inFlight = shelfPageRequests.get(key);
  if (inFlight) return inFlight;
  const request = fetchLivePackCollectorCards(userId, { page, pageSize: PAGE_SIZE, tier, query })
    .then((next) => {
      rememberShelfPage(key, next);
      return next;
    })
    .finally(() => {
      shelfPageRequests.delete(key);
    });
  shelfPageRequests.set(key, request);
  return request;
}

function rememberShelfPage(key: string, page: LivePackCommunityCollectionPage) {
  // Re-inserted so the map's order is least-recently-used, which is what the
  // eviction below reads.
  shelfPageCache.delete(key);
  shelfPageCache.set(key, page);
  while (shelfPageCache.size > SHELF_PAGE_CACHE_LIMIT) {
    const oldest = shelfPageCache.keys().next().value;
    if (oldest === undefined) break;
    shelfPageCache.delete(oldest);
  }
}

const TIER_FILTERS: Array<{ id: ManiaCardTier | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "goat", label: "GOAT" },
  { id: "eternal", label: "Eternal" },
  { id: "worldClass", label: "World Class" },
  { id: "ascendant", label: "Ascendant" },
  { id: "mythic", label: "Mythic" },
  { id: "legendary", label: "Legendary" },
  { id: "ultraRare", label: "Ultra Rare" },
  { id: "superRare", label: "Super Rare" },
  { id: "elite", label: "Elite" },
  { id: "rare", label: "Rare" },
  { id: "common", label: "Common" },
];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">{label}</div>
      <div translate="no" className="mt-1 text-2xl font-black leading-none text-white tabular-nums">
        {value}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-osu-f1">{hint}</div> : null}
    </div>
  );
}

function CollectorHeader({ profile }: { profile: LivePackCollectorProfile }) {
  const { t } = useLingui();
  const locale = useLocale();
  const { collector, completion, ranks } = profile;
  // Floored for the same reason the boards floor it: 99.99% is not 100%.
  const poolPercent =
    completion.poolTotal > 0 ? Math.floor((completion.poolOwnedCount / completion.poolTotal) * 100) : null;

  return (
    <div>
      <div className="flex items-center gap-3">
        <img
          src={collector.avatarUrl}
          alt=""
          width={52}
          height={52}
          className="h-13 w-13 shrink-0 rounded-full object-cover"
          style={{ width: 52, height: 52 }}
          draggable={false}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {collector.countryCode ? (
              <CountryFlag code={collector.countryCode} size="sm" decorative className="shrink-0" />
            ) : null}
            {collector.tracked ? (
              <Link
                to="/player/$username"
                params={{ username: collector.username }}
                preload="intent"
                className="truncate text-xl font-black text-white transition-colors hover:text-osu-pink-light"
              >
                {collector.username}
              </Link>
            ) : (
              <span className="truncate text-xl font-black text-white">{collector.username}</span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-osu-f1">
            {collector.joinedAt > 0
              ? t`First card ${formatTimeAgo(new Date(collector.joinedAt).toISOString(), locale)}`
              : t`Collecting`}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Stat
          label={t`cards`}
          value={formatNumber(collector.cards)}
          hint={t`${formatOrdinal(ranks.cards, locale)} biggest`}
        />
        <Stat
          label={t`copies`}
          value={formatNumber(collector.copies)}
          hint={collector.duplicates > 0 ? t`${formatNumber(collector.duplicates)} duplicate` : null}
        />
        <Stat
          label={t`packs opened`}
          value={collector.packsOpened === null ? t`unknown` : formatNumber(collector.packsOpened)}
          hint={ranks.packsOpened === null ? null : t`${formatOrdinal(ranks.packsOpened, locale)} most`}
        />
        {/* "roster" rather than "GOATs": the grid can hold more GOAT-tier
            cards than this counts, since /admin/collections can mint one for a
            player who is not on the honorary roster. */}
        <Stat
          label={t`GOAT roster`}
          value={`${completion.goatsOwned}/${completion.goatsTotal}`}
          hint={completion.goatsOwned >= completion.goatsTotal ? t`all of them` : null}
        />
      </div>

      {poolPercent !== null && (
        <div className="mt-5 text-[12px] text-osu-f1">
          <Trans>
            Holds{" "}
            <span translate="no" className="font-bold text-white tabular-nums">
              {formatNumber(completion.poolOwnedCount)}
            </span>{" "}
            of the{" "}
            <span translate="no" className="font-bold text-white tabular-nums">
              {formatNumber(completion.poolTotal)}
            </span>{" "}
            pullable players,{" "}
            <span translate="no" className="font-bold text-white tabular-nums">
              {poolPercent}%
            </span>
          </Trans>
          {collector.firstFinds > 0 ? (
            <Trans>
              , and got to{" "}
              <span translate="no" className="font-bold text-white tabular-nums">
                {formatNumber(collector.firstFinds)}
              </span>{" "}
              of their cards first
            </Trans>
          ) : null}
          .
        </div>
      )}
    </div>
  );
}

function CardGrid({
  page,
  loading,
  liftedCardKey,
  onSpotlight,
}: {
  page: LivePackCommunityCollectionPage | null;
  loading: boolean;
  /* Hidden until the spotlight's return flight lands back in the slot, so the
     card is never on screen twice. */
  liftedCardKey: string | null;
  onSpotlight: (target: CardSpotlightTarget, cardKey: string) => void;
}) {
  const { t } = useLingui();
  const cards = (page?.cards ?? []) as CollectedCard[];
  const { onThumbnailError } = useCardThumbnails(cards);

  if (loading && cards.length === 0) {
    return (
      <div className="mt-4 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6">
        {Array.from({ length: PAGE_SIZE }, (_, index) => (
          <CollectionCardPlaceholder key={index} tier={null} />
        ))}
      </div>
    );
  }

  if (cards.length === 0) {
    return <div className="py-12 text-center text-[12px] text-osu-f1">{t`No cards match that.`}</div>;
  }

  return (
    <div className="mt-4 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6">
      {cards.map((card) => {
        const cardKey = packCardKeyOf(card);
        const thumbnail = getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card));
        return (
          <button
            key={cardKey}
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onSpotlight(
                {
                  card,
                  thumbnail,
                  rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                },
                cardKey,
              );
            }}
            style={liftedCardKey === cardKey ? { visibility: "hidden" } : undefined}
            className="block cursor-pointer text-left transition-transform duration-150 hover:-translate-y-1"
          >
            <CollectionCardTile
              card={card}
              thumbnail={thumbnail}
              /* Repairing a missing mint is the holder's job and costs an osu!
                 read; a visitor just sees the sketch face. */
              canBackfill={false}
              onApplyMint={() => false}
              onThumbnailError={onThumbnailError}
            />
            <div className="mt-1 truncate text-center text-[11px] text-osu-f1">{card.username}</div>
          </button>
        );
      })}
    </div>
  );
}

export function CollectorShelf({ collector, tab }: {
  collector: string;
  /* Which tab this shelf was opened from, so leaving it goes back there
     instead of to the default one. */
  tab?: "showcase" | "stats" | "collectors";
}) {
  const { t } = useLingui();
  const [profile, setProfile] = useState<LivePackCollectorProfile | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tier, setTier] = useState<ManiaCardTier | "all">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [cardPage, setCardPage] = useState<LivePackCommunityCollectionPage | null>(null);
  const [cardsLoading, setCardsLoading] = useState(true);
  /* The page after the one on screen, held only so its faces are minted
     before it is asked for. */
  const [prefetched, setPrefetched] = useState<CollectedCard[]>([]);
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  const [liftedCardKey, setLiftedCardKey] = useState<string | null>(null);
  /* Settled before it reaches the backend. Every keystroke here is a paged
     read of one collector's whole shelf, matched with a like over the
     display name, so typing a five-letter player name undebounced was five
     of them. */
  const debounced = useDebounced(query, 250);
  const collectorLabel = packCollectorLabel(collector);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setMissing(false);
    setFailed(false);
    setPage(0);
    /* A bare numeric link predating the explicit name marker is ambiguous.
       Preserve its old id meaning first, then try the exact username if that
       id has no shelf. */
    const loadProfile = async () => {
      let missingError: unknown = null;
      for (const spec of packCollectorLookupSpecs(collector)) {
        try {
          return await fetchLivePackCollector(spec);
        } catch (error: unknown) {
          if (!(error instanceof LiveBackendRequestError) || error.status !== 404) throw error;
          missingError = error;
        }
      }
      throw missingError;
    };
    loadProfile()
      .then((next) => {
        if (!cancelled) setProfile(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A 404 is "no such collector", which is a different thing to say than
        // "the server is down".
        if (error instanceof LiveBackendRequestError && error.status === 404) setMissing(true);
        else setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [collector]);

  /* A filter change starts over at the first page. Done while rendering
     rather than in an effect because an effect leaves one commit where the
     new filter is paired with the old page index, and the read below would
     spend a request (and a warm behind it) on a page that is already on its
     way out. */
  const filterKey = `${tier}:${debounced}`;
  const [pagedFilter, setPagedFilter] = useState(filterKey);
  if (pagedFilter !== filterKey) {
    setPagedFilter(filterKey);
    setPage(0);
  }

  const ownerUserId = profile?.collector.userId ?? null;
  const requestKey = ownerUserId ? shelfPageKey(ownerUserId, page, tier, debounced) : null;
  /* Read during the render that the click causes, so a page already in hand
     paints in the same commit instead of a frame later. */
  const cachedPage = requestKey ? shelfPageCache.get(requestKey) ?? null : null;

  useEffect(() => {
    if (!ownerUserId || !requestKey) return;
    let cancelled = false;

    /* One page ahead, once the page on screen is settled. The prefetch keeps
       writing to the cache after this effect is torn down: whoever asks for
       that page next is who it was for. */
    const warmNextPage = (current: LivePackCommunityCollectionPage) => {
      const nextPage = page + 1;
      if (nextPage * PAGE_SIZE >= current.total) {
        setPrefetched([]);
        return;
      }
      loadShelfPage(ownerUserId, nextPage, tier, debounced)
        .then((next) => {
          if (!cancelled) setPrefetched(next.cards as CollectedCard[]);
        })
        // A page nobody asked for yet is not worth a failure state.
        .catch(() => {});
    };

    const held = shelfPageCache.get(requestKey);
    if (held) {
      setCardPage(held);
      setCardsLoading(false);
      warmNextPage(held);
      return () => {
        cancelled = true;
      };
    }

    setCardsLoading(true);
    // Whatever was warmed sat next to a page that is no longer on screen.
    setPrefetched([]);
    loadShelfPage(ownerUserId, page, tier, debounced)
      .then((next) => {
        if (cancelled) return;
        setCardPage(next);
        setCardsLoading(false);
        warmNextPage(next);
      })
      .catch(() => {
        if (!cancelled) setCardsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerUserId, requestKey, page, tier, debounced]);

  /* Mints the next page's faces into the shared thumbnail cache while this
     one is being read, so a turn lands on cards rather than on sketches. */
  useCardThumbnails(prefetched);

  /* Every move inside the shelf, for the admin activity feed: the tier chips,
     the player search, the pager. What is reported is the state
     the move landed on rather than which control was touched, so one line
     says what the visitor is looking at. The shelf as opened is skipped: the
     pageview already recorded that, and a filter change is one event because
     the reset to page one happens in the same render. */
  const browseKey = `${tier}:${debounced}:${page}`;
  const browsedKey = useRef(browseKey);
  useEffect(() => {
    if (browsedKey.current === browseKey) return;
    browsedKey.current = browseKey;
    track(
      "packs_collections_shelf",
      collectionsShelfProperties({
        collector: profile?.collector.username ?? collectorLabel,
        tierLabel: TIER_FILTERS.find((filter) => filter.id === tier)?.label ?? null,
        query: debounced,
        page,
      }),
    );
    // The key is the whole state; the rest is read off it and would only fire
    // the same event again when the collector's name lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseKey]);

  if (missing) {
    return (
      <div className="py-20 text-center">
        <div className="text-[13px] text-osu-l2">
          <Trans><span className="font-bold text-white">{collectorLabel}</span> has not opened a pack.</Trans>
        </div>
        <BackLink tab={tab} />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="py-20 text-center">
        <div className="text-[13px] text-osu-l2">{t`Could not load that collection.`}</div>
        <BackLink tab={tab} />
      </div>
    );
  }

  if (!profile) {
    return (
      <div>
        <BackLink tab={tab} />
        <div className="mt-5">
          <div className="flex items-center gap-3">
            <SkeletonBlock className="h-[52px] w-[52px] rounded-full" />
            <div>
              <SkeletonBlock className="h-5 w-32" />
              <NoteSkeleton className="mt-0.5" />
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            {[0, 1, 2, 3].map((index) => <StatSkeleton key={index} variant="shelf" withHint />)}
          </div>
          <NoteSkeleton width="w-80" className="mt-5" />
        </div>
        {/* The card section's own chrome, at the height it renders it at: the
            heading and the search box on one row, the tier filters under it,
            then a full page of cards. Leaving them out dropped the whole grid
            down the page the moment the cards arrived. */}
        <div className="mt-10">
          <div className="flex h-8 items-center gap-4">
            <HeadingSkeleton width="w-24" />
            <SkeletonBlock className="h-8 min-w-[160px] flex-1 rounded-lg sm:max-w-[220px]" />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <SkeletonBlock key={index} className="h-[25px] w-16 rounded-full" />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6">
            {Array.from({ length: PAGE_SIZE }, (_, index) => (
              <CollectionCardPlaceholder key={index} tier={null} />
            ))}
          </div>
          {/* The pager's row, held open for the same reason the directory
              holds its own. */}
          <div className="mt-4 h-[26px]" />
        </div>
      </div>
    );
  }

  /* The page in hand when there is one; otherwise the last one loaded, which
     is what keeps the pager and the rarity chips on screen while a cold page
     is on the way instead of collapsing to "0 cards" for a beat. */
  const shownPage = cachedPage ?? cardPage;
  const total = shownPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const tierCounts = shownPage?.tierCounts ?? {};

  return (
    <div>
      <BackLink tab={tab} />
      <div className="mt-5">
        <CollectorHeader profile={profile} />
      </div>

      {profile.showcase.length > 0 && (
        <Section className="mt-10">
          <SectionHeading>{t`showcase`}</SectionHeading>
          <div className="mt-3">
            <ShowcaseCards
              cards={profile.showcase}
              ownerUserId={profile.collector.userId}
              onCardOpen={(card) =>
                track(
                  "packs_collections_card",
                  collectionsCardProperties({
                    player: card.username,
                    tierLabel: card.tierLabel,
                    collector: profile.collector.username,
                  }),
                )
              }
            />
          </div>
        </Section>
      )}

      <Section className="mt-10">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <SectionHeading>
            every card
            <HeadingCount value={shownPage ? total : null} />
          </SectionHeading>
          <label className="relative flex min-w-[160px] flex-1 items-center sm:max-w-[220px]">
            <Search size={13} className="pointer-events-none absolute left-2 text-osu-f1" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Find a player`}
              className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/50 py-1.5 pl-7 pr-2 text-[12px] text-white outline-none transition-colors placeholder:text-osu-f1 focus:border-osu-pink/50"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {TIER_FILTERS.filter(
            (filter) => filter.id === "all" || filter.id === tier || (tierCounts[filter.id] ?? 0) > 0,
          ).map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setTier(filter.id)}
              className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                tier === filter.id ? "bg-osu-pink/20 text-white" : "text-osu-f1 hover:text-white"
              }`}
              style={
                tier === filter.id && filter.id !== "all"
                  ? { color: `rgb(${tierRgb(filter.id)})` }
                  : undefined
              }
            >
              {filter.label}
              {filter.id !== "all" && tierCounts[filter.id] ? (
                <span translate="no" className="ml-1 tabular-nums opacity-60">{tierCounts[filter.id]}</span>
              ) : null}
            </button>
          ))}
        </div>

        <CardGrid
          page={shownPage}
          loading={cachedPage ? false : cardsLoading}
          liftedCardKey={liftedCardKey}
          onSpotlight={(target, cardKey) => {
            setSpotlight({ ...target, ownerUserId: profile.collector.userId });
            setLiftedCardKey(cardKey);
            track(
              "packs_collections_card",
              collectionsCardProperties({
                player: target.card.username,
                tierLabel: target.card.tierLabel,
                collector: profile.collector.username,
              }),
            );
          }}
        />

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-3 text-[12px]">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              className="cursor-pointer px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
            >
              {t`Previous`}
            </button>
            <span translate="no" className="text-osu-f1 tabular-nums">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage >= totalPages - 1}
              onClick={() => setPage(currentPage + 1)}
              className="cursor-pointer px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
            >
              {t`Next`}
            </button>
          </div>
        )}
      </Section>

      <CardSpotlight
        target={spotlight}
        onClose={() => setSpotlight(null)}
        onExitComplete={() => setLiftedCardKey(null)}
      />
    </div>
  );
}

function BackLink({ tab }: { tab?: "showcase" | "stats" | "collectors" }) {
  const { t } = useLingui();
  return (
    <Link
      to="/packs/collections"
      search={tab && tab !== "showcase" ? { tab } : {}}
      className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white"
    >
      <ArrowLeft size={13} />
      {t`All collections`}
    </Link>
  );
}

function tierRgb(tier: ManiaCardTier): string {
  const match = MANIA_TIER_STYLES[tier].badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184";
}
