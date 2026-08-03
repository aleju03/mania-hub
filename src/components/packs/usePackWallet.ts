import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import type { ManiaCardTier } from "#/lib/maniacard";
import {
  applyCardMint,
  loadWalletForViewer,
  MAX_PACK_CHARGES,
  ownedCards,
  packCardKeyOf,
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
  mintServerPackCollectionCard,
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
  /* Recycles a card's duplicate copies, keeping one. Cards are addressed by
     their wallet key (see packCardKey), not by player: a GOAT and an ordinary
     card of the same player are two cards and recycle separately. */
  recycleCard: (cardKey: string) => number | Promise<number>;
  /* Recycles every copy; the card leaves the collection. */
  recycleWhole: (cardKey: string) => number | Promise<number>;
  /* Whole-recycles a batch of cards in one server round-trip. */
  recycleWholeMany: (cardKeys: string[]) => number | Promise<number>;
  recycleWholeMatching: (filter: { tier: ManiaCardTier | "all" | "unrated"; query: string }) => number | Promise<number>;
  recycleAll: () => number | Promise<number>;
  /* Backfills a recomputed mint (skills snapshot + tier) onto an owned
     card; used to upgrade legacy cards collected before snapshots existed.
     Resolves false when there was nothing to repair (or the repair failed). */
  applyMint: (cardKey: string, mint: Parameters<typeof applyCardMint>[2]) => boolean | Promise<boolean>;
  notePoolTotal: (total: number | null) => void;
}

const PUSH_DEBOUNCE_MS = 1200;
const PUSH_RETRY_MS = 15_000;
const LOCAL_WRITE_TIMEOUT_MS = 900;

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

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
  const pendingLocalWriteRef = useRef<{ key: string; wallet: PackWallet } | null>(null);
  const localWriteIdleRef = useRef<number | null>(null);
  const localWriteTimeoutRef = useRef<number | null>(null);
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

  const cancelScheduledLocalWrite = () => {
    if (typeof window === "undefined") return;
    const idleWindow = window as WindowWithIdleCallback;
    if (localWriteIdleRef.current !== null) {
      idleWindow.cancelIdleCallback?.(localWriteIdleRef.current);
      localWriteIdleRef.current = null;
    }
    if (localWriteTimeoutRef.current !== null) {
      window.clearTimeout(localWriteTimeoutRef.current);
      localWriteTimeoutRef.current = null;
    }
  };

  const flushLocalWrite = () => {
    cancelScheduledLocalWrite();
    const pending = pendingLocalWriteRef.current;
    pendingLocalWriteRef.current = null;
    if (pending) writePackWallet(pending.key, pending.wallet);
  };

  const scheduleLocalWrite = (key: string, next: PackWallet) => {
    pendingLocalWriteRef.current = { key, wallet: next };
    if (typeof window === "undefined") return;
    cancelScheduledLocalWrite();
    const idleWindow = window as WindowWithIdleCallback;
    const write = () => {
      localWriteIdleRef.current = null;
      localWriteTimeoutRef.current = null;
      flushLocalWrite();
    };
    if (idleWindow.requestIdleCallback) {
      localWriteIdleRef.current = idleWindow.requestIdleCallback(write, { timeout: LOCAL_WRITE_TIMEOUT_MS });
    } else {
      // Keep storage serialization out of the input/animation task even on
      // Safari, which still lacks requestIdleCallback.
      localWriteTimeoutRef.current = window.setTimeout(write, 180);
    }
  };

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
          scheduleLocalWrite(keyRef.current, stripped);
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
    scheduleLocalWrite(keyRef.current, next);
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
    scheduleLocalWrite(keyRef.current, stripped);
    setWallet(stripped);
    setNowMs(Date.now());
    setSyncStatus("synced");
  };

  const recycleOnServer = async (
    mode: "duplicates" | "whole" | "all_duplicates" | "whole_matching",
    cardKey?: string,
    cardKeys?: string[],
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
          cardKey,
          cardKeys,
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
    // A viewer switch changes the storage key; finish the previous scope's
    // pending write before moving the ref to the new one.
    flushLocalWrite();
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
    scheduleLocalWrite(keyRef.current, loaded);
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

  // Flush local durability and a pending server push when the page is leaving
  // or backgrounded. Normal interaction writes stay off animation frames.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      flushLocalWrite();
      const sync = syncRef.current;
      if (sync.enabled && sync.pushTimer) {
        clearTimeout(sync.pushTimer);
        sync.pushTimer = null;
        void runPushNow();
      }
    };
    const onPageHide = () => flushLocalWrite();
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", onPageHide);
      flushLocalWrite();
    };
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

  /* The actions close over refs and stable setters only, so they keep one
     identity for the hook's lifetime; memoized consumers (the packs route's
     panels) rely on that to skip re-renders on countdown ticks. */
  const actions = useMemo<Omit<PackWalletApi, "wallet" | "nowMs" | "syncStatus">>(() => ({
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
    recycleCard: (cardKey) => {
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("duplicates", cardKey);
          if (gained !== null) return gained;
          const current = walletRef.current;
          if (!current) return 0;
          const result = recycleDuplicates(current, cardKey);
          if (result.gained > 0) commit(result.wallet);
          return result.gained;
        })();
      }
      const current = walletRef.current;
      if (!current) return 0;
      const result = recycleDuplicates(current, cardKey);
      if (result.gained > 0) commit(result.wallet);
      return result.gained;
    },
    recycleWhole: (cardKey) => {
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("whole", cardKey);
          if (gained !== null) return gained;
          const current = walletRef.current;
          if (!current) return 0;
          const result = recycleAllCopies(current, cardKey);
          if (result.gained > 0) commit(result.wallet);
          return result.gained;
        })();
      }
      const current = walletRef.current;
      if (!current) return 0;
      const result = recycleAllCopies(current, cardKey);
      if (result.gained > 0) commit(result.wallet);
      return result.gained;
    },
    recycleWholeMany: (cardKeys) => {
      const recycleManyLocally = () => {
        let working = walletRef.current;
        if (!working) return 0;
        let gained = 0;
        for (const cardKey of cardKeys) {
          const result = recycleAllCopies(working, cardKey);
          gained += result.gained;
          working = result.wallet;
        }
        if (gained > 0) commit(working);
        return gained;
      };
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("whole", undefined, cardKeys);
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
        const cardKeys = ownedCards(working)
          .filter((card) => collectionCardMatchesFilter(card, filter))
          .map(packCardKeyOf);
        for (const cardKey of cardKeys) {
          const result = recycleAllCopies(working, cardKey);
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
    applyMint: (cardKey, mint) => {
      // A synced wallet holds no cards in its blob (they live in server rows),
      // so the repair has to be written server-side or it is lost.
      if (syncRef.current.enabled) {
        return mintServerPackCollectionCard({
          data: { cardKey, tier: mint.tier, tierLabel: mint.tierLabel, skills: mint.skills },
        }).catch(() => false);
      }
      const current = walletRef.current;
      if (!current) return false;
      const next = applyCardMint(current, cardKey, mint);
      if (!next) return false;
      commit(next);
      return true;
    },
    notePoolTotal: (total) => {
      const current = walletRef.current;
      if (!current || total === null || current.poolTotal === total) return;
      commit({ ...current, poolTotal: total });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  return { wallet, nowMs, syncStatus, ...actions };
}
