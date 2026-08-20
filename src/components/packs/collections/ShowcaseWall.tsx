import { useMemo, useState } from "react";
import type { CollectedCard } from "#/lib/pack-collection";
import { packCardKeyOf } from "#/lib/pack-collection";
import type { LivePackShowcaseWallCard } from "#/lib/live-backend";
import { CardSpotlight, type CardSpotlightTarget } from "../CardSpotlight";
import { SHOWCASE_GRID_CLASS } from "./chrome";
import { CollectionCardTile } from "../CardTile";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "../cardThumbnailCache";
import { useCardThumbnails } from "../useCardThumbnails";

/* The wall: every card anyone chose to show, in one grid, wearing nothing but
   itself. No name over it and no avatar on it, because the page is a gallery
   of cards rather than a directory of people; who put a card up is what
   opening it tells you, alongside its serial and how many collections hold it.
 *
 * A tile is keyed by owner and card together: two collectors showing the same
 * card are two tiles, and they are not the same tile at different sizes. */
export function ShowcaseWallGrid({ entries }: { entries: LivePackShowcaseWallCard[] }) {
  const cards = useMemo(() => entries.map((entry) => entry.card as CollectedCard), [entries]);
  const { onThumbnailError } = useCardThumbnails(cards);
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  /* The lifted tile stays hidden past close, until the return flight lands
     back in it, so the card is never on screen twice. Keyed by owner and card
     for the same reason the tiles are. */
  const [liftedId, setLiftedId] = useState<string | null>(null);

  return (
    <>
      {/* A grid rather than a wrapping flex row of fixed-width tiles: those
          leave whatever the last column could not fill as dead space down the
          right, which on a phone three tiles wide is most of a fourth tile.
          auto-fill fits as many columns as there is room for and 1fr shares
          the remainder between them, so both edges line up at every width. */}
      <div className={SHOWCASE_GRID_CLASS}>
        {entries.map((entry) => {
          const card = entry.card as CollectedCard;
          const tileId = `${entry.collector.userId}:${packCardKeyOf(card)}`;
          const thumbnail = getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card));
          return (
            <button
              key={tileId}
              type="button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setSpotlight({
                  card,
                  thumbnail,
                  rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                  ownerUserId: entry.collector.userId,
                  showcasedBy: {
                    userId: entry.collector.userId,
                    username: entry.collector.username,
                    avatarUrl: entry.collector.avatarUrl,
                    countryCode: entry.collector.countryCode,
                  },
                });
                setLiftedId(tileId);
              }}
              style={liftedId === tileId ? { visibility: "hidden" } : undefined}
              className="w-full cursor-pointer transition-transform duration-[120ms] hover:-translate-y-1"
              aria-label={`Inspect ${card.username}'s maniacard`}
            >
              <CollectionCardTile
                card={card}
                thumbnail={thumbnail}
                canBackfill={false}
                onApplyMint={() => false}
                onThumbnailError={onThumbnailError}
                showCopies={false}
              />
            </button>
          );
        })}
      </div>
      <CardSpotlight
        target={spotlight}
        onClose={() => setSpotlight(null)}
        onExitComplete={() => setLiftedId(null)}
      />
    </>
  );
}
