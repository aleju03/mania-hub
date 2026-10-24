import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CHAIN_SCENE_COPY,
  CHAIN_SCENE_NAMES,
  CHAIN_TRAIT_WORD,
  CHAIN_TRAITS,
  chainIsEndless,
  chainModLook,
  formatChainScore,
  type ChainBoardEntry,
  type ChainBoardPage,
  type ChainBoardPeriod,
  type ChainRunSheet,
} from "#/lib/chain-run";
import { CountryFlag } from "#/components/ui/CountryFlag";
import { runSound } from "../runSound";
import { SceneArt } from "../sceneArt";
import { ChainCardFace } from "./ChainCardFace";
import { SCENE_ART_ID } from "./ChainHud";
import { KIT, MARKER, SceneMedallion } from "./chainKit";
import { ModChip } from "./ModPin";

export type LoadBoard = (period: ChainBoardPeriod, user: number | null) => Promise<ChainBoardPage>;
export type LoadSheet = (userId: number, period: ChainBoardPeriod) => Promise<ChainRunSheet | null>;

/* A player's flag as an enamel pin, like the mod pins: the flag set in a
   gold rim, tipped a little, with a shine across its top. */
export function RunFlag({ cc, height = 14 }: { cc?: string; height?: number }) {
  if (!cc) return null;
  const width = Math.round(height * 1.45);
  return (
    <span
      className="relative inline-flex shrink-0 overflow-hidden align-middle"
      style={{
        width,
        height,
        borderRadius: Math.max(3, height * 0.24),
        padding: Math.max(1.5, height * 0.11),
        background: "linear-gradient(150deg, #fff3c4 0%, #f5c84b 35%, #b9832a 70%, #f5d77a 100%)",
        boxShadow: "0 2px 0 rgba(0,0,0,0.45)",
        transform: "rotate(-5deg)",
      }}
    >
      <span className="relative flex h-full w-full overflow-hidden" style={{ borderRadius: Math.max(2, height * 0.16) }}>
        <CountryFlag code={cc} size="xs" className="!h-full !w-full !rounded-none" />
        <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.4), rgba(255,255,255,0))" }} />
      </span>
    </span>
  );
}

/* The board for a period, reloaded when `key` changes; the viewer's own
   entry rides along when `user` is known. */
export function useBoard(loadBoard: LoadBoard, period: ChainBoardPeriod, user: number | null, key: unknown) {
  const [page, setPage] = useState<ChainBoardPage | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPage(null);
    loadBoard(period, user)
      .then((next) => !cancelled && setPage(next))
      .catch(() => !cancelled && setPage({ entries: [], mine: null }));
    return () => {
      cancelled = true;
    };
  }, [loadBoard, period, user, key]);
  return page;
}

/* The board's rows in the run's style: rank, flag and name, round reached and
   best row, marker numbers. `mine` is drawn lit, wherever it sits. A row
   opens its run sheet. */
export function BoardRows({
  entries,
  mine,
  compact = false,
  animate = false,
  mineName,
  onPick,
}: {
  entries: ChainBoardEntry[];
  mine: ChainBoardEntry | null;
  compact?: boolean;
  animate?: boolean;
  mineName?: ReactNode;
  onPick?: (entry: ChainBoardEntry) => void;
}) {
  const { t } = useLingui();
  const others = entries.filter((entry) => entry.userId !== mine?.userId);
  const rank = mine?.rank ?? 0;
  const limit = compact ? 5 : 6;
  const above = others.filter((entry) => rank === 0 || entry.rank < rank).slice(0, rank > limit + 1 ? limit - 1 : limit);
  const below = rank > 0 ? others.filter((entry) => entry.rank > rank).slice(0, compact ? 1 : 2) : [];
  const gap = rank > limit + 1;
  const cols = compact ? "grid-cols-[30px_1fr_26px_64px]" : "grid-cols-[36px_1fr_44px_88px] sm:grid-cols-[44px_1fr_56px_96px]";
  const row = (entry: ChainBoardEntry, index: number, own: boolean) => {
    // A "this run" stand-in (no entry yet) has nothing to open.
    const pickable = Boolean(onPick && entry.userId > 0);
    return (
      <motion.button
        type="button"
        key={own ? "mine" : entry.userId}
        disabled={!pickable}
        title={pickable ? t`See this run` : undefined}
        onClick={() => {
          if (!pickable) return;
          runSound.uiTap();
          onPick?.(entry);
        }}
        className={`grid w-full ${cols} items-center gap-2 border-b border-[#f3e9d8]/[0.08] text-left transition-colors ${pickable ? "cursor-pointer hover:bg-[#f3e9d8]/[0.06]" : "cursor-default"} ${compact ? "px-2.5 py-1.5 text-[13px]" : "px-3 py-2 text-[16px] sm:px-4"}`}
        style={own ? { background: "rgba(255,122,184,0.1)" } : undefined}
        initial={animate ? (own ? { opacity: 0, y: 50, scale: 1.08 } : { opacity: 0, x: -10 }) : false}
        animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
        transition={own ? { type: "spring", stiffness: 280, damping: 20, delay: 0.5 } : { duration: 0.2, delay: index * 0.05 }}
      >
        <span className="tabular-nums" style={{ fontFamily: MARKER, color: own ? KIT.pink : "rgba(243,233,216,0.55)" }}>
          {entry.rank > 0 ? `#${entry.rank}` : "-"}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <RunFlag cc={entry.cc} height={compact ? 11 : 14} />
          <span className="truncate font-black" style={{ color: own ? KIT.pink : "rgba(243,233,216,0.85)" }}>
            {own && mineName ? mineName : entry.username || "?"}
          </span>
        </span>
        <span className="text-center tabular-nums text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: compact ? 15 : 20 }}>
          {entry.round}
        </span>
        <span className="text-right tabular-nums" style={{ fontFamily: MARKER, color: KIT.gold, fontSize: compact ? 13 : 17 }}>
          {formatChainScore(entry.bestRow)}
        </span>
      </motion.button>
    );
  };
  return (
    <div className="flex flex-col gap-0.5">
      <div className={`grid ${cols} gap-2 ${compact ? "px-2.5" : "px-3 sm:px-4"} pb-1 text-[10px] font-black uppercase tracking-[0.14em] whitespace-nowrap text-[#f3e9d8]/45`}>
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

/* All time | This month, as two marker words with a hairline between. */
function PeriodTabs({ period, onChange, compact }: { period: ChainBoardPeriod; onChange: (period: ChainBoardPeriod) => void; compact: boolean }) {
  const tab = (id: ChainBoardPeriod, label: ReactNode) => (
    <button
      type="button"
      onClick={() => {
        if (id === period) return;
        runSound.uiTap();
        onChange(id);
      }}
      className="relative px-1 pb-1 leading-none transition-colors"
      style={{ fontFamily: MARKER, fontSize: compact ? 15 : 19, color: id === period ? KIT.cream : "rgba(243,233,216,0.4)" }}
      aria-pressed={id === period}
    >
      {label}
      {id === period && <motion.span layoutId={`board-tab-${compact ? "c" : "b"}`} className="absolute inset-x-0 -bottom-0.5 h-[3px] rounded-full" style={{ background: KIT.pink }} />}
    </button>
  );
  return (
    <div className={`flex items-center justify-center ${compact ? "gap-3 pb-2" : "gap-5 pb-3"}`}>
      {tab("all", <Trans>All time</Trans>)}
      <span className="h-4 w-px bg-[#f3e9d8]/25" />
      {tab("month", <Trans>This month</Trans>)}
    </div>
  );
}

/* The board with its period tabs and run sheets. `mine` is the viewer's
   all-time entry (or a stand-in for the run that just ended); this month's
   comes from the server. */
export function BoardPanel({
  loadBoard,
  loadSheet,
  mine,
  mineName,
  refreshKey,
  compact = false,
  animate = false,
  minHeight,
}: {
  loadBoard: LoadBoard;
  loadSheet: LoadSheet;
  mine: ChainBoardEntry | null;
  mineName?: ReactNode;
  refreshKey: unknown;
  compact?: boolean;
  animate?: boolean;
  minHeight?: number;
}) {
  const [period, setPeriod] = useState<ChainBoardPeriod>("all");
  const user = mine && mine.userId > 0 ? mine.userId : null;
  const page = useBoard(loadBoard, period, user, refreshKey);
  const [open, setOpen] = useState<ChainBoardEntry | null>(null);
  const shownMine = period === "all" ? mine : page?.mine ?? null;
  return (
    <div className="w-full">
      <PeriodTabs period={period} onChange={setPeriod} compact={compact} />
      {page ? (
        page.entries.length || shownMine ? (
          <BoardRows entries={page.entries} mine={shownMine} compact={compact} animate={animate && period === "all"} mineName={mineName} onPick={setOpen} />
        ) : (
          <div className="py-6 text-center text-[13px] font-bold text-[#f3e9d8]/45">
            <Trans>No runs this month yet.</Trans>
          </div>
        )
      ) : (
        <div style={{ height: minHeight ?? (compact ? 120 : 160) }} />
      )}
      <RunSheet entry={open} period={period} loadSheet={loadSheet} onClose={() => setOpen(null)} />
    </div>
  );
}

/* A board entry's run, over the table: how far it got, its best row, the
   scenes, practice and mods it held, and its deck. */
function RunSheet({ entry, period, loadSheet, onClose }: { entry: ChainBoardEntry | null; period: ChainBoardPeriod; loadSheet: LoadSheet; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const [sheet, setSheet] = useState<ChainRunSheet | null | "loading">("loading");
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setSheet("loading");
    setNarrow(window.innerWidth < 700);
    loadSheet(entry.userId, period)
      .then((next) => !cancelled && setSheet(next))
      .catch(() => !cancelled && setSheet(null));
    return () => {
      cancelled = true;
    };
  }, [entry, period, loadSheet]);
  useEffect(() => {
    if (!entry) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);
  if (typeof document === "undefined") return null;
  const shown = sheet && sheet !== "loading" ? sheet : null;
  const head = shown?.entry ?? entry;
  const snap = shown?.snapshot ?? null;
  const cardW = narrow ? 62 : 86;
  const section = (label: ReactNode, body: ReactNode) => (
    <div className="mt-6 w-full">
      <div className="mb-2.5 text-center text-[11px] font-black uppercase tracking-[0.22em] text-[#f3e9d8]/50">{label}</div>
      {body}
    </div>
  );
  const levels = snap ? CHAIN_TRAITS.filter((trait) => (snap.levels[trait] ?? 0) > 0) : [];
  const deck = snap ? [...snap.deck].sort((a, b) => b.base + (b.grown ?? 0) - (a.base + (a.grown ?? 0))) : [];
  return createPortal(
    <AnimatePresence>
      {entry && head && (
        <motion.div
          key="sheet"
          className="fixed inset-0 z-[90] overflow-y-auto overflow-x-hidden bg-[#0d0912]/85 backdrop-blur-[3px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="relative mx-auto flex min-h-full w-full max-w-[620px] flex-col items-center px-4 pb-10 pt-[76px] text-[#f3e9d8]"
            initial={{ y: 40 }}
            animate={{ y: 0 }}
            exit={{ y: 40 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              title={t`Close`}
              className="absolute right-3 top-[70px] flex h-10 w-10 items-center justify-center rounded-full border-2 transition hover:brightness-125"
              style={{ borderColor: KIT.cream, background: KIT.dark }}
            >
              <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" stroke={KIT.cream} strokeWidth={2.6} strokeLinecap="round">
                <path d="M3 3 L13 13 M13 3 L3 13" />
              </svg>
            </button>
            <div className="text-[12px] font-black uppercase tracking-[0.22em] text-[#f3e9d8]/50">
              {period === "all" ? <Trans>#{head.rank} all time</Trans> : <Trans>#{head.rank} this month</Trans>}
            </div>
            <div className="mt-2 flex max-w-full items-center gap-3">
              <RunFlag cc={head.cc} height={narrow ? 22 : 28} />
              <span className="truncate leading-none" style={{ fontFamily: MARKER, fontSize: narrow ? 34 : 46 }}>
                {head.username || "?"}
              </span>
            </div>
            {snap?.won && (
              <div className="mt-2 rounded-full px-3 py-0.5 text-[12px] font-black uppercase tracking-[0.16em]" style={{ background: KIT.gold, color: KIT.dark }}>
                <Trans>Run won</Trans>
              </div>
            )}
            <div className={`flex items-end justify-center ${narrow ? "mt-4 gap-7" : "mt-5 gap-12"}`}>
              {[
                [chainIsEndless(head.round) ? <Trans key="r">Endless round</Trans> : <Trans key="r">Round</Trans>, String(head.round), KIT.cream],
                [<Trans key="b">Best row</Trans>, formatChainScore(head.bestRow), KIT.gold],
                [<Trans key="w">Rows</Trans>, String(head.rows), KIT.pink],
              ].map(([label, value, ink], index) => (
                <div key={index} className="flex flex-col items-center">
                  <span className="text-[10px] font-black uppercase tracking-[0.22em] text-[#f3e9d8]/50">{label}</span>
                  <span className="leading-none tabular-nums" style={{ fontFamily: MARKER, color: ink as string, fontSize: narrow ? 30 : 42 }}>
                    {value}
                  </span>
                </div>
              ))}
            </div>

            {sheet === "loading" && <div className="mt-10 h-[200px]" />}
            {sheet !== "loading" && !snap && (
              <div className="mt-10 text-center text-[14px] font-bold text-[#f3e9d8]/55">
                <Trans>This run was played before runs kept their builds.</Trans>
              </div>
            )}

            {snap && snap.bestRow.length > 0 &&
              section(
                <Trans>Best row</Trans>,
                <div className="flex flex-wrap justify-center gap-2">
                  {snap.bestRow.map((card, index) => (
                    <div key={index} style={{ width: cardW, height: cardW * 1.4 }}>
                      <ChainCardFace card={card} width={cardW} />
                    </div>
                  ))}
                </div>,
              )}

            {snap && snap.scenes.length > 0 &&
              section(
                <Trans>Scenes</Trans>,
                <div className="flex flex-wrap justify-center gap-x-5 gap-y-4">
                  {snap.scenes.map((scene) => (
                    <div key={scene.id} className="flex w-[118px] flex-col items-center text-center">
                      <SceneMedallion size={narrow ? 58 : 72}>
                        <SceneArt id={SCENE_ART_ID[scene.id]} size={narrow ? 30 : 38} />
                      </SceneMedallion>
                      <span className="mt-1.5 text-[13px] font-black leading-tight">{CHAIN_SCENE_NAMES[scene.id]}</span>
                      <span className="mt-0.5 text-[11px] leading-snug text-[#f3e9d8]/55">{i18n._(CHAIN_SCENE_COPY[scene.id].short)}</span>
                    </div>
                  ))}
                </div>,
              )}

            {snap && (levels.length > 0 || snap.mods.length > 0) &&
              section(
                <Trans>Practice and mods</Trans>,
                <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
                  {levels.map((trait) => (
                    <span key={trait} className="text-[15px] font-black">
                      {i18n._(CHAIN_TRAIT_WORD[trait])} <span style={{ color: KIT.gold }}>+{snap.levels[trait]}</span>
                    </span>
                  ))}
                  {snap.mods.map((mod, index) => (
                    <span key={`${mod}-${index}`} className="flex items-center gap-1.5 text-[14px] font-black" title={chainModLook(mod, i18n).text}>
                      <ModChip id={mod} size={34} />
                      {chainModLook(mod, i18n).name}
                    </span>
                  ))}
                </div>,
              )}

            {snap &&
              deck.length > 0 &&
              section(
                <Trans>Deck ({deck.length})</Trans>,
                <div className="flex flex-wrap justify-center gap-2">
                  {deck.map((card, index) => (
                    <div key={index} style={{ width: cardW, height: cardW * 1.4 }}>
                      <ChainCardFace card={card} width={cardW} />
                    </div>
                  ))}
                </div>,
              )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
