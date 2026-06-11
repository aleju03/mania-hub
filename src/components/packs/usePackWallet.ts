import { useEffect, useRef, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import {
  applyCardMint,
  loadWalletForViewer,
  MAX_PACK_CHARGES,
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
import { fetchServerPackWallet, pushServerPackWallet } from "#/lib/pack-wallet-sync";
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
  recycleCard: (userId: number) => number;
  /* Recycles every copy; the card leaves the collection. */
  recycleWhole: (userId: number) => number;
  recycleAll: () => number;
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
  pushTimer: ReturnType<typeof setTimeout> | null;
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
    pushTimer: null,
    pushing: false,
    generation: 0,
  });

  const schedulePush = (delayMs = PUSH_DEBOUNCE_MS) => {
    const sync = syncRef.current;
    if (!sync.enabled) return;
    if (sync.pushTimer) clearTimeout(sync.pushTimer);
    sync.pushTimer = setTimeout(() => {
      sync.pushTimer = null;
      void pushNow();
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
      const result = await pushServerPackWallet({ data: { payload, baseRev: sync.rev } });
      if (generation !== sync.generation) return;
      if (!result) {
        // Logged out server-side or no backend configured: stay local.
        sync.enabled = false;
        setSyncStatus("local");
        return;
      }
      if (result.ok) {
        sync.rev = result.rev;
        sync.lastSyncedPayload = payload;
        // Mutations that landed mid-flight get their own push.
        if (JSON.stringify(walletRef.current) !== payload) schedulePush();
        else setSyncStatus("synced");
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

  const commit = (next: PackWallet, syncEligible = true) => {
    walletRef.current = next;
    writePackWallet(keyRef.current, next);
    setWallet(next);
    // Keep countdowns honest immediately after a spend instead of waiting
    // for the next interval tick.
    setNowMs(Date.now());
    if (syncEligible) schedulePush();
  };

  useEffect(() => {
    const sync = syncRef.current;
    sync.generation += 1;
    sync.enabled = false;
    sync.rev = 0;
    sync.lastSyncedPayload = null;
    if (sync.pushTimer) {
      clearTimeout(sync.pushTimer);
      sync.pushTimer = null;
    }
    setSyncStatus("local");

    keyRef.current = packWalletStorageKey(viewerId);
    const loaded = loadWalletForViewer(viewerId, Date.now());
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
        void pushNow();
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
      const current = walletRef.current;
      if (!current) return 0;
      const result = recycleDuplicates(current, userId);
      if (result.gained > 0) commit(result.wallet);
      return result.gained;
    },
    recycleWhole: (userId) => {
      const current = walletRef.current;
      if (!current) return 0;
      const result = recycleAllCopies(current, userId);
      if (result.gained > 0) commit(result.wallet);
      return result.gained;
    },
    recycleAll: () => {
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
