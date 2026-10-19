import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { fetchLivePackRunBoard, type LivePackRunBoardEntry } from "#/lib/live-backend";
import {
  BLIND_COPY,
  BLINDS,
  blindPacks,
  blindTarget,
  BOSS_COPY,
  EDITION_COPY,
  EDITION_TINT,
  formatScore,
  HAND_BASE,
  HAND_TYPE_COPY,
  HAND_TYPES,
  RUN_EDITIONS,
  RUNG_COPY,
  WRAPPER_COPY,
  xpForNextLevel,
  type PackRunView,
} from "#/lib/pack-run";
import { ModBadge } from "./ModBadge";

function Hairline() {
  return <span className="mx-2.5 inline-block h-3.5 w-px translate-y-[2px] bg-white/15" />;
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-white/[0.07] pt-4">
      <h3 className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.16em] text-osu-f1">{title}</h3>
      {children}
    </section>
  );
}

/* Everything about the run that is not the table: the stage's songs, the
   collector level and next wrapper, the collection ladder, master sets, how
   patterns score, the board of furthest stages, and the charm art credit.
   One drawer, opened from the HUD. */
export function RunInfo({
  open,
  onClose,
  view,
  loadBoard = fetchLivePackRunBoard,
}: {
  open: boolean;
  onClose: () => void;
  view: PackRunView;
  loadBoard?: () => Promise<LivePackRunBoardEntry[]>;
}) {
  const { t } = useLingui();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="run-info"
          className="absolute inset-0 z-[60] flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <button type="button" aria-label={t`Close`} className="absolute inset-0 bg-black/55" onClick={onClose} />
          <motion.aside
            className="relative flex h-full w-full max-w-[460px] flex-col bg-osu-b5"
            initial={{ x: 60 }}
            animate={{ x: 0 }}
            exit={{ x: 60 }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
            translate="no"
          >
            <div className="flex items-center gap-3 px-5 pb-3 pt-4">
              <span className="text-[20px] font-black italic uppercase leading-none text-white">
                <Trans>Run info</Trans>
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label={t`Close`}
                className="ml-auto grid h-8 w-8 place-items-center rounded-full text-osu-f1 hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-6">
              <RunInfoBody view={view} loadBoard={loadBoard} />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function RunInfoBody({ view, loadBoard }: { view: PackRunView; loadBoard: () => Promise<LivePackRunBoardEntry[]> }) {
  const { i18n } = useLingui();
  const [board, setBoard] = useState<LivePackRunBoardEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadBoard()
      .then((entries) => {
        if (!cancelled) setBoard(entries);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loadBoard]);

  const { state, unlocks } = view;
  const { blind, progress } = state;
  const nextRung = view.rungs.find((rung) => !rung.reached) ?? null;
  const previousRungAt = [...view.rungs].reverse().find((rung) => rung.reached)?.at ?? 0;
  const xpNeeded = xpForNextLevel(progress.level);

  return (
    <div className="flex flex-col gap-6">
      <div className="text-[12px] text-osu-f1 tabular-nums">
        <Trans>Run {state.runId}</Trans>
        <Hairline />
        <Trans>Best stage {progress.bestAnte}</Trans>
        <Hairline />
        <Plural value={progress.runsWon} one="# run cleared" other="# runs cleared" />
      </div>

      {/* The stage's three songs. */}
      <Section title={<Trans>Stage {blind.ante}</Trans>}>
        <div className="flex flex-col">
          {BLINDS.map((id) => {
            const index = BLINDS.indexOf(id);
            const current = BLINDS.indexOf(blind.blind);
            const isCurrent = index === current && !state.over;
            const isDone = index < current;
            const boss = id === "boss" ? blind.boss : null;
            const target = isCurrent ? blind.target : blindTarget(blind.ante, id, boss);
            return (
              <div key={id} className={`py-2 ${isDone ? "opacity-40" : ""}`}>
                <div className="flex items-center gap-2.5">
                  <span className={`text-[14px] font-bold ${isCurrent ? "text-white" : "text-osu-f1"}`}>{i18n._(BLIND_COPY[id])}</span>
                  {boss && <ModBadge boss={boss} size="sm" />}
                  {isDone && (
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#6be0a0]">
                      <Trans context="a dan course pass">Clear</Trans>
                    </span>
                  )}
                  <span className="ml-auto text-[18px] font-black leading-none text-white tabular-nums">{formatScore(target)}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-osu-f1">
                  {boss ? (
                    <>
                      <span className="font-bold text-white">{i18n._(BOSS_COPY[boss].name)}</span> {i18n._(BOSS_COPY[boss].text)}
                    </>
                  ) : (
                    <Plural value={blindPacks(id, boss)} one="# pack" other="# packs" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title={<Trans>Collector level</Trans>}>
        <div className="flex items-baseline gap-3">
          <span className="text-[36px] font-black leading-none text-white tabular-nums">{progress.level}</span>
          <span className="text-[12px] text-osu-f1 tabular-nums">
            {formatScore(progress.xp)} / {formatScore(xpNeeded)} XP
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-osu-b4">
          <div className="h-full rounded-full bg-osu-pink" style={{ width: `${Math.min(100, (progress.xp / xpNeeded) * 100)}%` }} />
        </div>
        <div className="mt-3 text-[13px]">
          {progress.wrapper !== "plain" ? (
            <span className="font-bold text-[#ffd36b]">
              {i18n._(WRAPPER_COPY[progress.wrapper].name)}
              <span className="ml-2 font-normal text-osu-f1">{i18n._(WRAPPER_COPY[progress.wrapper].text)}</span>
            </span>
          ) : (
            <span className="text-osu-f1">
              <Trans>Your next pack is plain.</Trans>
            </span>
          )}
        </div>
        {(progress.goldTokens > 0 || progress.prismaticTokens > 0) && (
          <div className="mt-1 text-[12px] text-osu-f1">
            <Trans>
              Queued: {progress.goldTokens} gold, {progress.prismaticTokens} rainbow
            </Trans>
          </div>
        )}
      </Section>

      <Section title={<Trans>Collection ladder</Trans>}>
        <div className="flex items-baseline gap-3">
          <span className="text-[36px] font-black leading-none text-white tabular-nums">{formatScore(view.distinct)}</span>
          <span className="text-[12px] text-osu-f1">
            <Trans>cards held</Trans>
          </span>
        </div>
        {nextRung && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-osu-b4">
            <div
              className="h-full rounded-full bg-[#6be0a0]"
              style={{
                width: `${Math.max(2, Math.min(100, ((view.distinct - previousRungAt) / Math.max(1, nextRung.at - previousRungAt)) * 100))}%`,
              }}
            />
          </div>
        )}
        <div className="mt-3 flex flex-col">
          {view.rungs.map((rung) => (
            <div
              key={rung.at}
              className={`flex items-baseline justify-between border-t border-white/[0.05] py-1.5 text-[12px] ${rung.reached ? "text-white" : "text-osu-f1"}`}
            >
              <span className={rung === nextRung ? "font-bold text-white" : ""}>{RUNG_COPY[rung.unlock] ? i18n._(RUNG_COPY[rung.unlock]) : rung.unlock}</span>
              <span className={`tabular-nums ${rung.reached ? "text-[#6be0a0]" : ""}`}>{rung.at.toLocaleString("en-US")}</span>
            </div>
          ))}
        </div>
      </Section>

      {view.masterSets && (
        <Section title={<Trans>Master sets</Trans>}>
          <div className="grid grid-cols-3 gap-4">
            {RUN_EDITIONS.map((edition) => {
              const owned = view.masterSets?.[edition] ?? 0;
              const total = view.poolTotal ?? 0;
              return (
                <div key={edition}>
                  <div className="text-[13px] font-bold" style={{ color: EDITION_TINT[edition] }}>
                    {i18n._(EDITION_COPY[edition].name)}
                  </div>
                  <div className="text-[11px] text-osu-f1">{i18n._(EDITION_COPY[edition].text)}</div>
                  <div className="mt-1 text-[20px] font-black leading-none text-white tabular-nums">
                    {formatScore(owned)}
                    {total > 0 && <span className="text-[12px] font-normal text-osu-f1"> / {formatScore(total)}</span>}
                  </div>
                  {edition === "polychrome" && !unlocks.polychrome && (
                    <div className="mt-1 text-[11px] text-osu-f1">
                      <Trans>Unlocks at 1,000 cards</Trans>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title={<Trans>Patterns</Trans>}>
        <div className="flex flex-col">
          {[...HAND_TYPES].reverse().map((id) => (
            <div key={id} className="flex items-baseline gap-3 border-t border-white/[0.05] py-1.5 text-[12px] first:border-t-0">
              <span className="w-[96px] shrink-0 font-bold text-white">{i18n._(HAND_TYPE_COPY[id].name)}</span>
              <span className="min-w-0 flex-1 text-osu-f1">{i18n._(HAND_TYPE_COPY[id].text)}</span>
              <span className="shrink-0 font-bold tabular-nums">
                <span className="text-[#8fc1ff]">{HAND_BASE[id].chips}</span>
                <span className="text-osu-f1"> x </span>
                <span className="text-[#ff66aa]">{HAND_BASE[id].mult}</span>
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title={<Trans>Furthest stages</Trans>}>
        <div className="flex flex-col">
          {(board ?? []).map((entry, index) => (
            <div key={entry.userId} className="flex items-baseline gap-3 border-t border-white/[0.05] py-1.5 text-[13px] first:border-t-0">
              <span className="w-5 text-right text-[11px] text-osu-f1 tabular-nums">{index + 1}</span>
              <Link to="/packs/collections" search={{ collector: entry.username }} className="min-w-0 flex-1 truncate font-bold text-white hover:underline">
                {entry.username}
              </Link>
              <span className="font-black text-white tabular-nums">{entry.bestAnte}</span>
              <span className="w-[86px] text-right text-[11px] text-osu-f1 tabular-nums">{formatScore(entry.bestHand)}</span>
            </div>
          ))}
          {board && board.length === 0 && (
            <div className="py-3 text-[12px] text-osu-f1">
              <Trans>Nobody has cleared a stage yet.</Trans>
            </div>
          )}
        </div>
      </Section>

      {/* CC BY 3.0 attribution for the charm silhouettes (gameIconBodies.ts). */}
      <div className="border-t border-white/[0.07] pt-4 text-[11px] text-osu-f1">
        <Trans>
          Charm icons by Lorc, Delapouite, Skoll, Sbed, Faithtoken and Carl Olsen at{" "}
          <a href="https://game-icons.net" target="_blank" rel="noreferrer" className="underline hover:text-white">
            game-icons.net
          </a>
          , CC BY 3.0
        </Trans>
      </div>
    </div>
  );
}
