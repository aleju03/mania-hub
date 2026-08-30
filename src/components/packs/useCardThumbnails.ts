import { useCallback, useEffect, useState } from "react";
import type { CollectedCard } from "#/lib/pack-collection";
import { pageSignature, renderCollectionThumbnail } from "./CardTile";
import {
  cardThumbnailKeyForCollectionCard,
  claimCardThumbnailErrorFallback,
  forgetRemoteCardThumbnail,
  getMemoryCardThumbnail,
  loadPersistedCardThumbnail,
  loadR2CardThumbnails,
  preloadRemoteCardThumbnail,
} from "./cardThumbnailCache";

/* Filling in the card faces for one page of a collection grid, in the order
   that costs least: the in-memory cache, then this browser's persisted store,
   then the shared R2 renders, and only then a local canvas mint. Shared by the
   collection panel and the community page so a card someone else already
   rendered is never re-rendered just because a different surface is showing it.
 *
 * The cache is module state, so nothing here holds the images. A landed face
 * re-renders the host, which reads the cache back on the way through. Keeping
 * the URLs out of React state is what lets a page of tiles repaint without
 * rebuilding the tile list. */
export function useCardThumbnails(cards: CollectedCard[]): {
  onThumbnailError: (card: CollectedCard) => void;
} {
  // The counter is never read: bumping it is how the host re-renders, and the
  // host reads the faces back out of the cache while it does.
  const [, setRevision] = useState(0);
  const signature = pageSignature(cards);

  /* A tile's remote thumbnail 404ed (pool URLs carry no existence check, so a
     lifecycle-expired object surfaces here): evict the dead URL so the tile
     shows its placeholder, render the card locally, and let
     rememberCardThumbnailBlob re-upload it for the next viewer. One attempt
     per key per session; a failed render leaves the placeholder. */
  const onThumbnailError = useCallback((card: CollectedCard) => {
    const key = cardThumbnailKeyForCollectionCard(card);
    if (!key || !claimCardThumbnailErrorFallback(key)) return;
    forgetRemoteCardThumbnail(key);
    setRevision((current) => current + 1);
    void renderCollectionThumbnail(card)
      .then((thumbnail) => {
        if (thumbnail) setRevision((current) => current + 1);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!signature) return;
    let cancelled = false;

    const missing = cards
      .map((card) => ({ card, key: cardThumbnailKeyForCollectionCard(card) }))
      .filter((entry): entry is { card: CollectedCard; key: string } =>
        Boolean(entry.key && entry.card.skills && !getMemoryCardThumbnail(entry.key)),
      );
    if (missing.length === 0) return;

    const run = async () => {
      const remoteCandidates: Array<{ card: CollectedCard; key: string }> = [];
      await Promise.all(missing.map(async ({ card, key }) => {
        const cached = await loadPersistedCardThumbnail(key);
        if (cancelled) return;
        if (cached) setRevision((current) => current + 1);
        else remoteCandidates.push({ card, key });
      }));
      if (cancelled || remoteCandidates.length === 0) return;

      const remoteUrls = await loadR2CardThumbnails(remoteCandidates.map((entry) => entry.key));
      if (cancelled) return;
      const toRender = remoteCandidates
        .filter(({ key }) => {
          if (!remoteUrls[key]) return true;
          // Warmed rather than merely addressed, so a page prepared ahead of
          // the visitor has its faces in the browser's cache when its tiles
          // mount rather than forty downloads to start then.
          preloadRemoteCardThumbnail(remoteUrls[key]);
          setRevision((current) => current + 1);
          return false;
        })
        .map(({ card }) => card);
      if (toRender.length === 0) return;

      await Promise.all(toRender.map(async (card) => {
        try {
          const thumbnail = await renderCollectionThumbnail(card);
          if (cancelled || !thumbnail) return;
          setRevision((current) => current + 1);
        } catch {
          // The DOM fallback remains for this card.
        }
      }));
    };
    void run();

    return () => {
      cancelled = true;
    };
    // Keyed by the page's card identities rather than the array, so a
    // re-render with the same cards does not restart the work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return { onThumbnailError };
}
