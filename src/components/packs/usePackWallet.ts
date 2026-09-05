import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import type { ManiaCardTier } from "#/lib/maniacard";
import {
  applyCardMint,
  createEmptyWallet,
  loadWalletForViewer,
  MAX_PACK_CHARGES,
  ownedCards,
  packCardKeyOf,
  packWalletStorageKey,
  recordPull,
  recycleAllCopies,
  recycleAllDuplicates,
  recycleCopies,
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
  mergeServerPackWallet,
  mintServerPackCollectionCard,
  recycleServerPackCollection,
} from "#/lib/pack-wallet-sync";
import type { PackCost } from "#/lib/packs";

export type PackSyncStatus = "local" | "syncing" | "synced";

export interface PackWalletApi {
  /* Null until hydrated from localStorage (and during SSR). */
  wallet: PackWallet | null;
  /* Ticks once a second while charges regenerate, for countdown displays. */
  nowMs: number;
  /* "local" = browser-only (logged out or backend unreachable);
     "synced" = the server owns this wallet's numbers. */
  syncStatus: PackSyncStatus;
  /* Spends locally. Anonymous wallets only: a synced open is paid inside the
     server draw, whose response the page adopts via applyServerWallet. */
  openPack: (cost: PackCost) => boolean;
  recordPull: (pull: PulledCard) => boolean;
  /* Adopts a wallet state the server just returned (the draw response, a
     refused spend's true balance). The server's word is the wallet for a
     signed-in account, so this also marks the wallet synced. */
  applyServerWallet: (payload: string, rev: number) => void;
  /* Re-reads the server wallet; for surfaces whose shards were granted by a
     route that does not return the wallet (the arcade). */
  refreshServerWallet: () => void;
  /* Recycles a card's duplicate copies, keeping one. Cards are addressed by
     their wallet key (see packCardKey), not by player: a GOAT and an ordinary
     card of the same player are two cards and recycle separately. */
  recycleCard: (cardKey: string) => number | Promise<number>;
  /* Recycles every copy; the card leaves the collection. */
  recycleWhole: (cardKey: string) => number | Promise<number>;
  /* Whole-recycles a batch of cards in one server round-trip. */
  recycleWholeMany: (cardKeys: string[]) => number | Promise<number>;
  /* Hands back a set number of copies per card, keeping the rest. The pull
     summary recycles a freshly opened pack this way: a card the pack was the
     first copy of leaves the collection, a duplicate gives up only the copy
     the pack added. */
  recycleCopies: (entries: Array<{ cardKey: string; copies: number }>) => number | Promise<number>;
  recycleWholeMatching: (filter: PackCollectionFilter) => number | Promise<number>;
  recycleAll: () => number | Promise<number>;
  /* Backfills a recomputed mint (skills snapshot + tier) onto an owned
     card; used to upgrade legacy cards collected before snapshots existed.
     Resolves false when there was nothing to repair (or the repair failed). */
  applyMint: (cardKey: string, mint: Parameters<typeof applyCardMint>[2]) => boolean | Promise<boolean>;
  notePoolTotal: (total: number | null) => void;
}

const LOCAL_WRITE_TIMEOUT_MS = 900;

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

interface SyncState {
  enabled: boolean;
  rev: number;
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

/* Whether this browser holds pack history the server may never have seen:
   pre-login pulls and shards. Decides first contact's shape - offer it for
   the one-time merge, or just read the server wallet. A synced session's own
   local cache trips this too (it mirrors the server's shard count), which is
   fine: the merge endpoint refuses accounts with history and answers with
   the authoritative wallet either way, so the call doubles as the fetch. */
function hasLocalHistory(wallet: PackWallet): boolean {
  return (
    Object.keys(wallet.cards).length > 0 ||
    wallet.shards > 0 ||
    wallet.shardsSpent > 0 ||
    wallet.openedPacks > 0
  );
}

/* What the collection grid is currently showing, so a bulk action over
   "everything matching" recycles exactly those rows. */
export interface PackCollectionFilter {
  tier: ManiaCardTier | "all" | "unrated" | "untracked";
  query: string;
  duplicatesOnly?: boolean;
}

function collectionCardMatchesFilter(
  card: PackWallet["cards"][string],
  filter: PackCollectionFilter,
): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query && !card.username.toLowerCase().includes(query)) return false;
  if (filter.duplicatesOnly && card.copies <= 1) return false;
  if (filter.tier === "all") return true;
  if (filter.tier === "unrated") return card.tier === null;
  // Pool membership is server knowledge; a local wallet can't resolve it, and
  // the untracked filter is only reachable on synced collections anyway.
  if (filter.tier === "untracked") return false;
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

  /* Local-wallet commit: React state plus the debounced localStorage write.
     For a synced wallet the local copy is only a display cache; the numbers
     that matter come back from the server with every spend and grant. */
  const commit = (next: PackWallet) => {
    walletRef.current = next;
    scheduleLocalWrite(keyRef.current, next);
    setWallet(next);
    // Keep countdowns honest immediately after a spend instead of waiting
    // for the next interval tick.
    setNowMs(Date.now());
  };

  const commitServerWallet = (payload: string, rev: number) => {
    const parsed = parseWalletPayload(payload);
    if (!parsed) return;
    /* The backend persists regeneration lazily: a wallet can still store four
       charges with an old refill timestamp even though the fifth charge is
       already available. Project that timestamp before painting the server's
       response, instead of briefly regressing a settled local cache until the
       one-second countdown interval catches up. */
    const settled = settleCharges(parsed, Date.now());
    const sync = syncRef.current;
    sync.enabled = true;
    sync.rev = rev;
    commit(stripWalletCards(settled));
    setSyncStatus("synced");
  };

  const recycleOnServer = async (
    mode: "duplicates" | "whole" | "all_duplicates" | "whole_matching" | "copies",
    cardKey?: string,
    cardKeys?: string[],
    filter?: PackCollectionFilter,
    cardCopies?: Array<{ cardKey: string; copies: number }>,
    /* Walks the wallet through syncing on the way out. The collection panel
       re-reads its page whenever a sync lands, so a recycle that happened
       somewhere else on the page (the pull summary) announces itself this
       way; the panel's own recycles already refresh themselves and would
       only pay for a second read. */
    announce = false,
  ) => {
    const sync = syncRef.current;
    if (!sync.enabled) return null;
    try {
      if (announce) setSyncStatus("syncing");
      const result = await recycleServerPackCollection({
        data: {
          mode,
          cardKey,
          cardKeys,
          cardCopies,
          tier: filter?.tier,
          query: filter?.query,
          duplicatesOnly: filter?.duplicatesOnly === true,
        },
      });
      if (!result) {
        if (announce) setSyncStatus("synced");
        return null;
      }
      commitServerWallet(result.payload, result.rev);
      return result.gained;
    } catch {
      if (announce) setSyncStatus("synced");
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
    setSyncStatus("local");

    keyRef.current = packWalletStorageKey(viewerId);
    const loaded = loadWalletForViewer(viewerId, Date.now());
    walletRef.current = loaded;
    scheduleLocalWrite(keyRef.current, loaded);
    setWallet(loaded);
    setNowMs(Date.now());

    if (!viewerId) return;
    const generation = sync.generation;
    setSyncStatus("syncing");
    /* First contact. A browser holding local history offers it for the
       one-time merge (pre-login pulls fold into an account that has never
       played; for everyone else the server refuses and simply answers with
       the authoritative wallet). A clean browser just reads the wallet; a
       missing one starts from the defaults and is created by the first
       draw. Failure either way keeps this session browser-local - the local
       history is still on disk, so a later session retries the merge. */
    const contact = hasLocalHistory(loaded)
      ? mergeServerPackWallet({ data: { payload: JSON.stringify(loaded) } }).then((result) =>
          result ? { payload: result.payload, rev: result.rev } : null,
        )
      : fetchServerPackWallet().then((server) =>
          server
            ? { payload: server.payload ?? JSON.stringify(createEmptyWallet(Date.now())), rev: server.rev }
            : null,
        );
    void contact
      .then((server) => {
        if (generation !== sync.generation) return;
        if (!server) {
          setSyncStatus("local");
          return;
        }
        commitServerWallet(server.payload, server.rev);
      })
      .catch(() => {
        if (generation === sync.generation) setSyncStatus("local");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerId]);

  // Flush local durability when the page is leaving or backgrounded. Normal
  // interaction writes stay off animation frames.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      flushLocalWrite();
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
      // Display-only settling: the server re-runs the same regeneration math
      // from lastRefillAt at the moment a synced draw spends.
      const settled = settleCharges(current, Date.now());
      if (settled !== current) commit(settled);
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
      /* A synced collection's cards live in server rows, written by the draw
         itself - the local blob stays empty, and the caller prefers the
         draw's own isNew over this fallback answer. */
      if (syncRef.current.enabled) return result.isNew;
      commit(result.wallet);
      return result.isNew;
    },
    applyServerWallet: (payload, rev) => {
      commitServerWallet(payload, rev);
    },
    refreshServerWallet: () => {
      const sync = syncRef.current;
      if (!sync.enabled) return;
      const generation = sync.generation;
      void fetchServerPackWallet()
        .then((server) => {
          if (generation !== sync.generation || !server?.payload) return;
          commitServerWallet(server.payload, server.rev);
        })
        .catch(() => {});
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
    recycleCopies: (entries) => {
      const recycleCopiesLocally = () => {
        let working = walletRef.current;
        if (!working) return 0;
        let gained = 0;
        for (const entry of entries) {
          const result = recycleCopies(working, entry.cardKey, entry.copies);
          gained += result.gained;
          working = result.wallet;
        }
        if (gained > 0) commit(working);
        return gained;
      };
      if (syncRef.current.enabled) {
        return (async () => {
          const gained = await recycleOnServer("copies", undefined, undefined, undefined, entries, true);
          return gained !== null ? gained : recycleCopiesLocally();
        })();
      }
      return recycleCopiesLocally();
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
