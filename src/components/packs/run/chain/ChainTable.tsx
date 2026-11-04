import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CHAIN_RULES,
  CHAIN_SCENE_INK,
  CHAIN_SCENE_NUMBERS,
  chainPackName,
  chainRefusalMessage,
  chainSharedTraits,
  chainCardFace,
  chainWouldLink,
  formatChainScore,
  scoreChainRow,
  type ChainAction,
  type ChainBoardEntry,
  type ChainCard,
  type ChainCardInstance,
  type ChainPayLine,
  type ChainContract,
  CHAIN_CONTRACT_COPY,
  chainReelTile,
  type ChainPlayOutcome,
  type ChainWysiField,
  type ChainWysiStamp,
  type ChainRowResult,
  type ChainRunView,
  type ChainSceneId,
  chainModLook,
  type ChainRunMode,
} from "#/lib/chain-run";
import type { PackTypeId } from "#/lib/packs";
import { getCachedCardBackDataUrl } from "../../packArt";
import { PaintBackdrop } from "./PaintBackdrop";
import { takeChainEntryOrigin } from "./chainEntry";
import { ChainButtons, IconFan, IconSwap, KIT, MARKER } from "./chainKit";
import { HeldMods } from "./ChainMods";
import { RUN_FEEL } from "../runFeel";
import { juice } from "../runJuice";
import { runSound } from "../runSound";
import { playMapPreview, stopMapPreview } from "./chainMapPreview";
import { useShudder } from "../shopMotion";
import { Shards } from "../Shards";
import { ChainBoard, type CardEnter, type LinkFx } from "./ChainBoard";
import { ChainDetailsLayer, hideChainDetails } from "./ChainDetails";
import { ChainOver, ChainStart } from "./ChainEnd";
import { BoardPanel, type LoadBoard, type LoadSheet } from "./ChainBoardPanel";
import { CHAIN_FEEL } from "./chainFeel";
import { ChainScenes, ChainTopBar, HudDeck } from "./ChainHud";
import { ChainHowTo } from "./ChainHowTo";
import { setWysiRunKey } from "./wysiSeen";
import { boardLayout, type BoardLayout } from "./chainLayout";
import { ChainPackStage, chainPackType, DeckPile, type PackKeepOutcome, type StageName } from "./ChainPackStage";
import { ChainScoring } from "./ChainScoring";
import { ChainBoostChips } from "./ChainReel";
import { ContractTracker } from "./ChainContracts";
import { ChainShop, type ShopActResult } from "./ChainShop";
import type { ChainActOutcome } from "./useChainRun";

/* Dev fixture hooks (dev/chainFixtures.tsx). */
export interface ChainTableScript {
  /* Packs tear and pick on their own. */
  autoPack?: boolean;
  /* A row laid out on mount (hand uids), the first `place` of it. */
  row?: number[] | null;
  place?: number;
  /* Then play it after a beat. */
  autoPlay?: boolean;
  /* Land the row on its slam at once. */
  skipReplay?: boolean;
  /* The round's pack counts as dealt already. */
  dealt?: boolean;
  /* The run's end plays its moment on mount. */
  fresh?: boolean;
  onSignal?: (signal: string) => void;
}

export interface ChainTableProps {
  view: ChainRunView | null;
  best: ChainBoardEntry | null;
  busy: boolean;
  act: (action: ChainAction) => Promise<ChainActOutcome>;
  reducedMotion: boolean;
  packThumbs: Partial<Record<PackTypeId, string>>;
  /* A signed-out guest run (useGuestChainRun). */
  guest?: boolean;
  loadBoard: LoadBoard;
  loadSheet: LoadSheet;
  onExit: () => void;
  script?: ChainTableScript;
  /* Signed in: the player's own run or the daily run, and the switch. */
  mode?: ChainRunMode;
  onMode?: (mode: ChainRunMode) => void;
}

interface PlayState {
  row: ChainRowResult;
  outcome: ChainPlayOutcome;
  pay: ChainPayLine[];
  forgotten: "grew" | "gone" | null;
  ascended: boolean;
  before: ChainRunView;
  /* A 727 the row left on the table, stamped once the row lands. */
  wysi: ChainWysiStamp | null;
  /* The signed contract, settled by this row (a clear or a failed round). */
  contract: { contract: ChainContract; met: boolean } | null;
  /* This clear won the run. */
  won: boolean;
}

type Aftermath =
  | { kind: "clear"; round: number; total: number; interest: number; chart: number }
  | { kind: "banner"; text: string; tone: "red" | "gold" | "green" };

const DEALT_KEY = "chain-run-dealt";

function roundKey(view: ChainRunView): string {
  return `${view.runNo}:${view.round}:${view.rebirths}`;
}

function readDealt(): string | null {
  try {
    return window.sessionStorage.getItem(DEALT_KEY);
  } catch {
    return null;
  }
}

function writeDealt(key: string) {
  try {
    window.sessionStorage.setItem(DEALT_KEY, key);
  } catch {
    // Private mode: the round pack may play again on a reload.
  }
}

function useBoardBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/* The chain run as a game table: the round's meter across the top, the row
   of six in the middle with its links, the hand under it, the scene cards in
   a corner, over the run's living backdrop. Packs open here as moments (torn,
   dealt, turned over), rows play out step by step and slam into the round
   score, and the shop and the run's end take the middle in turn. The server
   owns the run; this replays what it answers and keeps only the row being
   arranged. */
export function ChainTable(props: ChainTableProps) {
  const { view, best, busy, act, reducedMotion, packThumbs, loadBoard, loadSheet, onExit, script, guest = false, mode = "normal", onMode } = props;
  const daily = mode === "daily";
  const { i18n, t } = useLingui();
  const [boxRef, box] = useBoardBox();
  const narrow = box.width > 0 ? box.width < 700 : typeof window !== "undefined" && window.innerWidth < 700;

  const [hold, setHold] = useState<ChainRunView | null>(null);
  const shown = hold ?? view;
  // Hover stats remember their 727s per run (wysiSeen.ts).
  const wysiRunKey = view ? `${view.runNo}:${view.startedAt}` : "";
  useEffect(() => setWysiRunKey(wysiRunKey), [wysiRunKey]);
  const [rowUids, setRowUids] = useState<number[]>(() => (script?.row ? script.row.slice(0, script.place ?? script.row.length) : []));
  const [play, setPlay] = useState<PlayState | null>(null);
  /* The played row's server request, awaited once the chain lands. */
  const playRequestRef = useRef<Promise<ChainActOutcome> | null>(null);
  /* A drag's row as it would land if dropped now; previews read it. */
  const [dragRow, setDragRow] = useState<number[] | null>(null);
  const arrangedUids = dragRow ?? rowUids;
  /* The hand's order on this table: a card dragged back from the row keeps
     the place it was dropped at. Cards the server deals later go last. */
  const [handOrder, setHandOrder] = useState<number[]>([]);
  /* Several cards picked to move at once, in the order they were picked. */
  const [selected, setSelected] = useState<number[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  /* A held mod picked to use: the next hand card tapped takes it. */
  const [modPick, setModPick] = useState<number | null>(null);
  /* Bumped for a card each time it is dealt anew, so it remounts (comes in
     from the deck) rather than springing from where it last was. */
  const [dealGen, setDealGen] = useState<Record<number, number>>({});
  const [linkFx, setLinkFx] = useState<Record<string, LinkFx> | null>(null);
  /* On a phone a hand of more than six (committed, so a drag never
     resizes it) takes three rows. */
  const baseLayout: BoardLayout | null = box.width > 0 && box.height > 0 ? boardLayout(box.width, box.height) : null;
  /* On a phone the deck pile lives in the bar; draws and kept cards fly
     from and to where it sits there, in board px. */
  const [hudDeck, setHudDeck] = useState<BoardLayout["deck"] | null>(null);
  useLayoutEffect(() => {
    if (!baseLayout?.narrow) {
      if (hudDeck) setHudDeck(null);
      return;
    }
    const chip = document.querySelector<HTMLElement>("[data-chain-hud-deck] > div");
    const origin = boxRef.current?.getBoundingClientRect();
    const rect = chip?.getBoundingClientRect();
    if (!chip || !origin || !rect) return;
    const next = { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height };
    if (!hudDeck || Math.abs(hudDeck.x - next.x) > 1 || Math.abs(hudDeck.y - next.y) > 1) setHudDeck(next);
  });
  const layout: BoardLayout | null = baseLayout && baseLayout.narrow && hudDeck ? { ...baseLayout, deck: hudDeck } : baseLayout;
  const [cardCombo, setCardCombo] = useState<Record<number, number>>({});
  const [handsLit, setHandsLit] = useState<number[]>([]);
  const [scoreOverride, setScoreOverride] = useState<number | null>(null);
  const [shardOverride, setShardOverride] = useState<number | null>(null);
  const [aftermath, setAftermath] = useState<Aftermath | null>(null);
  /* How to play: opens by itself on a first visit to the start screen. */
  const [howTo, setHowTo] = useState(false);
  /* "+N base" rising off Stamina cards an unbroken 6 just grew. */
  const [growPops, setGrowPops] = useState<Array<{ id: string; x: number; y: number; add: number }>>([]);
  const [dealt, setDealt] = useState<string | null>(() => (script?.dealt && view ? roundKey(view) : typeof window === "undefined" ? null : readDealt()));
  const [enters, setEnters] = useState<Map<number, CardEnter>>(new Map());
  const [overFresh, setOverFresh] = useState(Boolean(script?.fresh));
  const [message, setMessage] = useState<string | null>(null);
  const [heat, setHeat] = useState<"mod" | "fire" | null>(null);
  /* The table's last beats of a round: cards leaving for the deck, or the
     row a run failed on greying out. */
  const [leaving, setLeaving] = useState(false);
  const [failedRow, setFailedRow] = useState(false);
  /* The next surface (keep pick, or the run's end) comes in while the
     cards are still on their way to the deck. */
  const [overlapNext, setOverlapNext] = useState(false);
  /* The chain's running total while a row plays, and the target crossing. */
  const [live, setLive] = useState(0);
  const [crossFlash, setCrossFlash] = useState(0);
  const [backUrl, setBackUrl] = useState<string | null>(null);
  const [playShudderX, playShudder] = useShudder(reducedMotion);
  const signal = useCallback((name: string) => script?.onSignal?.(name), [script]);

  useEffect(() => {
    setBackUrl(getCachedCardBackDataUrl());
    runSound.prefetch();
  }, []);

  /* The table owns the viewport while it is up. */
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    window.scrollTo(0, 0);
    return () => {
      root.style.overflow = previous;
      runSound.fireLoopStop();
      hideChainDetails();
    };
  }, []);

  /* Room shake and lean, as the pack run's table (feel §5). */
  const shakeX = useMotionValue(0);
  const shakeY = useMotionValue(0);
  const shakeRotate = useMotionValue(0);
  const jiggleRef = useRef({ value: 0, frame: 0, last: 0, t: 0 });
  const leanX = useMotionValue(0);
  const leanY = useMotionValue(0);
  const leanSpringX = useSpring(leanX, RUN_FEEL.lean.spring);
  const leanSpringY = useSpring(leanY, RUN_FEEL.lean.spring);
  const shake = useCallback(
    (amount: number) => {
      if (reducedMotion || amount <= 0) return;
      const jiggle = jiggleRef.current;
      jiggle.value = Math.min(3, jiggle.value + amount);
      if (jiggle.frame) return;
      const feel = RUN_FEEL.shake;
      jiggle.last = performance.now();
      const tick = (now: number) => {
        const dt = Math.min(50, now - jiggle.last);
        jiggle.last = now;
        jiggle.t += dt / 1000;
        jiggle.value *= Math.exp(-dt / feel.tauMs);
        const reach = window.innerWidth * feel.magnitudeWidthFraction * jiggle.value;
        const tau = Math.PI * 2;
        shakeX.set(reach * Math.sin(tau * feel.xHz * jiggle.t));
        shakeY.set(reach * 0.8 * Math.sin(tau * feel.yHz * jiggle.t + 1.3));
        shakeRotate.set(feel.rollDeg * jiggle.value * Math.sin(tau * feel.rollHz * jiggle.t));
        if (jiggle.value > 0.01) {
          jiggle.frame = window.requestAnimationFrame(tick);
        } else {
          jiggle.frame = 0;
          jiggle.value = 0;
          shakeX.set(0);
          shakeY.set(0);
          shakeRotate.set(0);
        }
      };
      jiggle.frame = window.requestAnimationFrame(tick);
    },
    [reducedMotion, shakeRotate, shakeX, shakeY],
  );
  useEffect(() => () => window.cancelAnimationFrame(jiggleRef.current.frame), []);

  const flash = useCallback(
    (text: string) => {
      setMessage(text);
      window.setTimeout(() => setMessage((current) => (current === text ? null : current)), 2600);
    },
    [],
  );

  /* A 727 on the table: the stamp on each number it showed on, the clip.
     A played row's stamp waits for the row to land (onReplayDone). */
  const [hudWysi, setHudWysi] = useState<{ id: number; on: ChainWysiField[] } | null>(null);
  const wysiIdRef = useRef(0);
  const stampWysi = useCallback((stamp: ChainWysiStamp, only?: (on: ChainWysiField) => boolean) => {
    const on = stamp.hits.map((hit) => hit.on).filter((field) => !only || only(field));
    if (!on.length) return;
    const id = ++wysiIdRef.current;
    setHudWysi({ id, on });
    runSound.wysi(false);
    window.setTimeout(() => setHudWysi((current) => (current?.id === id ? null : current)), 1800);
  }, []);

  const doAct = useCallback(
    async (action: ChainAction): Promise<ChainActOutcome> => {
      const outcome = await act(action);
      if (!outcome.ok && outcome.error !== "stale") flash(chainRefusalMessage(outcome.error, i18n));
      if (outcome.ok && outcome.result.wysi && outcome.result.kind !== "playRow") stampWysi(outcome.result.wysi);
      return outcome;
    },
    [act, flash, i18n, stampWysi],
  );

  /* Row cards that left the hand (a resync, a redraw) leave the row too. */
  const handUids = shown?.hand.map((entry) => entry.uid).join(",") ?? "";
  useEffect(() => {
    if (!shown) return;
    const inHand = new Set(shown.hand.map((entry) => entry.uid));
    setRowUids((current) => (current.every((uid) => inHand.has(uid)) ? current : current.filter((uid) => inHand.has(uid))));
    // Keyed on the hand's uids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handUids]);

  /* A round's pack opens once per round (and again after a rebirth). A run
     picked up mid-round skips it. */
  useEffect(() => {
    if (!shown || shown.phase !== "play" || play) return;
    const key = roundKey(shown);
    if (dealt === key) return;
    if (shown.rowsLeft < CHAIN_RULES.rows || shown.redrawsLeft < CHAIN_RULES.redraws || !shown.hand.some((entry) => entry.pack)) {
      setDealt(key);
      writeDealt(key);
    }
  }, [dealt, play, shown]);
  const needsRoundPack = Boolean(shown && shown.phase === "play" && !play && dealt !== roundKey(shown));

  /* The round's chart: its song, once per round, as the round opens. */
  const previewedRef = useRef<string | null>(null);
  const previewSet = shown?.phase === "play" ? (shown.roundChart?.chart?.setId ?? 0) : 0;
  const previewKey = shown && previewSet ? `${roundKey(shown)}:${previewSet}` : null;
  useEffect(
    () => () => {
      previewedRef.current = null;
      stopMapPreview(0);
    },
    [],
  );
  useEffect(() => {
    if (!previewKey || previewedRef.current === previewKey) return;
    previewedRef.current = previewKey;
    playMapPreview(previewSet);
  }, [previewKey, previewSet]);

  /* ------------------------------------------------------------ arranging */

  const handEntries = useMemo(() => {
    const hand = shown?.hand ?? [];
    if (!handOrder.length) return hand;
    const rank = new Map(handOrder.map((uid, index) => [uid, index]));
    return hand
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (rank.get(a.entry.uid) ?? 1000 + a.index) - (rank.get(b.entry.uid) ?? 1000 + b.index))
      .map(({ entry }) => entry);
  }, [handOrder, shown?.hand]);
  const orderedHandRef = useRef(handEntries);
  orderedHandRef.current = handEntries;
  /* The hand's order is the player's own and lasts the whole run (deck
     cards keep their uid from round to round), kept on this device only.
     Cards dealt later go to the right end; row cards keep their old place
     in it, so one tapped back returns there. */
  const orderKey = shown ? `${HAND_ORDER_PREFIX}${shown.runNo}:${shown.startedAt}` : null;
  useEffect(() => {
    if (!orderKey) return;
    try {
      const stored = JSON.parse(window.localStorage.getItem(orderKey) ?? "[]");
      setHandOrder(Array.isArray(stored) ? stored.filter((value): value is number => Number.isSafeInteger(value)) : []);
    } catch {
      setHandOrder([]);
    }
  }, [orderKey]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const commitOrder = useCallback(
    (next: number[]) => {
      setHandOrder(next);
      if (!orderKey) return;
      try {
        const live = viewRef.current;
        const known = new Set([...(live?.hand ?? []), ...(live?.deck ?? [])].map((entry) => entry.uid));
        window.localStorage.setItem(orderKey, JSON.stringify(next.filter((uid) => known.size === 0 || known.has(uid))));
        // Only the current run's order is kept.
        for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
          const key = window.localStorage.key(index);
          if (key && key.startsWith(HAND_ORDER_PREFIX) && key !== orderKey) window.localStorage.removeItem(key);
        }
      } catch {
        // Storage full or blocked: the order lasts this visit only.
      }
    },
    [orderKey],
  );
  const rowEntries = useMemo(
    () => arrangedUids.map((uid) => handEntries.find((entry) => entry.uid === uid)).filter(Boolean) as ChainCardInstance[],
    [handEntries, arrangedUids],
  );
  /* The arranged row with the scene cards held: what its links draw. */
  // Previews are blind to 727s: one lands as a surprise, never something to search for.
  const preview = useMemo(() => (shown && rowEntries.length ? scoreChainRow(shown, rowEntries, { blind: true }) : null), [rowEntries, shown]);
  /* The number the row shows before it plays: its plain links and combos,
     with practice levels (Balatro's hand value with its planets). Second
     passes, scene card effects and row multipliers are left out, so a strong
     build can beat it. */
  const levels = shown?.levels;
  const plainTotal = useMemo(() => (rowEntries.length ? scoreChainRow({ scenes: [], levels }, rowEntries, { blind: true }).total : 0), [rowEntries, levels]);
  /* Hand cards against the row's last card: the marks a linking card shares
     with it (lit on the card), and the ones that would break (dimmed). */
  const { wouldLink, breakers } = useMemo(() => {
    const map = new Map<number, { level: number; traits: Set<string> }>();
    const breaks = new Set<number>();
    if (!shown || !rowEntries.length || rowEntries.length >= CHAIN_RULES.rowMax) return { wouldLink: map, breakers: breaks };
    const last = rowEntries[rowEntries.length - 1];
    for (const entry of handEntries) {
      if (arrangedUids.includes(entry.uid)) continue;
      if (!chainWouldLink(shown, rowEntries, entry)) {
        breaks.add(entry.uid);
        continue;
      }
      const shared = chainSharedTraits(last.card, entry.card).filter((trait) => trait.trait !== "scene");
      map.set(entry.uid, { level: 0, traits: new Set(shared.map((trait) => trait.trait)) });
    }
    return { wouldLink: map, breakers: breaks };
  }, [handEntries, rowEntries, arrangedUids, shown]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelected([]);
      setSelectMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const arranging = Boolean(shown && shown.phase === "play" && !play && !needsRoundPack && !aftermath && !busy);

  const toRow = useCallback(
    (uid: number) => {
      hideChainDetails();
      setRowUids((current) => {
        if (current.includes(uid)) return current;
        if (current.length >= CHAIN_RULES.rowMax) {
          runSound.refuse();
          return current;
        }
        runSound.deal(current.length);
        return [...current, uid];
      });
    },
    [],
  );
  const toHand = useCallback((uid: number) => {
    hideChainDetails();
    runSound.uiTap();
    setRowUids((current) => current.filter((value) => value !== uid));
  }, []);
  const dragRowRef = useRef<number[] | null>(null);
  const onDragRow = useCallback((row: number[] | null) => {
    dragRowRef.current = row;
    setDragRow(row);
  }, []);
  const rowUidsRef = useRef(rowUids);
  rowUidsRef.current = rowUids;
  /* Picks only live while arranging, and only for cards still in hand. */
  useEffect(() => {
    if (!arranging) {
      setSelected((current) => (current.length ? [] : current));
      setSelectMode(false);
      return;
    }
    const inHand = new Set(handEntries.map((entry) => entry.uid));
    setSelected((current) => (current.every((uid) => inHand.has(uid)) ? current : current.filter((uid) => inHand.has(uid))));
  }, [arranging, handEntries]);
  const onDragEnd = useCallback(
    (uids: number[], handIndex: number | null) => {
      const proposed = dragRowRef.current;
      dragRowRef.current = null;
      setDragRow(null);
      if (proposed) setRowUids(proposed);
      const finalRow = proposed ?? rowUidsRef.current;
      const landed = uids.filter((uid) => finalRow.includes(uid));
      const rest = uids.filter((uid) => !finalRow.includes(uid));
      const fromHand = !rowUidsRef.current.includes(uids[0]);
      if (landed.length && fromHand) {
        runSound.deal(finalRow.indexOf(landed[0]));
        // Cards that did not fit stay picked, in the hand.
        if (rest.length) runSound.refuse();
        setSelected(rest.length > 1 || (rest.length === 1 && uids.length > 1) ? rest : []);
        return;
      }
      setSelected([]);
      if (!rest.length) return;
      if (handIndex === null) {
        if (proposed) runSound.uiTap();
        return;
      }
      // In the hand where they were let go, in order: before the card now
      // at that spot among the visible hand cards, every other card keeping
      // its place.
      runSound.charmMove();
      const order = orderedHandRef.current.map((entry) => entry.uid).filter((value) => !rest.includes(value));
      const visible = order.filter((value) => !finalRow.includes(value));
      const at = handIndex < visible.length ? order.indexOf(visible[handIndex]) : visible.length ? order.indexOf(visible[visible.length - 1]) + 1 : order.length;
      order.splice(Math.max(0, at), 0, ...rest);
      commitOrder(order);
    },
    [commitOrder],
  );

  /* Picking several cards: Ctrl/Cmd-click toggles one, Shift-click adds the
     run of cards between the last pick and this one; all picks stay on one
     side (row or hand). */
  const onSelect = useCallback(
    (uid: number, range: boolean) => {
      hideChainDetails();
      const inRow = rowUidsRef.current.includes(uid);
      const line = inRow
        ? rowUidsRef.current
        : orderedHandRef.current.map((entry) => entry.uid).filter((value) => !rowUidsRef.current.includes(value));
      setSelected((current) => {
        const sameSide = current.length > 0 && current.every((value) => line.includes(value));
        const base = sameSide ? current : [];
        if (range && base.length) {
          const from = line.indexOf(base[base.length - 1]);
          const to = line.indexOf(uid);
          const step = to >= from ? 1 : -1;
          const add: number[] = [];
          for (let index = from + step; step > 0 ? index <= to : index >= to; index += step) {
            if (!base.includes(line[index])) add.push(line[index]);
          }
          return [...base, ...add];
        }
        return base.includes(uid) ? base.filter((value) => value !== uid) : [...base, uid];
      });
      runSound.uiTap();
    },
    [],
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  /* A picked mod goes on the card tapped next, in the hand or the row. */
  const applyModTo = useCallback(
    async (uid: number) => {
      if (modPick === null) return;
      hideChainDetails();
      const outcome = await doAct({ kind: "useMod", index: modPick, uid });
      setModPick(null);
      if (!outcome.ok || outcome.result.kind !== "useMod") {
        runSound.refuse();
        return;
      }
      runSound.charmFire(3);
      shake(0.5);
    },
    [doAct, modPick, shake],
  );
  /* Send the picks: hand cards into the next free slots in pick order (the
     ones that do not fit stay picked), row cards back to the hand. */
  const onSendGroup = useCallback(() => {
    const group = selectedRef.current;
    if (!group.length) return;
    hideChainDetails();
    const row = rowUidsRef.current;
    if (row.includes(group[0])) {
      setRowUids(row.filter((uid) => !group.includes(uid)));
      setSelected([]);
      setSelectMode(false);
      runSound.uiTap();
      return;
    }
    const room = Math.max(0, CHAIN_RULES.rowMax - row.length);
    const going = group.slice(0, room);
    const left = group.slice(room);
    if (going.length) {
      setRowUids([...row, ...going]);
      going.forEach((_, index) => window.setTimeout(() => runSound.deal(row.length + index), index * 60));
    }
    if (left.length) runSound.refuse();
    setSelected(left);
    if (!left.length) setSelectMode(false);
  }, []);
  const onClearSelection = useCallback(() => setSelected([]), []);

  /* Cards dealt in from the deck pile, turning over as they land. */
  const enterFromDeck = useCallback(
    (uids: number[], lead = 0) => {
      if (!layout) return;
      const deck = layout.deck;
      const scale = deck.w / layout.cardW;
      setEnters((current) => {
        const next = new Map(current);
        uids.forEach((uid, index) => {
          next.set(uid, {
            x: deck.x + deck.w / 2 - layout.cardW / 2,
            y: deck.y + deck.h / 2 - layout.cardH / 2,
            scale,
            rotate: 12,
            delayMs: lead + index * RUN_FEEL.deal.staggerMs,
            flipAtMs: lead + index * RUN_FEEL.deal.staggerMs + 260,
          });
        });
        return next;
      });
      uids.forEach((_, index) => window.setTimeout(() => runSound.deal(index), reducedMotion ? 0 : lead + index * RUN_FEEL.deal.staggerMs));
    },
    [layout, reducedMotion],
  );

  const playRow = useCallback(async () => {
    if (!shown || !arranging || !rowUids.length) {
      if (shown && !rowUids.length) {
        playShudder();
        runSound.refuse();
      }
      return;
    }
    hideChainDetails();
    const before = shown;
    setHold(before);
    /* The engine is the server's, so the row scores here exactly as it will
       there: the chain starts on the tap while the server applies the row,
       and its answer (the outcome, pay, draws) is only needed once the row
       lands (onReplayDone). */
    const local = scoreChainRow(before, rowEntries);
    const request = doAct({ kind: "playRow", uids: rowUids });
    playRequestRef.current = request;
    setLinkFx({});
    setCardCombo({});
    setHandsLit([]);
    setScoreOverride(before.roundScore);
    setPlay({ row: local, outcome: "continue", pay: [], forgotten: null, ascended: false, before, wysi: null, contract: null, won: false });
    signal("play:start");
    const outcome = await request;
    if (!outcome.ok || outcome.result.kind !== "playRow") {
      setPlay(null);
      setScoreOverride(null);
      setHold(null);
      if (!outcome.ok && outcome.error === "stale") setRowUids([]);
      else {
        playShudder();
        runSound.refuse();
      }
      return;
    }
    // Should the two ever disagree, the server's row is the one that counts.
    const served = outcome.result.row;
    if (served.total !== local.total) setPlay((current) => (current && current.before === before ? { ...current, row: served } : current));
  }, [arranging, doAct, playShudder, rowEntries, rowUids, shown, signal]);

  const redraw = useCallback(async () => {
    if (!shown || !arranging || !rowUids.length || shown.redrawsLeft <= 0) return;
    // An Eternal never goes back: it stays laid out while the rest redraw.
    const eternal = new Set(shown.hand.filter((entry) => entry.card.eternal).map((entry) => entry.uid));
    const uids = rowUids.filter((uid) => !eternal.has(uid));
    if (!uids.length) {
      runSound.refuse();
      return;
    }
    hideChainDetails();
    const outcome = await doAct({ kind: "redraw", uids });
    if (!outcome.ok || outcome.result.kind !== "redraw") {
      runSound.refuse();
      return;
    }
    setRowUids((current) => current.filter((uid) => eternal.has(uid)));
    runSound.reroll();
    enterFromDeck(outcome.result.drawn, 200);
  }, [arranging, doAct, enterFromDeck, rowUids, shown]);

  /* Fixtures: a row laid out on mount, played after a beat. */
  const autoPlayedRef = useRef(false);
  useEffect(() => {
    if (!script?.autoPlay || autoPlayedRef.current || !arranging || !layout) return;
    const timer = window.setTimeout(() => {
      autoPlayedRef.current = true;
      void playRow();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [arranging, layout, playRow, script?.autoPlay]);

  /* ------------------------------------------------------------ the row plays */

  const finishPlay = useCallback((keepBanner = false) => {
    setPlay(null);
    setHeat(null);
    setLeaving(false);
    setFailedRow(false);
    setOverlapNext(false);
    setLive(0);
    setLinkFx(null);
    setCardCombo({});
    setHandsLit([]);
    setScoreOverride(null);
    setShardOverride(null);
    if (!keepBanner) setAftermath(null);
    setHold(null);
    setRowUids([]);
  }, []);

  const onReplayDone = useCallback(async () => {
    if (!play) return;
    // The chain ran on the local score; what the row did comes from the server.
    const settled = await playRequestRef.current;
    if (!settled || !settled.ok || settled.result.kind !== "playRow") return;
    const served = settled.result;
    const { before } = play;
    const { outcome, pay, forgotten, row } = served;
    const wysi = served.wysi ?? null;
    const contract = served.contract ?? null;
    const won = Boolean(served.won);
    signal("play:slam");
    // The round score (or round and target) lands now; shards with the pay.
    if (wysi) stampWysi(wysi, (on) => on !== "shards" || outcome !== "cleared");
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, reducedMotion ? Math.min(ms, 200) : ms));
    // An unbroken row of 6 grew the deck's Stamina cards: each one on the
    // table pops its "+N base" and its number pulses; the banner says why.
    if (row.growth?.length) {
      const trained = row.growth.reduce((most, grow) => Math.max(most, grow.add), 0);
      const origin = boxRef.current?.getBoundingClientRect();
      const pops: Array<{ id: string; x: number; y: number; add: number }> = [];
      for (const grow of row.growth) {
        const element = document.querySelector<HTMLElement>(`[data-chain-card="${grow.uid}"]`);
        if (!element || !origin) continue;
        const rect = element.getBoundingClientRect();
        pops.push({ id: `${grow.uid}-${Date.now()}`, x: rect.left - origin.left + rect.width / 2, y: rect.top - origin.top, add: grow.add });
        if (!reducedMotion) {
          element.querySelector<HTMLElement>("[data-chain-base]")?.animate(
            [{ transform: "scale(1)", color: "#ffffff" }, { transform: "scale(1.35)", color: "#8ff2b7" }, { transform: "scale(1)", color: "#ffffff" }],
            { duration: 700, easing: "ease-out" },
          );
        }
      }
      setGrowPops(pops);
      setAftermath({ kind: "banner", text: t`Unbroken 6: Stamina cards +${trained} base`, tone: "green" });
      runSound.charmFire(3);
      await wait(1300);
      setAftermath(null);
      setGrowPops([]);
    }
    if (forgotten === "gone") {
      setAftermath({ kind: "banner", text: t`Over ${CHAIN_SCENE_NUMBERS.starTimesTarget}x the target. Once Forgotten left.`, tone: "red" });
      runSound.refuse();
      await wait(1300);
    } else if (forgotten === "grew") {
      const scene = document.querySelector("[data-chain-scene='forgotten']");
      if (scene && !reducedMotion) juice(scene, RUN_FEEL.juice.firingCharm);
      runSound.charmFire(4);
    }
    if (outcome === "continue") {
      // New to the hand: anything not in the old hand, and the played cards
      // the deck dealt straight back (they leave with the row and come back
      // face down from the deck as fresh cards).
      const kept = before.hand.filter((entry) => !row.uids.includes(entry.uid)).map((entry) => entry.uid);
      const drawn = view?.hand.filter((entry) => !kept.includes(entry.uid)).map((entry) => entry.uid) ?? [];
      setDealGen((current) => {
        const next = { ...current };
        for (const uid of drawn) next[uid] = (next[uid] ?? 0) + 1;
        return next;
      });
      finishPlay();
      enterFromDeck(drawn, 320);
      signal("play:done");
      return;
    }
    if (outcome === "cleared") {
      // A 727 stamp on the HUD gets its burst before the clear strip comes
      // in over it.
      if (wysi && wysi.hits.some((hit) => hit.on !== "shards")) await wait(650);
      runSound.songCleared("song");
      shake(1);
      // One shard total for the round, no itemised lines.
      const total = pay.reduce((sum, line) => sum + line.amount, 0);
      setShardOverride(before.shards + total);
      const part = (kind: "interest" | "chart") => pay.filter((line) => line.kind === kind).reduce((sum, line) => sum + line.amount, 0);
      setAftermath({ kind: "clear", round: before.round, total, interest: part("interest"), chart: part("chart") });
      stopMapPreview(900);
      runSound.tallyTotal();
      if (part("interest") > 0) window.setTimeout(() => runSound.interest(), reducedMotion ? 0 : 380);
      if (wysi) stampWysi(wysi, (on) => on === "shards");
      await wait(CHAIN_FEEL.pay.bannerMs + CHAIN_FEEL.pay.afterMs);
      runSound.fireLoopStop();
      setAftermath(null);
      // The win round: the run is won, and goes on as endless.
      if (won) {
        setAftermath({ kind: "banner", text: t`Run won! Endless from here`, tone: "gold" });
        runSound.songCleared("song");
        shake(1.4);
        await wait(2400);
        setAftermath(null);
      }
      // The signed contract settles after the pay.
      if (contract) {
        const name = i18n._(CHAIN_CONTRACT_COPY[contract.contract.id].name);
        if (contract.met) {
          const prize = chainReelTile(contract.contract.prize, i18n);
          setAftermath({ kind: "banner", text: t`Contract met: ${name}. ${prize.text}`, tone: "gold" });
          runSound.charmFire(4);
        } else {
          setAftermath({ kind: "banner", text: t`Contract missed: ${name}`, tone: "red" });
          runSound.refuse();
        }
        await wait(1500);
        setAftermath(null);
      }
      // The row and hand leave for the deck before the keep pick deals in.
      setLeaving(true);
      const travel = reducedMotion ? 0 : 40 * Math.min(12, before.hand.length) + 320;
      await wait(travel * 0.55);
      setOverlapNext(true);
      await wait(travel * 0.45);
      finishPlay();
      signal("clear:done");
      return;
    }
    if (outcome === "reborn") {
      setAftermath({ kind: "banner", text: t`Ascension to Heaven burns. Round ${before.round} again.`, tone: "gold" });
      runSound.fireIgnite();
      shake(1.2);
      await wait(1500);
      finishPlay();
      signal("play:done");
      return;
    }
    // failed: the row greys out and the table holds on it a beat before
    // the board comes in.
    runSound.fireLoopStop();
    stopMapPreview(600);
    setFailedRow(true);
    runSound.stepMiss();
    shake(0.6);
    // How short the round fell, where the other row outcomes speak.
    const reached = formatChainScore(before.roundScore + row.total);
    const goal = formatChainScore(before.target);
    setAftermath({ kind: "banner", text: t`${reached} of ${goal}`, tone: "red" });
    await wait(1000);
    setAftermath(null);
    // The row and hand leave for the deck before the board comes in.
    setLeaving(true);
    const travel = reducedMotion ? 0 : 40 * Math.min(12, before.hand.length) + 340;
    await wait(travel * 0.55);
    setOverFresh(true);
    setOverlapNext(true);
    await wait(travel * 0.45);
    finishPlay();
    signal("over");
  }, [enterFromDeck, finishPlay, play, reducedMotion, shake, signal, stampWysi, t, view]);

  const readoutAt = useCallback(() => {
    const element = boxRef.current;
    if (!element || !layout) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + layout.width / 2, y: rect.top + layout.readoutY, size: layout.narrow ? 40 : 68, top: rect.top, narrow: layout.narrow };
  }, [boxRef, layout]);

  /* ------------------------------------------------------------ packs */

  const packKeyRef = useRef("");
  /* What the surfaces read: the live run once the next one may come in
     over the leaving cards. */
  const stageView = overlapNext && view ? view : shown;
  const pack = stageView?.phase === "pack" ? stageView.pack : null;
  const packKey = pack && stageView ? `${stageView.runNo}|${stageView.round}|${pack.reason}|${pack.startIndex ?? ""}|${pack.offer?.kind ?? ""}|${stageView.totalRows}` : "";
  if (packKey) packKeyRef.current = packKey;

  const openPack = useCallback(async (): Promise<ChainCard[] | null> => {
    const outcome = await doAct({ kind: "openPack" });
    if (outcome.ok && outcome.result.kind === "openPack") return outcome.result.cards;
    if (!outcome.ok && outcome.error === "pack_open" && outcome.view?.pack?.cards) return outcome.view.pack.cards;
    if (!outcome.ok && outcome.error === "stale" && outcome.view?.pack?.cards) return outcome.view.pack.cards;
    return null;
  }, [doAct]);

  const keepCards = useCallback(
    async (ids: number[]): Promise<PackKeepOutcome | null> => {
      if (!shown) return null;
      setHold(shown);
      setShardOverride(shown.shards);
      const outcome = await doAct({ kind: "keep", ids });
      if (outcome.ok && outcome.result.kind === "keep") return outcome.result;
      setHold(null);
      setShardOverride(null);
      return null;
    },
    [doAct, shown],
  );

  const onKept = useCallback(() => {
    setHold(null);
    setShardOverride(null);
    signal("pack:kept");
  }, [signal]);

  const onShards = useCallback((delta: number) => setShardOverride((current) => (current === null ? null : current + delta)), []);

  const roundPackCards = useMemo(() => (needsRoundPack && shown ? shown.hand.filter((entry) => entry.pack) : []), [needsRoundPack, shown]);

  const onJoin = useCallback(
    (rects: DOMRect[]) => {
      if (!shown || !layout) return;
      const element = boxRef.current;
      const origin = element?.getBoundingClientRect();
      const next = new Map<number, CardEnter>();
      roundPackCards.forEach((entry, index) => {
        const rect = rects[index];
        if (!rect || !origin || rect.width === 0) return;
        const scale = rect.width / layout.cardW;
        const cx = rect.left - origin.left + rect.width / 2;
        const cy = rect.top - origin.top + (rect.width * 1.4) / 2;
        next.set(entry.uid, { x: cx - layout.cardW / 2, y: cy - layout.cardH / 2, scale, rotate: 0, delayMs: index * CHAIN_FEEL.pack.joinStaggerMs });
      });
      setEnters(next);
      const key = roundKey(shown);
      setDealt(key);
      writeDealt(key);
      // The pack's cards already dealt with their sound out of the pack; the
      // flight into the hand is one soft move, not a second deal.
      runSound.charmMove();
      const deckCards = shown.hand.filter((entry) => !entry.pack).map((entry) => entry.uid);
      window.setTimeout(() => enterFromDeck(deckCards, 0), reducedMotion ? 0 : roundPackCards.length * CHAIN_FEEL.pack.joinStaggerMs + 120);
      window.setTimeout(() => signal("round:dealt"), reducedMotion ? 0 : 1400);
    },
    [boxRef, enterFromDeck, layout, reducedMotion, roundPackCards, shown, signal],
  );

  const onStage = useCallback((stage: StageName) => signal(`stage:${stage}`), [signal]);

  /* ------------------------------------------------------------ shop */

  const shopAct = useCallback(
    async (action: ChainAction): Promise<ShopActResult> => {
      const outcome = await act(action);
      return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error };
    },
    [act],
  );
  const sell = useCallback(
    async (scene: ChainSceneId) => {
      const outcome = await doAct({ kind: "sell", scene });
      if (outcome.ok) {
        runSound.sell();
        shake(0.2);
      } else runSound.refuse();
    },
    [doAct, shake],
  );

  /* ------------------------------------------------------------ the look */

  const roundScore = scoreOverride ?? shown?.roundScore ?? 0;
  const target = shown?.target ?? 0;
  const fire = Boolean(shown && target > 0 && roundScore >= target && (play || aftermath?.kind === "clear"));
  const overNow = Boolean(shown?.phase === "over" && !play);
  /* Opened from the Overjoy doodle: the paint pours out of it and swallows
     the page, a circle growing from the doodle, the swirl racing while it
     spreads and the table fading in behind it. */
  const [entry, setEntry] = useState<{ x: number; y: number; r: number } | null>(() => {
    if (typeof window === "undefined" || reducedMotion) return null;
    const at = takeChainEntryOrigin();
    if (!at) return null;
    const y = at.y - 60;
    const r = Math.hypot(Math.max(at.x, window.innerWidth - at.x), Math.max(y, window.innerHeight - y)) + 40;
    return { x: at.x, y, r };
  });
  const [entering, setEntering] = useState(Boolean(entry));
  /* Starts closed, opens on the next frames so the transition runs. */
  const [poured, setPoured] = useState(false);
  useEffect(() => {
    if (!entry || poured) return;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setPoured(true));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [entry, poured]);
  useEffect(() => {
    if (!entering) return;
    const timer = window.setTimeout(() => setEntering(false), CHAIN_ENTRY_MS + 500);
    return () => window.clearTimeout(timer);
  }, [entering]);
  /* Room beside the row for the board: wide tables, not at the run's end
     (which has its own). */
  /* Only beside a round being played: the shop, the pack picks and the
     round's pack use the whole width, and the board would sit on them. */
  const showSideBoard = Boolean(!narrow && box.width >= 1380 && view && !overNow && view.phase === "play" && !needsRoundPack);
  /* The room only brightens with heat: more, faster, lighter triangles. */
  const roomHeat = entering ? 1 : overNow ? 0 : fire ? 1 : play && heat === "fire" ? 0.85 : play && heat === "mod" ? 0.45 : 0;
  const shards = shardOverride ?? shown?.shards ?? 0;
  const showRound = Boolean(shown && shown.round > 0 && shown.phase !== "over");
  const scenesNode = shown ? (
    <ChainScenes
      scenes={shown.scenes}
      compact={narrow}
      ascension={shown.ascension}
      startCombo={shown.startCombo}
      onSell={shown.phase === "shop" ? (id) => void sell(id) : undefined}
      sellDisabled={busy}
    />
  ) : null;

  const modsNode =
    shown && shown.phase === "play" && shown.mods.length ? (
      <HeldMods mods={shown.mods} picked={modPick} compact={narrow} disabled={!arranging} onPick={(index) => {
        runSound.uiTap();
        setModPick(index);
      }} />
    ) : null;
  // A picked mod is put back when the table stops taking input.
  useEffect(() => {
    if (!arranging) setModPick(null);
  }, [arranging]);

  useEffect(() => {
    if (!shown) return;
    if (shown.phase === "shop") signal("shop");
    if (shown.phase === "over" && !play) signal("over:shown");
  }, [play, shown, signal]);

  const stagePack = stageView?.phase === "pack" && pack ? pack : null;
  const surfaceTitle =
    stagePack && shown
      ? stagePack.reason === "round"
        ? t`Keep one`
        : chainPackName(stagePack, shown.round, i18n)
      : needsRoundPack && shown
        ? chainPackName({ reason: "round" }, shown.round, i18n)
        : view?.phase === "shop" && !play && !overNow
          ? t`Shop`
          : null;
  const showBoard = Boolean(shown && (shown.phase === "play" || play));
  const actionsVisible = Boolean(showBoard && !play && !needsRoundPack && !aftermath && !leaving && !failedRow && layout);

  return (
    <div
      className="fixed inset-x-0 top-[60px] z-40 h-[calc(100dvh-60px)] pb-[env(safe-area-inset-bottom)] select-none overflow-hidden bg-osu-b6 text-white"
      translate="no"
      style={
        entry
          ? {
              clipPath: `circle(${poured ? entry.r : 0}px at ${entry.x}px ${entry.y}px)`,
              transition: `clip-path ${CHAIN_ENTRY_MS}ms cubic-bezier(0.75, 0, 0.25, 1)`,
            }
          : undefined
      }
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "clip-path") setEntry(null);
      }}
    >
      <PaintBackdrop
        stage={overNow ? "over" : view?.phase === "shop" && !play ? "shop" : stagePack || needsRoundPack ? "pack" : "round"}
        heat={roomHeat}
        dim={overNow}
        reducedMotion={reducedMotion}
      />
      <motion.div
        className="relative h-full"
        style={{ x: leanSpringX, y: leanSpringY }}
        onPointerMove={(event) => {
          if (reducedMotion || event.pointerType === "touch") return;
          leanX.set((event.clientX - window.innerWidth / 2) * RUN_FEEL.lean.fraction);
          leanY.set((event.clientY - window.innerHeight / 2) * RUN_FEEL.lean.fraction);
        }}
        onPointerLeave={() => {
          leanX.set(0);
          leanY.set(0);
        }}
      >
        <motion.div style={{ x: shakeX, y: shakeY, rotate: shakeRotate }} className="relative flex h-full flex-col">
          {/* The chain's fire burns here, under the HUD (whose score, target
              and meter sit on opaque plates over it) and over the board. */}
          <div data-chain-flame-layer="" className="pointer-events-none absolute inset-0 z-[2]" />
          <ChainTopBar
            narrow={narrow}
            round={shown?.round ?? 0}
            target={target}
            roundScore={roundScore}
            meterScore={play ? play.before.roundScore + live : roundScore}
            heatScore={play ? play.before.roundScore + live : aftermath?.kind === "clear" ? roundScore : 0}
            ghostScore={play ? play.before.roundScore + live : arranging ? roundScore + plainTotal : roundScore}
            crossFlash={crossFlash}
            star={shown?.star ?? null}
            shards={shards}
            showRound={showRound}
            showMeter={Boolean(showRound && (shown?.phase === "play" || play))}
            scoreBanked={Boolean(play) && scoreOverride === play?.before.roundScore}
            reducedMotion={reducedMotion}
            onExit={onExit}
            scenes={
              narrow && !overNow ? (
                <>
                  {modsNode}
                  {scenesNode}
                </>
              ) : null
            }
            wysi={hudWysi}
            roundChart={shown?.phase === "play" ? shown.roundChart : null}
            daily={daily && Boolean(shown)}
            onHelp={() => setHowTo(true)}
            onSwitchMode={onMode && !guest && !play ? () => onMode(daily ? "normal" : "daily") : undefined}
            inDaily={daily}
            deck={
              narrow && shown && !overNow ? (
                <HudDeck count={shown.phase === "play" ? shown.drawPileCount : shown.deck.length} backUrl={backUrl} />
              ) : null
            }
          />

          <div ref={boxRef} className="relative min-h-0 flex-1">
            <ChainHowTo open={howTo} narrow={narrow} onClose={() => setHowTo(false)} />
            <AnimatePresence>
              {growPops.map((pop) => (
                <motion.div
                  key={pop.id}
                  className="pointer-events-none absolute z-[60] whitespace-nowrap leading-none"
                  style={{ left: pop.x, top: pop.y, x: "-50%", fontFamily: MARKER, fontSize: narrow ? 18 : 24, color: "#8ff2b7", WebkitTextStroke: "5px #120f1a", paintOrder: "stroke fill" }}
                  initial={reducedMotion ? false : { y: 10, opacity: 0, scale: 0.6 }}
                  animate={{ y: -18, opacity: 1, scale: 1 }}
                  exit={{ y: -34, opacity: 0, transition: { duration: 0.25 } }}
                  transition={{ type: "spring", stiffness: 520, damping: 18 }}
                >
                  <Trans>+{pop.add} base</Trans>
                </motion.div>
              ))}
            </AnimatePresence>
            {layout && shown && showBoard && !needsRoundPack && (
              <>
                {/* The row's total as it stands, quiet until it plays. */}
                <ChainBoard
                  layout={layout}
                  hand={handEntries}
                  rowUids={play ? play.row.uids : arrangedUids}
                  committedRow={rowUids}
                  hiddenUids={needsRoundPack ? new Set(shown.hand.map((entry) => entry.uid)) : EMPTY}
                  mode={arranging ? "arrange" : "locked"}
                  preview={play ? play.row : preview}
                  wouldLink={wouldLink}
                  breakers={breakers}
                  linkFx={play ? linkFx : null}
                  cardCombo={play ? cardCombo : {}}
                  handsLit={handsLit}
                  enters={enters}
                  backUrl={backUrl}
                  reducedMotion={reducedMotion}
                  onToRow={toRow}
                  onToHand={toHand}
                  onDragRow={onDragRow}
                  onDragEnd={onDragEnd}
                  leaving={leaving}
                  failed={failedRow}
                  selected={selected}
                  dealGen={dealGen}
                  selectMode={selectMode || modPick !== null}
                  onSelect={modPick !== null ? (uid) => void applyModTo(uid) : onSelect}
                  onSendGroup={onSendGroup}
                  onClearSelection={onClearSelection}
                  roundChart={shown.roundChart}
                />
                {!needsRoundPack && !layout.narrow && <DeckPile layout={layout} count={shown.drawPileCount} backUrl={backUrl} bump={0} reducedMotion={reducedMotion} />}
                {actionsVisible && modPick !== null && shown.mods[modPick] && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-[5] text-center font-black leading-none"
                    style={{ top: layout.slots[0].y - (layout.narrow ? 54 : 78), fontFamily: MARKER, fontSize: layout.narrow ? 15 : 20, color: KIT.pink }}
                  >
                    <Trans>Tap a card for {chainModLook(shown.mods[modPick], i18n).name}</Trans>
                  </div>
                )}
                {actionsVisible && (
                  <div className="absolute inset-x-0 flex items-center justify-center" style={{ top: layout.actionsY, height: layout.narrow ? 48 : 52 }}>
                    {/* Pick several (tap cards to pick them, tap a picked one
                        to send them all), the row, and a redraw, chained.
                        Rows and redraws left sit on the buttons that spend
                        them. */}
                    <ChainButtons
                      compact={layout.narrow}
                      items={[
                        {
                          key: "pick",
                          title: t`Pick several cards`,
                          label: <Trans>Pick several</Trans>,
                          icon: <IconFan size={layout.narrow ? 26 : 30} />,
                          active: selectMode,
                          onClick: () => {
                            runSound.uiTap();
                            setSelectMode((current) => {
                              if (current) setSelected([]);
                              return !current;
                            });
                          },
                        },
                        {
                          key: "play",
                          primary: true,
                          title: t`Play row`,
                          label: <Trans>Play row</Trans>,
                          sub: layout.narrow ? undefined : (
                            <>
                              {Array.from({ length: CHAIN_RULES.rows }, (_, index) => (
                                <span key={index} className={`inline-block h-[8px] w-[8px] rounded-full bg-current ${index < shown.rowsLeft ? "" : "opacity-25"}`} />
                              ))}
                              <span className="ml-0.5">
                                <Trans>{shown.rowsLeft} left</Trans>
                              </span>
                            </>
                          ),
                          badge: shown.rowsLeft,
                          tone: "#f3e9d8",
                          muted: !rowUids.length,
                          disabled: busy,
                          style: { x: playShudderX },
                          onClick: () => void playRow(),
                        },
                        {
                          key: "redraw",
                          title: t`Redraw (${shown.redrawsLeft} left)`,
                          label: (
                            <>
                              <Trans>Redraw</Trans> <span style={{ color: "#7fc4ff" }}>x{shown.redrawsLeft}</span>
                            </>
                          ),
                          icon: <IconSwap size={layout.narrow ? 26 : 30} />,
                          tone: "#7fc4ff",
                          badge: shown.redrawsLeft,
                          disabled: !rowUids.length || shown.redrawsLeft <= 0 || busy,
                          onClick: () => void redraw(),
                        },
                      ]}
                    />
                  </div>
                )}
              </>
            )}

            {/* One title at a time across the table's surfaces: the old one
                leaves before the next comes in. */}
            <AnimatePresence mode="wait">
              {layout && surfaceTitle && (
                <motion.div
                  key={surfaceTitle}
                  className="pointer-events-none absolute inset-x-0 z-[30] text-center"
                  style={{ top: layout.narrow ? 14 : 26 }}
                  initial={reducedMotion ? false : { opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8, transition: { duration: 0.14 } }}
                  transition={{ duration: 0.18 }}
                >
                  <div className="leading-none text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: layout.narrow ? 24 : 38 }}>
                    {surfaceTitle}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* The shop comes in from the live run, under a pack stage that
                is still finishing its keep, so it lands as the kept card
                leaves. */}
            {layout && view && view.phase === "shop" && !play && (
              <ChainShop
                view={view}
                layout={layout}
                busy={busy}
                packThumbs={packThumbs}
                reducedMotion={reducedMotion}
                act={shopAct}
                shake={shake}
                enterDelayMs={stagePack ? 300 : 0}
              />
            )}

            {layout && shown && needsRoundPack && (
              <ChainPackStage
                key={`round-${roundKey(shown)}`}
                layout={layout}
                title={chainPackName({ reason: "round" }, shown.round, i18n)}
                packType="standard"
                packThumb={packThumbs.standard ?? null}
                art={{ reason: "round", round: shown.round }}
                mode="join"
                sealed
                autoTear
                cards={roundPackCards.map((entry) => entry.card)}
                keep={0}
                backUrl={backUrl}
                reducedMotion={reducedMotion}
                deckCount={shown.deck.length}
                onOpen={async () => roundPackCards.map((entry) => entry.card)}
                onKeep={async () => null}
                onJoin={onJoin}
                onKept={() => {}}
                onShards={() => {}}
                shake={shake}
                auto={script?.autoPack}
                showTitle={false}
                onStageChange={onStage}
              />
            )}

            {layout && shown && stagePack && (
              <ChainPackStage
                key={`pack-${packKeyRef.current}`}
                layout={layout}
                title={stagePack.reason === "round" ? t`Keep one` : chainPackName(stagePack, shown.round, i18n)}
                packType={chainPackType(stagePack.reason, stagePack.offer)}
                packThumb={packThumbs[chainPackType(stagePack.reason, stagePack.offer)] ?? packThumbs.standard ?? null}
                art={{ reason: stagePack.reason, offer: stagePack.offer, round: shown.round }}
                mode="keep"
                sealed={stagePack.sealed}
                cards={stagePack.cards}
                keep={stagePack.keep}
                backUrl={backUrl}
                reducedMotion={reducedMotion}
                deckCount={shown.deck.length}
                onOpen={openPack}
                onKeep={keepCards}
                onJoin={() => {}}
                onKept={onKept}
                onShards={onShards}
                shake={shake}
                auto={script?.autoPack}
                autoTear={stagePack.reason === "shop" || (stagePack.reason === "start" && (stagePack.startIndex ?? 1) > 1)}
                showTitle={false}
                instant={stagePack.reason === "round"}
                quick={stagePack.reason === "start" && (stagePack.startIndex ?? 1) > 1}
                deckCards={stagePack.reason === "round" ? [] : shown.deck.map((entry) => entry.card)}
                onStageChange={onStage}
              />
            )}


            {view && (overNow || (overlapNext && view.phase === "over")) && (
              <ChainOver
                view={view}
                best={best}
                fresh={overFresh}
                busy={busy}
                narrow={narrow}
                reducedMotion={reducedMotion}
                loadBoard={loadBoard}
                loadSheet={loadSheet}
                onNewRun={() => {
                  setOverFresh(false);
                  // The daily run is one try: its end goes back to the player's own runs.
                  if (daily) onMode?.("normal");
                  else void doAct({ kind: "start" });
                }}
                daily={daily}
                onRevive={async () => {
                  const outcome = await doAct({ kind: "revive" });
                  if (!outcome.ok) return false;
                  setOverFresh(false);
                  runSound.fireIgnite();
                  shake(1);
                  flash(t`Revived: ${CHAIN_RULES.reviveRows} more rows.`);
                  return true;
                }}
                onExit={onExit}
                onShake={shake}
              />
            )}

            {!shown && view === null && (
              <ChainStart
                best={best}
                busy={busy}
                narrow={narrow}
                packThumb={packThumbs.standard ?? null}
                reducedMotion={reducedMotion}
                loadBoard={loadBoard}
                loadSheet={loadSheet}
                onNewRun={() => void doAct({ kind: "start" })}
                guest={guest}
                daily={daily}
                onDaily={onMode && !guest ? () => onMode("daily") : undefined}
                onHowTo={() => setHowTo(true)}
                onBack={onMode ? () => onMode("normal") : undefined}
              />
            )}

            {/* The signed contract's round, and what a met one left for its
                first row (until that row plays). */}
            {shown?.phase === "play" && (shown.contract || (arranging && shown.rowBoost)) && (
              <div className="pointer-events-auto absolute left-1/2 top-2 z-[5] flex -translate-x-1/2 flex-col items-center gap-2">
                {shown.contract && (
                  <ContractTracker
                    contract={shown.contract}
                    track={shown.contractTrack}
                    roundScore={shown.roundScore}
                    target={shown.target}
                    narrow={layout?.narrow ?? false}
                  />
                )}
                {arranging && shown.rowBoost && <ChainBoostChips boost={shown.rowBoost} />}
              </div>
            )}

            {/* A cleared round's pay, or a banner, over the board. */}
            <AnimatePresence>
              {aftermath && (
                <motion.div
                  key={aftermath.kind}
                  className={`pointer-events-none absolute inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-x-4 gap-y-1 bg-[#0c0a10] px-3 ${narrow ? "py-2" : "py-2.5"}`}
                  initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scaleY: 0.4 }}
                  animate={{ opacity: 1, scaleY: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.18 } }}
                  transition={{ type: "spring", stiffness: 420, damping: 30 }}
                >
                  {aftermath.kind === "clear" ? (
                    <motion.div
                      className={`flex items-baseline gap-3 font-black italic uppercase leading-none ${narrow ? "text-[22px]" : "text-[32px]"}`}
                      initial={reducedMotion ? false : { scale: 1.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 520, damping: 20 }}
                    >
                      <span className="text-[#ffd36b]">
                        <Trans>Round {aftermath.round} cleared</Trans>
                      </span>
                      <Shards value={aftermath.total} sign className={`not-italic text-osu-pink-light ${narrow ? "text-[18px]" : "text-[24px]"}`} />
                      {(aftermath.interest > 0 || aftermath.chart > 0) && (
                        <span className={`flex items-center gap-2 not-italic normal-case text-[#f3e9d8]/75 ${narrow ? "text-[12px]" : "text-[14px]"}`}>
                          {aftermath.chart > 0 && <Trans>+{aftermath.chart} map</Trans>}
                          {aftermath.chart > 0 && aftermath.interest > 0 && <span aria-hidden="true" className="h-3 w-px bg-[#f3e9d8]/30" />}
                          {aftermath.interest > 0 && <Trans>+{aftermath.interest} interest</Trans>}
                        </span>
                      )}
                    </motion.div>
                  ) : (
                    <motion.div
                      className={`px-4 text-center font-black italic uppercase leading-tight ${narrow ? "text-[24px]" : "text-[40px]"}`}
                      style={{ color: aftermath.tone === "red" ? "#ff8a8a" : aftermath.tone === "green" ? "#8ff2b7" : CHAIN_SCENE_INK.ascension }}
                      initial={reducedMotion ? false : { scale: 1.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 520, damping: 20 }}
                    >
                      {aftermath.text}
                    </motion.div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {message && (
                <motion.div
                  key={message}
                  className="pointer-events-none absolute inset-x-0 top-3 z-[70] flex justify-center"
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <span className="rounded-full bg-[#0c0a10]/90 px-4 py-1.5 text-[13px] font-bold text-[#ff8a8a]">{message}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {!narrow && shown && !overNow && shown.scenes.length > 0 && (
            <div className="absolute bottom-6 left-6 z-[4] flex flex-col gap-4">
              {modsNode}
              {scenesNode}
            </div>
          )}
          {/* The game's board beside the table on wide screens, this run's
              best lit in it. */}
          {showSideBoard && (
            <div className="pointer-events-auto absolute left-5 top-[18%] z-[4] w-[230px]">
              <div className="mb-2 px-2.5 leading-none text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: 22 }}>
                <Trans>Leaderboard</Trans>
              </div>
              <BoardPanel key={mode} compact loadBoard={loadBoard} loadSheet={loadSheet} mine={daily ? null : best} mineName={best?.username} refreshKey={`${view?.runNo ?? 0}:${shown?.round ?? 0}`} initialPeriod={daily ? "day" : "all"} />
            </div>
          )}

          {play && (
            <ChainScoring
              key={`${play.before.runNo}-${play.before.totalRows}`}
              row={play.row}
              names={play.row.uids.map((uid) => {
                const card = play.before.hand.find((entry) => entry.uid === uid)?.card;
                return card ? chainCardFace(card).name : "";
              })}
              roundBefore={play.before.roundScore}
              target={play.before.target}
              readoutAt={readoutAt}
              reducedMotion={reducedMotion}
              skip={script?.skipReplay}
              onLinkFx={(update) => setLinkFx((current) => update(current ?? {}))}
              onCardCombo={(index, combo) => setCardCombo((current) => (current[index] === combo ? current : { ...current, [index]: combo }))}
              onHandLit={(hand) => setHandsLit((current) => (current.includes(hand) ? current : [...current, hand]))}
              onShake={shake}
              onSlam={(score) => setScoreOverride(score)}
              onRunning={setLive}
              onCross={() => setCrossFlash((value) => value + 1)}
              onHeat={(next) => setHeat((current) => (current === "fire" ? current : next))}
              onDone={() => void onReplayDone()}
            />
          )}
        </motion.div>
      </motion.div>
      <ChainDetailsLayer />
    </div>
  );
}

const EMPTY = new Set<number>();
/* The opening pour from the Overjoy doodle. */
const CHAIN_ENTRY_MS = 850;

const HAND_ORDER_PREFIX = "chain-hand-order:";
