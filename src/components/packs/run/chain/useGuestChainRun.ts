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

/* Two keys: the run (rewritten on every action, a few KB) and the cards it
   deals from (a few hundred KB, rewritten only when a new run takes its
   roster). v1 kept both in one key and rewrote it all on every action. */
const RUN_KEY = "mania-hub-overjoy-guest-v2";
const POOL_KEY = "mania-hub-overjoy-guest-pool-v2";
const LEGACY_KEY = "mania-hub-overjoy-guest-v1";
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

type SavedRun = Pick<Saved, "state" | "best" | "lastRunNo">;
/* The cards, tagged with the run they were saved for. */
type SavedPool = Pick<Saved, "cards" | "goats" | "charts"> & { runNo: number };

const list = (value: unknown): ChainCard[] => (Array.isArray(value) ? (value as ChainCard[]) : []);

function readKey(key: string): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function writeKey(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // A full or blocked storage only loses the run on reload.
    return false;
  }
}

function writePool(saved: Saved): boolean {
  const pool: SavedPool = { cards: saved.cards, goats: saved.goats, charts: saved.charts ?? [], runNo: saved.state?.runNo ?? 0 };
  return writeKey(POOL_KEY, pool);
}

function writeRun(saved: Saved): void {
  const run: SavedRun = { state: saved.state, best: saved.best, lastRunNo: saved.lastRunNo };
  writeKey(RUN_KEY, run);
}

function readSaved(): Saved | null {
  try {
    const legacy = readKey(LEGACY_KEY);
    if (legacy) {
      // A v1 save moves to the two keys once.
      const moved: Saved = {
        state: legacy.state ? normalizeChainRunState(legacy.state) : null,
        cards: list(legacy.cards),
        goats: list(legacy.goats),
        charts: list(legacy.charts),
        best: (legacy.best as Saved["best"]) ?? null,
        lastRunNo: Number(legacy.lastRunNo) || 0,
      };
      if (writePool(moved)) {
        writeRun(moved);
        window.localStorage.removeItem(LEGACY_KEY);
      }
      return moved;
    }
    const run = readKey(RUN_KEY);
    if (!run) return null;
    const state = run.state ? normalizeChainRunState(run.state) : null;
    const pool = readKey(POOL_KEY);
    // Cards saved for another run don't belong to this one.
    const ours = pool && state && Number(pool.runNo) === state.runNo ? pool : null;
    return {
      state,
      cards: list(ours?.cards),
      goats: list(ours?.goats),
      charts: list(ours?.charts),
      best: (run.best as Saved["best"]) ?? null,
      lastRunNo: Number(run.lastRunNo) || 0,
    };
  } catch {
    return null;
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
  // Unknown until the saved run is read, so a saved run never opens on the start screen.
  const [available, setAvailable] = useState<boolean | null>(enabled ? null : false);
  const [view, setView] = useState<ChainRunView | null>(null);
  const [savedBest, setSavedBest] = useState<Saved["best"]>(null);
  const [busy, setBusy] = useState(false);
  /* Loud actions still queued or running: busy clears when the last one lands,
     whatever quiet one was queued behind it. */
  const busyCountRef = useRef(0);
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
    const newPool = action.kind === "start" && pool !== null;
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
    // The cards only change when a run starts. They are tagged with the run,
    // so a reload never plays this run on another run's cards.
    if (newPool) writePool(next);
    writeRun(next);
    const nextView = chainRunView(state);
    setView(nextView);
    setSavedBest(best);
    return { ok: true, result: applied.result, view: nextView };
  };

  const act = useCallback((action: ChainAction): Promise<ChainActOutcome> => {
    const quiet = action.kind === "sign";
    if (!quiet) setBusy(true);
    const run = () => apply(action).catch((): ChainActOutcome => ({ ok: false, error: "failed", view: null }));
    if (!quiet) busyCountRef.current += 1;
    const outcome = queueRef.current.then(run, run).finally(() => {
      if (quiet) return;
      busyCountRef.current -= 1;
      if (busyCountRef.current === 0) setBusy(false);
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
