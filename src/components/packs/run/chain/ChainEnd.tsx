import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { CHAIN_RULES, CHAIN_RUN_NAME, CHAIN_SCENE_NAMES, formatChainScore, type ChainBoardEntry, type ChainRunView } from "#/lib/chain-run";
import { PACK_ASPECT } from "../../packArt";
import { runSound } from "../runSound";
import { SceneArt } from "../sceneArt";
import { SCENE_ART_ID } from "./ChainHud";
import { ChainButtons, KIT, MARKER, SceneMedallion } from "./chainKit";
import { shareChainRunLink } from "./chainShare";
import { BoardPanel, type LoadBoard, type LoadSheet } from "./ChainBoardPanel";
import { chainHowToSeen } from "./ChainHowTo";
import { prepareRewardedAd, type RewardedAd } from "#/lib/rewarded-ad";

/* A card lifting out of the table with an arrow: the share button's mark. */
function IconShareCard() {
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" aria-hidden="true" fill="none" stroke={KIT.cream} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <rect x={4} y={9} width={11} height={14} rx={2} transform="rotate(-8 9.5 16)" />
      <path d="M14 12 C17 9 19 7 22 5 M17 4.5 H22.5 V10" />
    </svg>
  );
}

/* A sealed pack with an arrow turning back to it: the exit's mark on phones,
   where the side buttons are icons. */
function IconBackToPacks() {
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" aria-hidden="true" fill="none" stroke={KIT.cream} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <rect x={11} y={3} width={11} height={20} rx={2} />
      <path d="M11 8 H22" strokeWidth={1.6} />
      <path d="M8 13 H2.5 M5.5 9.8 L2.3 13 L5.5 16.2" />
    </svg>
  );
}

/* A screen with a play mark and a heart-beat line: the revive button's mark. */
function IconWatchRevive() {
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" aria-hidden="true" fill="none" stroke={KIT.gold} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <rect x={3} y={5} width={20} height={14} rx={2.5} />
      <path d="M11 9.2 L16 12 L11 14.8 Z" fill={KIT.gold} strokeWidth={1.6} />
      <path d="M8 23 H18" />
    </svg>
  );
}

/* The run's one revive: asks for an ad when the end comes in, and offers it
   only when one is ready. */
function ReviveOffer({ round, narrow, onRevive }: { round: number; narrow: boolean; onRevive: () => Promise<boolean> }) {
  const { t } = useLingui();
  const [ad, setAd] = useState<RewardedAd | null>(null);
  const [state, setState] = useState<"idle" | "watching" | "reviving">("idle");
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    void prepareRewardedAd("revive").then((ready) => {
      if (live) setAd(ready);
    });
    return () => {
      live = false;
    };
  }, [asked]);
  if (!ad) return null;
  return (
    <motion.div
      className={`flex flex-col items-center ${narrow ? "mt-3" : "mt-4"}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 22 }}
    >
      {/* Not compact on phones: a compact side button hides its label. */}
      <ChainButtons
        items={[
          {
            key: "revive",
            title: t`Watch an ad to revive`,
            label: <Trans>Watch an ad to revive</Trans>,
            icon: <IconWatchRevive />,
            tone: KIT.gold,
            disabled: state !== "idle",
            onClick: async () => {
              runSound.uiTap();
              setState("watching");
              const viewed = await ad.show();
              if (!viewed) {
                // That ad is spent; ask for another.
                setAd(null);
                setState("idle");
                setAsked((count) => count + 1);
                return;
              }
              setState("reviving");
              if (!(await onRevive())) setState("idle");
            },
          },
        ]}
      />
      <span className="mt-2 text-center text-[12px] font-bold text-[#f3e9d8]/55">
        <Trans>
          Round {round} goes on with {CHAIN_RULES.reviveRows} more rows. Once per run.
        </Trans>
      </span>
    </motion.div>
  );
}

/* The run's end: what ended it, the run in three numbers and its scenes in
   their medallions, then the board with this run sliding into its place,
   and the way back in. */
export function ChainOver({
  view,
  best,
  fresh,
  busy,
  narrow,
  reducedMotion,
  loadBoard,
  loadSheet,
  onNewRun,
  onRevive,
  onExit,
  onShake,
  daily = false,
}: {
  view: ChainRunView;
  best: ChainBoardEntry | null;
  fresh: boolean;
  busy: boolean;
  narrow: boolean;
  reducedMotion: boolean;
  loadBoard: LoadBoard;
  loadSheet: LoadSheet;
  onNewRun: () => void;
  /* Revives the failed round; false when the server refused. */
  onRevive: () => Promise<boolean>;
  onExit: () => void;
  onShake: (amount: number) => void;
  /* The daily run ended: one try a day, so the button goes back to the
     player's own runs, and the board opens on today's. */
  daily?: boolean;
}) {
  const { t } = useLingui();
  const animate = fresh && !reducedMotion;
  useEffect(() => {
    if (!fresh) return;
    // A won run ended on purpose isn't a loss.
    if (!view.won) runSound.runFailed();
    onShake(0.8);
    // Once per end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const over = view.over;
  const round = over?.round ?? view.round;
  const [shareState, setShareState] = useState<"idle" | "busy" | "copied">("idle");
  const mine: ChainBoardEntry = best ?? { rank: 0, userId: -1, username: "", round, bestRow: view.bestRow, rows: view.totalRows, finished: true, updatedAt: 0 };
  const stat = (label: React.ReactNode, value: string, ink: string, delay: number) => (
    <motion.div
      className="flex flex-col items-center"
      initial={animate ? { opacity: 0, y: 14 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 22, delay }}
    >
      <span className="text-[10px] font-black uppercase tracking-[0.22em] text-[#f3e9d8]/50">{label}</span>
      <span className="leading-none tabular-nums" style={{ fontFamily: MARKER, color: ink, fontSize: narrow ? 30 : 44 }}>
        {value}
      </span>
    </motion.div>
  );
  return (
    <div className="absolute inset-0 z-[40] overflow-y-auto overflow-x-hidden">
      <div className={`relative mx-auto flex min-h-full w-full max-w-[560px] flex-col items-center px-4 ${narrow ? "pb-6 pt-4" : "pb-8 pt-[3vh]"}`}>
        <motion.div
          className="leading-none text-[#f3e9d8]"
          style={{ fontFamily: MARKER, fontSize: narrow ? 46 : 72 }}
          initial={animate ? { opacity: 0, scale: 1.4, rotate: -6 } : false}
          animate={{ opacity: 1, scale: 1, rotate: -2 }}
          transition={{ type: "spring", stiffness: 300, damping: 16 }}
        >
          {view.won ? <Trans>Run won</Trans> : <Trans>Run over</Trans>}
        </motion.div>
        {over && over.reason === "failed" && (
          <motion.div
            className="mt-2 text-center text-[14px] font-bold text-[#f3e9d8]/70"
            initial={animate ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
          >
            <Trans>
              Round {round} fell short: <span style={{ fontFamily: MARKER, color: KIT.cream }}>{formatChainScore(over.roundScore)}</span> of{" "}
              <span style={{ fontFamily: MARKER, color: KIT.gold }}>{formatChainScore(over.target)}</span>
            </Trans>
          </motion.div>
        )}
        {!daily && over?.reason === "failed" && over.round === view.round && !view.revived && <ReviveOffer round={round} narrow={narrow} onRevive={onRevive} />}
        <div className={`flex items-end justify-center ${narrow ? "mt-4 gap-7" : "mt-5 gap-12"}`}>
          {stat(<Trans>Round</Trans>, String(round), KIT.cream, 0.15)}
          {stat(<Trans>Best row</Trans>, formatChainScore(view.bestRow), KIT.gold, 0.22)}
          {stat(<Trans>Rows</Trans>, String(view.totalRows), KIT.pink, 0.29)}
        </div>
        {view.scenes.length > 0 && (
          <div className={`flex justify-center ${narrow ? "mt-3 gap-2" : "mt-4 gap-4"}`}>
            {view.scenes.map((scene, index) => (
              <motion.div
                key={scene.id}
                title={CHAIN_SCENE_NAMES[scene.id]}
                initial={animate ? { opacity: 0, y: -24, rotate: -12 } : false}
                animate={{ opacity: 1, y: 0, rotate: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 12, delay: 0.35 + index * 0.08 }}
              >
                <SceneMedallion size={narrow ? 62 : 84}>
                  <SceneArt id={SCENE_ART_ID[scene.id]} size={narrow ? 32 : 44} />
                </SceneMedallion>
              </motion.div>
            ))}
          </div>
        )}
        <div className={`w-full ${narrow ? "mt-4" : "mt-5"}`}>
          <BoardPanel loadBoard={loadBoard} loadSheet={loadSheet} mine={mine} mineName={mine.username || <Trans>This run</Trans>} refreshKey={view.runNo} animate={animate} initialPeriod={daily ? "day" : "all"} />
        </div>
        <motion.div
          className="mt-6"
          initial={animate ? { scale: 0.8, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18, delay: animate ? 0.8 : 0 }}
        >
          <ChainButtons
            big={!narrow}
            compact={narrow}
            items={[
              { key: "exit", title: t`Back to packs`, label: <Trans>Back to packs</Trans>, icon: narrow ? <IconBackToPacks /> : undefined, onClick: onExit },
              {
                key: "share",
                title: t`Share this run`,
                label: shareState === "copied" ? <Trans>Link copied</Trans> : <Trans>Share run</Trans>,
                disabled: shareState === "busy",
                icon: narrow ? <IconShareCard /> : undefined,
                onClick: async () => {
                  runSound.uiTap();
                  setShareState("busy");
                  const best = formatChainScore(view.bestRow);
                  const outcome = await shareChainRunLink(daily ? "daily" : "normal", () =>
                    view.won ? t`Won an Overjoy run and reached round ${round}, best row ${best}.` : t`Reached round ${round} in Overjoy, best row ${best}.`,
                  );
                  setShareState(outcome === "copied" ? "copied" : "idle");
                  if (outcome === "copied") window.setTimeout(() => setShareState("idle"), 2400);
                },
              },
              {
                key: "again",
                primary: true,
                title: daily ? t`Back to your runs` : t`Play again`,
                label: daily ? <Trans>Back to your runs</Trans> : <Trans>Play again</Trans>,
                disabled: busy,
                onClick: () => {
                  runSound.uiTap();
                  onNewRun();
                },
              },
            ]}
          />
        </motion.div>
      </div>
    </div>
  );
}

/* A day on a tear-off calendar, for the daily run. */
function IconDaily() {
  return (
    <svg width={26} height={26} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0 overflow-visible">
      <g strokeLinejoin="round" strokeLinecap="round">
        <rect x={5} y={7} width={22} height={21} rx={3} fill={KIT.dark} stroke={KIT.gold} strokeWidth={2.4} />
        <path d="M5 13 H27" stroke={KIT.gold} strokeWidth={2.4} />
        <path d="M11 4 V9 M21 4 V9" stroke={KIT.gold} strokeWidth={2.4} />
        <path d="M13 18 L16 16 V25" fill="none" stroke={KIT.cream} strokeWidth={2.4} />
      </g>
    </svg>
  );
}

/* Before the first run: three sealed packs and Start a run, with the board
   (or the daily run's start). */
export function ChainStart({
  best,
  busy,
  narrow,
  packThumb,
  reducedMotion,
  loadBoard,
  loadSheet,
  onNewRun,
  guest = false,
  daily = false,
  onDaily,
  onBack,
  onHowTo,
}: {
  best: ChainBoardEntry | null;
  busy: boolean;
  narrow: boolean;
  packThumb: string | null;
  reducedMotion: boolean;
  loadBoard: LoadBoard;
  loadSheet: LoadSheet;
  onNewRun: () => void;
  /* Signed out: the run is played and kept in this browser only. */
  guest?: boolean;
  /* The daily run's start (everyone on the same cards today, one try), and
     the way to it from the player's own start, and back. */
  daily?: boolean;
  onDaily?: () => void;
  onBack?: () => void;
  /* Opens how to play (and does so by itself the first time). */
  onHowTo?: () => void;
}) {
  const { t, i18n } = useLingui();
  // A first visit opens how to play by itself.
  useEffect(() => {
    if (onHowTo && !chainHowToSeen()) onHowTo();
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const height = narrow ? 150 : 230;
  const width = Math.round(height * PACK_ASPECT);
  return (
    <div className="absolute inset-0 overflow-y-auto overflow-x-hidden">
      <div className="flex min-h-full flex-col items-center justify-center gap-8 px-4 py-8">
        <motion.h2
          className="-rotate-2 text-center leading-none text-[#f3e9d8]"
          style={{ fontFamily: MARKER, fontSize: narrow ? 44 : 72 }}
          initial={reducedMotion ? false : { y: -24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 22 }}
        >
          {i18n._(CHAIN_RUN_NAME)}
        </motion.h2>
        {daily && (
          <div className="-mt-4 flex flex-col items-center gap-1 text-center">
            <div className="leading-none" style={{ fontFamily: MARKER, fontSize: narrow ? 22 : 30, color: KIT.gold }}>
              <Trans>Daily run</Trans> {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
            </div>
            <div className="max-w-[380px] text-[13px] font-bold leading-snug text-[#f3e9d8]/75">
              <Trans>Everyone gets the same cards and one attempt today.</Trans>
            </div>
          </div>
        )}
        <div className="relative" style={{ width: width * 2.1, height: height + 20 }}>
          {[-1, 0, 1].map((offset, index) => (
            <motion.div
              key={offset}
              className="absolute top-0 overflow-hidden rounded-[6px] bg-osu-b3"
              style={{ width, height, left: width * 0.55 + offset * width * 0.55 }}
              initial={reducedMotion ? false : { y: 80, opacity: 0, rotate: 0 }}
              animate={{ y: offset === 0 ? 0 : 14, opacity: 1, rotate: offset * 9 }}
              transition={{ type: "spring", stiffness: 380, damping: 22, delay: index * 0.08 }}
            >
              {packThumb && <img src={packThumb} alt="" draggable={false} className="h-full w-full object-cover" />}
            </motion.div>
          ))}
        </div>
        <motion.div
          initial={reducedMotion ? false : { scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.3 }}
        >
          <ChainButtons
            big={!narrow}
            items={[
              ...(daily && onBack ? [{ key: "back", label: <Trans>Back</Trans>, title: t`Back`, onClick: onBack }] : []),
              {
                key: "start",
                label: daily ? <Trans>Start today's run</Trans> : <Trans>Start a run</Trans>,
                title: daily ? t`Start today's run` : t`Start a run`,
                primary: true,
                disabled: busy,
                onClick: () => {
                  runSound.uiTap();
                  onNewRun();
                },
              },
              ...(!daily && onDaily
                ? [{ key: "daily", label: <Trans>Daily run</Trans>, title: t`Daily run`, icon: <IconDaily />, tone: KIT.gold, onClick: onDaily }]
                : []),
            ]}
          />
          {onHowTo && (
            <button
              type="button"
              onClick={() => {
                runSound.uiTap();
                onHowTo();
              }}
              className="mx-auto mt-3 block text-[14px] font-bold text-[#f3e9d8]/70 underline decoration-[#f3e9d8]/30 underline-offset-4 transition hover:text-white"
            >
              <Trans>How to play</Trans>
            </button>
          )}
          {guest && (
            <p className="mt-3 max-w-[300px] text-center text-[13px] leading-snug text-[#f3e9d8]/60">
              <Trans>Playing as a guest: runs stay in this browser and off the board. Sign in with osu! to save them.</Trans>
            </p>
          )}
        </motion.div>
        <div className="w-full max-w-[460px]">
          <BoardPanel key={daily ? "day" : "all"} loadBoard={loadBoard} loadSheet={loadSheet} mine={daily ? null : best} refreshKey={daily ? 1 : 0} initialPeriod={daily ? "day" : "all"} />
        </div>
      </div>
    </div>
  );
}
