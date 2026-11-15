import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  BLIND_COPY,
  EDITION_COPY,
  EDITION_TINT,
  formatScore,
  HAND_TYPE_COPY,
  RUN_EDITIONS,
  RUN_STATS_COPY,
  songMod,
  WINNING_ANTE,
  type BossId,
  type HandTypeId,
  type PackRunView,
  type RunOver,
  type RunStats,
} from "#/lib/pack-run";
import { CharmKey } from "./CharmCard";
import { ModBadge } from "./ModBadge";
import { RUN_END_FEEL } from "./runEndFeel";
import { runSound } from "./runSound";
import { Shards } from "./Shards";

export interface RunEndProps {
  view: PackRunView;
  over: RunOver;
  /* The run ended on this table just now, so the moment plays; otherwise
     the screen shows settled. */
  fresh: boolean;
  busy: boolean;
  reducedMotion: boolean;
  onNewRun: () => void;
  onExit: () => void;
  onShake: (amount: number) => void;
}

/* The ended run's numbers: the live state's, or the summary kept for it. */
function summaryOf(view: PackRunView): { stats: Partial<RunStats> | null; charms: string[] } {
  const { state } = view;
  const last = state.progress?.lastRun;
  const stats = (state.stats as Partial<RunStats> | undefined) ?? (last && last.runId === state.runId ? last.stats : null) ?? null;
  const charms = state.charms.length > 0 ? state.charms.map((entry) => entry.id) : last && last.runId === state.runId ? last.charms : [];
  return { stats, charms };
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1 md:tracking-[0.14em]">{children}</div>;
}

function Stat({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className="mt-1 text-[28px] font-black leading-none tabular-nums md:text-[32px]">{children}</div>
    </div>
  );
}

/* The title, a letter at a time inside RUN_END_FEEL.end.titleMs: dropping in
   on a loss, fanning in and then swaying on a win (feel §13). */
function Title({ text, won, animate, color }: { text: string; won: boolean; animate: boolean; color: string }) {
  const feel = RUN_END_FEEL.end;
  const letters = Array.from(text);
  const stagger = Math.min(feel.letterStaggerMs, (feel.titleMs - feel.letterMs) / Math.max(1, letters.length - 1));
  return (
    <h2 aria-label={text} className="whitespace-nowrap text-[40px] font-black italic uppercase leading-none md:text-[64px]" style={{ color }}>
      {letters.map((letter, index) => {
        if (letter === " ") return <span key={index} aria-hidden="true" className="inline-block w-[0.28em]" />;
        const delay = (feel.titleLeadMs + index * stagger) / 1000;
        const side = index % 2 === 0 ? 1 : -1;
        return (
          <motion.span
            key={index}
            aria-hidden="true"
            className="inline-block"
            initial={animate ? (won ? { opacity: 0, scale: 0.3, rotate: side * feel.winFanDeg } : { opacity: 0, y: -28 }) : false}
            animate={won ? { opacity: 1, scale: 1, rotate: 0 } : { opacity: 1, y: 0 }}
            transition={
              won
                ? { type: "spring", stiffness: 640, damping: 20, delay }
                : { duration: feel.letterMs / 1000, ease: [0.3, 0, 0.2, 1], delay }
            }
          >
            {won ? (
              <motion.span
                className="inline-block"
                animate={{ rotate: [-feel.winSwayDeg, feel.winSwayDeg] }}
                transition={{
                  duration: feel.winSwayPeriodMs / 2000,
                  repeat: Infinity,
                  repeatType: "mirror",
                  ease: "easeInOut",
                  delay: (index * feel.winSwayPeriodMs * 0.08) / 1000,
                }}
              >
                {letter}
              </motion.span>
            ) : (
              letter
            )}
          </motion.span>
        );
      })}
    </h2>
  );
}

/* The end of a run, won or lost: a flat wash over the table, the title, and
   the run's numbers already on the panel as it lands, then a new run. */
export function RunEnd({ view, over, fresh, busy, reducedMotion, onNewRun, onExit, onShake }: RunEndProps) {
  const { i18n, t } = useLingui();
  const feel = RUN_END_FEEL.end;
  const animate = fresh && !reducedMotion;
  const won = over.won;
  const { stats, charms } = useMemo(() => summaryOf(view), [view]);
  const [settled, setSettled] = useState(!animate);

  useEffect(() => {
    if (!fresh) return;
    if (won) runSound.songCleared("run");
    else runSound.runFailed();
    onShake(feel.landShake);
    if (!animate) return;
    const timer = window.setTimeout(() => setSettled(true), feel.actionsAtMs + 300);
    return () => window.clearTimeout(timer);
    // Once per ended run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over.at]);

  /* What stopped the run: the song, its mod, and how far the score got. */
  const failedSong = !won && view.state.blind.ante === over.ante && view.state.blind.blind === over.blind ? view.state.blind : null;
  const failedMod: BossId | null = won ? null : (failedSong ? songMod(failedSong) : null) ?? over.failedBy ?? null;

  const bestPack: { total: number; handType: HandTypeId | null } | null =
    stats?.bestPack ?? (over.bestHand > 0 ? { total: over.bestHand, handType: null } : null);
  const finishes = stats?.finishes;
  const finishCount = finishes ? RUN_EDITIONS.reduce((sum, edition) => sum + (finishes[edition] ?? 0), 0) : null;
  const mods = stats?.modsBeaten ?? [];

  return (
    <div className="absolute inset-0 z-[60]" data-run-end={settled ? "settled" : "playing"} translate="no">
      {/* Phones: nothing of the table shows behind the screen. */}
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-osu-b6 md:hidden"
        initial={animate ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: feel.washMs / 1000, ease: "linear" }}
      />
      <motion.div
        aria-hidden="true"
        className="absolute inset-0"
        style={{ background: won ? feel.winWash : feel.lossWash }}
        initial={animate ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: feel.washMs / 1000, ease: "linear" }}
      />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-3 md:p-6">
          <motion.section
            className="w-full max-w-[640px] rounded-2xl bg-osu-b6 px-4 pb-3 pt-4 md:px-9 md:pb-8 md:pt-8"
            initial={animate ? (won ? { opacity: 0, y: 60, scale: 0.96 } : { opacity: 0, y: -feel.lossSinkPx }) : false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={
              won
                ? { type: "spring", stiffness: 380, damping: 26 }
                : { opacity: { duration: 0.15 }, y: { duration: feel.lossSinkMs / 1000, ease: [0.2, 0, 0, 1] } }
            }
          >
            <Title text={won ? t`Run cleared` : t`Run failed`} won={won} animate={animate} color={won ? "#6be0a0" : "#ff5a5a"} />

            {!won && (
              <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-t border-white/[0.07] pt-3 md:mt-6 md:pt-4">
                <div className="min-w-0">
                  <Label>
                    <Trans>Stopped at</Trans>
                  </Label>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="text-[22px] font-black italic uppercase leading-none md:text-[26px]">
                      <Trans>Stage {over.ante}</Trans>
                    </span>
                    <span className="text-[16px] font-bold md:text-[18px]">{i18n._(BLIND_COPY[over.blind])}</span>
                    {failedMod && <ModBadge boss={failedMod} />}
                  </div>
                </div>
                {failedSong && (
                  <div className="text-[28px] font-black leading-none tabular-nums md:text-[32px]">
                    {formatScore(failedSong.score)}
                    <span className="text-[16px] text-osu-f1"> / {formatScore(failedSong.target)}</span>
                  </div>
                )}
              </div>
            )}

            {bestPack && (
              <div className={won ? "mt-5 md:mt-7" : "mt-3 border-t border-white/[0.07] pt-3 md:mt-4 md:pt-4"}>
                <Label>{i18n._(RUN_STATS_COPY.bestPack)}</Label>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
                  <span className="text-[44px] font-black leading-none tabular-nums md:text-[64px]">{formatScore(bestPack.total)}</span>
                  {bestPack.handType && (
                    <span className="text-[18px] font-bold text-osu-f1 md:text-[20px]">{i18n._(HAND_TYPE_COPY[bestPack.handType].name)}</span>
                  )}
                </div>
              </div>
            )}

            <div className={`mt-3 grid gap-x-3 gap-y-3 border-t border-white/[0.07] pt-3 md:mt-4 md:gap-x-4 md:pt-4 ${won ? "grid-cols-2 md:grid-cols-4" : "grid-cols-3"}`}>
              {won && (
                <Stat label={<Trans>Stage reached</Trans>}>
                  {over.ante}
                  <span className="text-[16px] text-osu-f1"> / {WINNING_ANTE}</span>
                </Stat>
              )}
              {stats?.songsCleared !== undefined && <Stat label={i18n._(RUN_STATS_COPY.songsCleared)}>{stats.songsCleared}</Stat>}
              {stats?.packsOpened !== undefined && <Stat label={i18n._(RUN_STATS_COPY.packsOpened)}>{stats.packsOpened}</Stat>}
              {stats?.shardsEarned !== undefined && (
                <div className="min-w-0">
                  <Label>{i18n._(RUN_STATS_COPY.shardsEarned)}</Label>
                  <Shards value={stats.shardsEarned} className="mt-1 text-[26px] font-black leading-none text-[#ffd36b] md:text-[30px]" />
                </div>
              )}
            </div>

            {(stats?.modsBeaten !== undefined || finishes) && (
              <div className="mt-3 grid grid-cols-2 gap-4 border-t border-white/[0.07] pt-3 md:mt-4 md:pt-4">
                {stats?.modsBeaten !== undefined && (
                  <div className="min-w-0">
                    <Label>{i18n._(RUN_STATS_COPY.modsBeaten)}</Label>
                    <div className="mt-1.5 flex min-h-[24px] flex-wrap items-center gap-1.5">
                      {mods.length > 0 ? (
                        mods.map((mod, index) => <ModBadge key={`${mod}-${index}`} boss={mod} />)
                      ) : (
                        <span className="text-[28px] font-black leading-none tabular-nums">0</span>
                      )}
                    </div>
                  </div>
                )}
                {finishes && finishCount !== null && (
                  <div className="min-w-0">
                    <Label>{i18n._(RUN_STATS_COPY.finishes)}</Label>
                    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      {finishCount === 0 ? (
                        <span className="text-[28px] font-black leading-none tabular-nums">0</span>
                      ) : (
                        RUN_EDITIONS.filter((edition) => (finishes[edition] ?? 0) > 0).map((edition) => (
                          <span key={edition} className="inline-flex items-baseline gap-1.5">
                            <span className="text-[24px] font-black leading-none tabular-nums md:text-[28px]">{finishes[edition]}</span>
                            <span className="text-[13px] font-bold" style={{ color: EDITION_TINT[edition] }}>
                              {i18n._(EDITION_COPY[edition].name)}
                            </span>
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {charms.length > 0 && (
              <div className="mt-3 border-t border-white/[0.07] pt-3 md:mt-4 md:pt-4">
                <Label>
                  <Trans>Charms</Trans>
                </Label>
                <div className="mt-2 flex flex-wrap gap-2.5">
                  {charms.map((id, index) => (
                    <CharmKey
                      key={`${id}-${index}`}
                      id={id}
                      charm={view.state.charms[index]?.id === id ? view.state.charms[index] : undefined}
                      size={46}
                    />
                  ))}
                </div>
              </div>
            )}

            <motion.div
              className="mt-4 flex flex-col items-stretch gap-0.5 md:mt-8 md:flex-row md:items-center md:gap-2"
              initial={animate ? { opacity: 0, y: 12 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 460, damping: 28, delay: animate ? feel.actionsAtMs / 1000 : 0 }}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  runSound.uiTap();
                  onNewRun();
                }}
                className="flex-1 rounded-xl bg-osu-pink py-3.5 text-[18px] font-black text-white transition-[filter] hover:brightness-110 disabled:opacity-50 md:text-[20px]"
              >
                <Trans>New run</Trans>
              </button>
              <button
                type="button"
                onClick={() => {
                  runSound.uiTap();
                  onExit();
                }}
                className="rounded-xl px-6 py-2.5 text-[15px] font-bold text-osu-f1 transition-colors hover:bg-white/5 hover:text-white md:py-3"
              >
                <Trans>Back to packs</Trans>
              </button>
            </motion.div>
          </motion.section>
        </div>
      </div>
    </div>
  );
}
