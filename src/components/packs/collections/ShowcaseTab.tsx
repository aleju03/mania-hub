import { Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import {
  fetchLivePackShowcaseCards,
  fetchLivePackShowcaseWall,
  isLiveBackendConfigured,
  type LivePackShowcaseWallCard,
} from "#/lib/live-backend";
import {
  PACK_SHOWCASE_MAX_CARDS,
  saveOwnPackShowcase,
  type ServerPackCollectionCard,
} from "#/lib/pack-wallet-sync";
import { Section, SectionHeading, ShowcaseRowSkeleton, SkeletonBlock } from "./chrome";
import { ShowcaseCards } from "./ShowcaseCards";
import { ShowcasePickerHost } from "./ShowcasePicker";
import { ShowcaseWallGrid } from "./ShowcaseWall";

/* The front of the collections page: the cards people chose to show.
 *
 * Your own row sits on top with the slots you have not filled, because the
 * point of the page is that you can put something on it, not just read it.
 * Under it the wall, which is a gallery rather than a directory: every card
 * anyone chose, most recently chosen first, with nothing written over it. */

const WALL_PAGE_SIZE = 40;

export function ShowcaseTab() {
  /* Saving your showcase changes the wall under it, and the wall used to fetch
     on page change alone, so the card you had just put up was not there until
     you reloaded the page. */
  const [savedAt, setSavedAt] = useState(0);
  const onSaved = useCallback(() => setSavedAt(Date.now()), []);
  return (
    <div className="space-y-10">
      <YourShowcase onSaved={onSaved} />
      <ShowcaseWall reloadKey={savedAt} />
    </div>
  );
}

function YourShowcase({ onSaved }: { onSaved: () => void }) {
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
    onSaved();
  }, [onSaved]);

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
      {/* An empty shelf draws nothing at all: no card-shaped holes, and no
          second button telling you to fill them. It cost the height of a row
          of cards to say nothing, above a page that is entirely cards, and
          Edit already opens the picker. */}
      {cards === null ? (
        <SkeletonBlock className="mt-3 h-3 w-40" />
      ) : chosen.length > 0 ? (
        <div className="mt-3">
          <ShowcaseCards
            cards={chosen}
            ownerUserId={viewer.id}
            /* One slot, not every one left. The row is already card-height
               once you have picked something, so a single opening says there
               is room without lining up four more empty boxes. */
            emptySlots={chosen.length < PACK_SHOWCASE_MAX_CARDS ? 1 : 0}
            onEmptySlotClick={() => setPicking(true)}
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
  const [page, setPage] = useState(0);
  /* A card you just picked sorts to the front, which is page one, so a save
     takes you back there. Adjusted during render rather than in an effect so
     the fetch below runs once, for the page it settles on. */
  const [seenReload, setSeenReload] = useState(reloadKey);
  if (seenReload !== reloadKey) {
    setSeenReload(reloadKey);
    setPage(0);
  }
  /* Paging from a button under a grid four rows tall otherwise leaves you at
     the bottom of the next page, looking at its last row with everything above
     already scrolled past. Same handling the collection's own pager uses. */
  const headerRef = useRef<HTMLDivElement>(null);
  const goToPage = useCallback((next: number) => {
    setPage(next);
    headerRef.current?.scrollIntoView({ block: "start" });
  }, []);
  const [result, setResult] = useState<{ cards: LivePackShowcaseWallCard[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchLivePackShowcaseWall({ page, pageSize: WALL_PAGE_SIZE, fresh: reloadKey > 0 })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [page, reloadKey]);

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
      <Section>
        <SectionHeading>showcases</SectionHeading>
        <div className="mt-3">
          <ShowcaseRowSkeleton cards={WALL_PAGE_SIZE} />
        </div>
      </Section>
    );
  }

  if (result.cards.length === 0) {
    return (
      <Section>
        <SectionHeading>showcases</SectionHeading>
        <p className="mt-2 text-[12px] text-osu-f1">
          Nobody has picked cards yet. Yours would be the first.
        </p>
      </Section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(result.total / WALL_PAGE_SIZE));

  return (
    <Section>
      <div ref={headerRef} className="flex scroll-mt-[76px] items-baseline gap-3">
        <SectionHeading>showcases</SectionHeading>
        <span className="ml-auto shrink-0 text-[11px] text-osu-f1 tabular-nums">
          {result.total.toLocaleString("en-US")} {result.total === 1 ? "card" : "cards"}
        </span>
      </div>
      <div className="mt-3">
        <ShowcaseWallGrid entries={result.cards} />
      </div>

      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3 text-[12px]">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => goToPage(page - 1)}
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
            onClick={() => goToPage(page + 1)}
            className="cursor-pointer px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </Section>
  );
}
