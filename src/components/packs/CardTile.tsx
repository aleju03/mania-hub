import { motion } from "framer-motion";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { MANIA_TIER_STYLES, type ManiaCardTier, type ManiaSkills } from "#/lib/maniacard";
import { collectedCardTier, packCardKeyOf, type CollectedCard } from "#/lib/pack-collection";
import { fetchPackPlayerScores } from "#/lib/packs";
import {
  buildManiaCardRenderData,
  buildManiaCardRenderDataFromSkills,
} from "../player/maniacard3d/renderData";
import { renderCardSkeletonThumbnail, renderCardThumbnailBlob } from "./cardSnapshot";
import {
  cardThumbnailKeyForCollectionCard,
  cardThumbnailKeyForData,
  COLLECTION_CARD_THUMB_WIDTH,
  noteCardThumbnailStored,
  rememberCardThumbnailBlob,
} from "./cardThumbnailCache";

/* How a collected card is drawn as a grid tile, shared by the collection panel
   (your own shelf) and the community page (somebody else's). One
   implementation on purpose: two surfaces drawing the same card from the same
   snapshot must not disagree about what it looks like.

   The tile itself is read-only. Everything a card can be *done* to - recycling,
   pinning, the spotlight - stays with the surface that owns the card, which is
   why the only interactive thing here is the mint repair, and that one is
   opt-in per surface via canBackfill. */

export interface CardMint {
  skills: ManiaSkills;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
}

const skeletonThumbnailCache = new Map<ManiaCardTier | "neutral", string>();

const noopSubscribe = () => () => {};
// False during SSR and the hydration render, true from the post-mount render
// on - and true on the first render of anything that mounts later, which is
// what every tile of a page turn is.
function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

let activeRenders = 0;
const renderQueue: Array<() => void> = [];
export async function throttleRender<T>(task: () => Promise<T>): Promise<T> {
  if (activeRenders >= 2) await new Promise<void>((resolve) => renderQueue.push(resolve));
  activeRenders += 1;
  try {
    return await task();
  } finally {
    activeRenders -= 1;
    const next = renderQueue.shift();
    if (next) {
      /* Resolving here keeps the whole visible page in one microtask chain:
         each canvas mint hands the main thread straight to the next before a
         queued click can run. A task boundary preserves the two-wide render
         bound while letting input and the streak-game handoff go first. */
      window.setTimeout(next, 0);
    }
  }
}

export function thumbnailKey(card: CollectedCard): string {
  return cardThumbnailKeyForCollectionCard(card) ?? `${card.userId}:${card.tier ?? "unrated"}:plain`;
}

export function cardUserForRender(card: CollectedCard) {
  return {
    id: card.userId,
    username: card.username,
    avatar_url: card.avatarUrl,
    country_code: card.countryCode,
    statistics: { global_rank: card.globalRank, pp: card.pp },
  };
}

export async function renderCollectionThumbnail(card: CollectedCard): Promise<{ key: string; url: string } | null> {
  if (!card.skills) return null;
  const data = buildManiaCardRenderDataFromSkills({
    user: cardUserForRender(card),
    skills: card.skills,
    tierOverride: collectedCardTier(card),
    labelOverride: card.customLabel,
    motifOverride: card.motif,
  });
  const key = cardThumbnailKeyForData(data, COLLECTION_CARD_THUMB_WIDTH);
  const blob = await throttleRender(() => renderCardThumbnailBlob(data, COLLECTION_CARD_THUMB_WIDTH));
  return { key, url: await rememberCardThumbnailBlob(key, blob) };
}

export function pageSignature(cards: CollectedCard[]) {
  return cards.map(thumbnailKey).join("|");
}

export function resolveCollectionCardTier(card?: CollectedCard): ManiaCardTier {
  return card ? collectedCardTier(card) : "common";
}

/* Legacy cards (collected before skills snapshots existed) and failed mints
   re-mint themselves when scrolled into view: fetch the player's plays once,
   compute the skills, store them in the wallet. One attempt per session per
   card, two in flight at a time. */
const attemptedBackfills = new Set<string>();
let activeBackfills = 0;
const backfillQueue: Array<() => void> = [];
async function throttleBackfill<T>(task: () => Promise<T>): Promise<T> {
  if (activeBackfills >= 2) await new Promise<void>((resolve) => backfillQueue.push(resolve));
  activeBackfills += 1;
  try {
    return await task();
  } finally {
    activeBackfills -= 1;
    backfillQueue.shift()?.();
  }
}

export async function backfillCardMint(
  card: CollectedCard,
  onApplyMint: (cardKey: string, mint: CardMint) => boolean | Promise<boolean>,
) {
  const cardKey = packCardKeyOf(card);
  if (attemptedBackfills.has(cardKey)) return;
  attemptedBackfills.add(cardKey);
  try {
    const scores = await throttleBackfill(() => fetchPackPlayerScores(card.userId));
    const data = buildManiaCardRenderData({
      user: cardUserForRender(card),
      scores,
      // A card that already knows what it was minted at keeps that tier: the
      // backfill is here to recover a missing skills snapshot, not to re-tier
      // a card because its player has since joined the honorary roster.
      tierOverride: card.tier ?? undefined,
    });
    if (data.status !== "ready") return;
    await onApplyMint(cardKey, { skills: data.skills, tier: data.tier, tierLabel: data.tierStyle.label });
  } catch {
    // The sketch tile remains; another session can retry.
    attemptedBackfills.delete(cardKey);
  }
}

export function CollectionCardFacePlaceholder({ card, tier: forcedTier }: { card?: CollectedCard; tier?: ManiaCardTier | null }) {
  // A null forcedTier is the rarity-less face; only an absent one falls back to
  // the card's own tier.
  const tier = forcedTier !== undefined ? forcedTier : resolveCollectionCardTier(card);
  /* The sketch face is drawn on a canvas, so it exists on the client and not
     on the server. Rendering it during the hydration pass would mean the
     server sent the gradient below and the client swapped in an <img>, which
     is a hydration mismatch wherever a placeholder is server-rendered (the
     collections page shows a grid of them while a collection loads).

     Only that one pass has to wait for it. A placeholder that mounts later has
     no server render to match, so it draws its sketch in the commit that mounts
     it: turning a page used to paint a frame of bare gradient first, which read
     as a third state between the old page and the new one. */
  const hydrated = useHydrated();
  let thumbnail = hydrated ? skeletonThumbnailCache.get(tier ?? "neutral") ?? null : null;
  if (hydrated && !thumbnail) {
    thumbnail = renderCardSkeletonThumbnail(tier, COLLECTION_CARD_THUMB_WIDTH);
    if (thumbnail) skeletonThumbnailCache.set(tier ?? "neutral", thumbnail);
  }
  if (thumbnail) {
    return (
      <img
        src={thumbnail}
        alt=""
        className="h-full w-full rounded-[10px] object-cover"
        draggable={false}
      />
    );
  }

  /* What a server-rendered placeholder grid shows until it hydrates, and the
     only thing left that ever precedes the sketch. It borrows the tier's wash
     but not the tier's border: that one is a near-white rim, far louder than
     anything on the sketch it hands over to. */
  const style = tier ? MANIA_TIER_STYLES[tier] : null;
  return (
    <div
      className={`relative overflow-hidden rounded-[10px] border border-white/8 bg-gradient-to-br ${
        style ? style.background : "from-osu-b3 via-osu-b4 to-osu-b5"
      }`}
      style={{ aspectRatio: "5 / 7" }}
    >
      <div className="absolute inset-0 bg-black/12" />
    </div>
  );
}

export function CollectionCardPlaceholder({ tier }: { tier: ManiaCardTier | null }) {
  return (
    <div>
      <div className="relative" style={{ aspectRatio: "5 / 7" }}>
        <CollectionCardFacePlaceholder tier={tier} />
      </div>
      <div className="mx-auto mt-1.5 h-4 w-10 rounded bg-osu-b4/40" />
    </div>
  );
}

export function CollectionCardTile({
  card,
  thumbnail,
  canBackfill,
  onApplyMint,
  onThumbnailError,
  showCopies = true,
}: {
  card: CollectedCard;
  thumbnail: string | null;
  /* Repairing a card collected before skills snapshots existed is the holder's
     business and costs an osu! read, so a surface showing somebody else's
     shelf passes false and lives with the sketch face. */
  canBackfill: boolean;
  onApplyMint: (cardKey: string, mint: CardMint) => boolean | Promise<boolean>;
  onThumbnailError: (card: CollectedCard) => void;
  /* How many copies the holder has is a fact about their shelf, not about the
     card. A gallery of other people's cards turns it off: there it reads as
     though several tiles had been stacked into one. */
  showCopies?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previousThumbnailRef = useRef<string | null>(thumbnail);
  const animateThumbnail = Boolean(thumbnail && !previousThumbnailRef.current);

  useEffect(() => {
    // Mid-sync the wallet does not yet know whether the repair belongs in
    // localStorage or in the server rows, and a backfill only gets one attempt
    // per card per session, so wait for the answer rather than burn it.
    if (card.skills || !canBackfill) return;
    let cancelled = false;
    const work = () => {
      if (!cancelled) void backfillCardMint(card, onApplyMint);
    };
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver !== "function") {
      work();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void work();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.userId, card.skills, canBackfill]);

  useEffect(() => {
    previousThumbnailRef.current = thumbnail;
  }, [thumbnail]);

  return (
    <div ref={hostRef} className="relative" style={{ aspectRatio: "5 / 7" }}>
      <CollectionCardFacePlaceholder card={card} />
      {thumbnail && (
        <motion.img
          key={thumbnail}
          src={thumbnail}
          alt={`${card.username} maniacard`}
          className="absolute inset-0 h-full w-full rounded-[10px] object-cover"
          initial={animateThumbnail ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={animateThumbnail ? { duration: 0.14, ease: "easeOut" } : { duration: 0 }}
          draggable={false}
          onLoad={(event) => noteCardThumbnailStored(card, event.currentTarget.src)}
          onError={(event) => {
            /* Only a remote pool URL can 404 (local renders are blob/data
               URLs); fall back to rendering this card locally. */
            if (/^https?:/.test(event.currentTarget.src)) onThumbnailError(card);
          }}
        />
      )}
      {showCopies && card.copies > 1 && (
        <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1 py-px text-[10px] font-bold text-white tabular-nums">
          x{card.copies}
        </span>
      )}
    </div>
  );
}
