import { Link } from "@tanstack/react-router";
import { ArrowLeft, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { formatNumber, formatOrdinal, formatTimeAgo } from "#/lib/format";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { packCardKeyOf, type CollectedCard } from "#/lib/pack-collection";
import {
  fetchLivePackCollector,
  fetchLivePackCollectorCards,
  LiveBackendRequestError,
  type LivePackCollectorProfile,
  type LivePackCommunityCollectionPage,
} from "#/lib/live-backend";
import { CountryFlag } from "../../ui/CountryFlag";
import { CardSpotlight, type CardSpotlightTarget } from "../CardSpotlight";
import { CollectionCardPlaceholder, CollectionCardTile } from "../CardTile";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "../cardThumbnailCache";
import { useCardThumbnails } from "../useCardThumbnails";
import { Section, SectionHeading, SkeletonBlock, StatSkeleton } from "./chrome";
import { useDebounced } from "./useDebounced";
import { ShowcaseCards } from "./ShowcaseCards";

/* Somebody else's collection. Read-only by construction: the same tiles the
   owner sees, with none of the actions, since nothing here is yours to recycle
   or pin. The shelf they pinned comes first because it is the part they chose;
   everything they hold follows.

   Their cards are a public read, cached on the backend, so this page never
   goes near the owner-scoped collection routes. */

const PAGE_SIZE = 24;

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
              ? `First card ${formatTimeAgo(new Date(collector.joinedAt).toISOString())}`
              : "Collecting"}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Stat
          label="cards"
          value={formatNumber(collector.cards)}
          hint={`${formatOrdinal(ranks.cards)} biggest`}
        />
        <Stat
          label="copies"
          value={formatNumber(collector.copies)}
          hint={collector.duplicates > 0 ? `${formatNumber(collector.duplicates)} duplicate` : null}
        />
        <Stat
          label="packs opened"
          value={collector.packsOpened === null ? "unknown" : formatNumber(collector.packsOpened)}
          hint={ranks.packsOpened === null ? null : `${formatOrdinal(ranks.packsOpened)} most`}
        />
        {/* "roster" rather than "GOATs": the grid can hold more GOAT-tier
            cards than this counts, since /admin/collections can mint one for a
            player who is not on the honorary roster. */}
        <Stat
          label="GOAT roster"
          value={`${completion.goatsOwned}/${completion.goatsTotal}`}
          hint={completion.goatsOwned >= completion.goatsTotal ? "all of them" : null}
        />
      </div>

      {poolPercent !== null && (
        <div className="mt-5 text-[12px] text-osu-f1">
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
          {collector.firstFinds > 0 ? (
            <>
              , and got to{" "}
              <span translate="no" className="font-bold text-white tabular-nums">
                {formatNumber(collector.firstFinds)}
              </span>{" "}
              of their cards first
            </>
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
    return <div className="py-12 text-center text-[12px] text-osu-f1">No cards match that.</div>;
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
  const [profile, setProfile] = useState<LivePackCollectorProfile | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tier, setTier] = useState<ManiaCardTier | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"rarity" | "newest">("rarity");
  const [page, setPage] = useState(0);
  const [cardPage, setCardPage] = useState<LivePackCommunityCollectionPage | null>(null);
  const [cardsLoading, setCardsLoading] = useState(true);
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  const [liftedCardKey, setLiftedCardKey] = useState<string | null>(null);
  /* Settled before it reaches the backend. Every keystroke here is a paged
     read of one collector's whole shelf, matched with a like over the
     display name, so typing a five-letter player name undebounced was five
     of them. */
  const debounced = useDebounced(query, 250);

  const asUserId = /^\d+$/.test(collector) ? Number(collector) : null;

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setMissing(false);
    setFailed(false);
    setPage(0);
    fetchLivePackCollector(asUserId ? { userId: asUserId } : { username: collector })
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
  }, [collector, asUserId]);

  useEffect(() => {
    setPage(0);
  }, [tier, debounced, sort]);

  const ownerUserId = profile?.collector.userId ?? null;

  useEffect(() => {
    if (!ownerUserId) return;
    let cancelled = false;
    setCardsLoading(true);
    fetchLivePackCollectorCards(ownerUserId, { page, pageSize: PAGE_SIZE, tier, query: debounced, sort })
      .then((next) => {
        if (cancelled) return;
        setCardPage(next);
        setCardsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setCardsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerUserId, page, tier, debounced, sort]);

  if (missing) {
    return (
      <div className="py-20 text-center">
        <div className="text-[13px] text-osu-l2">
          <span className="font-bold text-white">{collector}</span> has not opened a pack.
        </div>
        <BackLink tab={tab} />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="py-20 text-center">
        <div className="text-[13px] text-osu-l2">Could not load that collection.</div>
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
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="mt-2 h-2.5 w-24" />
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            {[0, 1, 2, 3].map((index) => <StatSkeleton key={index} />)}
          </div>
        </div>
        <div className="mt-10">
          <SkeletonBlock className="h-2.5 w-24" />
          <div className="mt-4 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-6">
            {Array.from({ length: 12 }, (_, index) => <CollectionCardPlaceholder key={index} tier={null} />)}
          </div>
        </div>
      </div>
    );
  }

  const total = cardPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const tierCounts = cardPage?.tierCounts ?? {};

  return (
    <div>
      <BackLink tab={tab} />
      <div className="mt-5">
        <CollectorHeader profile={profile} />
      </div>

      {profile.showcase.length > 0 && (
        <Section className="mt-10">
          <SectionHeading>showcase</SectionHeading>
          <div className="mt-3">
            <ShowcaseCards cards={profile.showcase} />
          </div>
        </Section>
      )}

      <Section className="mt-10">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <SectionHeading>
            every card
            <span translate="no" className="ml-1.5 text-osu-f1/70 tabular-nums">{formatNumber(total)}</span>
          </SectionHeading>
          <label className="relative flex min-w-[160px] flex-1 items-center sm:max-w-[220px]">
            <Search size={13} className="pointer-events-none absolute left-2 text-osu-f1" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a player"
              className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/50 py-1.5 pl-7 pr-2 text-[12px] text-white outline-none transition-colors placeholder:text-osu-f1 focus:border-osu-pink/50"
            />
          </label>
          <div className="flex items-center gap-1">
            {(["rarity", "newest"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSort(mode)}
                className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors ${
                  sort === mode ? "bg-osu-pink/20 text-white" : "text-osu-f1 hover:text-white"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
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
          page={cardPage}
          loading={cardsLoading}
          liftedCardKey={liftedCardKey}
          onSpotlight={(target, cardKey) => {
            setSpotlight(target);
            setLiftedCardKey(cardKey);
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
              Previous
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
              Next
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
  return (
    <Link
      to="/packs/collections"
      search={tab && tab !== "showcase" ? { tab } : {}}
      className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white"
    >
      <ArrowLeft size={13} />
      All collections
    </Link>
  );
}

function tierRgb(tier: ManiaCardTier): string {
  const match = MANIA_TIER_STYLES[tier].badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184";
}
