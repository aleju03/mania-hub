import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { CHAIN_RULES, CHAIN_SCENE_NAMES, chainIsEndless, formatChainScore, type ChainBoardEntry, type ChainRunView } from "#/lib/chain-run";
import { PACK_ASPECT } from "../../packArt";
import { runSound } from "../runSound";
import { SceneArt } from "../sceneArt";
import { SCENE_ART_ID } from "./ChainHud";
import { ChainButtons, KIT, MARKER, SceneMedallion } from "./chainKit";
import { shareChainRun } from "./chainShare";
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

function Board({
  entries,
  mine,
  highlight,
  animate = false,
}: {
  entries: ChainBoardEntry[] | null;
  mine: ChainBoardEntry | null;
  highlight: boolean;
  animate?: boolean;
}) {
  if (!entries) return <div className="h-[120px]" />;
  if (!entries.length && !mine) return null;
  const top = entries.slice(0, 5);
  const showMine = mine && !top.some((entry) => entry.userId === mine.userId);
  const row = (entry: ChainBoardEntry, own: boolean, index: number) => (
    <motion.div
      key={entry.userId}
      className={`grid grid-cols-[36px_1fr_auto_auto] items-baseline gap-3 rounded-md px-2 py-1.5 text-[15px] ${own && highlight ? "bg-osu-pink/15 text-osu-pink-light" : ""}`}
      initial={animate ? (own ? { opacity: 0, y: 46, scale: 1.08 } : { opacity: 0, x: -10 }) : false}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      transition={own ? { type: "spring", stiffness: 300, damping: 20, delay: 0.55 } : { duration: 0.2, delay: index * 0.05 }}
    >
      <span className="font-black tabular-nums text-osu-f1">#{entry.rank}</span>
      <span className="truncate font-bold">{entry.username || "?"}</span>
      <span className="font-black tabular-nums">
        <Trans>Round {entry.round}</Trans>
      </span>
      <span className="w-[84px] text-right tabular-nums text-osu-f1">{formatChainScore(entry.bestRow)}</span>
    </motion.div>
  );
  return (
    <div className="w-full max-w-[460px]">
      {top.map((entry, index) => row(entry, entry.userId === mine?.userId, index))}
      {showMine && mine && (
        <>
          <div className="py-0.5 text-center text-[11px] text-osu-f1">...</div>
          {row(mine, true, top.length)}
        </>
      )}
    </div>
  );
}

export function useBoard(loadBoard: () => Promise<ChainBoardEntry[]>, key: unknown) {
  const [entries, setEntries] = useState<ChainBoardEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadBoard()
      .then((list) => !cancelled && setEntries(list))
      .catch(() => !cancelled && setEntries([]));
    return () => {
      cancelled = true;
    };
  }, [loadBoard, key]);
  return entries;
}

/* The board's rows in the run's style: rank, name, round reached and best
   row, marker numbers. `mine` is drawn lit, wherever it sits. */
export function BoardRows({
  entries,
  mine,
  compact = false,
  animate = false,
  mineName,
}: {
  entries: ChainBoardEntry[];
  mine: ChainBoardEntry | null;
  compact?: boolean;
  animate?: boolean;
  mineName?: React.ReactNode;
}) {
  const others = entries.filter((entry) => entry.userId !== mine?.userId);
  const rank = mine?.rank ?? 0;
  const limit = compact ? 5 : 6;
  const above = others.filter((entry) => rank === 0 || entry.rank < rank).slice(0, rank > limit + 1 ? limit - 1 : limit);
  const below = rank > 0 ? others.filter((entry) => entry.rank > rank).slice(0, compact ? 1 : 2) : [];
  const gap = rank > limit + 1;
  const cols = compact ? "grid-cols-[30px_1fr_26px_64px]" : "grid-cols-[44px_1fr_56px_96px]";
  const row = (entry: ChainBoardEntry, index: number, own: boolean) => (
    <motion.div
      key={own ? "mine" : entry.userId}
      className={`grid ${cols} items-center gap-2 border-b border-[#f3e9d8]/[0.08] ${compact ? "px-2.5 py-1.5 text-[13px]" : "px-4 py-2 text-[16px]"}`}
      style={own ? { background: "rgba(255,122,184,0.1)" } : undefined}
      initial={animate ? (own ? { opacity: 0, y: 50, scale: 1.08 } : { opacity: 0, x: -10 }) : false}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      transition={own ? { type: "spring", stiffness: 280, damping: 20, delay: 0.5 } : { duration: 0.2, delay: index * 0.05 }}
    >
      <span className="tabular-nums" style={{ fontFamily: MARKER, color: own ? KIT.pink : "rgba(243,233,216,0.55)" }}>
        {entry.rank > 0 ? `#${entry.rank}` : "-"}
      </span>
      <span className="truncate font-black" style={{ color: own ? KIT.pink : "rgba(243,233,216,0.85)" }}>
        {own && mineName ? mineName : entry.username || "?"}
      </span>
      <span className="text-center tabular-nums text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: compact ? 15 : 20 }}>
        {entry.round}
      </span>
      <span className="text-right tabular-nums" style={{ fontFamily: MARKER, color: KIT.gold, fontSize: compact ? 13 : 17 }}>
        {formatChainScore(entry.bestRow)}
      </span>
    </motion.div>
  );
  return (
    <div className="flex flex-col gap-0.5">
      <div className={`grid ${cols} gap-2 ${compact ? "px-2.5" : "px-4"} pb-1 text-[10px] font-black uppercase tracking-[0.14em] whitespace-nowrap text-[#f3e9d8]/45`}>
        <span />
        <span />
        <span className="text-center">
          <Trans>Rd</Trans>
        </span>
        <span className="text-right">
          <Trans>Best row</Trans>
        </span>
      </div>
      {above.map((entry, index) => row(entry, index, false))}
      {gap && <div className="py-0.5 text-center text-[11px] text-[#f3e9d8]/40">...</div>}
      {mine && row(mine, above.length, true)}
      {below.map((entry, index) => row(entry, above.length + 1 + index, false))}
    </div>
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
  onNewRun,
  onRevive,
  onExit,
  onShake,
}: {
  view: ChainRunView;
  best: ChainBoardEntry | null;
  fresh: boolean;
  busy: boolean;
  narrow: boolean;
  reducedMotion: boolean;
  loadBoard: () => Promise<ChainBoardEntry[]>;
  onNewRun: () => void;
  /* Revives the failed round; false when the server refused. */
  onRevive: () => Promise<boolean>;
  onExit: () => void;
  onShake: (amount: number) => void;
}) {
  const { t } = useLingui();
  const entries = useBoard(loadBoard, view.runNo);
  const animate = fresh && !reducedMotion;
  useEffect(() => {
    if (!fresh) return;
    runSound.runFailed();
    onShake(0.8);
    // Once per end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const over = view.over;
  const round = over?.round ?? view.round;
  const [shareState, setShareState] = useState<"idle" | "busy" | "saved">("idle");
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
    <div className="absolute inset-0 z-[40] overflow-y-auto">
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
        {over?.reason === "failed" && over.round === view.round && !view.revived && <ReviveOffer round={round} narrow={narrow} onRevive={onRevive} />}
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
          {entries ? <BoardRows entries={entries} mine={mine} animate={animate} mineName={mine.username || <Trans>This run</Trans>} /> : <div className="h-[160px]" />}
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
              { key: "exit", title: t`Back to packs`, label: <Trans>Back to packs</Trans>, onClick: onExit },
              {
                key: "share",
                title: t`Share this run`,
                label: shareState === "saved" ? <Trans>Image saved</Trans> : <Trans>Share run</Trans>,
                disabled: shareState === "busy",
                icon: narrow ? <IconShareCard /> : undefined,
                onClick: async () => {
                  runSound.uiTap();
                  setShareState("busy");
                  const best = formatChainScore(view.bestRow);
                  const link = `${window.location.origin}/packs`;
                  const caption = view.won
                    ? t`Won an Overjoy run and reached round ${round}, best row ${best}. ${link}`
                    : t`Reached round ${round} in Overjoy, best row ${best}. ${link}`;
                  const outcome = await shareChainRun(
                    {
                      won: view.won,
                      round,
                      bestRow: view.bestRow,
                      rows: view.totalRows,
                      scenes: view.scenes.map((scene) => scene.id),
                      username: mine.username,
                      labels: {
                        title: view.won ? t`Run won` : t`Run over`,
                        round: chainIsEndless(round) ? t`Endless round ${round}` : t`Round ${round}`,
                        bestRow: t`Best row`,
                        rows: t`Rows`,
                        footer: link.replace(/^https?:\/\//, ""),
                      },
                    },
                    caption,
                  );
                  setShareState(outcome === "saved" ? "saved" : "idle");
                  if (outcome === "saved") window.setTimeout(() => setShareState("idle"), 2400);
                },
              },
              {
                key: "again",
                primary: true,
                title: t`Play again`,
                label: <Trans>Play again</Trans>,
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

/* Before the first run: three sealed packs and Start a run, with the board. */
export function ChainStart({
  best,
  busy,
  narrow,
  packThumb,
  reducedMotion,
  loadBoard,
  onNewRun,
}: {
  best: ChainBoardEntry | null;
  busy: boolean;
  narrow: boolean;
  packThumb: string | null;
  reducedMotion: boolean;
  loadBoard: () => Promise<ChainBoardEntry[]>;
  onNewRun: () => void;
}) {
  const entries = useBoard(loadBoard, 0);
  const height = narrow ? 150 : 230;
  const width = Math.round(height * PACK_ASPECT);
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center gap-8 px-4 py-8">
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
        <motion.button
          type="button"
          disabled={busy}
          onClick={() => {
            runSound.uiTap();
            onNewRun();
          }}
          className="rounded-full bg-osu-pink px-12 py-4 text-[22px] font-black text-[#120f1a] transition hover:brightness-110 disabled:opacity-50"
          initial={reducedMotion ? false : { scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.3 }}
        >
          <Trans>Start a run</Trans>
        </motion.button>
        <Board entries={entries} mine={best} highlight />
      </div>
    </div>
  );
}
