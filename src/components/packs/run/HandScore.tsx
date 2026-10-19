import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  BLIND_CLEARED_COPY,
  BLIND_COPY,
  formatMeter,
  formatMult,
  formatScore,
  HAND_TYPE_COPY,
  RUNG_COPY,
  RUNGS,
  type PackRunOpenPayload,
  type ScoreStep,
} from "#/lib/pack-run";
import {
  playRunBlindCleared,
  playRunCombo,
  playRunCredit,
  playRunFinish,
  playRunMeterTick,
  playRunMiss,
  playRunNote,
  playRunOver,
  playRunTotal,
  prefetchRunSounds,
} from "../packSfx";
import { CharmKey } from "./CharmCard";
import { Shards } from "./Shards";
import { ModBadge } from "./ModBadge";

const NOTES_TINT = "#8fc1ff";
const COMBO_TINT = "#ff66aa";
const XCOMBO_TINT = "#ffd36b";
const MISS_TINT = "#ff5a5a";
const AGAIN_TINT = "#8fe3ff";
const CLEAR_TINT = "#6be0a0";

/* Playfield geometry, in px. Notes fall TRAVEL_MS from above the top edge to
   the judgement line, and the lane keys sit under it. */
const FIELD_H = 176;
const LINE_Y = 136;
const NOTE_H = 12;
const TRAVEL_MS = 440;
const FIELD_W = 200;
const MAX_LANE_W = 40;

type NoteKind = "notes" | "combo" | "xcombo" | "miss" | "credit" | "again" | "break" | "pattern";

const NOTE_FILL: Record<NoteKind, string> = {
  notes: "#e9eef7",
  combo: COMBO_TINT,
  xcombo: XCOMBO_TINT,
  miss: "#6d6878",
  credit: XCOMBO_TINT,
  again: AGAIN_TINT,
  break: "#6d6878",
  pattern: "#e9eef7",
};

const STEP_NOTE: Record<ScoreStep["kind"], NoteKind> = {
  chips: "notes",
  mult: "combo",
  xMult: "xcombo",
  debuff: "miss",
  cash: "credit",
  retrigger: "again",
  break: "break",
};

interface FallingNote {
  id: number;
  lane: number;
  kind: NoteKind;
}

interface Judge {
  id: number;
  lane: number;
  text: string;
  color: string;
}

/* A number that rolls to its target over `duration` ms, calling `onTick` as
   the digits move (the meter's ticking). */
function useRolling(target: number, duration: number, onTick?: (progress: number) => void): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const tickRef = useRef(onTick);
  tickRef.current = onTick;
  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return;
    if (duration <= 0) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      const value = Math.round(from + (target - from) * eased);
      if (value !== shownRef.current) {
        shownRef.current = value;
        setShown(value);
        tickRef.current?.(t);
      }
      if (t < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return shown;
}

/* The score meter, osu!'s eight zero-padded digits with the padding dimmed. */
function Meter({ value, className = "" }: { value: number; className?: string }) {
  const text = formatMeter(value);
  const lead = text.match(/^0*/)?.[0].length ?? 0;
  const dim = Math.min(lead, text.length - 1);
  return (
    <span className={`font-black leading-none tabular-nums ${className}`}>
      <span className="text-white/20">{text.slice(0, dim)}</span>
      <span className="text-white">{text.slice(dim)}</span>
    </span>
  );
}

/* The pack, scored, played as a chart. Every card is a lane; each beat of the
   server's tally drops a note down the lane of the card that earned it, and
   it lands on the judgement line with a hitsound: notes white, combo pink, a
   multiplied combo gold with a finish. Pack-wide beats (the pattern itself,
   a charm that reads the whole pack) are chords across every lane, and a card
   that scores nothing is a miss. Every number is the server's; this only
   replays the order it counted them in and lands on its totals. */
export function HandScore({
  run,
  cardCount,
  reducedMotion,
  startDelayMs = 650,
}: {
  run: PackRunOpenPayload;
  cardCount: number;
  reducedMotion: boolean;
  startDelayMs?: number;
}) {
  const { i18n } = useLingui();
  const { outcome } = run;
  const { score } = outcome;
  const steps = useMemo(() => score.steps.slice(1), [score.steps]);
  /* The first step is the pattern's own base. Random zeroes a repeated
     pattern, base and all, which is the one time it is not baseChips. */
  const startChips = score.steps[0]?.value ?? score.baseChips;
  const startMult = startChips === 0 ? 0 : score.baseMult;
  const lanes = Math.max(1, run.editions.length);
  const laneW = Math.min(MAX_LANE_W, Math.floor(FIELD_W / lanes));
  const fieldW = laneW * lanes;
  const aimAtTiles = cardCount === run.editions.length;

  const [chips, setChips] = useState(reducedMotion ? score.chips : 0);
  const [mult, setMult] = useState(reducedMotion ? score.mult : 0);
  const [patternShown, setPatternShown] = useState(reducedMotion);
  const [meterTarget, setMeterTarget] = useState(reducedMotion ? score.total : 0);
  const [meterMs, setMeterMs] = useState(160);
  const [done, setDone] = useState(reducedMotion);
  const [slam, setSlam] = useState(0);
  const [settled, setSettled] = useState(reducedMotion);
  const [notes, setNotes] = useState<FallingNote[]>([]);
  const [judges, setJudges] = useState<Judge[]>([]);
  const [lit, setLit] = useState<Record<number, { count: number; color: string }>>({});
  const [pulses, setPulses] = useState<Record<number, number>>({});
  const [unlocksOpen, setUnlocksOpen] = useState(run.rungsCrossed.length > 0);
  const timersRef = useRef<number[]>([]);
  const idRef = useRef(0);
  const meterProgress = useRef(0);
  const doneRef = useRef(done);
  doneRef.current = done;

  const meter = useRolling(meterTarget, reducedMotion ? 0 : meterMs, (t) => {
    if (!reducedMotion) playRunMeterTick(doneRef.current ? t : meterProgress.current);
  });

  const clearTimers = () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  };

  useEffect(() => {
    if (reducedMotion) return;
    prefetchRunSounds();
    const at = (ms: number, fn: () => void) => {
      timersRef.current.push(window.setTimeout(fn, ms));
    };
    let runningChips = 0;
    let runningMult = 0;
    let tone = 0;
    const finalTotal = Math.max(1, score.total);

    const laneOf = (step: ScoreStep) => (step.card >= 0 && step.card < lanes ? step.card : -1);
    const judge = (lane: number, text: string, color: string) => {
      const id = ++idRef.current;
      setJudges((current) => [...current.slice(-10), { id, lane, text, color }]);
      at(640, () => setJudges((current) => current.filter((entry) => entry.id !== id)));
    };
    const light = (lane: number, color: string) => {
      const targets = lane < 0 ? Array.from({ length: lanes }, (_, index) => index) : [lane];
      setLit((current) => {
        const next = { ...current };
        for (const index of targets) next[index] = { count: (current[index]?.count ?? 0) + 1, color };
        return next;
      });
    };
    const bumpTile = (lane: number) => {
      if (lane < 0 || !aimAtTiles) return;
      const tile = document.querySelector<HTMLElement>(`[data-pull-position="${lane}"]`);
      tile?.animate?.(
        [{ transform: "translateY(0)" }, { transform: "translateY(-6px)" }, { transform: "translateY(0)" }],
        { duration: 200, easing: "ease-out" },
      );
    };
    const updateMeter = () => {
      const value = Math.floor(runningChips * runningMult);
      meterProgress.current = Math.min(1, value / finalTotal);
      setMeterTarget(value);
    };
    const drop = (lane: number, kind: NoteKind, hitAt: number) => {
      at(hitAt - TRAVEL_MS, () => {
        const id = ++idRef.current;
        setNotes((current) => [...current, { id, lane, kind }]);
        const life = kind === "miss" || kind === "break" ? TRAVEL_MS * 1.5 : TRAVEL_MS;
        at(life, () => setNotes((current) => current.filter((note) => note.id !== id)));
      });
    };

    /* Beats speed up as the tally goes, and a long one is squeezed to fit. */
    const beats = steps.map((_, index) => Math.max(105, 250 - index * 14));
    const total = beats.reduce((sum, beat) => sum + beat, 0);
    const squeeze = total > 3600 ? 3600 / total : 1;
    let hitAt = startDelayMs + TRAVEL_MS;

    // The pattern lands first, a chord across every lane.
    drop(-1, "pattern", hitAt);
    at(hitAt, () => {
      runningChips = startChips;
      runningMult = startMult;
      setChips(runningChips);
      setMult(runningMult);
      setPatternShown(true);
      light(-1, "#ffffff");
      playRunCombo(tone++);
      updateMeter();
    });

    steps.forEach((step, index) => {
      hitAt += beats[index] * squeeze;
      const lane = laneOf(step);
      drop(lane, STEP_NOTE[step.kind] ?? "break", hitAt);
      at(hitAt, () => {
        if (step.charm) setPulses((current) => ({ ...current, [step.charm!]: (current[step.charm!] ?? 0) + 1 }));
        switch (step.kind) {
          case "chips":
            runningChips += step.value;
            setChips(runningChips);
            judge(lane, `+${step.value}`, NOTES_TINT);
            light(lane, NOTES_TINT);
            bumpTile(lane);
            playRunNote(tone++);
            updateMeter();
            break;
          case "mult":
            runningMult += step.value;
            setMult(runningMult);
            judge(lane, `+${step.value}`, COMBO_TINT);
            light(lane, COMBO_TINT);
            bumpTile(lane);
            playRunCombo(tone++);
            updateMeter();
            break;
          case "xMult":
            runningMult *= step.value;
            setMult(runningMult);
            judge(lane, `x${formatMult(step.value)}`, XCOMBO_TINT);
            light(lane, XCOMBO_TINT);
            bumpTile(lane);
            setSlam((value) => value + 1);
            playRunFinish();
            updateMeter();
            break;
          case "debuff":
            judge(lane, i18n._(msgMiss), MISS_TINT);
            playRunMiss();
            break;
          case "retrigger":
            judge(lane, i18n._(msgAgain), AGAIN_TINT);
            light(lane, AGAIN_TINT);
            break;
          case "cash":
            judge(lane, `${step.value > 0 ? "+" : ""}${step.value}`, XCOMBO_TINT);
            playRunCredit(step.value > 0);
            break;
          case "break":
            judge(lane, i18n._(msgBroke), "#a8a3b3");
            playRunMiss();
            break;
          default:
            break;
        }
      });
    });

    // The meter rolls the rest of the way to the server's total and slams.
    const endAt = hitAt + 260;
    at(endAt, () => {
      setChips(score.chips);
      setMult(score.mult);
      setDone(true);
      setMeterMs(650);
      setMeterTarget(score.total);
    });
    at(endAt + 700, () => {
      setSlam((value) => value + 1);
      playRunTotal(outcome.blindBefore.target > 0 ? score.total / outcome.blindBefore.target : 0);
    });
    at(endAt + 1150, () => {
      setSettled(true);
      if (outcome.over?.won) playRunBlindCleared("run");
      else if (outcome.cleared.length > 0) playRunBlindCleared(outcome.cleared.some((entry) => entry.blind === "boss") ? "stage" : "song");
      else if (outcome.over) playRunOver();
    });
    return clearTimers;
    // The payload is fixed for the life of the summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = () => {
    clearTimers();
    setNotes([]);
    setJudges([]);
    setChips(score.chips);
    setMult(score.mult);
    setPatternShown(true);
    setMeterMs(0);
    setMeterTarget(score.total);
    setDone(true);
    setSettled(true);
  };

  const before = outcome.blindBefore;
  const blindScore = settled ? Math.min(before.target, before.score + score.total) : before.score;
  const progress = before.target > 0 ? Math.min(1, blindScore / before.target) : 0;
  const cleared = outcome.cleared[0];
  const charms = run.view.state.charms;
  const mod = before.blind === "boss" ? before.boss : null;
  const stamp = settled ? (cleared ? "clear" : outcome.over && !outcome.over.won ? "failed" : null) : null;
  const comboText = formatMult(Math.round(mult * 100) / 100);

  return (
    <div className="mt-6 w-full max-w-[560px]" translate="no">
      <div className="flex items-stretch justify-center gap-4">
        {/* The playfield. */}
        <div
          key={`field-${slam}`}
          className={`relative shrink-0 overflow-hidden rounded-t-[10px] bg-black/40 ${slam > 0 && !reducedMotion ? "run-shake" : ""}`}
          style={{ width: fieldW, height: FIELD_H }}
          aria-hidden="true"
        >
          {Array.from({ length: lanes }, (_, lane) => (
            <div
              key={`lane-${lane}`}
              className={`absolute top-0 ${lane > 0 ? "border-l border-white/[0.06]" : ""}`}
              style={{ left: lane * laneW, width: laneW, height: LINE_Y }}
            >
              {lit[lane] && (
                <div
                  key={lit[lane].count}
                  className="run-lane-flash absolute inset-0"
                  style={{ background: `linear-gradient(to top, ${lit[lane].color}, transparent 85%)` }}
                />
              )}
            </div>
          ))}

          {/* Combo, mid-field as in the game. */}
          {patternShown && !stamp && (
            <div className="absolute inset-x-0 top-[34%] -translate-y-1/2 text-center">
              <div key={comboText} className="run-punch text-[34px] font-black leading-none text-white tabular-nums">
                {comboText}
              </div>
              <div className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.2em]" style={{ color: COMBO_TINT }}>
                <Trans>combo</Trans>
              </div>
            </div>
          )}

          {notes.map((note) => {
            const left = note.lane < 0 ? 2 : note.lane * laneW + 2;
            const width = note.lane < 0 ? fieldW - 4 : laneW - 4;
            const passes = note.kind === "miss" || note.kind === "break";
            const height = note.kind === "xcombo" || note.kind === "pattern" ? NOTE_H + 4 : NOTE_H;
            return (
              <motion.div
                key={note.id}
                className="absolute top-0 rounded-[3px]"
                style={{ left, width, height, background: NOTE_FILL[note.kind], boxShadow: "inset 0 -3px 0 rgba(0,0,0,0.25)" }}
                initial={{ y: -height, opacity: 1 }}
                animate={passes ? { y: FIELD_H + NOTE_H, opacity: 0.25 } : { y: LINE_Y - height / 2 }}
                transition={{ duration: (passes ? TRAVEL_MS * 1.5 : TRAVEL_MS) / 1000, ease: "linear" }}
              />
            );
          })}

          {/* Judgement line and the lane keys under it. */}
          <div className="absolute inset-x-0 h-[3px] bg-white/85" style={{ top: LINE_Y - 1 }} />
          {Array.from({ length: lanes }, (_, lane) => (
            <div
              key={`key-${lane}-${lit[lane]?.count ?? 0}`}
              className={`absolute rounded-[5px] ${lit[lane] ? "run-key" : ""}`}
              style={{
                left: lane * laneW + 3,
                width: laneW - 6,
                top: LINE_Y + 9,
                height: FIELD_H - LINE_Y - 16,
                background: lane % 2 === 0 ? "#3a3542" : "#2c2833",
                boxShadow: "inset 0 -3px 0 rgba(0,0,0,0.35)",
              }}
            />
          ))}

          {judges.map((entry) => (
            <span
              key={entry.id}
              className="run-judge absolute whitespace-nowrap text-[15px] font-black italic tabular-nums"
              style={{
                left: entry.lane < 0 ? fieldW / 2 : entry.lane * laneW + laneW / 2,
                top: LINE_Y - 26,
                color: entry.color,
                textShadow: "0 1px 0 rgba(0,0,0,0.6)",
              }}
            >
              {entry.text}
            </span>
          ))}

          {stamp && (
            <div className="absolute inset-0 grid place-items-center bg-black/60">
              <span
                className={`${reducedMotion ? "" : "run-stamp"} text-[26px] font-black italic uppercase tracking-[0.18em]`}
                style={{ color: stamp === "clear" ? CLEAR_TINT : MISS_TINT }}
              >
                {stamp === "clear" ? <Trans context="a dan course pass">Clear</Trans> : <Trans>Failed</Trans>}
              </span>
            </div>
          )}
        </div>

        {/* Score side: the pattern, the meter, notes and combo. */}
        <div className="flex min-w-0 flex-1 flex-col justify-between py-1">
          <div>
            <div className="min-h-[22px]">
              {patternShown && (
                <div className={`${reducedMotion ? "" : "run-stamp"} origin-left text-[20px] font-black italic uppercase leading-none text-white`}>
                  {i18n._(HAND_TYPE_COPY[score.handType].name)}
                </div>
              )}
            </div>
            <div key={`meter-${slam}`} className={`mt-2 origin-left ${slam > 0 && done && !reducedMotion ? "run-punch" : ""}`}>
              <Meter value={meter} className="text-[26px]" />
            </div>
            {done && <span className="sr-only">{formatScore(score.total)}</span>}
          </div>
          <div className="space-y-1 text-[13px] tabular-nums">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-osu-f1">
                <Trans>notes</Trans>
              </span>
              <span className="text-[18px] font-black" style={{ color: NOTES_TINT }}>
                {formatScore(chips)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-osu-f1">
                <Trans>combo</Trans>
              </span>
              <span className="text-[18px] font-black" style={{ color: COMBO_TINT }}>
                x{comboText}
              </span>
            </div>
            {mod && (
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-osu-f1">{i18n._(BLIND_COPY.boss)}</span>
                <ModBadge boss={mod} size="sm" />
              </div>
            )}
          </div>
        </div>
      </div>

      {charms.length > 0 && (
        <div className="mt-5 flex justify-center gap-2">
          {charms.map((charm) => (
            <span key={charm.uid} data-run-charm={charm.uid}>
              <CharmKey id={charm.id} charm={charm} pulse={pulses[charm.uid] ?? 0} size={34} />
            </span>
          ))}
        </div>
      )}

      <div className="mt-6 flex items-baseline justify-between text-[12px] text-osu-f1">
        <span>
          <Trans>Stage {before.ante}</Trans>
          <span className="mx-2 inline-block h-3 w-px translate-y-[2px] bg-white/15" />
          {i18n._(BLIND_COPY[before.blind])}
        </span>
        <span className="tabular-nums">
          <span className="text-[15px] font-black text-white">{formatScore(blindScore)}</span> / {formatScore(before.target)}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-osu-b3/50">
        <motion.div
          className="h-full rounded-full"
          style={{ background: progress >= 1 ? CLEAR_TINT : NOTES_TINT }}
          initial={false}
          animate={{ width: `${Math.max(2, progress * 100)}%` }}
          transition={{ duration: reducedMotion ? 0 : 0.5, ease: "easeOut" }}
        />
      </div>

      <AnimatePresence>
        {settled && (
          <motion.div
            className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-[13px]"
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
          >
            {cleared ? (
              <span className="font-bold" style={{ color: CLEAR_TINT }}>
                {i18n._(BLIND_CLEARED_COPY[cleared.blind])}
              </span>
            ) : outcome.over ? (
              <span className="font-bold text-osu-pink-light">
                {outcome.over.won ? <Trans>Run cleared</Trans> : <Trans>Failed at stage {outcome.over.ante}</Trans>}
              </span>
            ) : (
              <span className="text-osu-f1">
                <Plural value={outcome.blindAfter.packsLeft} one="# pack left" other="# packs left" />
              </span>
            )}
            {cleared && outcome.over?.won && (
              <span className="font-bold text-osu-pink-light">
                <Trans>Run cleared</Trans>
              </span>
            )}
            {outcome.shards > 0 && (
              <Shards value={outcome.shards} sign className="font-bold text-osu-pink-light" />
            )}
            {outcome.levelsGained.length > 0 && (
              <span className="font-bold text-white">
                <Trans>Collector level {outcome.levelsGained[outcome.levelsGained.length - 1]}</Trans>
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!settled && (
        <div className="mt-2 text-center">
          <button type="button" onClick={skip} className="text-[11px] text-osu-f1 hover:text-white">
            <Trans>Skip</Trans>
          </button>
        </div>
      )}

      <AnimatePresence>
        {unlocksOpen && settled && (
          <RunUnlocks rungs={run.rungsCrossed} onClose={() => setUnlocksOpen(false)} reducedMotion={reducedMotion} />
        )}
      </AnimatePresence>
    </div>
  );
}

/* Rungs of the collection ladder crossed by this pack. The first time a
   collector is scored, every rung they already stand past arrives at once. */
function RunUnlocks({ rungs, onClose, reducedMotion }: { rungs: number[]; onClose: () => void; reducedMotion: boolean }) {
  const { i18n } = useLingui();
  const entries = rungs
    .map((at) => RUNGS.find((rung) => rung.at === at))
    .filter((rung): rung is (typeof RUNGS)[number] => Boolean(rung));
  if (typeof document === "undefined") return null;
  return createPortal(
    <motion.div
      className="fixed inset-0 z-[95] grid place-items-center bg-black/75 px-6"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <motion.div
        className="w-full max-w-[420px] text-center"
        initial={reducedMotion ? false : { scale: 0.85, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
      >
        <div className="text-[40px] font-black italic uppercase leading-none text-white">
          <Plural value={entries.length} one="Unlocked" other="# unlocks" />
        </div>
        <div className="mt-6 flex flex-col gap-3">
          {entries.map((rung, index) => (
            <motion.div
              key={rung.at}
              className="flex items-baseline justify-between gap-4 border-t border-white/[0.07] pt-3 text-left"
              initial={reducedMotion ? false : { opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + index * 0.12 }}
            >
              <span className="text-[16px] font-bold text-white">{i18n._(RUNG_COPY[rung.unlock])}</span>
              <span className="text-[12px] text-osu-f1 tabular-nums">
                <Trans>{rung.at.toLocaleString("en-US")} cards</Trans>
              </span>
            </motion.div>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-8 rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white transition hover:brightness-110"
        >
          <Trans>Ok</Trans>
        </button>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

const msgMiss = msg`MISS`;
const msgAgain = msg`AGAIN`;
const msgBroke = msg`BROKE`;
