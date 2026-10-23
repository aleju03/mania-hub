import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LogOut } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CHAIN_RUN_NAME,
  chainSkip727,
  CHAIN_RULES,
  CHAIN_SCENE_COPY,
  CHAIN_SCENE_INK,
  CHAIN_SCENE_NAMES,
  CHAIN_SCENE_NUMBERS,
  formatChainScore,
  formatChainX,
  type ChainSceneHeld,
  type ChainSceneId,
  type ChainWysiField,
} from "#/lib/chain-run";
import { flameLevel } from "../RunFlame";
import { punch } from "../runJuice";
import { runSound } from "../runSound";
import { SceneArt, type SceneId } from "../sceneArt";
import { Shards } from "../Shards";
import { useTicker } from "../shopMotion";
import { showChainDetails, useChainDetailsTrigger } from "./ChainDetails";
import { WysiDigits, WysiStamp } from "./Wysi";

export const SCENE_ART_ID: Record<ChainSceneId, SceneId> = {
  makiba: "makiba",
  mario: "marioPaint",
  duplicity: "duplicity",
  echoes: "echoes",
  tree: "tree",
  forgotten: "onceForgotten",
  future: "futureDominators",
  ascension: "ascension",
  aiae: "aiae",
  scatteredFaith: "scatteredFaith",
  foolMoon: "foolMoon",
  moonGate: "moonGate",
  lostRequiem: "lostRequiem",
  purplePalace: "purplePalace",
};

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-osu-f1">{children}</div>;
}

function Pips({ left, total, fill }: { left: number; total: number; fill: string }) {
  return (
    <span className="flex items-center gap-1">
      {Array.from({ length: total }, (_, index) => (
        <motion.span
          key={index}
          className="block h-2.5 w-2.5 rounded-full"
          initial={false}
          animate={{ backgroundColor: index < left ? fill : "rgba(255,255,255,0.14)", scale: index < left ? 1 : 0.8 }}
          transition={{ type: "spring", stiffness: 500, damping: 22 }}
        />
      ))}
    </span>
  );
}

/* HUD pieces that come and go with the round fade out instead of
   vanishing in one frame. */
function Fade({ show, className, children }: { show: boolean; className?: string; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className={className}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8, transition: { duration: 0.24 } }}
          transition={{ duration: 0.22 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function digits(value: number): number {
  return String(Math.round(Math.abs(value))).length;
}

/* The round's score in its box. Quiet while it is 0; punches when a row
   lands on it. Past the target (`heat`, the score as the chain has it) the
   ink flame burns on its top edge. */
function ScoreBox({
  score,
  heat,
  target,
  big,
  reducedMotion,
  banked = false,
}: {
  score: number;
  heat: number;
  target: number;
  big: boolean;
  reducedMotion: boolean;
  /* A row is playing: the box holds the banked score, dimmed, until the
     row's total lands on it. */
  banked?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(score);
  const level = flameLevel(heat, target);
  /* A rise counts up from the old score over ~220ms (one number change per
     row); a drop (a new round) shows at once. */
  const [shown, setShown] = useState(score);
  useEffect(() => {
    const before = last.current;
    last.current = score;
    if (reducedMotion || score <= before) {
      setShown(score);
      return;
    }
    punch(ref.current, digits(score) + 2);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 220);
      setShown(chainSkip727(before + (score - before) * (1 - (1 - k) ** 2), score));
      if (k < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [reducedMotion, score]);
  const idle = score === 0 && level === 0;
  return (
    <div className="relative">
      <div
        ref={ref}
        data-chain-score=""
        className={`relative z-[1] rounded-lg bg-[#0c0a10] font-black leading-none tabular-nums transition-colors duration-300 ${idle ? "text-white/40" : banked ? "text-white/45" : "text-white"} ${big ? "min-w-[150px] px-3 py-2 text-[40px]" : "min-w-[84px] px-2 py-1 text-[24px]"}`}
      >
        <span data-chain-score-digits="">
          <WysiDigits text={formatChainScore(shown)} />
        </span>
      </div>
    </div>
  );
}

/* The round's progress: score against target, a faint fill to what the
   arranged row (or the playing chain) would bring it to, and Once
   Forgotten's star at 3x when she is held (the bar then runs to the star).
   `flash` bumps when the chain carries the round past its target. */
function Meter({ score, ghost, fuzzy, target, star, width, flash }: { score: number; ghost: number; fuzzy: boolean; target: number; star: number | null; width: number; flash: number }) {
  const end = star ?? target;
  const share = end > 0 ? Math.min(1, score / end) : 0;
  const ghostShare = end > 0 ? Math.min(1, Math.max(score, ghost) / end) : 0;
  const targetAt = end > 0 ? target / end : 1;
  const passed = score >= target && target > 0;
  const ghostPassed = ghost >= target && target > 0;
  return (
    <div data-chain-meter="" className="relative h-[8px] rounded-full bg-[#2a2531]" style={{ width }}>
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full"
        initial={false}
        style={{
          background: fuzzy
            ? `linear-gradient(90deg, ${ghostPassed ? "rgba(255,179,71,0.42)" : "rgba(255,102,170,0.32)"} 0%, ${ghostPassed ? "rgba(255,179,71,0.42)" : "rgba(255,102,170,0.32)"} 62%, transparent 100%)`
            : ghostPassed
              ? "rgba(255,179,71,0.45)"
              : "rgba(255,102,170,0.3)",
        }}
        animate={{ width: `${Math.min(1, ghostShare * (fuzzy ? 1.25 : 1)) * 100}%` }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
      />
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full"
        initial={false}
        animate={{ width: `${share * 100}%`, backgroundColor: passed ? "#ffb347" : "#ff66aa" }}
        transition={{ type: "spring", stiffness: 160, damping: 24 }}
      />
      {flash > 0 && (
        <motion.div
          key={flash}
          className="absolute -inset-y-[5px] inset-x-0 rounded-full bg-[#ffd36b]"
          initial={{ opacity: 0.95, scaleY: 1.6 }}
          animate={{ opacity: 0, scaleY: 1 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
        />
      )}
      {star !== null && <div className="absolute -top-[3px] h-[14px] w-[2px] rounded bg-white/50" style={{ left: `${targetAt * 100}%` }} />}
      {star !== null && (
        <svg viewBox="0 0 20 20" className="absolute -right-[7px] -top-[10px] h-[16px] w-[16px]" aria-hidden="true">
          <path d="M10 1 L12.6 7 L19 7.6 L14.1 11.8 L15.6 18.2 L10 14.8 L4.4 18.2 L5.9 11.8 L1 7.6 L7.4 7Z" fill={score > star ? "#6d6878" : CHAIN_SCENE_INK.forgotten} />
        </svg>
      )}
    </div>
  );
}

export interface ChainTopBarProps {
  narrow: boolean;
  round: number;
  target: number;
  roundScore: number;
  /* The bar's fill: the chain's running score while a row plays, so the box
     keeps the old number until the row's total lands on it once. */
  meterScore: number;
  /* The score the flame and bar read: the round's, or the chain's as it plays. */
  heatScore: number;
  /* The faint fill: what the arranged row or the playing chain reaches. */
  ghostScore: number;
  /* The arranged row's ghost is a rough band, never an exact mark. */
  ghostFuzzy: boolean;
  crossFlash: number;
  star: number | null;
  rowsLeft: number;
  redrawsLeft: number;
  shards: number;
  showRound: boolean;
  /* The score against the target, while a round is being played. */
  showMeter: boolean;
  /* The score box reads the banked score while a row plays. */
  scoreBanked?: boolean;
  reducedMotion: boolean;
  onExit: () => void;
  /* Phones carry the scene cards in the bar. */
  scenes: React.ReactNode;
  /* Phones carry the deck pile in the bar too. */
  deck?: React.ReactNode;
  /* A 727 on the table: which numbers get the stamp, keyed by `id`. */
  wysi?: { id: number; on: ChainWysiField[] } | null;
}

/* Across the top: the round, its score against the target (the flame lives
   here), rows and redraws left, and run shards. */
export function ChainTopBar(props: ChainTopBarProps) {
  const { deck, narrow, round, target, roundScore, meterScore, heatScore, ghostScore, ghostFuzzy, crossFlash, star, rowsLeft, redrawsLeft, shards, showRound, showMeter, reducedMotion, onExit, scenes, wysi, scoreBanked = false } = props;
  const { t, i18n } = useLingui();
  const shownShards = useTicker(shards, reducedMotion);
  const stamp = (on: ChainWysiField) => (wysi?.on.includes(on) ? <WysiStamp key={`wysi-${wysi.id}-${on}`} reducedMotion={reducedMotion} /> : null);
  const exit = (
    <button
      type="button"
      onClick={onExit}
      title={t`Back to packs`}
      aria-label={t`Back to packs`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-osu-f1 transition hover:bg-white/5 hover:text-white"
    >
      <LogOut className="h-4 w-4 -scale-x-100" />
    </button>
  );
  const shardsBox = (
    <div data-chain-shards="" className="relative text-right">
      <Label>
        <Trans>Shards</Trans>
      </Label>
      <Shards value={shownShards} lit727 className={`font-black leading-none ${narrow ? "text-[18px]" : "text-[24px]"}`} />
      {stamp("shards")}
    </div>
  );

  if (narrow) {
    return (
      <div className="relative z-[3] flex flex-col gap-2 px-3 pb-1 pt-5">
        <div className="flex items-center gap-3">
          {showRound ? (
            <>
              <div className="relative shrink-0">
                <Label>
                  <Trans>Round</Trans>
                </Label>
                <div className="text-[24px] font-black italic leading-none tabular-nums">
                  <WysiDigits text={String(round)} />
                </div>
                {stamp("round")}
              </div>
              <Fade show={showMeter} className="flex min-w-0 items-center gap-3">
                <>
                  <div className="relative z-[1] min-w-0">
                    <ScoreBox score={roundScore} heat={heatScore} target={target} big={false} reducedMotion={reducedMotion} banked={scoreBanked} />
                    {stamp("roundScore")}
                  </div>
                  <div className="relative min-w-0 leading-tight">
                    <Label>
                      <Trans>Target</Trans>
                    </Label>
                    <div className="text-[15px] font-black tabular-nums">
                      <WysiDigits text={formatChainScore(target)} />
                    </div>
                    {stamp("target")}
                  </div>
                </>
              </Fade>
            </>
          ) : (
            <div className="text-[20px] font-black italic uppercase leading-none">
              {i18n._(CHAIN_RUN_NAME)}
            </div>
          )}
          <span className="ml-auto" />
          {shardsBox}
          {exit}
        </div>
        <div className="flex items-center gap-3">
          <Fade show={showMeter} className="flex items-center gap-3">
            <>
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-osu-f1">
                <Trans>Rows</Trans>
                <Pips left={rowsLeft} total={CHAIN_RULES.rows} fill="#ff66aa" />
              </div>
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-osu-f1">
                <Trans>Redraws</Trans>
                <Pips left={redrawsLeft} total={CHAIN_RULES.redraws} fill="#8fc1ff" />
              </div>
            </>
          </Fade>
          <span className="ml-auto" />
          {scenes}
          {deck}
        </div>
        <Fade show={showMeter}>
          <Meter score={meterScore} ghost={ghostScore} fuzzy={ghostFuzzy} target={target} star={star} width={window.innerWidth - 24} flash={crossFlash} />
        </Fade>
      </div>
    );
  }

  return (
    <div className="relative z-[3] grid grid-cols-[1fr_auto_1fr] items-center gap-6 px-6 pb-2 pt-10">
      <div className="flex items-center gap-4">
        {showRound ? (
          <div className="relative">
            <Label>
              <Trans>Round</Trans>
            </Label>
            <div className="text-[40px] font-black italic leading-none tabular-nums">
              <WysiDigits text={String(round)} />
            </div>
            {stamp("round")}
          </div>
        ) : (
          <div className="text-[30px] font-black italic uppercase leading-none">
            {i18n._(CHAIN_RUN_NAME)}
          </div>
        )}
      </div>
      <div className="flex flex-col items-center gap-2.5">
        <Fade show={showMeter} className="flex flex-col items-center gap-2.5">
          <>
            <div className="flex items-end gap-3">
              <div className="relative z-[1]">
                <ScoreBox score={roundScore} heat={heatScore} target={target} big reducedMotion={reducedMotion} banked={scoreBanked} />
                {stamp("roundScore")}
              </div>
              <div className="relative z-[1] rounded-lg bg-[#0c0a10] px-2.5 py-1.5 leading-tight">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-osu-f1">
                  <Trans>Target</Trans>
                </div>
                <div className="text-[24px] font-black tabular-nums">
                  <WysiDigits text={formatChainScore(target)} />
                </div>
                {stamp("target")}
              </div>
            </div>
            <Meter score={meterScore} ghost={ghostScore} fuzzy={ghostFuzzy} target={target} star={star} width={360} flash={crossFlash} />
          </>
        </Fade>
      </div>
      <div className="flex items-center justify-end gap-6">
        <Fade show={showMeter} className="flex items-center gap-6">
          <>
            <div>
              <Label>
                <Trans>Rows</Trans>
              </Label>
              <div className="mt-1.5">
                <Pips left={rowsLeft} total={CHAIN_RULES.rows} fill="#ff66aa" />
              </div>
            </div>
            <div>
              <Label>
                <Trans>Redraws</Trans>
              </Label>
              <div className="mt-1.5">
                <Pips left={redrawsLeft} total={CHAIN_RULES.redraws} fill="#8fc1ff" />
              </div>
            </div>
          </>
        </Fade>
        {shardsBox}
        {exit}
      </div>
    </div>
  );
}

function sceneBadge(scene: ChainSceneHeld, ascension: number, startCombo: number): string | null {
  if (scene.id === "forgotten" && startCombo > 1) return `+${startCombo - 1}`;
  if (scene.id === "ascension" && ascension > 0) return `x${formatChainX(ascension)}`;
  if (scene.id === "lostRequiem" && scene.stacks > 0) return `+${scene.stacks * CHAIN_SCENE_NUMBERS.requiemBase}`;
  return null;
}

function SceneItem({
  scene,
  compact,
  ascension,
  startCombo,
  onSell,
  sellDisabled,
}: {
  scene: ChainSceneHeld;
  compact: boolean;
  ascension: number;
  startCombo: number;
  onSell: ((id: ChainSceneId) => void) | null;
  sellDisabled: boolean;
}) {
  const { i18n } = useLingui();
  const content = () => ({ kind: "scene" as const, scene, ascension, startCombo, ...(onSell ? { sell: CHAIN_RULES.sceneSell } : {}) });
  const details = useChainDetailsTrigger(content);
  const badge = sceneBadge(scene, ascension, startCombo);
  const art = compact ? 36 : 54;
  return (
    <motion.div
      layout
      className={`flex items-center ${compact ? "flex-col gap-1" : "gap-3"}`}
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.4, transition: { duration: 0.25 } }}
      transition={{ type: "spring", stiffness: 520, damping: 26 }}
    >
      <div
        data-chain-scene={scene.id}
        className="relative shrink-0 cursor-default"
        onPointerEnter={details.onPointerEnter}
        onPointerMove={details.onPointerMove}
        onPointerLeave={details.onPointerLeave}
        onPointerDown={details.onPointerDown}
        onPointerUp={details.onPointerUp}
        onClick={(event) => {
          if (compact) {
            const rect = event.currentTarget.getBoundingClientRect();
            details.onPointerLeave();
            showChainDetails(content(), rect);
          }
        }}
      >
        <div data-run-juice="" className="overflow-hidden rounded-[8px]" style={{ width: art, height: art }}>
          <SceneArt id={SCENE_ART_ID[scene.id]} size={art} />
        </div>
        {badge && (
          <span
            className="absolute -bottom-1.5 -right-2 rounded-full px-1.5 py-0.5 text-[11px] font-black leading-none tabular-nums"
            style={{ background: CHAIN_SCENE_INK[scene.id], color: "#120f1a" }}
          >
            {badge}
          </span>
        )}
      </div>
      {!compact && (
        <div className="min-w-0">
          <div className="truncate text-[14px] font-black" style={{ color: CHAIN_SCENE_INK[scene.id] }}>
            {CHAIN_SCENE_NAMES[scene.id]}
          </div>
          <div className="text-[12px] leading-snug text-osu-f1">{i18n._(CHAIN_SCENE_COPY[scene.id].short)}</div>
          {onSell && (
            <button
              type="button"
              disabled={sellDisabled}
              onClick={() => onSell(scene.id)}
              className="mt-1 inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-0.5 text-[12px] font-bold text-white transition hover:brightness-125 disabled:opacity-40"
            >
              <Trans>Sell</Trans> <Shards value={CHAIN_RULES.sceneSell} sign />
            </button>
          )}
        </div>
      )}
      {compact && onSell && (
        <>
          <div className="line-clamp-2 w-[92px] text-center text-[11px] leading-tight text-osu-f1">{i18n._(CHAIN_SCENE_COPY[scene.id].short)}</div>
          <button
            type="button"
            disabled={sellDisabled}
            onClick={() => onSell(scene.id)}
            className="rounded-full bg-white/10 px-1.5 py-0.5 text-[11px] font-bold text-white disabled:opacity-40"
          >
            <Trans>Sell</Trans> <Shards value={CHAIN_RULES.sceneSell} sign />
          </button>
        </>
      )}
    </motion.div>
  );
}

/* The held scene cards as a small group: name and one line each, the full
   rule on hover. A corner of the table on desktop, a strip in the bar on
   phones. In the shop each one can be sold. */
export function ChainScenes({
  scenes,
  compact,
  ascension,
  startCombo,
  onSell,
  sellDisabled = false,
}: {
  scenes: ChainSceneHeld[];
  compact: boolean;
  ascension: number;
  startCombo: number;
  onSell?: (id: ChainSceneId) => void;
  sellDisabled?: boolean;
}) {
  useEffect(() => runSound.prefetch(), []);
  return (
    <div className={compact ? "flex items-start gap-2" : "flex w-[240px] flex-col gap-3"}>
      <AnimatePresence initial={false}>
        {scenes.map((scene) => (
          <SceneItem
            key={scene.id}
            scene={scene}
            compact={compact}
            ascension={ascension}
            startCombo={startCombo}
            onSell={onSell ?? null}
            sellDisabled={sellDisabled}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/* The deck pile as a chip in the phone's bar: where draws come from and
   kept cards go. */
export function HudDeck({ count, backUrl }: { count: number; backUrl: string | null }) {
  const { t } = useLingui();
  return (
    <div data-chain-hud-deck="" className="flex shrink-0 items-center gap-1.5" title={t`${count} cards in the deck`}>
      <div className="relative h-[34px] w-[24px] overflow-hidden rounded-[4px] bg-osu-b4">
        {backUrl && <img src={backUrl} alt="" draggable={false} className="h-full w-full object-cover" />}
      </div>
      <span className="text-[13px] font-black tabular-nums">{count}</span>
    </div>
  );
}
