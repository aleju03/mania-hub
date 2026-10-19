import { useEffect, useRef } from "react";
import { LogOut } from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  BLIND_COPY,
  BOSS_COPY,
  formatMult,
  formatScore,
  HAND_TYPE_COPY,
  WINNING_ANTE,
  type HandTypeId,
  type RunBlind,
  type RunOver,
} from "#/lib/pack-run";
import { ModBadge } from "./ModBadge";
import { flameLevel, RunFlame } from "./RunFlame";
import { punch } from "./runJuice";
import { runSound } from "./runSound";
import { Shards } from "./Shards";

export const NOTES_FILL = "#8fc1ff";
export const COMBO_FILL = "#ff66aa";

export interface RunHudProps {
  /* The song on screen: the one the open is scoring against while a pack
     plays out, the run's current one otherwise. */
  blind: RunBlind;
  over: RunOver | null;
  score: number;
  notes: number | null;
  combo: number | null;
  pattern: HandTypeId | null;
  shards: number;
  rerolls: number;
  /* The score has passed the target. */
  fire: boolean;
  reducedMotion?: boolean;
  shopOpen: boolean;
  onShop: () => void;
  onInfo: () => void;
  onExit: () => void;
}

/* Dev only: `?runOvershoot=10` multiplies the score the flame reads, so a
   huge overshoot can be shot from the ordinary fixtures. */
function devOvershoot(): number {
  if (!import.meta.env.DEV || typeof window === "undefined") return 1;
  const value = Number(new URLSearchParams(window.location.search).get("runOvershoot"));
  return Number.isFinite(value) && value > 1 ? value : 1;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-osu-f1">{children}</div>;
}

function digitsOf(value: number): number {
  return String(Math.round(Math.abs(value))).length;
}

/* A HUD number that punches each time it ticks to a new value (feel §3:
   bigger numbers hit harder). */
function usePunchOnChange(value: number | null, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(value);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (!enabled || value === null || before === null || value === before || value === 0) return;
    punch(ref.current, digitsOf(value));
  }, [enabled, value]);
  return ref;
}

function NotesCombo({ notes, combo, big, motion }: { notes: number | null; combo: number | null; big: boolean; motion: boolean }) {
  const size = big ? "h-[64px] text-[36px]" : "h-[40px] text-[22px]";
  const notesRef = usePunchOnChange(notes, motion);
  const comboRef = usePunchOnChange(combo, motion);
  return (
    <div className="flex items-center gap-1.5">
      <div
        ref={notesRef}
        data-run-notes=""
        className={`flex flex-1 items-center justify-end rounded-lg px-3 font-black leading-none text-osu-b6 tabular-nums ${size}`}
        style={{ background: NOTES_FILL }}
      >
        {notes === null ? 0 : formatScore(notes)}
      </div>
      <span className={`font-black text-white ${big ? "text-[22px]" : "text-[16px]"}`}>x</span>
      <div
        ref={comboRef}
        data-run-combo=""
        className={`flex flex-1 items-center justify-start rounded-lg px-3 font-black leading-none text-osu-b6 tabular-nums ${size}`}
        style={{ background: COMBO_FILL }}
      >
        {combo === null ? 0 : formatMult(combo)}
      </div>
    </div>
  );
}

/* The song's score in its box. Past the target the box catches fire: the
   flame roots behind the box and rises above it. The number punches when a
   pack lands on it (the first tick after it has been still) and again when
   it catches. */
function ScoreBox({ score, level, big, reducedMotion }: { score: number; level: number; big: boolean; reducedMotion: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef({ score, at: 0, level });
  useEffect(() => {
    const now = performance.now();
    const before = last.current;
    last.current = { score, at: score === before.score ? before.at : now, level };
    if (reducedMotion) return;
    if (level > 0 && before.level === 0) punch(ref.current, digitsOf(score) + 3);
    else if (score > before.score && now - before.at > 250) punch(ref.current, digitsOf(score) + 2);
  }, [level, reducedMotion, score]);
  return (
    <div className="relative">
      {/* 340% of the box tall, its bottom 10% up the box: the box's top edge
         sits 0.9 / 3.4 of the way up the canvas. */}
      <RunFlame
        level={level}
        reducedMotion={reducedMotion}
        boxTop={0.9 / 3.4}
        boxSpan={[0.06 / 1.12, 1.06 / 1.12]}
        className="bottom-[10%] left-[-6%] z-0 h-[340%] w-[112%]"
      />
      <div
        ref={ref}
        data-run-score=""
        className={`relative z-[1] rounded-lg bg-[#0c0a10] font-black leading-none text-white tabular-nums ${big ? "px-3 py-2 text-[52px]" : "px-2 py-1 text-[30px]"}`}
      >
        <span data-run-score-digits="">{formatScore(score)}</span>
      </div>
    </div>
  );
}

/* The run's HUD: the stage and song, the target, the song's score, the
   pattern's notes x combo, and what is left to spend. A column beside the
   table on desktop, a band above it on phones. */
export function RunHud(props: RunHudProps) {
  const { i18n, t } = useLingui();
  const { blind, over, score, notes, combo, pattern, shards, rerolls, fire, reducedMotion = false, shopOpen, onShop, onInfo, onExit } = props;
  useEffect(() => runSound.prefetch(), []);
  const boss = blind.blind === "boss" ? blind.boss : null;
  const level = fire ? flameLevel(score * devOvershoot(), blind.target) : 0;
  const buttons = (
    <>
      <button
        type="button"
        onClick={onShop}
        disabled={Boolean(over)}
        aria-pressed={shopOpen}
        className="rounded-lg bg-[#2f9e63] px-3 py-2 text-[13px] font-black text-white transition hover:brightness-110 disabled:opacity-40"
      >
        {shopOpen ? <Trans>Pack</Trans> : <Trans>Shop</Trans>}
      </button>
      <button
        type="button"
        onClick={onInfo}
        className="rounded-lg bg-osu-pink px-3 py-2 text-[13px] font-black text-white transition hover:brightness-110"
      >
        <Trans>Run info</Trans>
      </button>
    </>
  );
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

  return (
    <div translate="no" className="text-white">
      {/* Phones: one band. */}
      <div className="flex flex-col gap-2 md:hidden">
        <div className="relative z-[2] flex items-center gap-2">
          <span className="text-[20px] font-black italic uppercase leading-none">
            <Trans>Stage {blind.ante}</Trans>
          </span>
          <span className="text-[12px] text-osu-f1">{i18n._(BLIND_COPY[blind.blind])}</span>
          {boss && <ModBadge boss={boss} size="sm" />}
          <span className="ml-auto" />
          {exit}
        </div>
        <div className="flex items-end gap-3">
          <div className="min-w-0">
            <Label>
              <Trans>Target</Trans>
            </Label>
            <div className="text-[22px] font-black leading-none tabular-nums">{formatScore(blind.target)}</div>
          </div>
          <div className="relative z-[1] min-w-0">
            <div className="relative z-[2]">
              <Label>
                <Trans>Score</Trans>
              </Label>
            </div>
            <ScoreBox score={score} level={level} big={false} reducedMotion={reducedMotion} />
          </div>
          <div className="ml-auto text-right text-[12px] leading-tight text-osu-f1 tabular-nums">
            <div>
              <Plural value={blind.packsLeft} one="# pack left" other="# packs left" />
            </div>
            <Shards value={shards} className="font-bold text-white" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <NotesCombo notes={notes} combo={combo} big={false} motion={!reducedMotion} />
          </div>
          {buttons}
        </div>
      </div>

      {/* Desktop: the column. */}
      <div className="hidden h-full flex-col gap-5 md:flex">
        <div className="relative z-[2]">
          <div className="flex items-baseline gap-2">
            <span className="text-[34px] font-black italic uppercase leading-none">
              <Trans>Stage {blind.ante}</Trans>
            </span>
            <span className="text-[13px] text-osu-f1 tabular-nums">/ {WINNING_ANTE}</span>
            <span className="ml-auto" />
            {exit}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[16px] font-bold">{i18n._(BLIND_COPY[blind.blind])}</span>
            {boss && <ModBadge boss={boss} />}
          </div>
          {boss && <div className="mt-1 text-[12px] leading-snug text-osu-f1">{i18n._(BOSS_COPY[boss].text)}</div>}
        </div>

        <div className="relative z-[2] border-t border-white/[0.07] pt-4">
          <Label>
            <Trans>Target</Trans>
          </Label>
          <div className="mt-1 text-[40px] font-black leading-none tabular-nums">{formatScore(blind.target)}</div>
        </div>

        <div>
          <div className="relative z-[2]">
            <Label>
              <Trans>Score</Trans>
            </Label>
          </div>
          <div className="mt-1">
            <ScoreBox score={score} level={level} big reducedMotion={reducedMotion} />
          </div>
        </div>

        <div>
          <div className="mb-1.5 h-[18px] text-[14px] font-bold">{pattern ? i18n._(HAND_TYPE_COPY[pattern].name) : ""}</div>
          <NotesCombo notes={notes} combo={combo} big motion={!reducedMotion} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-white/[0.05] px-2.5 py-2">
            <Label>
              <Trans>Packs</Trans>
            </Label>
            <div className="mt-1 text-[24px] font-black leading-none tabular-nums">{over ? 0 : blind.packsLeft}</div>
          </div>
          <div className="rounded-lg bg-white/[0.05] px-2.5 py-2">
            <Label>
              <Trans>Shards</Trans>
            </Label>
            <Shards value={shards} className="mt-1 text-[20px] font-black leading-none" />
          </div>
          <div className="rounded-lg bg-white/[0.05] px-2.5 py-2">
            <Label>
              <Trans>Rerolls</Trans>
            </Label>
            <div className="mt-1 text-[24px] font-black leading-none tabular-nums">{rerolls}</div>
          </div>
        </div>

        <div className="mt-auto grid grid-cols-2 gap-2">{buttons}</div>
      </div>
    </div>
  );
}
