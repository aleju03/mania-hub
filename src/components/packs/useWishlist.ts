import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchOwnPackWishlist,
  mutateOwnPackWishlist,
  type PackWishlist,
} from "#/lib/pack-wishlist";

/* The signed-in collector's wishlist, held once on /packs and handed to both
   the line above the collection and the toggle on each missing player.

   The server owns the list: every add and remove answers with the whole list,
   so nothing here has to guess what the write did. `enabled` is false for a
   local wallet, and then this hook does not call at all. */
export interface WishlistApi {
  wishlist: PackWishlist | null;
  userIds: Set<number>;
  full: boolean;
  toggle: (userId: number) => Promise<void>;
  refresh: () => void;
}

const WISHLIST_MAX = 5;

export function useWishlist(enabled: boolean): WishlistApi {
  const [wishlist, setWishlist] = useState<PackWishlist | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setWishlist(null);
      return;
    }
    let cancelled = false;
    void fetchOwnPackWishlist()
      .then((result) => {
        if (!cancelled && result) setWishlist(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  const userIds = useMemo(
    () => new Set((wishlist?.players ?? []).map((player) => player.userId)),
    [wishlist],
  );

  const toggle = useCallback(
    async (userId: number) => {
      if (!enabled || pendingRef.current) return;
      const action = userIds.has(userId) ? "remove" : "add";
      pendingRef.current = true;
      try {
        const result = await mutateOwnPackWishlist({ data: { action, userId } });
        if (result?.status === "ok") setWishlist(result.wishlist);
      } catch {
        // A failed change leaves the list exactly as the server last said it
        // was; the next open refetches it anyway.
      } finally {
        pendingRef.current = false;
      }
    },
    [enabled, userIds],
  );

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  /* One object per change, not per render: the collection panel this feeds
     is memoized, and a new prop every second (the charge countdown re-renders
     the page) would re-render every tile on it. */
  return useMemo(
    () => ({
      wishlist,
      userIds,
      full: userIds.size >= WISHLIST_MAX,
      toggle,
      refresh,
    }),
    [wishlist, userIds, toggle, refresh],
  );
}
