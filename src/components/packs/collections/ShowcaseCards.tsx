import type { CollectedCard } from "#/lib/pack-collection";
import { packCardKeyOf } from "#/lib/pack-collection";
import type { ServerPackCollectionCard } from "#/lib/pack-wallet-sync";
import { CardSpotlight, type CardSpotlightTarget } from "../CardSpotlight";
import { CollectionCardTile } from "../CardTile";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "../cardThumbnailCache";
import { useCardThumbnails } from "../useCardThumbnails";
import { useState } from "react";

/* A row of chosen cards, drawn bigger than a collection tile because this is
   the one place cards are meant to be looked at rather than counted. Clicking
   one lifts it into the same spotlight the collection uses.

   The tiles are the collection's own, so a card a collector already rendered
   somewhere else on the site is read out of the shared cache rather than drawn
   again. */

/* A row whose faces are being loaded by whoever is drawing several rows at
   once, so this one asks for nothing of its own. */
const NO_CARDS: CollectedCard[] = [];

export function ShowcaseCards({
  cards,
  ownerUserId,
  emptySlots = 0,
  onEmptySlotClick,
  thumbnails,
}: {
  cards: ServerPackCollectionCard[];
  /* Whose showcase this is, so the spotlight can say how many collections
     hold the card in front of it rather than how many hold the player. */
  ownerUserId?: number | null;
  /* Placeholders the owner can click to add a card. Only their own showcase
     draws these; on the wall an unfilled slot is nothing to say. */
  emptySlots?: number;
  onEmptySlotClick?: () => void;
  /* Passed by a surface that draws many rows at once (the wall) so all of
     their faces are resolved in one request instead of one per row. A row on
     its own loads its own. */
  thumbnails?: ReturnType<typeof useCardThumbnails>;
}) {
  const collected = cards as CollectedCard[];
  const own = useCardThumbnails(thumbnails ? NO_CARDS : collected);
  const { onThumbnailError } = thumbnails ?? own;
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  /* The lifted card's slot stays hidden past close, until the return flight
     lands back in it, so the card is never on screen twice. Keyed by card key,
     not player: a GOAT and an ordinary card of the same player are two slots
     and only the clicked one hides. Same handling the collection grid uses. */
  const [liftedCardKey, setLiftedCardKey] = useState<string | null>(null);

  return (
    <>
      <div className="flex flex-wrap gap-2.5 sm:gap-3">
        {collected.map((card) => {
          const cardKey = packCardKeyOf(card);
          const thumbnail = getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card));
          return (
            <button
              key={cardKey}
              type="button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setSpotlight({
                  card,
                  thumbnail,
                  rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                  ownerUserId,
                });
                setLiftedCardKey(cardKey);
              }}
              style={liftedCardKey === cardKey ? { visibility: "hidden" } : undefined}
              className="w-[92px] cursor-pointer transition-transform duration-[120ms] hover:-translate-y-1 sm:w-[116px]"
              title={card.serial ? `${card.username}, serial #${card.serial}` : card.username}
            >
              <CollectionCardTile
                card={card}
                thumbnail={thumbnail}
                canBackfill={false}
                onApplyMint={() => false}
                onThumbnailError={onThumbnailError}
              />
            </button>
          );
        })}
        {Array.from({ length: Math.max(0, emptySlots) }, (_, index) => (
          <button
            key={`slot-${index}`}
            type="button"
            onClick={onEmptySlotClick}
            className="w-[92px] cursor-pointer rounded-[10px] border border-dashed border-osu-b3/60 text-[20px] font-light text-osu-f1 transition-colors hover:border-osu-pink/50 hover:text-osu-pink-light sm:w-[116px]"
            style={{ aspectRatio: "5 / 7" }}
            aria-label="Add a card to your showcase"
          >
            +
          </button>
        ))}
      </div>
      <CardSpotlight
        target={spotlight}
        onClose={() => setSpotlight(null)}
        onExitComplete={() => setLiftedCardKey(null)}
      />
    </>
  );
}
