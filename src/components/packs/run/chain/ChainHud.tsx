import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LogOut } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  chainSkip727,
  CHAIN_RULES,
  CHAIN_SCENE_COPY,
  CHAIN_SCENE_INK,
  CHAIN_SCENE_NAMES,
  CHAIN_SCENE_NUMBERS,
  chainIsEndless,
  chainSceneMultiplier,
  formatChainScore,
  formatChainX,
  type ChainSceneHeld,
  type ChainSceneId,
  type ChainWysiField,
  type ChainCard,
} from "#/lib/chain-run";
import { RoundChartTag } from "./ChainRoundChart";
import { punch } from "../runJuice";
import { isRunMusicOn, setRunMusicOn, subscribeRunMusic } from "../../packSfx";
import { runSound } from "../runSound";
import { SceneArt, type SceneId } from "../sceneArt";
import { Shards } from "../Shards";
import { useTicker } from "../shopMotion";
import { showChainDetails, useChainDetailsTrigger } from "./ChainDetails";
import { WysiDigits, WysiStamp } from "./Wysi";
import { KIT, KitGem, MARKER, ObjectiveLine, SceneMedallion } from "./chainKit";

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
  galaxy: "galaxyCollapse",
  sidetracked: "sidetrackedDay",
  freedomDive: "freedomDive",
  blueZenith: "blueZenith",
  halcyon: "halcyon",
};

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
  return formatChainScore(Math.abs(value)).length;
}

/* Marker digits sized to fit a ring `room` px across. */
function fitSize(text: string, room: number, max: number): number {
  return Math.min(max, (room * 0.86) / Math.max(1, text.length * 0.6));
}

/* The round's score inside the bridge's left ring. Quiet while it is 0;
   punches when a row lands on it, counting up from the old score. */
function ScoreBox({
  score,
  room,
  max,
  reducedMotion,
  banked = false,
}: {
  score: number;
  room: number;
  max: number;
  reducedMotion: boolean;
  /* A row is playing: the ring holds the banked score, dimmed, until the
     row's total lands on it. */
  banked?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(score);
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
  const text = formatChainScore(shown);
  return (
    <div
      ref={ref}
      data-chain-score=""
      className={`relative z-[1] leading-none tabular-nums transition-colors duration-300 ${score === 0 ? "text-[#f3e9d8]/40" : banked ? "text-[#f3e9d8]/45" : "text-[#f3e9d8]"}`}
      style={{ fontFamily: MARKER, fontSize: fitSize(text, room, max) }}
    >
      <span data-chain-score-digits="">
        <WysiDigits text={text} />
      </span>
    </div>
  );
}

/* The round's objective: "score of target", numbers first, with the
   progress hairline under it (what the arranged row would add marked on
   it). */
function Objective({
  narrow,
  round,
  score,
  meterScore,
  ghost,
  target,
  star,
  flash,
  banked,
  reducedMotion,
  stamp,
  lineWidth,
}: {
  narrow: boolean;
  round: number;
  score: number;
  meterScore: number;
  ghost: number;
  target: number;
  star: number | null;
  flash: number;
  banked: boolean;
  reducedMotion: boolean;
  stamp: (on: ChainWysiField) => React.ReactNode;
  lineWidth: number;
}) {
  const end = star ?? target;
  const share = end > 0 ? Math.min(1, meterScore / end) : 0;
  const ghostShare = end > 0 ? Math.min(1, Math.max(meterScore, ghost) / end) : 0;
  const adds = Math.max(0, ghost - meterScore);
  return (
    <div className="flex flex-col items-center">
      <div className="relative font-black uppercase leading-none text-[#f3e9d8]/60" style={{ fontSize: narrow ? 10 : 12, letterSpacing: "0.3em" }}>
        {chainIsEndless(round) ? <Trans>Endless round {round}</Trans> : <Trans>Round {round}</Trans>}
        {stamp("round")}
      </div>
      <div className={`flex items-baseline justify-center ${narrow ? "mt-1 gap-2" : "mt-1 gap-3"}`}>
        <div className="relative">
          <ScoreBox score={score} room={narrow ? 150 : 320} max={narrow ? 34 : 72} reducedMotion={reducedMotion} banked={banked} />
          {stamp("roundScore")}
        </div>
        <span className="leading-none text-[#f3e9d8]/45" style={{ fontFamily: MARKER, fontSize: narrow ? 16 : 32 }}>
          <Trans>of</Trans>
        </span>
        <div className="relative leading-none tabular-nums" style={{ fontFamily: MARKER, color: KIT.gold, fontSize: narrow ? 22 : 42 }}>
          <WysiDigits text={formatChainScore(target)} />
          {stamp("target")}
        </div>
      </div>
      <div className={narrow ? "mt-2" : "mt-3"}>
        <ObjectiveLine
          width={lineWidth}
          share={share}
          ghostShare={ghostShare}
          passed={meterScore >= target && target > 0}
          ghostLabel={adds > 0 ? `+${formatChainScore(adds)}` : null}
          targetAt={end > 0 ? target / end : 1}
          star={star !== null ? { ink: CHAIN_SCENE_INK.forgotten, lit: meterScore <= star } : null}
          flash={flash}
          meterProps={{ "data-chain-meter": "" }}
        />
      </div>
    </div>
  );
}

export interface ChainTopBarProps {
  narrow: boolean;
  round: number;
  target: number;
  roundScore: number;
  /* The bridge's fill: the chain's running score while a row plays, so the
     ring keeps the old number until the row's total lands on it once. */
  meterScore: number;
  /* The score the flame and bridge read: the round's, or the chain's as it plays. */
  heatScore: number;
  /* The faint fill: what the arranged row or the playing chain reaches.
     The arranged row's counts its plain links and combos only (Balatro's
     hand value before jokers), so scene cards can still beat it. */
  ghostScore: number;
  crossFlash: number;
  star: number | null;
  shards: number;
  showRound: boolean;
  /* The score against the target, while a round is being played. */
  showMeter: boolean;
  /* The score ring reads the banked score while a row plays. */
  scoreBanked?: boolean;
  reducedMotion: boolean;
  onExit: () => void;
  /* Phones carry the scene cards in the bar. */
  scenes: React.ReactNode;
  /* Phones carry the deck pile in the bar too. */
  deck?: React.ReactNode;
  /* A 727 on the table: which numbers get the stamp, keyed by `id`. */
  wysi?: { id: number; on: ChainWysiField[] } | null;
  /* The chart the round being played is set on. */
  roundChart?: ChainCard | null;
  /* The daily run: a tag says so. */
  daily?: boolean;
  /* Opens how to play. */
  onHelp?: () => void;
  /* Signed in: switches between the player's own run and the daily run
     (both stay saved). */
  onSwitchMode?: () => void;
  /* The table is showing the daily run (the switch then goes back). */
  inDaily?: boolean;
  /* Ends the run where it stands, after a confirm. */
  onEndRun?: () => void;
}

/* Ends the run on purpose (a won run's endless rounds have no end of their
   own): a flag that asks first. */
function EndRunButton({ onEnd }: { onEnd: () => void }) {
  const { t } = useLingui();
  const [asking, setAsking] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          runSound.uiTap();
          setAsking((value) => !value);
        }}
        title={t`End run`}
        aria-label={t`End run`}
        aria-expanded={asking}
        className="grid h-8 w-8 place-items-center rounded-full border-2 border-[#f3e9d8]/40 text-[#f3e9d8]/80 transition hover:border-[#f3e9d8] hover:text-white"
      >
        <svg viewBox="0 0 20 20" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 18V3" />
          <path d="M5 3.5c3-1.6 5.5 1.6 9.5 0v8c-4 1.6-6.5-1.6-9.5 0" fill="currentColor" fillOpacity={0.25} />
        </svg>
      </button>
      {asking && (
        <div
          className="absolute right-0 top-full z-[60] mt-2 w-[230px] rounded-xl border-2 p-3 text-left"
          style={{ background: KIT.dark, borderColor: "rgba(243,233,216,0.35)", boxShadow: "0 8px 24px rgba(0,0,0,0.55)" }}
        >
          <div className="text-[13px] font-bold leading-snug text-[#f3e9d8]">
            <Trans>End this run here? It counts on the board at the round you reached.</Trans>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                onEnd();
              }}
              className="flex-1 rounded-full px-3 py-1.5 text-[13px] font-black"
              style={{ background: KIT.pink, color: KIT.dark }}
            >
              <Trans>End run</Trans>
            </button>
            <button
              type="button"
              onClick={() => {
                runSound.uiTap();
                setAsking(false);
              }}
              className="flex-1 rounded-full border-2 border-[#f3e9d8]/40 px-3 py-1.5 text-[13px] font-black text-[#f3e9d8]"
            >
              <Trans>Keep playing</Trans>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* Music on or off; the choice is kept for every later run. */
function MusicToggle() {
  const { t } = useLingui();
  const on = useSyncExternalStore(subscribeRunMusic, isRunMusicOn, () => true);
  const label = on ? t`Turn music off` : t`Turn music on`;
  return (
    <button
      type="button"
      onClick={() => {
        runSound.uiTap();
        setRunMusicOn(!on);
      }}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-[#f3e9d8]/40 text-[#f3e9d8]/80 transition hover:border-[#f3e9d8] hover:text-white"
    >
      <svg viewBox="0 0 20 20" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 14.5V4.5l7-1.5v9.5" />
        <ellipse cx="5.6" cy="14.6" rx="2.4" ry="1.9" fill="currentColor" stroke="none" />
        <ellipse cx="12.6" cy="12.8" rx="2.4" ry="1.9" fill="currentColor" stroke="none" />
        {!on && <path d="M3 3l14 14" stroke={KIT.dark} strokeWidth={4.5} />}
        {!on && <path d="M3 3l14 14" />}
      </svg>
    </button>
  );
}

/* Across the top: the round in its medallion (rows and redraws left as its
   rings), the score bridge to the target (the flame lives under it), and
   the run's shards. */
export function ChainTopBar(props: ChainTopBarProps) {
  const { deck, narrow, round, target, roundScore, meterScore, ghostScore, crossFlash, star, shards, showRound, showMeter, reducedMotion, onExit, scenes, wysi, scoreBanked = false, roundChart = null, daily = false, onHelp, onSwitchMode, inDaily = false, onEndRun } = props;
  const { t } = useLingui();
  const shownShards = useTicker(shards, reducedMotion);
  const stamp = (on: ChainWysiField) => (wysi?.on.includes(on) ? <WysiStamp key={`wysi-${wysi.id}-${on}`} reducedMotion={reducedMotion} /> : null);
  const switchMode = onSwitchMode ? (
    <button
      type="button"
      onClick={onSwitchMode}
      className="shrink-0 rounded-full border-2 px-2.5 py-1 leading-none transition hover:brightness-125"
      style={{ fontFamily: MARKER, fontSize: narrow ? 13 : 15, color: KIT.gold, borderColor: `${KIT.gold}99`, background: KIT.dark }}
    >
      {inDaily ? <Trans>Your run</Trans> : <Trans>Daily</Trans>}
    </button>
  ) : null;
  const help = onHelp ? (
    <button
      type="button"
      onClick={onHelp}
      title={t`How to play`}
      aria-label={t`How to play`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-[#f3e9d8]/40 leading-none text-[#f3e9d8]/80 transition hover:border-[#f3e9d8] hover:text-white"
      style={{ fontFamily: MARKER, fontSize: 16 }}
    >
      ?
    </button>
  ) : null;
  const music = <MusicToggle />;
  const endRun = onEndRun ? <EndRunButton onEnd={onEndRun} /> : null;
  const exit = (
    <button
      type="button"
      onClick={onExit}
      title={t`Back to packs`}
      aria-label={t`Back to packs`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[#f3e9d8]/70 transition hover:bg-white/5 hover:text-white"
    >
      <LogOut className="h-4 w-4 -scale-x-100" />
    </button>
  );
  const shardsBox = (
    <div data-chain-shards="" className="relative flex items-center gap-1.5" title={t`${shards} shards`}>
      <KitGem size={narrow ? 28 : 44} turn={shards} />
      <span className="leading-none tabular-nums text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: narrow ? 24 : 36 }}>
        <WysiDigits text={shownShards.toLocaleString("en-US")} />
      </span>
      {stamp("shards")}
    </div>
  );
  const objective = (lineWidth: number) => (
    <Objective
      narrow={narrow}
      round={round}
      score={roundScore}
      meterScore={meterScore}
      ghost={ghostScore}
      target={target}
      star={star}
      flash={crossFlash}
      banked={scoreBanked}
      reducedMotion={reducedMotion}
      stamp={stamp}
      lineWidth={lineWidth}
    />
  );
  /* Between rounds (packs, the shop) the corner says where the run is; before
     the first round and after the last it stays empty (the start screen
     carries the game's name). */
  const where = showRound ? (
    <div className="relative leading-none text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: narrow ? 20 : 30 }}>
      {chainIsEndless(round) ? <Trans>Endless round {round}</Trans> : <Trans>Round {round}</Trans>}
      {stamp("round")}
    </div>
  ) : null;

  const dailyTag = (
    <span className="shrink-0 rounded-full border-[2.5px] px-2.5 py-1 leading-none" style={{ fontFamily: MARKER, fontSize: narrow ? 14 : 17, color: KIT.gold, borderColor: KIT.gold, background: KIT.dark }}>
      <Trans>Daily</Trans>
    </span>
  );

  if (narrow) {
    return (
      <div className="relative z-[3] flex flex-col gap-1 px-3 pb-1 pt-3">
        <div className="flex items-start gap-2">
          {showMeter ? <div className="min-w-0 flex-1">{objective(Math.max(160, window.innerWidth - 24 - 120))}</div> : where}
          <span className="ml-auto" />
          {shardsBox}
          {switchMode}
          {help}
          {endRun}
          {exit}
        </div>
        <div className="flex items-center gap-3">
          {music}
          {daily && dailyTag}
          {roundChart && showMeter && <RoundChartTag chart={roundChart} compact />}
          <span className="ml-auto" />
          {scenes}
          {deck}
        </div>
      </div>
    );
  }

  return (
    <div className="relative z-[3] grid grid-cols-[1fr_auto_1fr] items-start gap-6 px-6 pb-2 pt-6">
      <div className="flex min-w-0 items-center gap-4">
        {daily && dailyTag}
        {showMeter ? roundChart ? <RoundChartTag chart={roundChart} /> : null : where}
      </div>
      <div className="flex flex-col items-center">
        <Fade show={showMeter}>{objective(560)}</Fade>
      </div>
      <div className="flex items-center justify-end gap-4">
        {shardsBox}
        {switchMode}
        {music}
        {help}
        {endRun}
        {exit}
      </div>
    </div>
  );
}

function sceneBadge(scene: ChainSceneHeld, ascension: number, startCombo: number): string | null {
  if (scene.id === "forgotten" && startCombo > 1) return `+${startCombo - 1}`;
  if (scene.id === "ascension" && ascension > 0) return `x${formatChainX(ascension)}`;
  if (scene.id === "galaxy" || scene.id === "sidetracked") {
    const x = chainSceneMultiplier({ scenes: [scene] }, scene.id);
    return x > 1 ? `x${formatChainX(x)}` : null;
  }
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
  const art = compact ? 50 : 72;
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
        <div data-run-juice="">
          <SceneMedallion size={art}>
            <SceneArt id={SCENE_ART_ID[scene.id]} size={Math.round(art * 0.48)} />
          </SceneMedallion>
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
