import { useCallback, useEffect, useRef, useState } from "react";
import {
  actOnOwnChainRun,
  fetchOwnChainRun,
  type ChainAction,
  type ChainActionResult,
  type ChainBoardEntry,
  type ChainRunMode,
  type ChainRunView,
} from "#/lib/chain-run";

/* What one action came back with. `view` is always the run as the server
   now has it, refusal or not: the table reconciles to it either way. A
   "stale" refusal means the action (or a double click of it) already went
   through, so the table only resyncs. */
export type ChainActOutcome =
  | { ok: true; result: ChainActionResult; view: ChainRunView | null }
  | { ok: false; error: string; view: ChainRunView | null };

export interface ChainRunApi {
  /* null while the first read is in flight; false when chain runs are not
     open to this viewer (logged out or no backend). */
  available: boolean | null;
  view: ChainRunView | null;
  best: ChainBoardEntry | null;
  busy: boolean;
  act: (action: ChainAction) => Promise<ChainActOutcome>;
  refresh: () => void;
}

/* A failed first read tries again after these waits, ms (and on focus). */
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];

/* The signed-in player's chain run, held once on /packs. The server owns it:
   every action carries the rev of the last answer and comes back with the
   whole run, which replaces the one held here. `onWalletPrize` runs when a
   played row met a contract whose prize went to the pack wallet. */
export function useChainRun(enabled: boolean, mode: ChainRunMode = "normal", onWalletPrize?: () => void): ChainRunApi {
  const [available, setAvailable] = useState<boolean | null>(enabled ? null : false);
  const [view, setView] = useState<ChainRunView | null>(null);
  const [best, setBest] = useState<ChainBoardEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const revRef = useRef(0);
  /* A fetch and an action can cross; the one that started last wins. */
  const sequenceRef = useRef(0);
  /* Actions go out one at a time, each with the rev the one before it got
     back, so two quick taps never race each other into a stale refusal. */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const busyCountRef = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /* The mode whose run the rev belongs to: none until its first read lands,
     and actions wait for it, so a tap right after a switch never sends the
     other run's rev. */
  const loadedModeRef = useRef<ChainRunMode | null>(null);
  const failuresRef = useRef(0);
  const onWalletPrizeRef = useRef(onWalletPrize);
  onWalletPrizeRef.current = onWalletPrize;

  useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      setView(null);
      loadedModeRef.current = null;
      return;
    }
    let cancelled = false;
    let retry = 0;
    const sequence = ++sequenceRef.current;
    if (loadedModeRef.current !== mode) {
      // Switching between the own and the daily run shows nothing stale.
      loadedModeRef.current = null;
      revRef.current = 0;
      setView(null);
    }
    const retryLater = () => setRefreshKey((value) => value + 1);
    void fetchOwnChainRun({ data: mode })
      .then((response) => {
        if (cancelled || sequence !== sequenceRef.current) return;
        failuresRef.current = 0;
        if (!response) {
          setAvailable(false);
          setView(null);
          return;
        }
        revRef.current = response.rev;
        loadedModeRef.current = mode;
        setView(response.run);
        setBest(response.best);
        setAvailable(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAvailable((current) => current ?? false);
        // a blip, not a closed door: try again later, and when the tab comes back
        const wait = RETRY_MS[Math.min(failuresRef.current, RETRY_MS.length - 1)];
        failuresRef.current += 1;
        retry = window.setTimeout(retryLater, wait);
        window.addEventListener("focus", onFocus);
      });
    function onFocus() {
      window.clearTimeout(retry);
      window.removeEventListener("focus", onFocus);
      retryLater();
    }
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, refreshKey, mode]);

  const act = useCallback((action: ChainAction): Promise<ChainActOutcome> => {
    // Signing a contract is shown at once by the shop and holds nothing else
    // up; everything else marks the table busy until it lands.
    const quiet = action.kind === "sign";
    if (!quiet) {
      busyCountRef.current += 1;
      setBusy(true);
    }
    const send = () => sendAction(action);
    const outcome = queueRef.current.then(send, send).finally(() => {
      if (quiet) return;
      busyCountRef.current -= 1;
      if (busyCountRef.current === 0) setBusy(false);
    });
    queueRef.current = outcome;
    return outcome;
    // sendAction only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendAction = async (action: ChainAction): Promise<ChainActOutcome> => {
    // the run of this mode hasn't loaded yet (just switched): its rev is unknown
    if (loadedModeRef.current !== modeRef.current) return { ok: false, error: "loading", view: null };
    const sequence = ++sequenceRef.current;
    try {
      const response = await actOnOwnChainRun({ data: { ...action, rev: revRef.current, mode: modeRef.current } });
      if (!response) return { ok: false, error: "unavailable", view: null };
      if (sequence === sequenceRef.current) {
        revRef.current = response.rev;
        setView(response.run);
        setBest(response.best);
      }
      if (response.status === "refused") return { ok: false, error: response.error, view: response.run };
      const { result } = response;
      if (result.kind === "playRow" && result.contract?.met && result.contract.contract.prize.id === "wallet") onWalletPrizeRef.current?.();
      return { ok: true, result, view: response.run };
    } catch {
      return { ok: false, error: "failed", view: null };
    }
  };

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  return { available, view, best, busy, act, refresh };
}
