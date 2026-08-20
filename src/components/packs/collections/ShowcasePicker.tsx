import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatNumber } from "#/lib/format";
import type { CollectedCard } from "#/lib/pack-collection";
import { packCardKeyOf } from "#/lib/pack-collection";
import { fetchLivePackCollectorCards, type LivePackCommunityCollectionPage } from "#/lib/live-backend";
import { PACK_SHOWCASE_MAX_CARDS } from "#/lib/pack-showcase";
import { useBodyScrollLock } from "#/lib/use-body-scroll-lock";
import { CollectionCardPlaceholder, CollectionCardTile } from "../CardTile";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "../cardThumbnailCache";
import { useCardThumbnails } from "../useCardThumbnails";
import { useDebounced } from "./useDebounced";

/* Choosing which of your cards to show. Reads your own collection through the
   same public paged endpoint the rest of this page uses, rather than the
   owner-scoped one: a showcase is public anyway, and it keeps the picker to a
   single fetch path with search and rarity order already in it.

   Picked cards are held here and only written when the sheet is saved, so
   opening it and changing your mind costs nothing. */

const PAGE_SIZE = 18;

export function ShowcasePicker({
  userId,
  initialKeys,
  onCancel,
  onSave,
}: {
  userId: number;
  initialKeys: string[];
  onCancel: () => void;
  onSave: (cardKeys: string[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string[]>(initialKeys);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<LivePackCommunityCollectionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const debounced = useDebounced(query, 250);

  // The picker is only mounted while open. Keep the page behind the sheet
  // still so a touch at either end of the grid cannot scroll the document and
  // make the mobile browser chrome resize two viewports at once.
  useBodyScrollLock(true);

  useEffect(() => {
    setPage(0);
  }, [debounced]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLivePackCollectorCards(userId, { page, pageSize: PAGE_SIZE, query: debounced })
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, page, debounced]);

  const toggle = (cardKey: string) => {
    setPicked((current) => {
      if (current.includes(cardKey)) return current.filter((key) => key !== cardKey);
      if (current.length >= PACK_SHOWCASE_MAX_CARDS) return current;
      return [...current, cardKey];
    });
  };

  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const full = picked.length >= PACK_SHOWCASE_MAX_CARDS;

  if (typeof document === "undefined") return null;

  return createPortal(
    <motion.div
      className="fixed inset-x-0 top-0 z-[90] flex h-[100dvh] min-h-0 items-end justify-center overscroll-none bg-black/70 p-0 sm:items-center sm:p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={onCancel}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Pick your showcase"
        className="modal-card-mobile-safe flex max-h-[88dvh] w-full max-w-[860px] flex-col overflow-hidden rounded-t-2xl border border-osu-b3/30 bg-osu-b5 sm:rounded-2xl"
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 8, opacity: 0 }}
        transition={{ duration: 0.14, ease: "easeOut" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-osu-b3/30 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold text-white">Pick your showcase</div>
            <div className="mt-0.5 text-[11px] text-osu-f1 tabular-nums">
              {picked.length} of {PACK_SHOWCASE_MAX_CARDS} chosen
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="shrink-0 border-b border-osu-b3/30 px-4 py-3">
          <label className="relative flex items-center">
            <Search size={13} className="pointer-events-none absolute left-2.5 text-osu-f1" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a player in your collection"
              className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/60 py-2 pl-8 pr-3 text-[12px] text-white outline-none transition-colors placeholder:text-osu-f1 focus:border-osu-pink/50"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-gutter:stable]">
          <PickerGrid
            page={result}
            loading={loading}
            picked={picked}
            full={full}
            onToggle={toggle}
          />
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-osu-b3/30 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {totalPages > 1 && (
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                className="cursor-pointer rounded-lg px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
              >
                Previous
              </button>
              <span translate="no" className="text-osu-f1 tabular-nums">
                {currentPage + 1} / {formatNumber(totalPages)}
              </span>
              <button
                type="button"
                disabled={currentPage >= totalPages - 1}
                onClick={() => setPage(currentPage + 1)}
                className="cursor-pointer rounded-lg px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
              >
                Next
              </button>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onSave(picked).finally(() => setSaving(false));
              }}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-osu-pink/20 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-osu-pink/30 disabled:cursor-default disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : null}
              Save showcase
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function PickerGrid({
  page,
  loading,
  picked,
  full,
  onToggle,
}: {
  page: LivePackCommunityCollectionPage | null;
  loading: boolean;
  picked: string[];
  full: boolean;
  onToggle: (cardKey: string) => void;
}) {
  const cards = (page?.cards ?? []) as CollectedCard[];
  const { onThumbnailError } = useCardThumbnails(cards);

  if (!page && loading) {
    return (
      <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-5 md:grid-cols-6">
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
    <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-5 md:grid-cols-6">
      {cards.map((card) => {
        const cardKey = packCardKeyOf(card);
        const chosen = picked.includes(cardKey);
        const blocked = full && !chosen;
        return (
          <button
            key={cardKey}
            type="button"
            disabled={blocked}
            onClick={() => onToggle(cardKey)}
            className={`relative block text-left transition-opacity ${
              blocked ? "cursor-default opacity-40" : "cursor-pointer"
            }`}
          >
            <div className={chosen ? "rounded-[10px] ring-2 ring-osu-pink" : ""}>
              <CollectionCardTile
                card={card}
                thumbnail={getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card))}
                canBackfill={false}
                onApplyMint={() => false}
                onThumbnailError={onThumbnailError}
              />
            </div>
            {chosen && (
              <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-osu-pink text-white">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
            <div className="mt-1 truncate text-center text-[10px] text-osu-f1">{card.username}</div>
          </button>
        );
      })}
    </div>
  );
}


export function ShowcasePickerHost({ open, ...props }: { open: boolean } & Parameters<typeof ShowcasePicker>[0]) {
  return <AnimatePresence>{open && <ShowcasePicker {...props} />}</AnimatePresence>;
}
