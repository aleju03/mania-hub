import { Link } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import type { CollectedCard } from "#/lib/pack-collection";
import { formatNumber, formatTimeAgo } from "#/lib/format";
import {
  fetchLivePackShowcaseCards,
  fetchLivePackShowcases,
  isLiveBackendConfigured,
  type LivePackShowcase,
} from "#/lib/live-backend";
import {
  PACK_SHOWCASE_MAX_CARDS,
  saveOwnPackShowcase,
  type ServerPackCollectionCard,
} from "#/lib/pack-wallet-sync";
import { CountryFlag } from "../../ui/CountryFlag";
import { Section, SectionHeading, ShowcaseRowSkeleton } from "./chrome";
import { ShowcaseCards } from "./ShowcaseCards";
import { ShowcasePickerHost } from "./ShowcasePicker";
import { useCardThumbnails } from "../useCardThumbnails";

/* The front of the collections page: the cards people chose to show.
 *
 * Your own row sits on top with the slots you have not filled, because the
 * point of the page is that you can put something on it, not just read it.
 * Everyone else's follows, most recently changed first, so the wall moves. */

const WALL_PAGE_SIZE = 12;

export function ShowcaseTab() {
  return (
    <div className="space-y-10">
      <YourShowcase />
      <ShowcaseWall />
    </div>
  );
}

function YourShowcase() {
  const auth = useAuth();
  const viewer = auth.viewer;
  const [cards, setCards] = useState<ServerPackCollectionCard[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  /* One browser-direct read for the whole row, and one that touches nothing
     expensive. It used to be two requests in series: the owner-scoped server
     function for the card keys, then the entire wall (two dozen collectors'
     showcases) purely to find this viewer's own row in it. Both sat on the
     critical path before your own cards could be drawn. */
  useEffect(() => {
    if (!viewer || !isLiveBackendConfigured()) return;
    let cancelled = false;
    fetchLivePackShowcaseCards(viewer.id, { fresh: reloadKey > 0 })
      .then((showcase) => {
        if (!cancelled) setCards(showcase);
      })
      .catch(() => {
        // Nothing chosen yet, or nothing to choose from: an empty row rather
        // than a failure.
        if (!cancelled) setCards([]);
      });
    return () => {
      cancelled = true;
    };
  }, [viewer, reloadKey]);

  /* What the picker opens with. Taken from the cards rather than from the
     stored keys, so a showcase pointing at a card that has since been recycled
     opens showing what it can actually draw. */
  const keys = cards?.map((card) => card.cardKey ?? String(card.userId)) ?? null;

  const save = useCallback(async (cardKeys: string[]) => {
    await saveOwnPackShowcase({ data: { cardKeys } }).catch(() => null);
    setPicking(false);
    setReloadKey((current) => current + 1);
  }, []);

  if (!viewer) {
    return (
      <Section>
        <SectionHeading>your showcase</SectionHeading>
        <p className="mt-2 text-[12px] text-osu-f1">
          <a href="/api/auth/osu" className="font-semibold text-osu-pink-light hover:text-white">
            Log in with osu!
          </a>{" "}
          to put your own cards up here.
        </p>
      </Section>
    );
  }

  const chosen = cards ?? [];
  const emptySlots = Math.max(0, PACK_SHOWCASE_MAX_CARDS - chosen.length);

  return (
    <Section>
      <div className="flex items-center gap-3">
        <SectionHeading>your showcase</SectionHeading>
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white"
        >
          <Pencil size={12} />
          Edit
        </button>
      </div>
      {cards === null ? (
        <div className="mt-3">
          <ShowcaseRowSkeleton cards={PACK_SHOWCASE_MAX_CARDS} />
        </div>
      ) : (
        <div className="mt-3">
          <ShowcaseCards cards={chosen} emptySlots={emptySlots} onEmptySlotClick={() => setPicking(true)} />
        </div>
      )}
      <ShowcasePickerHost
        open={picking}
        userId={viewer.id}
        initialKeys={keys ?? []}
        onCancel={() => setPicking(false)}
        onSave={save}
      />
    </Section>
  );
}

function ShowcaseWall() {
  const viewerId = useAuth().viewer?.id ?? null;
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ showcases: LivePackShowcase[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchLivePackShowcases({ page, pageSize: WALL_PAGE_SIZE })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  // Your own row is already at the top of the page; showing it twice reads as
  // a bug rather than as emphasis.
  const others = useMemo(
    () => (result?.showcases ?? []).filter((entry) => entry.collector.userId !== viewerId),
    [result, viewerId],
  );
  /* Every face on the wall in one lookup. Left to each row, a dozen rows made
     a dozen requests for what one batch answers, since the cache behind them
     is shared anyway. */
  const thumbnails = useCardThumbnails(
    useMemo(() => others.flatMap((entry) => entry.cards as CollectedCard[]), [others]),
  );

  if (failed) {
    return (
      <Section>
        <SectionHeading>showcases</SectionHeading>
        <p className="mt-2 text-[12px] text-osu-f1">Could not load the showcases.</p>
      </Section>
    );
  }

  if (!result) {
    return (
      <div className="space-y-8">
        {[0, 1].map((index) => (
          <ShowcaseRowSkeleton key={index} cards={5} withHeader />
        ))}
      </div>
    );
  }

  if (others.length === 0) {
    return (
      <Section>
        <SectionHeading>showcases</SectionHeading>
        <p className="mt-2 text-[12px] text-osu-f1">
          Nobody else has picked cards yet. Yours would be the first.
        </p>
      </Section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(result.total / WALL_PAGE_SIZE));

  return (
    <div>
      {/* A hairline where one person's cards end and the next person's begin.
          The only rule the wall needs, and cheaper than a box each. */}
      {others.map((entry) => (
        <div key={entry.collector.userId} className="border-t border-osu-b3/20 py-6 first:border-t-0 first:pt-0">
          <div className="flex items-center gap-2.5">
            <img
              src={entry.collector.avatarUrl}
              alt=""
              width={26}
              height={26}
              loading="lazy"
              className="h-[26px] w-[26px] shrink-0 rounded-full object-cover"
              draggable={false}
            />
            {entry.collector.countryCode ? (
              <CountryFlag code={entry.collector.countryCode} size="xs" decorative className="shrink-0" />
            ) : null}
            <Link
              to="/packs/collections"
              search={{ collector: entry.collector.username || String(entry.collector.userId) }}
              preload="intent"
              className="min-w-0 truncate text-[14px] font-bold text-white transition-colors hover:text-osu-pink-light"
            >
              {entry.collector.username}
            </Link>
            <span className="ml-auto shrink-0 text-[11px] text-osu-f1 tabular-nums">
              {formatNumber(entry.collector.cards)} cards
            </span>
            {entry.updatedAt > 0 && (
              <span className="hidden shrink-0 text-[11px] text-osu-f1 sm:block">
                {formatTimeAgo(new Date(entry.updatedAt).toISOString())}
              </span>
            )}
          </div>
          <div className="mt-3">
            <ShowcaseCards cards={entry.cards} thumbnails={thumbnails} />
          </div>
        </div>
      ))}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-[12px]">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
            className="cursor-pointer px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
          >
            Previous
          </button>
          <span translate="no" className="text-osu-f1 tabular-nums">
            {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
            className="cursor-pointer px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
