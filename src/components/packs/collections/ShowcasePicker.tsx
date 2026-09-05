import { Trans, useLingui } from "@lingui/react/macro";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, Loader2, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  maxCards = PACK_SHOWCASE_MAX_CARDS,
  allowReorder = false,
  initialCards = [],
  title,
  saveLabel,
  onCancel,
  onSave,
}: {
  userId: number;
  initialKeys: string[];
  /* How many cards this picker is choosing. The showcase's five by default;
     binders pick from the same grid with their own ceiling. */
  maxCards?: number;
  allowReorder?: boolean;
  initialCards?: LivePackCommunityCollectionPage["cards"];
  title?: string;
  saveLabel?: string;
  onCancel: () => void;
  onSave: (cardKeys: string[]) => Promise<void>;
}) {
  const { t } = useLingui();
  const [picked, setPicked] = useState<string[]>(initialKeys);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<LivePackCommunityCollectionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showArrangement, setShowArrangement] = useState(initialKeys.length > 0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [saveError, setSaveError] = useState(false);
  const seenCards = useRef(new Map(initialCards.map((card) => [card.cardKey ?? String(card.userId), card])));
  for (const card of result?.cards ?? []) seenCards.current.set(card.cardKey ?? String(card.userId), card);
  const movePicked = (index: number, direction: number) => {
    setPicked((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const debounced = useDebounced(query, 250);

  // Adding the first card or removing the last must not move the grid under
  // a held pointer. Show/hide the arrangement strip after the sweep finishes.
  useEffect(() => {
    if (!dragging) setShowArrangement(picked.length > 0);
  }, [dragging, picked.length]);

  // The picker is only mounted while open. Keep the page behind the sheet
  // still so a touch at either end of the grid cannot scroll the document and
  // make the mobile browser chrome resize two viewports at once.
  useBodyScrollLock(true);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, saving]);

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
    if (saving) return;
    setPicked((current) => {
      if (current.includes(cardKey)) return current.filter((key) => key !== cardKey);
      if (current.length >= maxCards) return current;
      return [...current, cardKey];
    });
  };

  const select = useCallback((cardKey: string, on: boolean) => {
    if (saving) return;
    setPicked((current) => {
      if (on === current.includes(cardKey)) return current;
      if (!on) return current.filter((key) => key !== cardKey);
      return current.length < maxCards ? [...current, cardKey] : current;
    });
  }, [maxCards, saving]);

  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const full = picked.length >= maxCards;

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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? t`Pick your showcase`}
        tabIndex={-1}
        className="modal-card-mobile-safe flex max-h-[88dvh] w-full max-w-[860px] flex-col overflow-hidden rounded-t-2xl border border-osu-b3/30 bg-osu-b5 outline-none sm:rounded-2xl"
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 8, opacity: 0 }}
        transition={{ duration: 0.14, ease: "easeOut" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-osu-b3/30 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold text-white">{title ?? t`Pick your showcase`}</div>
            <div className="mt-0.5 text-[11px] text-osu-f1 tabular-nums">
              <Trans>{picked.length} of {maxCards} chosen</Trans>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
            aria-label={t`Close`}
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
              placeholder={t`Find a player in your collection`}
              className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/60 py-2 pl-8 pr-3 text-[12px] text-white outline-none transition-colors placeholder:text-osu-f1 focus:border-osu-pink/50"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-gutter:stable]">
          {allowReorder && showArrangement && (
            <div className="mb-5">
              <p className="mb-2 text-[11px] text-osu-f1">{t`Arrange your cards`}</p>
              <ol className="flex min-h-[102px] gap-2 overflow-x-auto pb-2">
                {picked.map((key, index) => {
                  const card = seenCards.current.get(key);
                  const name = card?.username ?? key;
                  return <li key={key} className="w-[94px] shrink-0 rounded-lg bg-white/5 p-2">
                    <div className="flex items-center gap-1.5"><span className="text-[10px] text-osu-f1">{index + 1}</span>
                      {card && <img src={card.avatarUrl} alt="" className="h-8 w-8 rounded-lg object-cover" />}
                    </div>
                    <div className="mt-1 truncate text-[10px] text-osu-l2">{name}</div>
                    <div className="mt-1 flex justify-between">
                      <button type="button" aria-label={t`Move ${name} left`} disabled={index === 0 || saving} onClick={() => movePicked(index, -1)} className="rounded p-1 text-osu-f1 hover:bg-white/10 hover:text-white disabled:opacity-25"><ChevronLeft size={14} /></button>
                      <button type="button" aria-label={t`Move ${name} right`} disabled={index === picked.length - 1 || saving} onClick={() => movePicked(index, 1)} className="rounded p-1 text-osu-f1 hover:bg-white/10 hover:text-white disabled:opacity-25"><ChevronRight size={14} /></button>
                    </div>
                  </li>;
                })}
              </ol>
            </div>
          )}
          <PickerGrid
            page={result}
            loading={loading}
            picked={picked}
            full={full}
            saving={saving}
            onToggle={toggle}
            onSelect={select}
            onDragChange={setDragging}
          />
        </div>

        {saveError && <p role="alert" className="px-4 pb-2 text-[12px] text-rose-300">{t`That did not save. Try again.`}</p>}
        <div className="flex shrink-0 items-center gap-3 border-t border-osu-b3/30 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {totalPages > 1 && (
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                className="cursor-pointer rounded-lg px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
              >
                {t`Previous`}
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
                {t`Next`}
              </button>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white"
            >
              {t`Cancel`}
            </button>
            <button
              type="button"
              disabled={saving || picked.length > maxCards}
              onClick={() => {
                setSaving(true);
                setSaveError(false);
                void onSave(picked).catch(() => setSaveError(true)).finally(() => setSaving(false));
              }}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-osu-pink/20 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-osu-pink/30 disabled:cursor-default disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : null}
              {saveLabel ?? t`Save showcase`}
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
  saving,
  onToggle,
  onSelect,
  onDragChange,
}: {
  page: LivePackCommunityCollectionPage | null;
  loading: boolean;
  picked: string[];
  full: boolean;
  saving: boolean;
  onToggle: (cardKey: string) => void;
  onSelect: (cardKey: string, on: boolean) => void;
  onDragChange: (dragging: boolean) => void;
}) {
  const { t } = useLingui();
  const cards = (page?.cards ?? []) as CollectedCard[];
  const { onThumbnailError } = useCardThumbnails(cards);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; on: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const stop = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      onDragChange(false);
    };
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!(event.buttons & 1)) {
        stop();
        return;
      }
      if (!(event.target instanceof Element)) return;
      const tile = event.target.closest<HTMLElement>("[data-picker-card]");
      if (tile && gridRef.current?.contains(tile)) onSelect(tile.dataset.pickerCard!, drag.on);
    };
    const release = (event: PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) stop();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    window.addEventListener("blur", stop);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", stop);
      dragRef.current = null;
    };
  }, [onSelect, onDragChange]);

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
    return <div className="py-12 text-center text-[12px] text-osu-f1">{t`No cards match that.`}</div>;
  }

  return (
    <div ref={gridRef} className="grid select-none grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-5 md:grid-cols-6"
      onDragStart={(event) => event.preventDefault()}>
      {cards.map((card) => {
        const cardKey = packCardKeyOf(card);
        const chosen = picked.includes(cardKey);
        const blocked = saving || (full && !chosen);
        return (
          <button
            key={cardKey}
            type="button"
            data-picker-card={cardKey}
            aria-pressed={chosen}
            disabled={blocked}
            onPointerDown={(event) => {
              if (event.pointerType !== "mouse") {
                suppressClickRef.current = false;
                return;
              }
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              suppressClickRef.current = true;
              dragRef.current = { pointerId: event.pointerId, on: !chosen };
              onDragChange(true);
              onSelect(cardKey, !chosen);
            }}
            onClick={(event) => {
              // Mouse presses already changed this card. Touch taps and
              // keyboard clicks (detail 0) still toggle once in the usual way.
              if (suppressClickRef.current && event.detail !== 0) {
                suppressClickRef.current = false;
                return;
              }
              suppressClickRef.current = false;
              onToggle(cardKey);
            }}
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
