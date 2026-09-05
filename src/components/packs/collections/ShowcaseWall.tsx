import { useLingui } from "@lingui/react/macro";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { track } from "#/lib/analytics";
import { collectionsCardProperties } from "#/lib/analytics-collections";
import type { CollectedCard } from "#/lib/pack-collection";
import { packCardKeyOf } from "#/lib/pack-collection";
import type { LivePackShowcaseWallCard } from "#/lib/live-backend";
import { CardSpotlight, type CardSpotlightTarget } from "../CardSpotlight";
import { SHOWCASE_GRID_CLASS } from "./chrome";
import { CollectionCardPlaceholder, CollectionCardTile } from "../CardTile";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "../cardThumbnailCache";
import { useCardThumbnails } from "../useCardThumbnails";

type ThumbnailError = ReturnType<typeof useCardThumbnails>["onThumbnailError"];
const NO_CARDS: CollectedCard[] = [];

/** A set occupies adjacent grid columns. Larger groups scroll within that
 * footprint, preserving both their order and the scale of surrounding cards.
 */
function SetTiles({ entry, renderCard, onThumbnailError }: {
  entry: LivePackShowcaseWallCard;
  renderCard: (card: CollectedCard, id: string, onError: ThumbnailError) => ReactNode;
  onThumbnailError: ThumbnailError;
}) {
  const { t } = useLingui();
  const set = entry.set!;
  const strip = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const cards = set.cards as CollectedCard[];
  useEffect(() => {
    const node = strip.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = node.firstElementChild?.getBoundingClientRect().width ?? 1;
      setStart(Math.max(0, Math.floor(node.scrollLeft / (width + 12))));
      setAtEnd(node.scrollLeft + node.clientWidth >= node.scrollWidth - 2);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const visible = useMemo(() => start > 0 ? cards.slice(Math.max(0, start - 1), start + 4) : NO_CARDS, [cards, start]);
  const extra = useCardThumbnails(visible);
  const span = cards.length === 1 ? "[--set-cols:1]" : cards.length === 2 ? "col-span-2 [--set-cols:2]" : "col-span-2 sm:col-span-3 [--set-cols:2] sm:[--set-cols:3]";
  const move = (direction: number) => strip.current?.scrollBy({ left: direction * strip.current.clientWidth });
  return <div role="group" aria-label={set.name} className={`min-w-0 self-start rounded-xl bg-white/[0.025] outline outline-1 outline-white/10 outline-offset-4 ${span}`}>
    <div ref={strip} className="grid snap-x snap-mandatory grid-flow-col gap-3 overflow-x-auto rounded-[10px] scroll-smooth motion-reduce:scroll-auto [scrollbar-width:none]"
      style={{ gridAutoColumns: "calc((100% - (var(--set-cols) - 1) * 12px) / var(--set-cols))" }}
      onScroll={(event) => {
        const node = event.currentTarget;
        const width = node.firstElementChild?.getBoundingClientRect().width ?? 1;
        setStart(Math.max(0, Math.floor(node.scrollLeft / (width + 12))));
        setAtEnd(node.scrollLeft + node.clientWidth >= node.scrollWidth - 2);
      }}>
      {cards.map((card, index) => <div key={packCardKeyOf(card)} className="min-w-0 snap-start">
        {index >= Math.max(0, start - 1) && index < start + 4
          ? renderCard(card, `set:${set.id}:${packCardKeyOf(card)}`, start > 0 ? extra.onThumbnailError : onThumbnailError)
          : <CollectionCardPlaceholder tier={card.tier} />}
      </div>)}
    </div>
    <div className="flex items-center gap-2 px-1 pt-2 pb-0.5">
      <span className="min-w-0 flex-1 truncate text-[10px] text-osu-f1">{set.name}</span>
      {cards.length > 2 && <div className={`flex shrink-0 ${cards.length === 3 ? "sm:hidden" : ""}`}>
        <button type="button" disabled={start === 0} aria-label={t`Previous cards in ${set.name}`} onClick={() => move(-1)} className="rounded p-1 text-osu-f1 hover:bg-white/5 hover:text-white disabled:opacity-25"><ChevronLeft size={12} /></button>
        <button type="button" disabled={atEnd} aria-label={t`Next cards in ${set.name}`} onClick={() => move(1)} className="rounded p-1 text-osu-f1 hover:bg-white/5 hover:text-white disabled:opacity-25"><ChevronRight size={12} /></button>
      </div>}
    </div>
  </div>;
}

/** One wall for individual cards and sets. Creator identity appears only in
 * the card spotlight, never on the outside of either kind of entry.
 */
export function ShowcaseWallGrid({ entries }: { entries: LivePackShowcaseWallCard[] }) {
  const { t } = useLingui();
  const cards = useMemo(() => entries.flatMap((entry) => (entry.set?.cards.slice(0, 4) ?? [entry.card]) as CollectedCard[]), [entries]);
  const { onThumbnailError } = useCardThumbnails(cards);
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  const [liftedId, setLiftedId] = useState<string | null>(null);

  const renderCard = (entry: LivePackShowcaseWallCard, card: CollectedCard, tileId: string, onError: ThumbnailError) => {
    const thumbnail = getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card));
    return <button key={tileId} type="button"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setSpotlight({ card, thumbnail, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          ownerUserId: entry.collector.userId, showcasedBy: entry.collector });
        setLiftedId(tileId);
        track("packs_collections_card", collectionsCardProperties({ player: card.username, tierLabel: card.tierLabel, collector: entry.collector.username }));
      }}
      style={liftedId === tileId ? { visibility: "hidden" } : undefined}
      className="w-full self-start cursor-pointer transition-transform duration-[120ms] hover:-translate-y-1"
      aria-label={t`Inspect ${card.username}'s maniacard`}>
      <CollectionCardTile card={card} thumbnail={thumbnail} canBackfill={false} onApplyMint={() => false} onThumbnailError={onError} showCopies={false} />
    </button>;
  };
  return <>
    <div className={SHOWCASE_GRID_CLASS}>
      {entries.map((entry) => entry.set ? <SetTiles key={`set:${entry.set.id}`} entry={entry} onThumbnailError={onThumbnailError}
        renderCard={(card, id, onError) => renderCard(entry, card, id, onError)} />
        : renderCard(entry, entry.card as CollectedCard, `${entry.collector.userId}:${packCardKeyOf(entry.card as CollectedCard)}`, onThumbnailError))}
    </div>
    <CardSpotlight target={spotlight} onClose={() => setSpotlight(null)} onExitComplete={() => setLiftedId(null)} />
  </>;
}
