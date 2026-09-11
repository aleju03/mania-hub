import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchOwnPackWishlist,
  mutateOwnPackWishlist,
  type PackWishlist,
  type PackWishlistPlayer,
} from "#/lib/pack-wishlist";

/* The signed-in collector's wishlist, held once on /packs and handed to both
   the line above the collection and the toggle on each missing player.

   The server owns the list: every add and remove answers with the whole list,
   so nothing here has to guess what the write did. What the collector sees,
   though, flips the moment they press: each change is applied on top of the
   last list the server confirmed until its own answer lands, then that answer
   replaces the confirmed list. A refused or failed change simply drops out of
   that overlay, which puts the button back where the server says it is.
   `enabled` is false for a local wallet, and then this hook does not call at
   all. */
export interface WishlistApi {
  wishlist: PackWishlist | null;
  userIds: Set<number>;
  full: boolean;
  /* `player` lets an add show the new entry before the server answers; a
     remove finds the entry on the list it already has. */
  toggle: (userId: number, player?: WishlistCandidate) => Promise<void>;
  refresh: () => void;
}

export type WishlistCandidate = Omit<PackWishlistPlayer, "inPool">;

type PendingChange = { action: "add"; player: WishlistCandidate | null } | { action: "remove" };

const WISHLIST_MAX = 5;

function applyPending(server: PackWishlist, pending: Map<number, PendingChange>): PackWishlist {
  if (pending.size === 0) return server;
  let players = server.players;
  for (const [userId, change] of pending) {
    const listed = players.some((player) => player.userId === userId);
    if (change.action === "remove") {
      if (listed) players = players.filter((player) => player.userId !== userId);
    } else if (!listed && change.player) {
      players = [...players, { ...change.player, inPool: true }];
    }
  }
  return players === server.players ? server : { ...server, players };
}

export function useWishlist(enabled: boolean): WishlistApi {
  const [server, setServer] = useState<PackWishlist | null>(null);
  const [pending, setPending] = useState<Map<number, PendingChange>>(() => new Map());
  const [refreshKey, setRefreshKey] = useState(0);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /* Answers can land out of order; only the newest one may replace the
     confirmed list. */
  const sequenceRef = useRef(0);
  const appliedRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setServer(null);
      setPending(new Map());
      return;
    }
    let cancelled = false;
    const sequence = ++sequenceRef.current;
    void fetchOwnPackWishlist()
      .then((result) => {
        if (cancelled || !result || sequence < appliedRef.current) return;
        appliedRef.current = sequence;
        setServer(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  const wishlist = useMemo(() => (server ? applyPending(server, pending) : null), [server, pending]);

  const userIds = useMemo(
    () => new Set((wishlist?.players ?? []).map((player) => player.userId)),
    [wishlist],
  );

  const setPendingChange = useCallback((userId: number, change: PendingChange | null) => {
    setPending((current) => {
      const next = new Map(current);
      if (change) next.set(userId, change);
      else next.delete(userId);
      return next;
    });
  }, []);

  const toggle = useCallback(
    async (userId: number, player?: WishlistCandidate) => {
      if (!enabled || !server || pendingRef.current.has(userId)) return;
      const action = userIds.has(userId) ? "remove" : "add";
      setPendingChange(userId, action === "add" ? { action, player: player ?? null } : { action });
      const sequence = ++sequenceRef.current;
      try {
        const result = await mutateOwnPackWishlist({ data: { action, userId } });
        if (result?.status === "ok" && sequence > appliedRef.current) {
          appliedRef.current = sequence;
          setServer(result.wishlist);
        }
      } catch {
        // A failed change leaves the list exactly as the server last said it
        // was; the next open refetches it anyway.
      } finally {
        setPendingChange(userId, null);
      }
    },
    [enabled, server, userIds, setPendingChange],
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
