import { useEffect, useRef, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import type { ManiaCardTier } from "#/lib/maniacard";
import {
  applyCardMint,
  loadWalletForViewer,
  MAX_PACK_CHARGES,
  ownedCards,
  packWalletStorageKey,
  reconcileWallets,
  recordPull,
  recycleAllCopies,
  recycleAllDuplicates,
  recycleDuplicates,
  sanitizeWallet,
  settleCharges,
  spendCharge,
  spendShards,
  writePackWallet,
  type PackWallet,
  type PulledCard,
} from "#/lib/pack-collection";
import {
  fetchServerPackWallet,
  pushServerPackWallet,
  recycleServerPackCollection,
  type PackWalletCardsMode,
} from "#/lib/pack-wallet-sync";
import type { PackCost } from "#/lib/packs";

export type PackSyncStatus = "local" | "syncing" | "synced";

export interface PackWalletApi {
  /* Null until hydrated from localStorage (and during SSR). */
  wallet: PackWallet | null;
  /* Ticks once a second while charges regenerate, for countdown displays. */
  nowMs: number;
  /* "local" = browser-only (logged out or backend unreachable);
     "synced" = the server holds this exact wallet. */
  syncStatus: PackSyncStatus;
  openPack: (cost: PackCost) => boolean;
  recordPull: (pull: PulledCard) => boolean;
  /* Recycles a card's duplicate copies, keeping one. */
  recycleCard: (userId: number) => number | Promise<number>;
  /* Recycles every copy; the card leaves the collection. */
  recycleWhole: (userId: number) => number | Promise<number>;
  /* Whole-recycles a batch of cards in one server round-trip. */
  recycleWholeMany: (userIds: number[]) => number | Promise<number>;
  recycleWholeMatching: (filter: { tier: ManiaCardTier | "all" | "unrated"; query: string }) => number | Promise<number>;
  recycleAll: () => number | Promise<number>;
  /* Backfills a recomputed mint (skills snapshot + tier) onto an owned
     card; used to upgrade legacy cards collected before snapshots existed. */
  applyMint: (userId: number, mint: Parameters<typeof applyCardMint>[2]) => boolean;
  notePoolTotal: (total: number | null) => void;
}

const PUSH_DEBOUNCE_MS = 1200;
const PUSH_RETRY_MS = 15_000;

interface SyncState {
  enabled: boolean;
  rev: number;
  lastSyncedPayload: string | null;
  cardsMode: PackWalletCardsMode;
  pushTimer: ReturnType<typeof setTimeout> | null;
  pushPromise: Promise<void> | null;
  pushing: boolean;
  /* Bumped on viewer change so stale async work drops its results. */
  generation: number;
}

function parseWalletPayload(payload: string | null): PackWallet | null {
  if (!payload) return null;
  try {
    return sanitizeWallet(JSON.parse(payload), Date.now());
  } catch {
    return null;
  }
}

function stripWalletCards(wallet: PackWallet): PackWallet {
  return Object.keys(wallet.cards).length === 0 ? wallet : { ...wallet, cards: {} };
}

function collectionCardMatchesFilter(
  card: PackWallet["cards"][string],
  filter: { tier: ManiaCardTier | "all" | "unrated"; query: string },
): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query && !card.username.toLowerCase().includes(query)) return false;
  if (filter.tier === "all") return true;
  if (filter.tier === "unrated") return card.tier === null;
  return card.tier === filter.tier;
}

export function usePackWallet(): PackWalletApi {
  const auth = useAuth();
  const viewerId = auth.viewer?.id ?? null;
  const [wallet, setWallet] = useState<PackWallet | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [syncStatus, setSyncStatus] = useState<PackSyncStatus>("local");
  const walletRef = useRef<PackWallet | null>(null);
  const keyRef = useRef<string>(packWalletStorageKey(viewerId));
  const syncRef = useRef<SyncState>({
    enabled: false,
    rev: 0,
    lastSyncedPayload: null,
    cardsMode: "delta",
    pushTimer: null,
    pushPromise: null,
    pushing: false,
    generation: 0,
  });

  const schedulePush = (delayMs = PUSH_DEBOUNCE_MS) => {
    const sync = syncRef.current;
    if (!sync.enabled) return;
    if (sync.pushTimer) clearTimeout(sync.pushTimer);
    sync.pushTimer = setTimeout(() => {
      sync.pushTimer = null;
      void runPushNow();
    }, delayMs);
  };

  const pushNow = async () => {
    const sync = syncRef.current;
    const current = walletRef.current;
    if (!sync.enabled || sync.pushing || !current) return;
    const payload = JSON.stringify(current);
    if (payload === sync.lastSyncedPayload) {
      setSyncStatus("synced");
      return;
    }
    sync.pushing = true;
    setSyncStatus("syncing");
    const generation = sync.generation;
    try {
      const result = await pushServerPackWallet({ data: { payload, baseRev: sync.rev, cardsMode: sync.cardsMode } });
      if (generation !== sync.generation) return;
      if (!result) {
        // Logged out server-side or no backend configured: stay local.
        sync.enabled = false;
        setSyncStatus("local");
        return;
      }
      if (result.ok) {
        sync.rev = result.rev;
        const latestPayload = JSON.stringify(walletRef.current);
        // Mutations that landed mid-flight get their own push.
        if (latestPayload !== payload) {
          schedulePush();
        } else {
          const stripped = stripWalletCards(current);
          const strippedPayload = JSON.stringify(stripped);
          sync.lastSyncedPayload = strippedPayload;
          sync.cardsMode = "delta";
          walletRef.current = stripped;
          writePackWallet(keyRef.current, stripped);
          setWallet(stripped);
          setSyncStatus("synced");
        }
        return;
      }
      // Another device moved the wallet forward: reconcile and push again.
      sync.rev = result.conflict.rev;
      const serverWallet = parseWalletPayload(result.conflict.payload);
      if (serverWallet && walletRef.current) {
        commit(reconcileWallets(walletRef.current, serverWallet, Date.now()));
      } else {
        schedulePush();
      }
    } catch {
      // Transient network/server failure: retry later, keep playing locally.
      if (generation === sync.generation) schedulePush(PUSH_RETRY_MS);
    } finally {
      sync.pushing = false;
    }
  };

  const runPushNow = () => {
    const sync = syncRef.current;
    if (sync.pushing && sync.pushPromise) return sync.pushPromise;
    const promise = pushNow();
    sync.pushPromise = promise;
    void promise.finally(() => {
      if (syncRef.current.pushPromise === promise) syncRef.current.pushPromise = null;
    });
    return promise;
  };

  const commit = (next: PackWallet, syncEligible = true) => {
    walletRef.current = next;
    writePackWallet(keyRef.current, next);
    setWallet(next);
    // Keep countdowns honest immediately after a spend instead of waiting
    // for the next interval tick.
    setNowMs(Date.now());
    if (syncEligible) schedulePush();
  };

  const commitServerWallet = (payload: string, rev: number) => {
    const parsed = parseWalletPayload(payload);
    if (!parsed) return;
    const stripped = stripWalletCards(parsed);
    const serialized = JSON.stringify(stripped);
    const sync = syncRef.current;
    sync.rev = rev;
    sync.lastSyncedPayload = serialized;
    sync.cardsMode = "delta";
    walletRef.current = stripped;
    writePackWallet(keyRef.current, stripped);
    setWallet(stripped);
    setNowMs(Date.now());
    setSyncStatus("synced");
  };

  const recycleOnServer = async (
    mode: "duplicates" | "whole" | "all_duplicates" | "whole_matching",
    userId?: number,
    userIds?: number[],
    filter?: { tier: ManiaCardTier | "all" | "unrated"; query: string },
  ) => {
    const sync = syncRef.current;
    if (!sync.enabled) return null;
    try {
      if (sync.pushTimer) {
        clearTimeout(sync.pushTimer);
        sync.pushTimer = null;
        await runPushNow();
      } else if (sync.pushPromise) {
        await sync.pushPromise;
      }
      if (Object.keys(walletRef.current?.cards ?? {}).length > 0) return null;
      const result = await recycleServerPackCollection({
        data: {
          mode,
          cardUserId: userId,
          cardUserIds: userIds,
          tier: filter?.tier,
          query: filter?.query,
        },
      });
      if (!result) return null;
      commitServerWallet(result.payload, result.rev);
      return result.gained;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    const sync = syncRef.current;
    sync.generation += 1;
    sync.enabled = false;
    sync.rev = 0;
    sync.lastSyncedPayload = null;
    sync.cardsMode = "delta";
    if (sync.pushTimer) {
      clearTimeout(sync.pushTimer);
      sync.pushTimer = null;
    }
    sync.pushPromise = null;
    setSyncStatus("local");

    keyRef.current = packWalletStorageKey(viewerId);
    const loaded = loadWalletForViewer(viewerId, Date.now());
    sync.cardsMode = Object.keys(loaded.cards).length > 0 ? "snapshot" : "delta";
    walletRef.current = loaded;
    writePackWallet(keyRef.current, loaded);
    setWallet(loaded);
    setNowMs(Date.now());

    if (!viewerId) return;
    const generation = sync.generation;
    setSyncStatus("syncing");
    void fetchServerPackWallet()
      .then((server) => {
        if (generation !== sync.generation) return;
        if (!server) {
          setSyncStatus("local");
          return;
        }
        sync.enabled = true;
        sync.rev = server.rev;
        sync.lastSyncedPayload = server.payload;
        const serverWallet = parseWalletPayload(server.payload);
        const local = walletRef.current ?? loaded;
        // First contact merges this device's history into the account
        // wallet; pushNow then no-ops if the server already has it all.
        commit(serverWallet ? reconcileWallets(local, serverWallet, Date.now()) : local);
      })
      .catch(() => {
        if (generation === sync.generation) setSyncStatus("local");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerId]);

  // Flush a pending push when the tab goes to background, so closing the
  // browser right after a pack rarely loses the debounce window.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      const sync = syncRef.current;
      if (sync.enabled && sync.pushTimer) {
        clearTimeout(sync.pushTimer);
        sync.pushTimer = null;
        void runPushNow();
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const regenerating = wallet !== null && wallet.charges < MAX_PACK_CHARGES;
  useEffect(() => {
    if (!regenerating) return;
    const interval = setInterval(() => {
      setNowMs(Date.now());
      const current = walletRef.current;
      if (!current) return;
      // Pure regen ticks skip the server push; reconciles re-settle charges
      // from lastRefillAt anyway, and the next real mutation carries them.
      const settled = settleCharges(current, Date.now());
      if (settled !== current) commit(settled, false);
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenerating]);

  return {
    wallet,
    nowMs,
    syncStatus,
    openPack: (cost) => {
      const current = walletRef.current;
      if (!current) return false;
      const next =
        cost.kind === "shards"
          ? spendShards(current, cost.amount)
          : spendCharge(current, Date.now());
      if (!next) return false;
      commit(next);
      return true;
    },
    recordPull: (pull) => {
      const current = walletRef.current;
      if (!current) return false;
      const result = recordPull(current, pull, Date.now());
      commit(result.wallet);
      return result.isNew;
    },
    recycleCard: (userId) => {
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("duplicates", userId);
          if (gained !== null) return gained;
          const current = walletRef.current;
          if (!current) return 0;
          const result = recycleDuplicates(current, userId);
          if (result.gained > 0) commit(result.wallet);
          return result.gained;
        })();
      }
      const current = walletRef.current;
      if (!current) return 0;
      const result = recycleDuplicates(current, userId);
      if (result.gained > 0) commit(result.wallet);
      return result.gained;
    },
    recycleWhole: (userId) => {
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("whole", userId);
          if (gained !== null) return gained;
          const current = walletRef.current;
          if (!current) return 0;
          const result = recycleAllCopies(current, userId);
          if (result.gained > 0) commit(result.wallet);
          return result.gained;
        })();
      }
      const current = walletRef.current;
      if (!current) return 0;
      const result = recycleAllCopies(current, userId);
      if (result.gained > 0) commit(result.wallet);
      return result.gained;
    },
    recycleWholeMany: (userIds) => {
      const recycleManyLocally = () => {
        let working = walletRef.current;
        if (!working) return 0;
        let gained = 0;
        for (const userId of userIds) {
          const result = recycleAllCopies(working, userId);
          gained += result.gained;
          working = result.wallet;
        }
        if (gained > 0) commit(working);
        return gained;
      };
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("whole", undefined, userIds);
          return gained !== null ? gained : recycleManyLocally();
        })();
      }
      return recycleManyLocally();
    },
    recycleWholeMatching: (filter) => {
      const recycleMatchingLocally = () => {
        let working = walletRef.current;
        if (!working) return 0;
        let gained = 0;
        const userIds = ownedCards(working)
          .filter((card) => collectionCardMatchesFilter(card, filter))
          .map((card) => card.userId);
        for (const userId of userIds) {
          const result = recycleAllCopies(working, userId);
          gained += result.gained;
          working = result.wallet;
        }
        if (gained > 0) commit(working);
        return gained;
      };
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("whole_matching", undefined, undefined, filter);
          return gained !== null ? gained : recycleMatchingLocally();
        })();
      }
      return recycleMatchingLocally();
    },
    recycleAll: () => {
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("all_duplicates");
          if (gained !== null) return gained;
          const current = walletRef.current;
          if (!current) return 0;
          const result = recycleAllDuplicates(current);
          if (result.gained > 0) commit(result.wallet);
          return result.gained;
        })();
      }
      const current = walletRef.current;
      if (!current) return 0;
      const result = recycleAllDuplicates(current);
      if (result.gained > 0) commit(result.wallet);
      return result.gained;
    },
    applyMint: (userId, mint) => {
      const current = walletRef.current;
      if (!current) return false;
      const next = applyCardMint(current, userId, mint);
      if (!next) return false;
      commit(next);
      return true;
    },
    notePoolTotal: (total) => {
      const current = walletRef.current;
      if (!current || total === null || current.poolTotal === total) return;
      commit({ ...current, poolTotal: total });
    },
  };
}
