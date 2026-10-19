import { useCallback, useEffect, useRef, useState } from "react";
import {
  actOnOwnChainRun,
  fetchOwnChainRun,
  type ChainAction,
  type ChainActionResult,
  type ChainBoardEntry,
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
     open to this viewer (logged out, no backend, or gated). */
  available: boolean | null;
  view: ChainRunView | null;
  best: ChainBoardEntry | null;
  busy: boolean;
  act: (action: ChainAction) => Promise<ChainActOutcome>;
  refresh: () => void;
}

/* The signed-in player's chain run, held once on /packs. The server owns it:
   every action carries the rev of the last answer and comes back with the
   whole run, which replaces the one held here. */
export function useChainRun(enabled: boolean): ChainRunApi {
  const [available, setAvailable] = useState<boolean | null>(enabled ? null : false);
  const [view, setView] = useState<ChainRunView | null>(null);
  const [best, setBest] = useState<ChainBoardEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const revRef = useRef(0);
  /* A fetch and an action can cross; the one that started last wins. */
  const sequenceRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      setView(null);
      return;
    }
    let cancelled = false;
    const sequence = ++sequenceRef.current;
    void fetchOwnChainRun()
      .then((response) => {
        if (cancelled || sequence !== sequenceRef.current) return;
        if (!response) {
          setAvailable(false);
          setView(null);
          return;
        }
        revRef.current = response.rev;
        setView(response.run);
        setBest(response.best);
        setAvailable(true);
      })
      .catch(() => {
        if (!cancelled) setAvailable((current) => current ?? false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  const act = useCallback(async (action: ChainAction): Promise<ChainActOutcome> => {
    setBusy(true);
    const sequence = ++sequenceRef.current;
    try {
      const response = await actOnOwnChainRun({ data: { ...action, rev: revRef.current } });
      if (!response) return { ok: false, error: "unavailable", view: null };
      if (sequence === sequenceRef.current) {
        revRef.current = response.rev;
        setView(response.run);
        setBest(response.best);
      }
      if (response.status === "refused") return { ok: false, error: response.error, view: response.run };
      return { ok: true, result: response.result, view: response.run };
    } catch {
      return { ok: false, error: "failed", view: null };
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  return { available, view, best, busy, act, refresh };
}
