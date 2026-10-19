import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Trans } from "@lingui/react/macro";
import { CHAIN_SCENE_NAMES, formatChainScore, type ChainBoardEntry, type ChainRunView } from "#/lib/chain-run";
import { PACK_ASPECT } from "../../packArt";
import { runSound } from "../runSound";
import { SceneArt } from "../sceneArt";
import { SCENE_ART_ID } from "./ChainHud";

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

function useBoard(loadBoard: () => Promise<ChainBoardEntry[]>, key: unknown) {
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

/* The run's end is the board: everyone's best runs with this run's row
   sliding into its place, bigger than the rest, and Play again under it. */
export function ChainOver({
  view,
  best,
  fresh,
  busy,
  narrow,
  reducedMotion,
  loadBoard,
  onNewRun,
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
  onShake: (amount: number) => void;
}) {
  const entries = useBoard(loadBoard, view.runNo);
  const animate = fresh && !reducedMotion;
  useEffect(() => {
    if (!fresh) return;
    runSound.runFailed();
    onShake(0.8);
    // Once per end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const round = view.over?.round ?? view.round;
  const mine: ChainBoardEntry = best ?? { rank: 0, userId: -1, username: "", round, bestRow: view.bestRow, rows: view.totalRows, finished: true, updatedAt: 0 };
  const list = entries ?? [];
  const others = list.filter((entry) => entry.userId !== mine.userId);
  const above = others.filter((entry) => mine.rank === 0 || entry.rank < mine.rank).slice(0, mine.rank > 6 ? 4 : 5);
  const below = mine.rank > 0 ? others.filter((entry) => entry.rank > mine.rank).slice(0, 2) : [];
  const gap = mine.rank > 6;
  const plain = (entry: ChainBoardEntry, index: number) => (
    <motion.div
      key={entry.userId}
      className="grid grid-cols-[44px_1fr_auto_96px] items-baseline gap-3 px-3 py-1.5 text-[15px]"
      initial={animate ? { opacity: 0, x: -10 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, delay: index * 0.05 }}
    >
      <span className="font-black tabular-nums text-osu-f1">#{entry.rank}</span>
      <span className="truncate font-bold">{entry.username || "?"}</span>
      <span className="font-black tabular-nums">{entry.round}</span>
      <span className="text-right tabular-nums text-osu-f1">{formatChainScore(entry.bestRow)}</span>
    </motion.div>
  );
  return (
    <div className="absolute inset-0 z-[40] overflow-y-auto">
      <div className={`relative mx-auto flex min-h-full w-full max-w-[520px] flex-col justify-start px-4 ${narrow ? "pb-6 pt-6" : "pb-10 pt-[9vh]"}`}>
        <div className="grid grid-cols-[44px_1fr_auto_96px] gap-3 px-3 pb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-osu-f1">
          <span />
          <span />
          <span>
            <Trans>Round</Trans>
          </span>
          <span className="text-right">
            <Trans>Best row</Trans>
          </span>
        </div>
        {above.map(plain)}
        {gap && <div className="py-0.5 text-center text-[11px] text-osu-f1">...</div>}
        {/* This run's row, sliding up into its place. */}
        <motion.div
          className="my-1 grid grid-cols-[44px_1fr_auto_96px] items-center gap-3 rounded-lg bg-osu-pink px-3 py-3 text-[#120f1a]"
          initial={animate ? { opacity: 0, y: 70, scale: 1.12 } : false}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 20, delay: animate ? 0.35 : 0 }}
        >
          <span className={`font-black tabular-nums ${narrow ? "text-[20px]" : "text-[24px]"}`}>{mine.rank > 0 ? `#${mine.rank}` : "-"}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className={`truncate font-black ${narrow ? "text-[17px]" : "text-[20px]"}`}>{mine.username || <Trans>This run</Trans>}</span>
            {view.scenes.map((scene) => (
              <span key={scene.id} className="shrink-0 overflow-hidden rounded-[5px]" title={CHAIN_SCENE_NAMES[scene.id]}>
                <SceneArt id={SCENE_ART_ID[scene.id]} size={narrow ? 20 : 24} />
              </span>
            ))}
          </span>
          <span className={`font-black italic tabular-nums ${narrow ? "text-[26px]" : "text-[34px]"}`}>{round}</span>
          <span className={`text-right font-black tabular-nums ${narrow ? "text-[15px]" : "text-[18px]"}`}>{formatChainScore(view.bestRow)}</span>
        </motion.div>
        {below.map((entry, index) => plain(entry, above.length + index))}
        <motion.button
          type="button"
          disabled={busy}
          onClick={() => {
            runSound.uiTap();
            onNewRun();
          }}
          className="mx-auto mt-6 rounded-full bg-white px-10 py-3.5 text-[20px] font-black text-[#120f1a] transition hover:brightness-110 disabled:opacity-50"
          initial={animate ? { scale: 0.7, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18, delay: animate ? 0.8 : 0 }}
        >
          <Trans>Play again</Trans>
        </motion.button>
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
