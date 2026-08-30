import { Trans, useLingui } from "@lingui/react/macro";
import { Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { track } from "#/lib/analytics";
import { useAuth } from "#/lib/auth-context";
import {
  fetchLivePackShowcaseCards,
  fetchLivePackShowcaseWall,
  isLiveBackendConfigured,
  type LivePackShowcaseWallCard,
} from "#/lib/live-backend";
import { PACK_SHOWCASE_MAX_CARDS, writePackShowcaseSlotsClient } from "#/lib/pack-showcase";
import { saveOwnPackShowcase, type ServerPackCollectionCard } from "#/lib/pack-wallet-sync";
import { Section, SectionHeading, ShowcaseRowSkeleton, ShowcaseWallSkeleton } from "./chrome";
import { ShowcaseCards } from "./ShowcaseCards";
import { ShowcasePickerHost } from "./ShowcasePicker";
import { ShowcaseWallGrid } from "./ShowcaseWall";
import { useCardThumbnails } from "../useCardThumbnails";
import type { CollectedCard } from "#/lib/pack-collection";

/* The front of the collections page: the cards people chose to show.
 *
 * Your own row sits on top with the slots you have not filled, because the
 * point of the page is that you can put something on it, not just read it.
 * Under it the wall, which is a gallery rather than a directory: every card
 * anyone chose, most recently chosen first, with nothing written over it. */

const WALL_PAGE_SIZE = 40;

/* Pages of the wall, held for as long as the tab is open and warmed one page
   ahead of wherever the visitor is. Paging is the whole interaction here and
   every turn was a round trip you could feel: the read, then forty card faces
   fetched behind it, so the grid sat on the page you had just left for a
   couple of hundred milliseconds and then filled in tile by tile. The read is
   public and the backend serves it with cache-control, so keeping the pages
   that were walked costs a map and nothing else. Same handling the shelf
   uses. */
const WALL_PAGE_CACHE_LIMIT = 12;
const wallPageCache = new Map<number, LivePackShowcaseWallPage>();

/* Pages already on the wire, so a turn taken before the warm behind it lands
   joins that read instead of opening a second one for the same page. */
const wallPageRequests = new Map<number, Promise<LivePackShowcaseWallPage>>();

function rememberWallPage(page: number, value: LivePackShowcaseWallPage) {
  // Re-inserted so the map's order is least-recently-used, which is what the
  // eviction below reads.
  wallPageCache.delete(page);
  wallPageCache.set(page, value);
  while (wallPageCache.size > WALL_PAGE_CACHE_LIMIT) {
    const oldest = wallPageCache.keys().next().value;
    if (oldest === undefined) break;
    wallPageCache.delete(oldest);
  }
}

function loadWallPage(page: number, fresh: boolean): Promise<LivePackShowcaseWallPage> {
  const held = wallPageCache.get(page);
  if (held) return Promise.resolve(held);
  const inFlight = wallPageRequests.get(page);
  if (inFlight) return inFlight;
  const request = fetchLivePackShowcaseWall({ page, pageSize: WALL_PAGE_SIZE, fresh })
    .then((next) => {
      rememberWallPage(page, next);
      return next;
    })
    .finally(() => {
      wallPageRequests.delete(page);
    });
  wallPageRequests.set(page, request);
  return request;
}

interface LivePackShowcaseWallPage {
  cards: LivePackShowcaseWallCard[];
  total: number;
}

export function ShowcaseTab({ shelfSlots }: { shelfSlots: number }) {
  /* Saving your showcase changes the wall under it, and the wall used to fetch
     on page change alone, so the card you had just put up was not there until
     you reloaded the page. */
  const [savedAt, setSavedAt] = useState(0);
  const onSaved = useCallback(() => setSavedAt(Date.now()), []);
  return (
    <div className="space-y-10">
      <YourShowcase slots={shelfSlots} onSaved={onSaved} />
      <ShowcaseWall reloadKey={savedAt} />
    </div>
  );
}

function YourShowcase({ slots, onSaved }: { slots: number; onSaved: () => void }) {
  const { t } = useLingui();
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
        // Written whether or not this render is still around to draw it:
        // what the shelf holds is true for the next page load either way.
        writePackShowcaseSlotsClient(viewer.id, showcase.length);
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
    track("packs_showcase_saved", { collections_cards: String(cardKeys.length) });
    await saveOwnPackShowcase({ data: { cardKeys } }).catch(() => null);
    setPicking(false);
    setReloadKey((current) => current + 1);
    onSaved();
  }, [onSaved]);

  if (!viewer) {
    return (
      <Section>
        <SectionHeading>{t`your showcase`}</SectionHeading>
        <p className="mt-2 text-[12px] text-osu-f1">
          <Trans>
            <a href="/api/auth/osu" className="font-semibold text-osu-pink-light hover:text-white">
              Log in with osu!
            </a>{" "}
            to put your own cards up here.
          </Trans>
        </p>
      </Section>
    );
  }

  const chosen = cards ?? [];

  return (
    <Section>
      <div className="flex items-center gap-3">
        <SectionHeading>{t`your showcase`}</SectionHeading>
        <button
          type="button"
          onClick={() => {
            track("packs_showcase_edit");
            setPicking(true);
          }}
          className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white"
        >
          <Pencil size={12} />
          {t`Edit`}
        </button>
      </div>
      {/* An empty shelf draws nothing at all: no card-shaped holes, and no
          second button telling you to fill them. It cost the height of a row
          of cards to say nothing, above a page that is entirely cards, and
          Edit already opens the picker.

          So the shelf lands on one of two heights, a row of cards or that same
          nothing, and nothing on the client knows which until the read
          answers. The bar that used to wait here was neither: it reserved 24px
          that an empty shelf then took back, dropping the wall below it and
          raising it again on every load. What waits here now is the shelf this
          browser saw last time, which is nothing for everyone who has picked
          no cards and the right number of holes for everyone who has. It rides
          a cookie so the server-rendered frame can hold the row too, minutes
          of hydration before any script could read it back. A browser that has
          never had the page open reserves nothing, same as before. */}
      {cards === null ? (
        slots > 0 ? (
          <div className="mt-3">
            <ShowcaseRowSkeleton cards={slots} />
          </div>
        ) : null
      ) : chosen.length > 0 ? (
        <div className="mt-3">
          <ShowcaseCards
            cards={chosen}
            ownerUserId={viewer.id}
            /* One slot, not every one left. The row is already card-height
               once you have picked something, so a single opening says there
               is room without lining up four more empty boxes. */
            emptySlots={chosen.length < PACK_SHOWCASE_MAX_CARDS ? 1 : 0}
            onEmptySlotClick={() => {
              track("packs_showcase_edit");
              setPicking(true);
            }}
          />
        </div>
      ) : null}
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

function ShowcaseWall({ reloadKey }: { reloadKey: number }) {
  const { t } = useLingui();
  const [page, setPage] = useState(0);
  /* A card you just picked sorts to the front, which is page one, so a save
     takes you back there. Adjusted during render rather than in an effect so
     the fetch below runs once, for the page it settles on. */
  const [seenReload, setSeenReload] = useState(reloadKey);
  if (seenReload !== reloadKey) {
    setSeenReload(reloadKey);
    setPage(0);
  }
  /* Paging leaves the scroll alone. Every page is the same forty tiles tall,
     so the buttons stay under the cursor for the next click and the grid
     changes in place; scrolling back up to the heading on each press meant
     re-finding the pager every time you wanted the page after this one. */
  const [result, setResult] = useState<LivePackShowcaseWallPage | null>(null);
  const [failed, setFailed] = useState(false);
  /* The page after the one on screen, held only so its faces are minted into
     the shared thumbnail cache before anyone asks to see them. */
  const [prefetched, setPrefetched] = useState<LivePackShowcaseWallCard[]>([]);

  /* Turning a page of the wall. The first page is what the pageview already
     says, and a save bouncing back to it is not a page turn either, so only a
     move away from where the visitor was gets reported. */
  const pagedTo = useRef(page);
  useEffect(() => {
    if (pagedTo.current === page) return;
    pagedTo.current = page;
    if (page > 0) track("packs_collections_wall", { collections_page: String(page + 1) });
  }, [page]);

  /* A save rewrites the front of the wall, so everything walked before it is
     stale. Dropped during the render the save causes, before the read below
     can serve one of those pages back. */
  const [cachedReload, setCachedReload] = useState(reloadKey);
  if (cachedReload !== reloadKey) {
    setCachedReload(reloadKey);
    wallPageCache.clear();
  }

  /* Read during the render that the click causes, so a page already in hand
     paints in the same commit instead of a round trip later. */
  const cached = wallPageCache.get(page) ?? null;

  useEffect(() => {
    let cancelled = false;

    /* One page ahead, once the page on screen is settled. The prefetch keeps
       writing to the cache after this effect is torn down: whoever asks for
       that page next is who it was for. */
    const warmNextPage = (current: LivePackShowcaseWallPage) => {
      const nextPage = page + 1;
      if (nextPage * WALL_PAGE_SIZE >= current.total) {
        setPrefetched([]);
        return;
      }
      loadWallPage(nextPage, false)
        .then((next) => {
          if (!cancelled) setPrefetched(next.cards);
        })
        // A page nobody asked for yet is not worth a failure state.
        .catch(() => {});
    };

    const held = wallPageCache.get(page);
    if (held) {
      setFailed(false);
      warmNextPage(held);
      return () => {
        cancelled = true;
      };
    }

    setFailed(false);
    // Whatever was warmed sat next to a page that is no longer on screen.
    setPrefetched([]);
    loadWallPage(page, reloadKey > 0)
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        warmNextPage(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [page, reloadKey]);

  /* Mints the next page's faces into the shared thumbnail cache while this one
     is being looked at, so a turn lands on cards rather than on empty tiles.
     The wall's faces are forty R2 objects a page, which is what the turn used
     to be spent on. */
  const prefetchedCards = useMemo(
    () => prefetched.map((entry) => entry.card as CollectedCard),
    [prefetched],
  );
  useCardThumbnails(prefetchedCards);

  /* One header for every state this section has. The count only exists once
     the wall lands, so until then its slot holds a blank line of the same 11px
     type: an empty span has no line box at all, and the heading row growing
     1.5px when the number arrives steps the whole grid under it. */
  const shown = cached ?? result;

  const header = (
    <div className="flex items-baseline gap-3">
      <SectionHeading>{t`showcases`}</SectionHeading>
      <span className="ml-auto shrink-0 text-[11px] text-osu-f1 tabular-nums">
        {shown && shown.total > 0
          ? (shown.total === 1
            ? t`${shown.total.toLocaleString("en-US")} card`
            : t`${shown.total.toLocaleString("en-US")} cards`)
          : "\u00a0"}
      </span>
    </div>
  );

  if (failed && !shown) {
    return (
      <Section>
        {header}
        <p className="mt-2 text-[12px] text-osu-f1">{t`Could not load the showcases.`}</p>
      </Section>
    );
  }

  if (!shown) {
    return (
      <Section>
        {header}
        <div className="mt-3">
          <ShowcaseWallSkeleton cards={WALL_PAGE_SIZE} />
        </div>
      </Section>
    );
  }

  if (shown.cards.length === 0) {
    return (
      <Section>
        {header}
        <p className="mt-2 text-[12px] text-osu-f1">
          {t`Nobody has picked cards yet. Yours would be the first.`}
        </p>
      </Section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(shown.total / WALL_PAGE_SIZE));

  return (
    <Section>
      {header}
      <div className="mt-3">
        <ShowcaseWallGrid entries={shown.cards} />
      </div>

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3 text-[12px]">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
            className="cursor-pointer px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
          >
            {t`Previous`}
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
            {t`Next`}
          </button>
        </div>
      )}
    </Section>
  );
}
