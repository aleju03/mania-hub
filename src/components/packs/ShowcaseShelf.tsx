import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { collectedCardTier, type CollectedCard } from "#/lib/pack-collection";
import { fetchPackShowcaseCards, type ServerPackCollectionCard } from "#/lib/pack-wallet-sync";
import { buildManiaCardRenderDataFromSkills } from "../player/maniacard3d/renderData";
import { CardSpotlight, type CardSpotlightTarget } from "./CardSpotlight";
import { renderCardSkeletonThumbnail, renderCardThumbnailBlob } from "./cardSnapshot";
import {
  cardThumbnailKeyForData,
  COLLECTION_CARD_THUMB_WIDTH,
  getMemoryCardThumbnail,
  loadPersistedCardThumbnail,
  rememberCardThumbnailBlob,
} from "./cardThumbnailCache";

/* The showcase shelf on a player's profile: the cards they pinned from their
   collection (see the pin action in CollectionPanel's card menu). Renders
   nothing while loading and nothing for players with no pins, so profiles
   without a shelf stay exactly as they were. Admin-gated for now, on both
   this render and the fetch behind it, while the design is judged.

   Presented as a literal display shelf: the cards stand on a plank, each
   turned slightly toward the viewer, with their reflection on the shelf
   surface. Hovering picks a card up (it straightens, lifts, and stops
   reflecting). Clicking lifts it into the same spotlight the collection
   uses, so inspecting a card never leaves the page. */

function shelfCardId(card: ServerPackCollectionCard): string {
  return card.cardKey ?? String(card.userId);
}

export function ShowcaseShelf({ userId }: { userId: number }) {
  const [cards, setCards] = useState<ServerPackCollectionCard[] | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  // The lifted card's shelf slot stays hidden until the return flight lands
  // back in it, so the card never shows twice. Keyed by card, not player: a
  // shelf can hold two tiers of the same player and only one is lifted.
  const [liftedCardKey, setLiftedCardKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCards(null);
    fetchPackShowcaseCards({ data: { userId } })
      .then((shelf) => {
        if (!cancelled) setCards(shelf);
      })
      .catch(() => {
        if (!cancelled) setCards([]);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!cards || cards.length === 0) return;
    let cancelled = false;
    void Promise.all(
      cards.map(async (card) => {
        if (!card.skills) return;
        try {
          const data = buildManiaCardRenderDataFromSkills({
            user: {
              id: card.userId,
              username: card.username,
              avatar_url: card.avatarUrl,
              country_code: card.countryCode,
              statistics: { global_rank: card.globalRank, pp: card.pp },
            },
            skills: card.skills,
            tierOverride: collectedCardTier(card as CollectedCard),
          });
          const key = cardThumbnailKeyForData(data, COLLECTION_CARD_THUMB_WIDTH);
          let url = getMemoryCardThumbnail(key) ?? (await loadPersistedCardThumbnail(key));
          if (!url) url = await rememberCardThumbnailBlob(key, await renderCardThumbnailBlob(data, COLLECTION_CARD_THUMB_WIDTH));
          if (!cancelled && url) {
            setThumbnails((current) => ({ ...current, [shelfCardId(card)]: url }));
          }
        } catch {
          // The tier skeleton face stays for this card.
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [cards]);

  if (!cards || cards.length === 0) return null;

  const mid = (cards.length - 1) / 2;

  return (
    <section className="mb-8">
      <h3 className="mb-5 text-center text-sm font-bold text-white">Showcase</h3>
      {/* Cards stand on the plank below, each turned slightly toward the
          viewer, and the shelf surface carries their reflection. Picking a
          card up straightens it and lifts it off the wood. */}
      <div className="mx-auto w-fit max-w-full px-4" style={{ perspective: "900px" }}>
        <div className="flex items-end justify-center gap-4 sm:gap-6">
          {cards.map((card, index) => {
            const thumbnail = thumbnails[shelfCardId(card)] ?? null;
            const face = thumbnail ?? renderCardSkeletonThumbnail(collectedCardTier(card as CollectedCard), COLLECTION_CARD_THUMB_WIDTH);
            const offset = index - mid;
            const lifted = liftedCardKey === shelfCardId(card);
            return (
              <motion.div
                key={shelfCardId(card)}
                className="group relative hover:z-10"
                style={{ transformStyle: "preserve-3d", opacity: lifted ? 0 : 1 }}
                initial={false}
                animate={{ rotateY: offset * 13, y: 0 }}
                whileHover={{ rotateY: 0, y: -10, scale: 1.03 }}
                transition={{ type: "spring", stiffness: 300, damping: 24 }}
              >
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setSpotlight({
                      card: card as CollectedCard,
                      thumbnail,
                      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                    });
                    setLiftedCardKey(shelfCardId(card));
                  }}
                  className="relative block w-[112px] overflow-hidden rounded-[10px] shadow-[0_10px_20px_rgba(0,0,0,0.55)] cursor-pointer sm:w-[150px]"
                  style={{ aspectRatio: "5 / 7" }}
                  title={`${card.username}${card.serial ? ` · serial #${card.serial}` : ""}`}
                >
                  {face ? (
                    <img src={face} alt={`${card.username} maniacard`} className="h-full w-full object-cover" draggable={false} />
                  ) : (
                    <div className="h-full w-full rounded-[10px] border border-osu-b3/40 bg-osu-b4" />
                  )}
                  {card.serial !== null && card.serial !== undefined && (
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-px text-[11px] font-bold text-white tabular-nums">
                      #{card.serial}
                    </span>
                  )}
                </button>
                {/* The card's reflection lying on the shelf surface: the same
                    face mirrored on its bottom edge, fading into the wood. It
                    fades out as the card is picked up off the shelf. */}
                {face && (
                  <div
                    className="pointer-events-none absolute inset-x-0 top-full h-[26px] overflow-hidden blur-[1px] transition-opacity duration-200 group-hover:opacity-0 sm:h-[34px]"
                    aria-hidden="true"
                    style={{
                      transform: "scaleY(-1)",
                      maskImage: "linear-gradient(to top, rgba(0,0,0,0.22), transparent)",
                      WebkitMaskImage: "linear-gradient(to top, rgba(0,0,0,0.22), transparent)",
                    }}
                  >
                    {/* Full card height so the mirrored edge lines up with the
                        real card's bottom, cropped by the surface strip. */}
                    <img
                      src={face}
                      alt=""
                      className="absolute inset-x-0 bottom-0 w-full object-cover"
                      style={{ aspectRatio: "5 / 7" }}
                      draggable={false}
                    />
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
        {/* The plank: a lit top edge, the wood's front face, and the shadow it
            throws onto the page. */}
        <div className="relative -mx-2 mt-[26px] h-[8px] rounded-[2px] bg-gradient-to-b from-osu-b3/70 via-osu-b4 to-osu-b5 shadow-[0_12px_24px_rgba(0,0,0,0.5)] sm:-mx-4 sm:mt-[34px]">
          <div className="absolute inset-x-0 top-0 h-px bg-white/15" />
        </div>
      </div>
      <CardSpotlight
        target={spotlight}
        onClose={() => setSpotlight(null)}
        onExitComplete={() => setLiftedCardKey(null)}
      />
    </section>
  );
}
