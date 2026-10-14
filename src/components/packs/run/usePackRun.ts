import { useCallback, useEffect, useRef, useState } from "react";
import { actOnOwnPackRun, fetchOwnPackRun, type PackRunView, type ShopAction } from "#/lib/pack-run";

/* The signed-in collector's pack run, held once on /packs and handed to the
   stage line, the summary's tally and the run view. The server owns it: a
   dealt pack carries the run as it now stands (applyView), and every shop
   action answers with the whole run. `enabled` false (a local wallet, or a
   viewer runs are not released to) never calls. */
export interface PackRunApi {
  view: PackRunView | null;
  /* An action is in flight; the shop disables itself meanwhile. */
  busy: boolean;
  act: (action: ShopAction) => Promise<string | null>;
  applyView: (view: PackRunView) => void;
  refresh: () => void;
}

/* `onWallet` adopts the wallet a shop action answers with, so the shard
   count on the page moves the moment a charm is bought or sold. */
export function usePackRun(enabled: boolean, onWallet?: (payload: string, rev: number) => void): PackRunApi {
  const [view, setView] = useState<PackRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /* A draw's view and a fetch can cross; the one that started last wins. */
  const sequenceRef = useRef(0);
  const onWalletRef = useRef(onWallet);
  onWalletRef.current = onWallet;

  useEffect(() => {
    if (!enabled) {
      setView(null);
      return;
    }
    let cancelled = false;
    const sequence = ++sequenceRef.current;
    void fetchOwnPackRun()
      .then((result) => {
        if (cancelled || sequence !== sequenceRef.current) return;
        setView(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  const applyView = useCallback((next: PackRunView) => {
    sequenceRef.current += 1;
    setView((current) => ({
      ...next,
      masterSets: next.masterSets ?? current?.masterSets,
      poolTotal: next.poolTotal ?? current?.poolTotal,
    }));
  }, []);

  const act = useCallback(async (action: ShopAction): Promise<string | null> => {
    setBusy(true);
    try {
      const result = await actOnOwnPackRun({ data: action });
      if (!result) return "unavailable";
      if (result.status === "refused") return result.reason;
      applyView(result.view);
      if (result.wallet) onWalletRef.current?.(result.wallet.payload, result.wallet.rev);
      return null;
    } catch {
      return "failed";
    } finally {
      setBusy(false);
    }
  }, [applyView]);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  return { view, busy, act, applyView, refresh };
}
