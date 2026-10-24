import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import type { LivePackRunBoardEntry } from "#/lib/live-backend";
import type { PulledCard } from "#/lib/pack-collection";
import {
  liveCharms,
  rerollsLeft,
  type HandTypeId,
  type PackRunOpenPayload,
  type PackRunView,
  type RunBlind,
  type ShopAction,
} from "#/lib/pack-run";
import { PACK_TYPE_NAME_LABELS, type PackTypeDef, type PackTypeId } from "#/lib/packs";
import { getCachedCardBackDataUrl, PACK_ASPECT, PACK_TEAR_FRACTION } from "../packArt";
import type { PackCardState, RevealedCard } from "../RevealStage";
import { NudgeGlyph } from "./charmGlyphs";
import { RunBackdrop, type RunMood } from "./RunBackdrop";
import { prepareRunCard, type RunHandCard, type RunPreparedCard } from "./RunCard";
import { RunHand } from "./RunHand";
import { RunHud } from "./RunHud";
import { RunInfo } from "./RunInfo";
import { RunScoring, type RunScoringResult, type RunScoringStep } from "./RunScoring";
import { RunCharmRail } from "./RunCharmRail";
import { RunShop } from "./RunShop";
import { RunEnd } from "./RunEnd";
import { RunTally } from "./RunTally";
import { RUN_FEEL } from "./runFeel";
import { runSound } from "./runSound";
import { Shards } from "./Shards";

/* What the page's run open answered. `dealt` carries the hand to deal and
   the run's side of it; the rest put the pack back with a message. */
export type RunOpenResult =
  | { kind: "dealt"; cards: PackCardState[]; run: PackRunOpenPayload | null }
  | { kind: "busy"; reason: "write_pressure" | "rate_limited" }
  | { kind: "paused"; pausedUntil: number }
  | { kind: "insufficient" }
  | { kind: "failed" };

export type RunTablePhase = "rest" | "opening" | "dealing" | "flipping" | "scoring" | "tally";

/* Dev fixture hooks (dev/runFixtures.tsx): start the table mid-moment. */
export interface RunTableScript {
  /* Open the pack once the table has settled. */
  autoOpen?: boolean;
  /* A hand already dealt face up, with this open's scoring about to play. */
  preset?: { hand: RevealedCard[]; run: PackRunOpenPayload; skipToTotal?: boolean };
  /* The last pack's hand, face up, left on the table at rest. */
  restHand?: RevealedCard[];
  startInShop?: boolean;
  onPhase?: (phase: RunTablePhase) => void;
}

export interface RunPackChoice {
  id: PackTypeId;
  canOpen: boolean;
}

export interface RunTableProps {
  view: PackRunView;
  /* A shop action is in flight. */
  busy: boolean;
  act: (action: ShopAction) => Promise<string | null>;
  shards: number;
  charges: number;
  maxCharges: number;
  nextChargeMs: number | null;
  packType: PackTypeDef;
  packThumb: string | null;
  packChoices: RunPackChoice[];
  onSelectPackType: (id: PackTypeId) => void;
  canOpen: boolean;
  reducedMotion: boolean;
  /* The server draw with `run: true`, and everything the page does with it. */
  openPack: () => Promise<RunOpenResult>;
  /* Same contract as RevealStage's: called per card as it turns face up,
     returns whether it is a first copy; then once with the whole hand. */
  onCardRevealed: (pull: PulledCard) => boolean;
  onComplete: (revealed: RevealedCard[]) => void;
  onExit: () => void;
  prepareCard?: (card: PackCardState, queuePaint: <T>(work: () => Promise<T>) => Promise<T>) => Promise<RunPreparedCard>;
  loadBoard?: () => Promise<LivePackRunBoardEntry[]>;
  script?: RunTableScript;
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function useWideTable(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

function handCardOf(card: PackCardState): RunHandCard {
  return {
    key: card.player.cardKey ?? String(card.player.user.id),
    thumbnail: null,
    tier: null,
    edition: card.player.edition ?? null,
    faceUp: false,
  };
}

function handCardOfRevealed(entry: RevealedCard): RunHandCard {
  return {
    key: entry.player.cardKey ?? String(entry.player.user.id),
    thumbnail: entry.thumbnail,
    tier: entry.tier,
    edition: entry.player.edition ?? null,
    faceUp: true,
  };
}

function pullOf(entry: RunPreparedCard["entry"], skills: RunPreparedCard["skills"]): PulledCard {
  return {
    userId: entry.player.user.id,
    ...(entry.player.cardKey ? { cardKey: entry.player.cardKey } : {}),
    username: entry.player.user.username,
    avatarUrl: entry.player.user.avatar_url,
    countryCode: entry.player.user.country_code,
    tier: entry.tier,
    tierLabel: entry.tierLabel,
    skills,
    pp: entry.player.pp,
    globalRank: entry.player.globalRank,
  };
}

export type PackLook = "idle" | "charging" | "torn" | "gone";

/* The pack in the play area: the foil art cut into its tear strip and body,
   bobbing while it waits, tilting toward the pointer, and torn at the strip
   when opened. */
export function RunPack({
  thumb,
  accent,
  look,
  height,
  disabled,
  reducedMotion,
  onOpen,
  packRef,
}: {
  thumb: string | null;
  accent: { r: number; g: number; b: number };
  look: PackLook;
  height: number;
  disabled: boolean;
  reducedMotion: boolean;
  onOpen: () => void;
  packRef: React.Ref<HTMLButtonElement>;
}) {
  const { t } = useLingui();
  const width = Math.round(height * PACK_ASPECT);
  const strip = Math.round(height * PACK_TEAR_FRACTION);
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, RUN_FEEL.hover.tiltSpring);
  const springY = useSpring(pointerY, RUN_FEEL.hover.tiltSpring);
  const rotateY = useTransform(springX, (value) => value * RUN_FEEL.pack.hoverTiltDeg * 2);
  const rotateX = useTransform(springY, (value) => -value * RUN_FEEL.pack.hoverTiltDeg * 2);
  const [hovered, setHovered] = useState(false);
  /* The build-up before the burst (feel §12): a rotation made of three
     sines whose reach grows with time, and a swell. */
  const chargeRotate = useMotionValue(0);
  const chargeScale = useMotionValue(1);
  useEffect(() => {
    if (look !== "charging" || reducedMotion) {
      chargeRotate.set(0);
      chargeScale.set(1);
      return;
    }
    const feel = RUN_FEEL.pack;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      const reach = Math.min(1, (now - start) / feel.chargeMs);
      const wave = feel.chargeSinesHz.reduce((sum, hz, index) => sum + Math.sin(Math.PI * 2 * hz * t + index * 1.7), 0) / feel.chargeSinesHz.length;
      chargeRotate.set(feel.chargeMaxDeg * reach * wave);
      chargeScale.set(1 + feel.chargeScale * reach);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [chargeRotate, chargeScale, look, reducedMotion]);
  const fill = `rgb(${accent.r}, ${accent.g}, ${accent.b})`;
  const art = (offset: number): React.CSSProperties =>
    thumb
      ? { backgroundImage: `url(${thumb})`, backgroundSize: `${width}px ${height}px`, backgroundPosition: `0 ${-offset}px` }
      : { background: fill };
  const torn = look === "torn" || look === "gone";
  return (
    <motion.div
      initial={reducedMotion ? false : { y: 90, opacity: 0, scale: 0.9 }}
      animate={look === "gone" ? { y: 70, opacity: 0, scale: 0.92 } : { y: 0, opacity: 1, scale: 1 }}
      transition={look === "gone" ? { duration: RUN_FEEL.pack.exitMs / 1000, ease: [0.5, 0, 0.75, 0] } : RUN_FEEL.deal.spring}
    >
      <div className={look === "idle" && !reducedMotion ? "run-pack-bob" : undefined}>
      <motion.div style={{ rotate: chargeRotate, scale: chargeScale }}>
      <motion.button
        ref={packRef}
        type="button"
        aria-label={t`Open the pack`}
        disabled={disabled}
        onClick={onOpen}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") setHovered(true);
        }}
        onPointerLeave={() => {
          setHovered(false);
          pointerX.set(0);
          pointerY.set(0);
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch" || reducedMotion) return;
          const rect = event.currentTarget.getBoundingClientRect();
          pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
          pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
        }}
        className="relative block cursor-pointer disabled:cursor-default"
        style={{ width, height, rotateX, rotateY, transformPerspective: 800 }}
        animate={{ scale: hovered && !torn && !disabled ? RUN_FEEL.pack.hoverScale : 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 24 }}
      >
        <span className="absolute inset-0 translate-x-[4px] translate-y-[9px] rounded-[6px] bg-black/45" />
        <motion.span
          className="absolute inset-x-0 top-0 block rounded-t-[6px]"
          style={{ height: strip, ...art(0) }}
          initial={false}
          animate={
            torn && !reducedMotion
              ? { y: -RUN_FEEL.pack.tearFlyPx, x: width * 0.35, rotate: RUN_FEEL.pack.tearSpinDeg, opacity: 0 }
              : { y: 0, x: 0, rotate: 0, opacity: torn ? 0 : 1 }
          }
          transition={{ duration: RUN_FEEL.pack.tearMs / 1000, ease: [...RUN_FEEL.pack.tearEase] as [number, number, number, number] }}
        />
        <motion.span
          className="absolute inset-x-0 bottom-0 block rounded-b-[6px]"
          style={{ top: strip, ...art(strip) }}
          initial={false}
          animate={torn && !reducedMotion ? { scaleY: [1, 0.96, 1], y: [0, 4, 0] } : { scaleY: 1, y: 0 }}
          transition={{ duration: 0.28 }}
        />
      </motion.button>
      </motion.div>
      </div>
    </motion.div>
  );
}

/* The pack run as a game table: the HUD beside it, the charms held across
   the top, the pack in the middle and the hand along the bottom, over a
   living backdrop. A run open happens here end to end: the pack tears, the
   cards deal out and turn over, the pack scores, and the table settles into
   the next pack, the shop, or the end of the run. */
export function RunTable(props: RunTableProps) {
  const {
    view,
    busy,
    act,
    shards,
    charges,
    maxCharges,
    nextChargeMs,
    packType,
    packThumb,
    packChoices,
    onSelectPackType,
    canOpen,
    reducedMotion,
    openPack,
    onCardRevealed,
    onComplete,
    onExit,
    prepareCard = prepareRunCard,
    loadBoard,
    script,
  } = props;
  const { t, i18n } = useLingui();
  const wide = useWideTable();
  const { state, unlocks } = view;

  const [phase, setPhaseState] = useState<RunTablePhase>("rest");
  const phaseRef = useRef<RunTablePhase>("rest");
  const setPhase = useCallback((next: RunTablePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const [playMode, setPlayMode] = useState<"pack" | "shop">(script?.startInShop ? "shop" : "pack");
  const [packLook, setPackLook] = useState<PackLook>("idle");
  /* Bumped when a fresh pack comes back to the play area, so it enters whole. */
  const [packKey, setPackKey] = useState(0);
  const [hand, setHand] = useState<RunHandCard[]>([]);
  const [dealId, setDealId] = useState(0);
  const [openRun, setOpenRun] = useState<PackRunOpenPayload | null>(null);
  const [scoringKey, setScoringKey] = useState(0);
  const [skipToTotal, setSkipToTotal] = useState(false);
  const [display, setDisplay] = useState<{ score: number; notes: number | null; combo: number | null; pattern: HandTypeId | null }>({
    score: 0,
    notes: null,
    combo: null,
    pattern: null,
  });
  /* The song and the wallet as they stood at the click: the draw answers
     with the run and wallet after the pack, and the HUD must not show that
     before the pack has played out. */
  const [held, setHeld] = useState<{ blind: RunBlind; shards: number } | null>(null);
  /* A cleared song's pay counting in (RunTally), and whether the run ended
     on this table just now, so the end screen plays its moment. */
  const [tally, setTally] = useState<PackRunOpenPayload | null>(null);
  const [endFresh, setEndFresh] = useState(false);
  const [error, setError] = useState<Exclude<RunOpenResult, { kind: "dealt" }> | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [backUrl, setBackUrl] = useState<string | null>(null);

  const packRef = useRef<HTMLButtonElement>(null);
  const playAreaRef = useRef<HTMLDivElement>(null);
  const [playHeight, setPlayHeight] = useState(300);
  const cardElementsRef = useRef<Array<HTMLElement | null>>([]);
  const charmElementsRef = useRef(new Map<number, HTMLElement>());
  const dealSeqRef = useRef(0);
  const mountedRef = useRef(true);
  /* Room shake (feel §5): one jiggle value that bumps stack onto and that
     decays on its own clock, driving a sway and a roll of the whole table. */
  const shakeX = useMotionValue(0);
  const shakeY = useMotionValue(0);
  const shakeRotate = useMotionValue(0);
  const jiggleRef = useRef({ value: 0, frame: 0, last: 0, t: 0 });
  /* The table leans a little toward the cursor (feel §5). */
  const leanX = useMotionValue(0);
  const leanY = useMotionValue(0);
  const leanSpringX = useSpring(leanX, RUN_FEEL.lean.spring);
  const leanSpringY = useSpring(leanY, RUN_FEEL.lean.spring);

  useEffect(() => {
    mountedRef.current = true;
    setBackUrl(getCachedCardBackDataUrl());
    return () => {
      mountedRef.current = false;
      dealSeqRef.current += 1;
    };
  }, []);

  /* The table owns the viewport while it is up. */
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    window.scrollTo(0, 0);
    return () => {
      root.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const element = playAreaRef.current;
    if (!element) return;
    const measure = () => setPlayHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    script?.onPhase?.(phase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const shakeTable = useCallback(
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

  const finishOpen = useCallback(
    (result: RunScoringResult | null) => {
      setOpenRun(null);
      setHeld(null);
      setTally(null);
      setSkipToTotal(false);
      setPackLook("idle");
      setPackKey((key) => key + 1);
      if (result?.cleared && !result.won && !result.failed) setPlayMode("shop");
      if (result?.won || result?.failed) setEndFresh(true);
      setPhase("rest");
    },
    [setPhase],
  );

  /* A cleared song tallies its pay before the shop or the run's end. */
  const settle = useCallback(
    (result: RunScoringResult | null) => {
      if (result?.cleared && openRun && openRun.outcome.cleared.length > 0) {
        setTally(openRun);
        setPhase("tally");
        return;
      }
      finishOpen(result);
    },
    [finishOpen, openRun, setPhase],
  );

  const deal = useCallback(
    async (cards: PackCardState[], run: PackRunOpenPayload | null) => {
      const seq = ++dealSeqRef.current;
      const stale = () => seq !== dealSeqRef.current || !mountedRef.current;
      setOpenRun(run);
      if (run) setDisplay({ score: run.outcome.blindBefore.score, notes: null, combo: null, pattern: null });
      setHand(cards.map(handCardOf));
      setDealId(seq);
      setPhase("dealing");
      const stagger = reducedMotion ? 0 : RUN_FEEL.deal.staggerMs;
      cards.forEach((_, index) => {
        window.setTimeout(() => {
          if (!stale()) runSound.deal(index);
        }, index * stagger);
      });
      const leaveMs = (cards.length - 1) * stagger + 160;
      window.setTimeout(() => {
        if (!stale()) setPackLook("gone");
      }, leaveMs);
      const dealMs = reducedMotion ? 0 : (cards.length - 1) * stagger + RUN_FEEL.deal.settleMs;

      /* The faces paint one at a time and not before the deal has landed:
         each is a synchronous canvas job that would stall the flight. */
      let lastPaint: Promise<void> = wait(dealMs + 120);
      const queuePaint = <T,>(work: () => Promise<T>): Promise<T> => {
        const next = lastPaint.then(work);
        lastPaint = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };
      const prepared = cards.map((card) =>
        prepareCard(card, queuePaint).catch(
          (): RunPreparedCard => ({
            entry: { player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null },
            skills: null,
          }),
        ),
      );

      await wait(dealMs + (reducedMotion ? 0 : RUN_FEEL.flip.leadMs));
      if (stale()) return;
      setPhase("flipping");
      const revealed: RevealedCard[] = [];
      let nextFlipAt = performance.now();
      for (let index = 0; index < prepared.length; index += 1) {
        const { entry, skills } = await prepared[index];
        if (stale()) return;
        const holdMs = nextFlipAt - performance.now();
        if (holdMs > 0) await wait(holdMs);
        if (stale()) return;
        const isNew = onCardRevealed(pullOf(entry, skills));
        revealed[index] = { ...entry, skills, isNew };
        setHand((current) =>
          current.map((card, position) =>
            position === index ? { ...card, thumbnail: entry.thumbnail, tier: entry.tier, faceUp: true } : card,
          ),
        );
        runSound.flip(index);
        nextFlipAt = performance.now() + (reducedMotion ? 0 : RUN_FEEL.flip.staggerMs);
      }
      await wait(reducedMotion ? 0 : RUN_FEEL.flip.durationMs + RUN_FEEL.flip.tailMs);
      if (stale()) return;
      onComplete(revealed);
      if (run) {
        setScoringKey((key) => key + 1);
        setPhase("scoring");
      } else {
        settle(null);
      }
    },
    [onCardRevealed, onComplete, prepareCard, reducedMotion, setPhase, settle],
  );

  const open = useCallback(async () => {
    if (phaseRef.current !== "rest" || !canOpen) return;
    setError(null);
    setPlayMode("pack");
    setHeld({ blind: view.state.blind, shards });
    setPhase("opening");
    /* The pack builds up (feel §12) while the draw is in flight, then
       bursts at its strip; the last hand drops off the table meanwhile. */
    setPackLook("charging");
    setHand([]);
    const charge = wait(reducedMotion ? 0 : RUN_FEEL.pack.chargeMs);
    let result: RunOpenResult;
    try {
      result = await openPack();
    } catch {
      result = { kind: "failed" };
    }
    await charge;
    if (!mountedRef.current) return;
    if (result.kind !== "dealt") {
      setHeld(null);
      setPackLook("idle");
      setPackKey((key) => key + 1);
      setError(result);
      setPhase("rest");
      runSound.refuse();
      return;
    }
    setPackLook("torn");
    runSound.packOpen();
    shakeTable(RUN_FEEL.pack.burstShake);
    await wait(reducedMotion ? 0 : RUN_FEEL.deal.leadMs);
    if (!mountedRef.current) return;
    void deal(result.cards, result.run);
  }, [canOpen, deal, openPack, reducedMotion, setPhase, shakeTable, shards, view.state.blind]);

  /* Fixture presets: a hand already turned over, its scoring about to play,
     or a pack that opens itself. */
  const scriptStartedRef = useRef(false);
  useEffect(() => {
    if (!script || scriptStartedRef.current) return;
    scriptStartedRef.current = true;
    if (script.restHand && !script.preset) {
      setHand(script.restHand.map(handCardOfRevealed));
      setDealId(++dealSeqRef.current);
    }
    if (script.preset) {
      const { hand: presetHand, run } = script.preset;
      setHeld({ blind: run.outcome.blindBefore, shards: Math.max(0, shards - run.outcome.shards) });
      setOpenRun(run);
      setDisplay({ score: run.outcome.blindBefore.score, notes: null, combo: null, pattern: null });
      setHand(presetHand.map(handCardOfRevealed));
      setDealId(++dealSeqRef.current);
      setPackLook("gone");
      setSkipToTotal(Boolean(script.preset.skipToTotal));
      window.setTimeout(() => {
        setScoringKey((key) => key + 1);
        setPhase("scoring");
      }, 500);
    } else if (script.autoOpen) {
      window.setTimeout(() => void open(), 900);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStep = useCallback(
    (step: RunScoringStep) => {
      setDisplay((current) => ({
        score: step.songScore ?? current.score,
        notes: step.notes ?? current.notes,
        combo: step.combo ?? current.combo,
        pattern: step.pattern ?? current.pattern,
      }));
      if (step.shake) shakeTable(step.shake);
    },
    [shakeTable],
  );

  const shownBlind: RunBlind = openRun
    ? { ...openRun.outcome.blindBefore, score: display.score }
    : held?.blind ?? state.blind;
  const shownScore = openRun ? display.score : shownBlind.score;
  const fire = Boolean(openRun) && display.score >= shownBlind.target && shownBlind.target > 0;
  const over = phase === "rest" ? state.over : null;
  const mood: RunMood = over ? (over.won ? "won" : "failed") : fire ? "fire" : shownBlind.blind === "boss" ? "mod" : "calm";

  const charmElements = useCallback(() => charmElementsRef.current, []);
  const cardElements = useCallback(() => cardElementsRef.current, []);
  const setCharmElement = useCallback((uid: number, element: HTMLDivElement | null) => {
    if (element) charmElementsRef.current.set(uid, element);
    else charmElementsRef.current.delete(uid);
  }, []);
  const onCardElements = useCallback((elements: Array<HTMLDivElement | null>) => {
    cardElementsRef.current = elements;
  }, []);
  const dealOrigin = useCallback(() => {
    const rect = packRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height * PACK_TEAR_FRACTION + rect.height * 0.3 };
  }, []);

  const charmSize = wide ? 76 : 44;
  const packHeight = Math.max(120, Math.min(playHeight * 0.78, wide ? 330 : 240));
  const choiceIndex = packChoices.findIndex((choice) => choice.id === packType.id);
  const cyclePack = (direction: 1 | -1) => {
    if (packChoices.length < 2) return;
    const next = packChoices[(choiceIndex + direction + packChoices.length) % packChoices.length];
    onSelectPackType(next.id);
  };
  const showPack = phase === "opening" || phase === "dealing" || (phase === "rest" && playMode === "pack" && !over && !error && canOpen);
  const holdingPack = phase !== "rest";

  const errorCopy = useMemo(() => {
    if (!error) return null;
    if (error.kind === "busy") {
      return error.reason === "write_pressure"
        ? t`The server is busy. Please try again in a moment. This pack wasn't charged.`
        : t`Please wait a minute before opening another pack. This pack wasn't charged.`;
    }
    if (error.kind === "paused") {
      const until = new Date(error.pausedUntil).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
      return t`Pack opening is paused on this account until ${until}.`;
    }
    if (error.kind === "insufficient") return t`Not enough to open this pack.`;
    return t`The pack could not be opened. Please try again in a moment.`;
  }, [error, t]);

  return (
    <div className="fixed inset-x-0 top-[60px] z-40 h-[calc(100dvh-60px)] pb-[env(safe-area-inset-bottom)] overflow-hidden bg-osu-b6 text-white" translate="no">
      <RunBackdrop mood={mood} reducedMotion={reducedMotion} />
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
      <motion.div
        style={{ x: shakeX, y: shakeY, rotate: shakeRotate }}
        className="relative flex h-full flex-col gap-2 p-2.5 md:flex-row md:gap-4 md:p-4"
      >
        <aside className="shrink-0 rounded-xl bg-black/40 p-3 md:h-full md:w-[300px] md:p-4 lg:w-[320px]">
          <RunHud
            blind={shownBlind}
            over={over}
            score={shownScore}
            notes={openRun ? display.notes : null}
            combo={openRun ? display.combo : null}
            pattern={openRun ? display.pattern : null}
            shards={held?.shards ?? shards}
            rerolls={rerollsLeft(state)}
            fire={fire}
            reducedMotion={reducedMotion}
            shopOpen={playMode === "shop" && phase === "rest"}
            onShop={() => {
              if (holdingPack) return;
              runSound.uiTap();
              setPlayMode((mode) => (mode === "shop" ? "pack" : "shop"));
            }}
            onInfo={() => {
              runSound.uiTap();
              setInfoOpen(true);
            }}
            onExit={onExit}
          />
        </aside>

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The charms held, in the order they fire, and the open slots. */}
          <RunCharmRail
            charms={state.charms}
            liveCharms={liveCharms(state)}
            slots={unlocks.slots}
            size={charmSize}
            reducedMotion={reducedMotion}
            editable={phase === "rest" && !state.over}
            busy={busy}
            act={act}
            shake={shakeTable}
            elementRef={setCharmElement}
          />

          {/* The play area: the pack, the shop, or the run's end. */}
          <div ref={playAreaRef} className="relative min-h-0 flex-1">
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {showPack && (
                <>
                  <RunPack
                    key={`pack-${packKey}`}
                    thumb={packThumb}
                    accent={packType.accent}
                    look={packLook}
                    height={packHeight}
                    disabled={phase !== "rest"}
                    reducedMotion={reducedMotion}
                    onOpen={() => void open()}
                    packRef={packRef}
                  />
                  {phase === "rest" && (
                    <div className="mt-4 flex items-center gap-2">
                      {packChoices.length > 1 && (
                        <button
                          type="button"
                          aria-label={t`Previous pack`}
                          onClick={() => cyclePack(-1)}
                          className="grid h-8 w-8 place-items-center rounded-full text-osu-f1 hover:bg-white/5 hover:text-white"
                        >
                          <NudgeGlyph direction="left" />
                        </button>
                      )}
                      <div className="flex min-w-[120px] flex-col items-center">
                        <span className="text-[15px] font-black uppercase tracking-[0.08em]">{i18n._(PACK_TYPE_NAME_LABELS[packType.id])}</span>
                        {packType.cost.kind === "charge" ? (
                          <span className="mt-1 flex items-center gap-1" aria-label={t`${charges} of ${maxCharges} packs`}>
                            {Array.from({ length: maxCharges }, (_, position) => (
                              <span key={position} className={`h-2 w-2 rounded-full ${position < charges ? "bg-osu-pink" : "bg-white/15"}`} />
                            ))}
                          </span>
                        ) : (
                          <Shards value={packType.cost.amount} className="mt-0.5 text-[13px] font-bold text-osu-pink-light" />
                        )}
                      </div>
                      {packChoices.length > 1 && (
                        <button
                          type="button"
                          aria-label={t`Next pack`}
                          onClick={() => cyclePack(1)}
                          className="grid h-8 w-8 place-items-center rounded-full text-osu-f1 hover:bg-white/5 hover:text-white"
                        >
                          <NudgeGlyph direction="right" />
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

              {phase === "rest" && error && (
                <div className="max-w-[420px] text-center">
                  <div className="text-[15px] font-bold">
                    <Trans>Couldn't deal a pack</Trans>
                  </div>
                  <div className="mt-2 text-[12px] text-osu-f1">{errorCopy}</div>
                  {error.kind !== "paused" && (
                    <button
                      type="button"
                      onClick={() => setError(null)}
                      className="mt-5 rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white transition hover:brightness-110"
                    >
                      <Trans>Retry</Trans>
                    </button>
                  )}
                </div>
              )}

              {phase === "rest" && !error && playMode === "pack" && !over && !canOpen && (
                <div className="text-center">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
                    <Trans>next free pack</Trans>
                  </div>
                  <div className="mt-1.5 text-4xl font-black tabular-nums">
                    {nextChargeMs !== null ? `${Math.ceil(nextChargeMs / 1000)}s` : t`ready`}
                  </div>
                  {packChoices.length > 1 && (
                    <button
                      type="button"
                      onClick={() => cyclePack(1)}
                      className="mt-4 text-[12px] font-bold text-osu-f1 hover:text-white"
                    >
                      {i18n._(PACK_TYPE_NAME_LABELS[packType.id])}
                    </button>
                  )}
                </div>
              )}

            </div>

            {/* The shop eases in and out of the play area. Below the rail
                (z-20) so a charm's popover stays on top. */}
            <AnimatePresence>
              {phase === "rest" && !error && !over && playMode === "shop" && (
                <div key="shop" className="absolute inset-0 z-[15]">
                  <RunShop
                    view={view}
                    shards={shards}
                    busy={busy}
                    act={act}
                    onLeave={() => setPlayMode("pack")}
                    reducedMotion={reducedMotion}
                    shake={shakeTable}
                  />
                </div>
              )}
            </AnimatePresence>

            {phase === "scoring" && openRun && (
              <RunScoring
                key={scoringKey}
                payload={openRun}
                cardElements={cardElements}
                charmElements={charmElements}
                reducedMotion={reducedMotion}
                skipToTotal={skipToTotal}
                onStep={onStep}
                onDone={settle}
              />
            )}
          </div>

          {/* The hand. */}
          <div className="relative h-[180px] shrink-0 md:h-[clamp(190px,30vh,300px)]">
            <RunHand
              cards={hand}
              dealId={dealId}
              dealOrigin={dealOrigin}
              backUrl={backUrl}
              reducedMotion={reducedMotion}
              onCardElements={onCardElements}
            />
          </div>

          {/* A cleared song's pay, over the play area and the hand. */}
          {phase === "tally" && tally && (
            <div className="absolute inset-x-0 bottom-0 z-30" style={{ top: playAreaRef.current?.offsetTop ?? 0 }}>
              <RunTally
                payload={tally}
                charms={state.charms}
                charmElements={charmElements}
                walletFrom={held?.shards ?? shards}
                walletTo={shards}
                reducedMotion={reducedMotion}
                onWallet={(value) => setHeld((current) => (current ? { ...current, shards: value } : current))}
                onShake={shakeTable}
                onContinue={() => finishOpen({ cleared: true, won: Boolean(tally.outcome.over?.won), failed: false })}
              />
            </div>
          )}
        </main>
      </motion.div>
      </motion.div>
      {phase === "rest" && over && (
        <RunEnd
          view={view}
          over={over}
          fresh={endFresh}
          busy={busy}
          reducedMotion={reducedMotion}
          onNewRun={() => void act({ kind: "newRun" })}
          onExit={onExit}
          onShake={shakeTable}
        />
      )}
      <RunInfo open={infoOpen} onClose={() => setInfoOpen(false)} view={view} loadBoard={loadBoard} />
    </div>
  );
}
