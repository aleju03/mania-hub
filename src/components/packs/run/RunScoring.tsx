import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  formatMult,
  formatScore,
  HAND_TYPE_COPY,
  type HandTypeId,
  type PackRunOpenPayload,
  type ScoreStep,
} from "#/lib/pack-run";
import { FloatingText, type FloatingTextItem } from "./FloatingText";
import { RUN_FEEL } from "./runFeel";
import { juice, punch } from "./runJuice";
import { runSound } from "./runSound";

/* What one beat of the scoring sequence tells the table: the numbers the HUD
   should show now, and how hard to shake. Every field is optional; a beat
   only names what it changed. */
export interface RunScoringStep {
  songScore?: number;
  notes?: number;
  combo?: number;
  pattern?: HandTypeId;
  /* 0..1, scaled by RUN_FEEL.shake. */
  shake?: number;
  /* A hand card or charm that fired, for the table to react to. */
  card?: number;
  charmUid?: number;
}

export interface RunScoringResult {
  cleared: boolean;
  failed: boolean;
  won: boolean;
}

/* The scoring slot on the table. It gets the open's payload, where the
   hand's cards and the charm rail's charms sit on screen, and two
   callbacks, and owns everything between the flip and the slam. The clear,
   the tally and the run's end are the table's (RunTally, RunEnd). */
export interface RunScoringProps {
  payload: PackRunOpenPayload;
  /* The hand's cards by hand index. Read when needed: they move. */
  cardElements: () => Array<HTMLElement | null>;
  /* The charm rail's charms by uid. */
  charmElements: () => Map<number, HTMLElement>;
  reducedMotion: boolean;
  /* Dev fixture: land on the final total straight away. */
  skipToTotal?: boolean;
  onStep: (step: RunScoringStep) => void;
  onDone: (result: RunScoringResult) => void;
}

/* Step colours: lighter than the HUD slabs so the numerals read over cards. */
const NOTES_TEXT = "#8fc1ff";
/* The notes x combo line under the total: saturated, white numerals. */
const NOTES_SLAB = "#2a7cf0";
const COMBO_SLAB = "#ec2f78";
const COMBO_TEXT = "#ff66aa";
const MULTIPLIER_TEXT = "#ffd36b";
const AGAIN_TEXT = "#8fe3ff";
const MISS_TEXT = "#ff5a5a";
const BROKE_TEXT = "#a8a3b3";
const PLAIN_TEXT = "#e9eef7";

const msgMiss = msg`MISS`;
const msgAgain = msg`AGAIN`;
const msgBroke = msg`BROKE`;

type Stage = "steps" | "total" | "fly" | "landed";
type Speed = 1 | 3 | "skip";

interface LaneLight {
  id: number;
  x: number;
  width: number;
  bottom: number;
  height: number;
  fill: string;
}

/* How long a step holds, by its place in the chain: the first holds
   stepFirstMs and the rest decay toward stepFloorMs, so the chain builds.
   A charm firing for the whole pack holds longer wherever it falls. */
export function stepHoldMs(index: number, step: Pick<ScoreStep, "kind" | "card" | "charm">, reducedMotion: boolean): number {
  const feel = RUN_FEEL.scoring;
  if (reducedMotion) return feel.reducedStepMs;
  const base = feel.stepFloorMs + (feel.stepFirstMs - feel.stepFloorMs) * feel.stepDecay ** index;
  const charm = step.card < 0 && step.charm !== undefined ? feel.stepExtraMs.charm ?? 0 : 0;
  return Math.round(base + Math.max(feel.stepExtraMs[step.kind] ?? 0, charm));
}

/* A floating number's life: full while the chain is slow, cut toward
   floatMinMs once holds drop under 200ms. */
function floatLifeMs(holdMs: number): number {
  const feel = RUN_FEEL.scoring;
  if (holdMs >= 200) return feel.floatMs;
  return Math.max(feel.floatMinMs, Math.round(feel.floatMs - (200 - holdMs) * 5));
}

/* The pack, scored, one step at a time on the table. Every number is the
   server's (`score.steps`, in its order); this only replays them:
   - the pattern lands with its base notes x combo;
   - each step fires its card or charm (a wobble, a big number in the step's
     colour floating off it, the lane over a card lighting like a key press)
     and ticks the HUD, the chain speeding up as it goes and its pitch
     climbing;
   - notes x combo resolve to the pack's total, which counts up big in the
     play area, lands, holds, flies into the song score and slams; the song
     score takes it in one jump and catches fire past the target.
   A tap or click fast-forwards x3; a second jumps to the total. */
export function RunScoring({
  payload,
  cardElements,
  charmElements,
  reducedMotion,
  skipToTotal = false,
  onStep,
  onDone,
}: RunScoringProps) {
  const { i18n, t } = useLingui();
  const { outcome } = payload;
  const { score, blindBefore } = outcome;
  const [stage, setStage] = useState<Stage>("steps");
  const [patternShown, setPatternShown] = useState(false);
  const [totalShown, setTotalShown] = useState(0);
  const [floats, setFloats] = useState<FloatingTextItem[]>([]);
  const [lanes, setLanes] = useState<LaneLight[]>([]);
  const [fly, setFly] = useState<{ x: number; y: number; scale: number } | null>(null);
  const [speed, setSpeedState] = useState<Speed>(skipToTotal ? "skip" : 1);
  const overlayRef = useRef<HTMLDivElement>(null);
  const totalRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<{ speed: number; skip: boolean; stage: Stage; finishCount: boolean }>({
    speed: 1,
    skip: skipToTotal,
    stage: "steps",
    finishCount: false,
  });
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const elementsRef = useRef({ cardElements, charmElements });
  elementsRef.current = { cardElements, charmElements };

  /* A tap anywhere on the table (bar the buttons, which keep their jobs)
     or Space/Enter: x3, then skip to the total; while the total counts, it
     finishes the count. */
  useEffect(() => {
    const bump = () => {
      const clock = clockRef.current;
      if (clock.stage === "total") {
        clock.finishCount = true;
        clock.skip = true;
        setSpeedState("skip");
        return;
      }
      if (clock.stage !== "steps" || clock.skip) return;
      if (clock.speed === 1) {
        clock.speed = RUN_FEEL.scoring.fastForward;
        setSpeedState(3);
      } else {
        clock.skip = true;
        setSpeedState("skip");
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-run-speed]")) return bump();
      if (target?.closest("button, a, input, select, textarea, [role='dialog'], [aria-modal='true']")) return;
      bump();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " " && event.key !== "Enter") return;
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest("[data-run-speed]")) return;
      event.preventDefault();
      bump();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const timers: number[] = [];
    const clock = clockRef.current;
    const feel = RUN_FEEL.scoring;
    let floatId = 0;
    let laneId = 0;
    let fireLoop = false;
    let hiddenDigits: HTMLElement | null = null;

    const later = (ms: number, fn: () => void) => {
      timers.push(window.setTimeout(fn, ms));
    };
    const enter = (next: Stage) => {
      clock.stage = next;
      setStage(next);
    };
    const stopFire = () => {
      if (!fireLoop) return;
      fireLoop = false;
      runSound.fireLoopStop();
    };
    /* Holds `ms` of sequence time: sped up by the fast-forward, cut short by
       a skip when `skippable`. */
    const hold = (ms: number, skippable = true) =>
      new Promise<void>((resolve) => {
        if (ms <= 0) return resolve();
        let elapsed = 0;
        let last = performance.now();
        const tick = (now: number) => {
          if (cancelled) return resolve();
          elapsed += Math.max(0, now - last) * clock.speed;
          last = Math.max(last, now);
          if (elapsed >= ms || (skippable && clock.skip)) return resolve();
          frame = window.requestAnimationFrame(tick);
        };
        frame = window.requestAnimationFrame(tick);
      });

    const overlayRect = () => overlayRef.current?.getBoundingClientRect() ?? null;

    /* A newer number replaces the older one on its own card; on a fast
       chain or a narrow hand, where neighbouring numbers would run into
       one string, it also retires the others early. A multiplier stays up
       either way, drawn over the rest. */
    const pop = (item: Omit<FloatingTextItem, "id">, crowded: boolean) => {
      if (!item.text) return;
      const id = ++floatId;
      setFloats((current) => [
        ...current
          .filter((entry) => entry.anchor !== item.anchor && (!crowded || entry.top))
          .slice(-10),
        { ...item, id },
      ]);
      later(item.lifeMs + 40, () => setFloats((current) => current.filter((entry) => entry.id !== id)));
    };

    const lightLane = (rect: DOMRect, origin: DOMRect, fill: string) => {
      if (reducedMotion) return;
      const id = ++laneId;
      const bottom = rect.top - origin.top + rect.height * 0.1;
      // Up to just under the pattern's title, never through it.
      const title = titleRef.current?.getBoundingClientRect();
      const ceiling = title && title.height > 0 ? title.bottom - origin.top + 10 : 0;
      const height = Math.min(bottom - ceiling, origin.height * 0.7);
      if (height < 24) return;
      setLanes((current) => [
        ...current.slice(-6),
        { id, x: rect.left - origin.left + rect.width * 0.1, width: rect.width * 0.8, bottom, height, fill },
      ]);
      later(240, () => setLanes((current) => current.filter((lane) => lane.id !== id)));
    };

    /* One step on the table: the wobble, the number, the lane, the sound. */
    const show = (step: ScoreStep, chain: number, holdMs: number) => {
      const card = step.card >= 0 ? elementsRef.current.cardElements()[step.card] ?? null : null;
      const charm = step.charm !== undefined ? elementsRef.current.charmElements().get(step.charm) ?? null : null;
      const kind = step.kind as string;
      let text = "";
      let fill = PLAIN_TEXT;
      let word = false;
      switch (kind) {
        case "chips":
          text = `+${formatScore(step.value)}`;
          fill = NOTES_TEXT;
          break;
        case "mult":
          text = `+${formatMult(step.value)}`;
          fill = COMBO_TEXT;
          break;
        case "xMult":
          text = `x${formatMult(step.value)}`;
          fill = MULTIPLIER_TEXT;
          break;
        case "retrigger":
          text = i18n._(msgAgain);
          fill = AGAIN_TEXT;
          word = true;
          break;
        case "debuff":
          text = i18n._(msgMiss);
          fill = MISS_TEXT;
          word = true;
          break;
        case "break":
          text = i18n._(msgBroke);
          fill = BROKE_TEXT;
          word = true;
          break;
        case "cash":
          text = step.value ? `${step.value > 0 ? "+" : ""}${formatScore(step.value)}` : "";
          fill = MULTIPLIER_TEXT;
          break;
        default:
          // A kind this build does not know yet: its number, plainly.
          text = typeof step.value === "number" && step.value !== 0 ? formatMult(step.value) : "";
          break;
      }
      const lifeMs = floatLifeMs(holdMs);
      const narrow = window.innerWidth < 768;
      const crowded = narrow || holdMs < 250;
      const top = kind === "xMult";
      const origin = overlayRect();
      if (origin) {
        if (card) {
          const rect = card.getBoundingClientRect();
          // On a narrow hand neighbours alternate heights so they never touch.
          const lift = narrow && step.card % 2 === 1 ? 34 : 0;
          pop({ anchor: `card-${step.card}`, place: "above", x: rect.left - origin.left + rect.width / 2, y: rect.top - origin.top - 4 - lift, text, fill, word, top, lifeMs }, crowded);
          if (kind !== "debuff" && kind !== "break") lightLane(rect, origin, fill);
        } else if (charm) {
          const rect = charm.getBoundingClientRect();
          pop({ anchor: `charm-${step.charm}`, place: "below", x: rect.left - origin.left + rect.width / 2, y: rect.bottom - origin.top + 4, text, fill, word, top, lifeMs }, crowded);
        } else {
          pop({ anchor: "pack", place: "center", x: origin.width / 2, y: origin.height * 0.62, text, fill, word, top, lifeMs }, crowded);
        }
      }

      if (!reducedMotion) {
        if (card) juice(card, kind === "debuff" ? { amount: 0.12, rotateRad: 0.1 } : RUN_FEEL.juice.scoringCard);
        if (charm) juice(charm, RUN_FEEL.juice.firingCharm);
      }

      const fromCharm = step.card < 0 && step.charm !== undefined;
      if (kind === "xMult") runSound.stepMultiplier(chain);
      else if (kind === "retrigger") runSound.stepAgain(chain);
      else if (kind === "debuff" || kind === "break") runSound.stepMiss();
      else if (kind === "chips" && !fromCharm) runSound.stepNotes(chain);
      else if (kind === "mult" && !fromCharm) runSound.stepCombo(chain);
      else runSound.charmFire(chain);
    };

    /* A charm that grew, reset or was switched off mid-pack wobbles. */
    const showEvents = (after: number) => {
      if (reducedMotion) return;
      for (const event of score.events ?? []) {
        if (event.after !== after || event.charm === undefined) continue;
        juice(elementsRef.current.charmElements().get(event.charm), { amount: 0.16, rotateRad: 0.1 });
      }
    };

    const run = async () => {
      const steps = score.steps;
      const before = blindBefore.score;
      const after = blindBefore.score + score.total;
      const target = blindBefore.target;
      if (target > 0 && before >= target) {
        fireLoop = true;
        runSound.fireLoopStart();
      }
      /* The first step is the pattern's own base. A pattern a mod blocks
         scores 0 x 0, the one time it is not baseChips x baseMult. */
      const startChips = steps[0]?.value ?? score.baseChips;
      const startMult = startChips === 0 ? 0 : score.baseMult;
      let chips = startChips;
      let mult = startMult;
      let chain = 0;

      // The pattern lands.
      setPatternShown(true);
      onStepRef.current({ pattern: score.handType, notes: chips, combo: mult, shake: reducedMotion ? 0 : feel.stepShake });
      if (!clock.skip) runSound.stepNotes(chain);
      chain += 1;
      showEvents(1);
      await hold(reducedMotion ? feel.reducedStepMs * 2 : feel.patternHoldMs);
      if (cancelled) return;

      // The steps, one at a time, quicker as they go.
      for (let index = 1; index < steps.length && !clock.skip; index += 1) {
        const step = steps[index];
        if (step.kind === "chips") chips += step.value;
        else if (step.kind === "mult") mult += step.value;
        else if (step.kind === "xMult") mult *= step.value;
        const moved = step.kind === "chips" || step.kind === "mult" || step.kind === "xMult";
        const holdMs = stepHoldMs(index - 1, step, reducedMotion);
        onStepRef.current({
          ...(moved ? { notes: chips, combo: Math.round(mult * 100) / 100 } : {}),
          shake: reducedMotion ? 0 : step.kind === "xMult" ? feel.multiplierShake : feel.stepShake,
          card: step.card >= 0 ? step.card : undefined,
          charmUid: step.charm,
        });
        show(step, chain, holdMs / clock.speed);
        chain += 1;
        showEvents(index + 1);
        await hold(holdMs);
        if (cancelled) return;
      }

      // The server's own totals, whatever the replay rounded.
      onStepRef.current({ pattern: score.handType, notes: score.chips, combo: score.mult });
      const skipped = clock.skip;
      if (!skipped) await hold(feel.tailMs);
      if (cancelled) return;

      // notes x combo resolve to the pack's total: it counts up big in the
      // middle of the table, lands with a punch, and holds.
      // The first frame already shows a counted value, never a faded 0.
      setTotalShown(Math.floor(score.total * 0.05));
      enter("total");
      const countMs = reducedMotion ? 0 : skipped ? feel.totalCountMs * 0.5 : feel.totalCountMs;
      if (countMs > 0 && score.total > 0) {
        await new Promise<void>((resolve) => {
          const start = performance.now();
          const tick = (now: number) => {
            if (cancelled) return resolve();
            const progress = clock.finishCount ? 1 : Math.min(1, 0.05 + (0.95 * Math.max(0, now - start)) / countMs);
            setTotalShown(Math.floor(score.total * progress));
            runSound.countTick(progress);
            if (progress < 1) frame = window.requestAnimationFrame(tick);
            else resolve();
          };
          frame = window.requestAnimationFrame(tick);
        });
        if (cancelled) return;
      }
      setTotalShown(score.total);
      runSound.finish();
      if (!reducedMotion) punch(totalRef.current, String(score.total).length + 2);
      await hold(reducedMotion ? 400 : clock.skip ? 450 : feel.holdMs, false);
      if (cancelled) return;

      // It flies into the song score, opaque all the way, shrinking onto
      // the box, and slams; the song score takes it in one jump.
      // It lands on the score's own digits (left-aligned in their box),
      // which hide while it is in the air, so the slam never shares the
      // box with the old number.
      const box = [...document.querySelectorAll<HTMLElement>("[data-run-score]")].find((element) => element.offsetParent !== null);
      const digits = box?.querySelector<HTMLElement>("[data-run-score-digits]") ?? box ?? null;
      const from = totalRef.current?.getBoundingClientRect();
      const to = digits?.getBoundingClientRect();
      if (!reducedMotion && from && to && from.width > 0 && from.height > 0 && to.height > 0) {
        const scale = Math.max(0.12, Math.min(0.9, to.height / from.height));
        setFly({
          x: to.left + (from.width * scale) / 2 - (from.left + from.width / 2),
          y: to.top + to.height / 2 - (from.top + from.height / 2),
          scale,
        });
        hiddenDigits = digits;
        digits!.style.opacity = "0";
        enter("fly");
        await hold(feel.flyMs, false);
        if (cancelled) return;
      }
      const share = Math.min(1, score.total / Math.max(1, target));
      enter("landed");
      if (hiddenDigits) hiddenDigits.style.opacity = "";
      const slamAt = performance.now();
      runSound.slam(share);
      onStepRef.current({
        songScore: after,
        notes: 0,
        combo: 0,
        shake: reducedMotion ? 0 : feel.slamShake + feel.slamShakePerShare * share,
      });

      // Past the target the score catches fire, a beat after the slam.
      const ignites = target > 0 && after >= target && before < target;
      if (ignites) {
        await hold(reducedMotion ? 0 : feel.igniteDelayMs, false);
        if (cancelled) return;
        runSound.fireIgnite();
        if (!fireLoop) {
          fireLoop = true;
          runSound.fireLoopStart();
        }
        if (!reducedMotion && performance.now() - slamAt > feel.igniteShakeGapMs) onStepRef.current({ shake: feel.igniteShake });
      }
      await hold(ignites || after >= target ? feel.afterFireMs : feel.afterSlamMs, false);
      if (cancelled) return;
      // The song settles here; the tally or the run's end takes it from
      // there and plays the clear or the loss.
      stopFire();
      onDoneRef.current({
        cleared: outcome.cleared.length > 0,
        failed: Boolean(outcome.over && !outcome.over.won),
        won: Boolean(outcome.over?.won),
      });
    };
    void run();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
      stopFire();
      if (hiddenDigits) hiddenDigits.style.opacity = "";
    };
    // One sequence per payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  const showTotal = stage === "total" || stage === "fly";
  const patternName = i18n._(HAND_TYPE_COPY[score.handType].name);

  return (
    <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-[30]" translate="no">
      {/* The lane over a card that just scored, lit like a key press: a flat
          column in the step's colour, on and off. */}
      {lanes.map((lane) => (
        <motion.div
          key={lane.id}
          className="absolute"
          style={{ left: lane.x, top: lane.bottom - lane.height, width: lane.width, height: lane.height, background: lane.fill }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.2, 0.2, 0] }}
          transition={{ duration: 0.22, times: [0, 0.1, 0.55, 1], ease: "linear" }}
        />
      ))}

      {/* The pattern, then the total under it. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <AnimatePresence>
          {patternShown && stage !== "landed" && (
            <motion.div
              key="pattern"
              ref={titleRef}
              className="text-[34px] font-black italic uppercase leading-none text-white md:text-[52px]"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 1.5, y: 8 }}
              animate={{ opacity: stage === "fly" ? 0 : 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ type: "spring", stiffness: 560, damping: 22 }}
            >
              {patternName}
            </motion.div>
          )}
        </AnimatePresence>

        {showTotal && (
          <div className="mt-3 flex flex-col items-center md:mt-4">
            <motion.div
              className="flex items-center gap-2 text-[22px] font-black leading-none text-white tabular-nums md:text-[30px]"
              initial={reducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: stage === "fly" ? 0 : 1, y: 0 }}
              transition={{ duration: 0.16 }}
            >
              <span className="rounded-md px-2.5 py-1.5" style={{ background: NOTES_SLAB }}>
                {formatScore(score.chips)}
              </span>
              <span>x</span>
              <span className="rounded-md px-2.5 py-1.5" style={{ background: COMBO_SLAB }}>
                {formatMult(score.mult)}
              </span>
            </motion.div>
            {/* Its own layer, so the punch's transform never fights the flight's. */}
            <motion.div
              className="mt-2"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 1, scale: 0.6 }}
              animate={fly ? { opacity: 1, scale: fly.scale, x: fly.x, y: fly.y } : { opacity: 1, scale: 1, x: 0, y: 0 }}
              transition={
                fly
                  ? { duration: RUN_FEEL.scoring.flyMs / 1000, ease: [0.5, 0, 0.9, 0.5] }
                  : { type: "spring", stiffness: 520, damping: 20 }
              }
            >
              <div
                ref={totalRef}
                className="text-[76px] font-black leading-none text-white tabular-nums md:text-[clamp(96px,9vw,140px)]"
              >
                {formatScore(totalShown)}
              </div>
            </motion.div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {floats.map((item) => (
          <FloatingText key={item.id} item={item} reducedMotion={reducedMotion} />
        ))}
      </AnimatePresence>

      {/* Fast-forward: a tap anywhere works too; this shows it can. */}
      {(stage === "steps" || stage === "total") && (
        <button
          type="button"
          data-run-speed=""
          aria-label={speed === 1 ? t`Speed up` : t`Skip to the score`}
          className="pointer-events-auto absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-black/40 text-white transition hover:brightness-110 disabled:opacity-40"
          disabled={speed === "skip"}
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
            <path d="M2 4 L9 10 L2 16 Z" />
            <path d="M9 4 L16 10 L9 16 Z" opacity={speed === 1 ? 1 : 0.55} />
            {speed !== 1 && <rect x="16" y="4" width="2.4" height="12" />}
          </svg>
        </button>
      )}
    </div>
  );
}
