import { useCallback, useEffect, useRef, useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
  applyChainAction,
  buildChainPool,
  chainActionNeedsPool,
  chainRunStanding,
  chainRunView,
  normalizeChainRunState,
  type ChainAction,
  type ChainBoardEntry,
  type ChainCard,
  type ChainPool,
  type ChainRunState,
  type ChainRunView,
} from "#/lib/chain-run";
import { fetchLiveChainGuestPool } from "#/lib/live-backend";
import type { ChainActOutcome, ChainRunApi } from "./useChainRun";

/* A signed-out visitor's run: the same engine the backend runs, played in
   the browser on a slice of the pool and kept in localStorage. Nothing of it
   reaches the server, so it pays no prizes and stands on no board. */

const STORAGE_KEY = "mania-hub-overjoy-guest-v1";
const GUEST_NAME = msg`You`;

interface Saved {
  state: ChainRunState | null;
  /* The run's roster and the GOATs: all it deals from once started, so a
     reload plays on even after the server's slice has been resampled. */
  cards: ChainCard[];
  goats: ChainCard[];
  /* The chart cards (who played each comes from the cards above). */
  charts?: ChainCard[];
  best: { runNo: number; round: number; bestRow: number; rows: number; finished: boolean; updatedAt: number } | null;
  lastRunNo: number;
}

function readSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Saved>;
    return {
      state: parsed.state ? normalizeChainRunState(parsed.state) : null,
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
      goats: Array.isArray(parsed.goats) ? parsed.goats : [],
      charts: Array.isArray(parsed.charts) ? parsed.charts : [],
      best: parsed.best ?? null,
      lastRunNo: Number(parsed.lastRunNo) || 0,
    };
  } catch {
    return null;
  }
}

function writeSaved(saved: Saved): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A full or blocked storage only loses the run on reload.
  }
}

function rosterOf(state: ChainRunState, pool: ChainPool): ChainCard[] {
  const out: ChainCard[] = [];
  for (const id of state.roster) {
    const card = pool.byId.get(id);
    if (card) out.push(card);
  }
  return out;
}

function randomSeed(): number {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  return word[0]!;
}

/* Same shape as useChainRun, so the table plays a guest run unchanged. */
export function useGuestChainRun(enabled: boolean): ChainRunApi {
  const { i18n } = useLingui();
  const [available, setAvailable] = useState<boolean>(enabled);
  const [view, setView] = useState<ChainRunView | null>(null);
  const [savedBest, setSavedBest] = useState<Saved["best"]>(null);
  const [busy, setBusy] = useState(false);
  const savedRef = useRef<Saved>({ state: null, cards: [], goats: [], best: null, lastRunNo: 0 });
  /* The pool the current run plays on: the saved roster, or the server's
     slice once fetched for a new run. */
  const poolRef = useRef<ChainPool | null>(null);
  const slicePromiseRef = useRef<Promise<ChainPool | null> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      setView(null);
      return;
    }
    const saved = readSaved();
    if (saved) {
      savedRef.current = saved;
      if (saved.state && saved.cards.length) poolRef.current = buildChainPool(saved.cards, saved.goats, saved.charts ?? []);
      setView(saved.state ? chainRunView(saved.state) : null);
      setSavedBest(saved.best);
    }
    setAvailable(true);
  }, [enabled]);

  const loadSlice = useCallback((): Promise<ChainPool | null> => {
    if (!slicePromiseRef.current) {
      slicePromiseRef.current = fetchLiveChainGuestPool<ChainCard>().then((slice) => {
        if (!slice || slice.cards.length === 0) {
          slicePromiseRef.current = null;
          return null;
        }
        return buildChainPool(slice.cards, slice.goats, slice.charts);
      });
    }
    return slicePromiseRef.current;
  }, []);

  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const apply = async (action: ChainAction): Promise<ChainActOutcome> => {
    const saved = savedRef.current;
    let pool: ChainPool | null = null;
    if (chainActionNeedsPool(action.kind)) {
      // A new run deals a fresh roster from the server's slice; a run under
      // way keeps dealing from its own.
      pool = action.kind === "start" || !poolRef.current ? await loadSlice() : poolRef.current;
      if (!pool) return { ok: false, error: "pool_unavailable", view: saved.state ? chainRunView(saved.state) : null };
    }
    const now = Date.now();
    const applied = applyChainAction(saved.state, action, { pool, seed: randomSeed(), now, lastRunNo: saved.lastRunNo });
    if (!applied.ok) return { ok: false, error: applied.error, view: saved.state ? chainRunView(saved.state) : null };
    const state = applied.state;
    if (action.kind === "start" && pool) {
      poolRef.current = buildChainPool(rosterOf(state, pool), [...pool.goats], [...pool.charts]);
    }
    const standing = chainRunStanding(state);
    let best = saved.best;
    if (
      standing.round >= 1 &&
      (!best || best.runNo === state.runNo || standing.round > best.round || (standing.round === best.round && standing.bestRow > best.bestRow))
    ) {
      best = { runNo: state.runNo, ...standing, finished: state.phase === "over", updatedAt: now };
    }
    const next: Saved = {
      state,
      cards: poolRef.current ? [...poolRef.current.cards] : saved.cards,
      goats: poolRef.current ? [...poolRef.current.goats] : saved.goats,
      charts: poolRef.current ? [...poolRef.current.charts] : saved.charts ?? [],
      best,
      lastRunNo: Math.max(saved.lastRunNo, state.runNo),
    };
    savedRef.current = next;
    writeSaved(next);
    const nextView = chainRunView(state);
    setView(nextView);
    setSavedBest(best);
    return { ok: true, result: applied.result, view: nextView };
  };

  const act = useCallback((action: ChainAction): Promise<ChainActOutcome> => {
    const quiet = action.kind === "sign";
    if (!quiet) setBusy(true);
    const run = () => apply(action).catch((): ChainActOutcome => ({ ok: false, error: "failed", view: null }));
    const outcome = queueRef.current.then(run, run).finally(() => {
      if (!quiet && queueRef.current === outcome) setBusy(false);
    });
    queueRef.current = outcome;
    return outcome;
    // apply only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    const saved = readSaved();
    if (saved) {
      savedRef.current = saved;
      setView(saved.state ? chainRunView(saved.state) : null);
      setSavedBest(saved.best);
    }
  }, []);

  /* The board's "you" row: a stand-in with no rank, since guest runs stand
     on no board. */
  const best: ChainBoardEntry | null = savedBest
    ? {
        rank: 0,
        userId: 0,
        username: i18n._(GUEST_NAME),
        cc: "",
        round: savedBest.round,
        bestRow: savedBest.bestRow,
        rows: savedBest.rows,
        finished: savedBest.finished,
        updatedAt: savedBest.updatedAt,
      }
    : null;

  return { available, view, best, busy, act, refresh };
}
