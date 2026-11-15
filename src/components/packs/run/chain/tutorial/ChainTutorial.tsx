import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { applyChainAction, chainRunView, chainSkillShort, type ChainAction, type ChainCard, type ChainRunState, type ChainRunView } from "#/lib/chain-run";
import { fetchLiveChainGuestPool } from "#/lib/live-backend";
import type { PackTypeId } from "#/lib/packs";
import { ChainTable, type ChainCoach, type ChainTableScript } from "../ChainTable";
import { ChainButtons, KIT, MARKER } from "../chainKit";
import { SKILL_CODE } from "../ChainCardFace";
import { runSound } from "../../runSound";
import type { ChainActOutcome } from "../useChainRun";
import { dealTutorial, type TutorialDeal, type TutorialRound1, type TutorialRound2 } from "./chainTutorialDeal";

/* Overjoy's tutorial: two rounds on real cards with a guide that says what
   to do at every step and lets the table do only that. Played in the
   browser like a guest run; nothing of it is saved or sent. */

type StepId =
  | "intro"
  | "tapA"
  | "tapB"
  | "tapC"
  | "play"
  | "rules"
  | "own"
  | "keep"
  | "shop"
  | "map"
  | "swap"
  | "redraw"
  | "mapRow"
  | "finish"
  | "end";

interface Ctx {
  view: ChainRunView;
  row: readonly number[];
  r1: TutorialRound1;
  r2: TutorialRound2 | null;
}

const same = (left: readonly number[], right: readonly number[]) => left.length === right.length && left.every((uid, index) => uid === right[index]);
const isPrefix = (row: readonly number[], of: readonly number[]) => row.length <= of.length && row.every((uid, index) => uid === of[index]);

/* What each step lets the table do. Steps not listed allow everything. */
function allowRowAt(step: StepId, ctx: Ctx, next: readonly number[]): boolean {
  const { a, b, c } = ctx.r1;
  switch (step) {
    case "intro":
    case "map":
    case "play":
    case "rules":
      return same(next, ctx.row);
    case "tapA":
      return isPrefix(next, [a]);
    case "tapB":
      return isPrefix(next, [a, b]);
    case "tapC":
      return isPrefix(next, [a, b, c]);
    case "swap":
    case "redraw":
      return next.every((uid) => ctx.r2!.swap.includes(uid));
    default:
      return true;
  }
}

function allowActAt(step: StepId, ctx: Ctx, action: ChainAction): boolean {
  switch (action.kind) {
    case "playRow":
      return step === "play" ? same(action.uids, [ctx.r1.a, ctx.r1.b, ctx.r1.c]) : step === "own" || step === "mapRow" || step === "finish";
    case "redraw":
      return step === "redraw" || step === "own" || step === "mapRow" || step === "finish";
    case "openPack":
    case "keep":
      return step === "keep" || step === "end";
    case "nextRound":
      return step === "shop";
    default:
      return false;
  }
}

/* The hand card the rules step shows a second skillset on. */
function secondSkillCard(ctx: Ctx) {
  return ctx.view.hand.find((entry) => entry.card.skill2 && !entry.card.chart) ?? null;
}

/* Where a step points: selectors for the ring. */
function targetsAt(step: StepId, ctx: Ctx): string[] {
  const card = (uid: number) => `[data-chain-card="${uid}"]`;
  switch (step) {
    case "tapA":
      return [card(ctx.r1.a)];
    case "tapB":
      return [card(ctx.r1.b)];
    case "tapC":
      return [card(ctx.r1.c)];
    case "play":
      return ['[data-chain-button="play"]'];
    case "rules": {
      const entry = secondSkillCard(ctx);
      return entry ? [card(entry.uid)] : [];
    }
    case "shop":
      return ['[data-chain-button="next"]'];
    case "map":
      return ["[data-chain-round-chart]"];
    case "swap":
      return ctx.r2!.swap.filter((uid) => !ctx.row.includes(uid)).map(card);
    case "redraw":
      return ['[data-chain-button="redraw"]'];
    case "mapRow":
      return ctx.r2!.incoming.filter((uid) => !ctx.row.includes(uid)).map(card);
    default:
      return [];
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* Follows the targets every frame: cards deal, slide and lift. */
function useRects(selectors: string[], on: boolean): Rect[] {
  const [rects, setRects] = useState<Rect[]>([]);
  const key = selectors.join("|");
  useEffect(() => {
    if (!on || !selectors.length) {
      setRects([]);
      return;
    }
    let frame = 0;
    let last = "";
    let scrolled = false;
    const tick = () => {
      const next: Rect[] = [];
      for (const selector of selectors) {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) continue;
        const box = element.getBoundingClientRect();
        // A target below the fold (the shop scrolls) comes into view once.
        if (!scrolled && box.height && (box.bottom > window.innerHeight || box.top < 60)) {
          scrolled = true;
          element.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        if (box.width && box.height) next.push({ x: box.left, y: box.top, w: box.width, h: box.height });
      }
      const sig = next.map((rect) => `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`).join(";");
      if (sig !== last) {
        last = sig;
        setRects(next);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on]);
  return rects;
}

export function ChainTutorial({
  reducedMotion,
  packThumbs,
  onExit,
  onPlay,
}: {
  reducedMotion: boolean;
  packThumbs: Partial<Record<PackTypeId, string>>;
  onExit: () => void;
  /* Ends the tutorial into a real run. */
  onPlay: () => void;
}) {
  const { t } = useLingui();
  const [deal, setDeal] = useState<TutorialDeal | null>(null);
  const [failed, setFailed] = useState(false);
  const stateRef = useRef<ChainRunState | null>(null);
  const [view, setView] = useState<ChainRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<StepId>("intro");
  const [row, setRow] = useState<readonly number[]>([]);
  const [r1, setR1] = useState<TutorialRound1 | null>(null);
  const [r2, setR2] = useState<TutorialRound2 | null>(null);
  /* The table is mid-animation: the guide waits. */
  const [moving, setMoving] = useState(true);
  /* Round snapshots, to play a failed round again. */
  const roundStartRef = useRef<{ state: ChainRunState; step: StepId } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [over, setOver] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchLiveChainGuestPool<ChainCard>().then((slice) => {
      if (!live) return;
      const dealt = slice ? dealTutorial(slice) : null;
      if (!dealt) {
        setFailed(true);
        return;
      }
      const first = dealt.deal.round1(dealt.start);
      stateRef.current = first.state;
      roundStartRef.current = { state: first.state, step: "intro" };
      setDeal(dealt.deal);
      setR1(first.uids);
      setView(chainRunView(first.state));
    });
    return () => {
      live = false;
    };
  }, []);

  const act = useCallback(
    async (action: ChainAction): Promise<ChainActOutcome> => {
      const current = stateRef.current;
      if (!deal || !current) return { ok: false, error: "failed", view: null };
      setBusy(true);
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      setBusy(false);
      const out = applyChainAction(current, action, { pool: deal.pool, seed: 4242 + current.nextUid, now: Date.now() });
      if (!out.ok) return { ok: false, error: out.error, view: chainRunView(current) };
      let state = out.state;
      if (action.kind === "nextRound") {
        const second = deal.round2(state);
        state = second.state;
        setR2(second.uids);
        roundStartRef.current = { state, step: "map" };
      }
      stateRef.current = state;
      const next = chainRunView(state);
      setView(next);
      return { ok: true, result: out.result, view: next };
    },
    [deal],
  );

  const ctx: Ctx | null = view && r1 ? { view, row, r1, r2 } : null;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const stepRef = useRef(step);
  stepRef.current = step;

  const coach = useMemo<ChainCoach>(
    () => ({
      allowRow: (next) => (ctxRef.current ? allowRowAt(stepRef.current, ctxRef.current, next) : false),
      allowAct: (action) => (ctxRef.current ? allowActAt(stepRef.current, ctxRef.current, action) : false),
      onRow: (next) => setRow([...next]),
    }),
    [],
  );

  /* Row steps move on as the row takes shape. */
  useEffect(() => {
    if (!r1) return;
    if (step === "tapA" && same(row, [r1.a])) setStep("tapB");
    else if (step === "tapB" && same(row, [r1.a, r1.b])) setStep("tapC");
    else if (step === "tapC" && same(row, [r1.a, r1.b, r1.c])) setStep("play");
    else if (step === "swap" && r2 && r2.swap.every((uid) => row.includes(uid))) setStep("redraw");
  }, [row, r1, r2, step]);

  useEffect(() => {
    if (step === "redraw" && view && view.redrawsLeft < (roundStartRef.current?.state.redrawsLeft ?? 0)) setStep("mapRow");
  }, [step, view]);

  const onSignal = useCallback((name: string) => {
    const now = stepRef.current;
    if (name === "play:start") setMoving(true);
    else if (name === "round:dealt") setMoving(false);
    else if (name === "play:done") {
      setMoving(false);
      if (now === "play") setStep("rules");
      else if (now === "mapRow") setStep("finish");
    } else if (name === "clear:done") {
      setMoving(false);
      setStep(stateRef.current?.round === 2 ? "end" : "keep");
    } else if (name === "pack:kept") {
      if (now === "keep") setStep("shop");
    } else if (name === "shop") setMoving(false);
    else if (name === "over") setOver(true);
  }, []);

  useEffect(() => {
    if (step === "shop" && view?.round === 2) {
      setMoving(true);
      setStep("map");
    }
  }, [step, view?.round]);

  const script = useMemo<ChainTableScript>(() => ({ onSignal, music: true }), [onSignal]);

  const retry = () => {
    const start = roundStartRef.current;
    if (!start) return;
    runSound.uiTap();
    stateRef.current = start.state;
    setView(chainRunView(start.state));
    setRow([]);
    setOver(false);
    // The round's cards are already dealt (same round), so no deal signal comes.
    setMoving(false);
    setStep(start.step === "intro" ? "own" : "finish");
    // A fresh table: the failed round's beats stay with the old one.
    setAttempt((value) => value + 1);
  };

  /* What the guide says at each step (here, where the t macro reaches). */
  const guideText = (step: StepId, ctx: Ctx): ReactNode => {
    switch (step) {
      case "intro": {
        const target = ctx.view.target.toLocaleString("en-US");
        return t`Each round has a score to reach, and 3 rows to reach it. This one needs ${target}.`;
      }
      case "tapA":
        return t`Tap this card to put it in the row.`;
      case "tapB":
        return t`This card is from the same country, so the two link. Put it next.`;
      case "tapC":
        return t`This one shares a skillset and a dan with the last card. The more two cards share, the more the combo goes up.`;
      case "play":
        return t`Play the row. Each card scores its number times the combo.`;
      case "rules": {
        const entry = secondSkillCard(ctx);
        if (!entry?.card.skill2) return t`Before you build your own row: a shared keymode or rarity alone doesn't link.`;
        const name = entry.card.name;
        const main = chainSkillShort(entry.card.skill);
        const second = SKILL_CODE[entry.card.skill2][0];
        return t`Before you build your own row: on ${name}, ${main} is the main skillset and ${second} the second one. ${second} only links with another card's second skillset, and a shared keymode or rarity alone doesn't link.`;
      }
      case "own":
        return t`Now build a row yourself: line up cards that share a country, a dan or a skillset, and play it. A pair that shares none of them breaks the combo.`;
      case "keep":
        return t`Round cleared. Keep one of these cards for your deck.`;
      case "shop":
        return t`Clears pay shards to spend in the shop. Skip it this time.`;
      case "map": {
        const chart = ctx.view.roundChart;
        const fits = chart ? `${chart.key}K ${chart.skill}` : "";
        return t`This round is set on a map. ${fits} cards score x1.25.`;
      }
      case "swap":
        return t`These two don't fit the map. Put them in the row to swap them out.`;
      case "redraw":
        return t`Redraw swaps the cards in the row for new ones from your deck.`;
      case "mapRow":
        return t`These fit the map, and share a skillset, so they link too. Build a row with them and play it.`;
      case "finish":
        return t`Finish the round with rows of your own.`;
      default:
        return null;
    }
  };

  const targets = ctx ? targetsAt(step, ctx) : [];
  const showGuide = Boolean(ctx) && !moving && !over && step !== "end";
  const rects = useRects(targets, showGuide);

  if (failed) {
    return (
      <div className="fixed inset-0 z-[60] grid place-items-center bg-[#120c18] px-6 text-center text-[#f3e9d8]">
        <div>
          <p className="text-[15px] font-bold"><Trans>The tutorial can't load right now. Try again in a moment.</Trans></p>
          <div className="mt-5 flex justify-center">
            <ChainButtons items={[{ key: "back", label: <Trans>Back</Trans>, title: t`Back`, onClick: onExit }]} />
          </div>
        </div>
      </div>
    );
  }

  const text = ctx ? guideText(step, ctx) : null;
  const intro = step === "intro" || step === "rules" || step === "map";

  return (
    <>
      <ChainTable
        key={attempt}
        view={view}
        best={null}
        busy={busy}
        act={act}
        reducedMotion={reducedMotion}
        packThumbs={packThumbs}
        guest
        loadBoard={async () => ({ entries: [], mine: null })}
        loadSheet={async () => null}
        onExit={onExit}
        script={script}
        coach={coach}
      />
      {typeof document !== "undefined" &&
        createPortal(
          <div className="pointer-events-none fixed inset-0 z-[120]">
            {showGuide &&
              rects.map((rect, index) => (
                <motion.div
                  key={`${step}-${index}`}
                  className="absolute rounded-[16px]"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  style={{
                    left: rect.x - 8,
                    top: rect.y - 8,
                    width: rect.w + 16,
                    height: rect.h + 16,
                    border: `3px solid ${KIT.gold}`,
                    boxShadow: `0 0 0 4px rgba(18,12,24,0.55)`,
                  }}
                >
                  {!reducedMotion && (
                    <motion.div
                      className="absolute inset-[-3px] rounded-[16px]"
                      style={{ border: `3px solid ${KIT.gold}` }}
                      // Starts and ends unseen, so the loop never pops.
                      animate={{ scale: [1, 1, 1.12], opacity: [0, 0.8, 0] }}
                      transition={{ duration: 1.4, times: [0, 0.15, 1], repeat: Infinity, ease: "easeOut" }}
                    />
                  )}
                </motion.div>
              ))}
            <AnimatePresence>
              {showGuide && text && (
                <GuideBox key={step} rects={rects} narrow={typeof window !== "undefined" && window.innerWidth < 640}>
                  <p className="text-[15px] font-bold leading-snug">{text}</p>
                  <div className="mt-3 flex items-center gap-3">
                    {intro && (
                      <button
                        type="button"
                        className="pointer-events-auto cursor-pointer rounded-full px-4 py-1.5 text-[14px] font-black"
                        style={{ background: KIT.dark, color: KIT.cream, fontFamily: MARKER }}
                        onClick={() => {
                          runSound.uiTap();
                          setStep(step === "intro" ? "tapA" : step === "rules" ? "own" : "swap");
                        }}
                      >
                        <Trans>Next</Trans>
                      </button>
                    )}
                    <button
                      type="button"
                      className="pointer-events-auto ml-auto cursor-pointer text-[12px] font-bold underline-offset-2 opacity-60 hover:underline hover:opacity-100"
                      onClick={onExit}
                    >
                      <Trans>Skip tutorial</Trans>
                    </button>
                  </div>
                </GuideBox>
              )}
            </AnimatePresence>
            {(over || step === "end") && (
              <div className="pointer-events-auto absolute inset-0 grid place-items-center bg-black/55 px-5">
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="w-full max-w-[460px] rounded-[18px] border-[3px] px-6 py-6 text-center"
                  style={{ background: KIT.dark, borderColor: KIT.cream, color: KIT.cream }}
                >
                  <p className="text-[26px] font-black" style={{ fontFamily: MARKER }}>
                    {over ? <Trans>Out of rows</Trans> : <Trans>That's Overjoy</Trans>}
                  </p>
                  <p className="mt-3 text-[14.5px] font-bold leading-snug opacity-85">
                    {over ? (
                      <Trans>The round ran out of rows before the target. Try it again: line up cards that share more.</Trans>
                    ) : (
                      <Trans>
                        A real run starts by picking cards from three packs, and goes on for 12 rounds, with a shop between them where your
                        shards buy packs, scene cards and mods.
                      </Trans>
                    )}
                  </p>
                  <div className="mt-5 flex justify-center">
                    <ChainButtons
                      items={
                        over
                          ? [
                              { key: "exit", label: <Trans>Leave</Trans>, title: t`Leave`, onClick: onExit },
                              { key: "retry", primary: true, label: <Trans>Try again</Trans>, title: t`Try again`, onClick: retry },
                            ]
                          : [
                              { key: "exit", label: <Trans>Back</Trans>, title: t`Back`, onClick: onExit },
                              { key: "play", primary: true, label: <Trans>Start a run</Trans>, title: t`Start a run`, onClick: onPlay },
                            ]
                      }
                    />
                  </div>
                </motion.div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/* The guide's box: above its targets when they sit low, below when high,
   and up top when it points at nothing. */
function GuideBox({ rects, narrow, children }: { rects: Rect[]; narrow: boolean; children: ReactNode }) {
  const width = narrow ? Math.min(340, window.innerWidth - 24) : 380;
  let left = (window.innerWidth - width) / 2;
  // Under the round's score, above the row.
  let top = narrow ? 150 : 205;
  if (rects.length) {
    const minX = Math.min(...rects.map((rect) => rect.x));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
    left = Math.max(12, Math.min(window.innerWidth - width - 12, (minX + maxX) / 2 - width / 2));
    top = minY > window.innerHeight / 2 ? minY - 24 : maxY + 24;
  }
  const above = rects.length > 0 && top < Math.min(...rects.map((rect) => rect.y));
  return (
    <div className="absolute" style={{ left, top, width, transform: above ? "translateY(-100%)" : undefined }}>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className="rounded-[14px] border-[3px] px-4 py-3"
        style={{ background: KIT.cream, borderColor: KIT.dark, color: KIT.dark, boxShadow: "0 5px 0 rgba(0,0,0,0.45)" }}
      >
        {children}
      </motion.div>
    </div>
  );
}
