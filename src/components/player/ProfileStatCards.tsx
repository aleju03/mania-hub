import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { formatNumber } from "#/lib/format";
import { useBodyScrollLock } from "#/lib/use-body-scroll-lock";
import { compactCount, DEFAULT_PROFILE_STATS, formatTopPercent, hourLabel, peakHour, PROFILE_STAT_LABELS, PROFILE_STATS, sessionLength, type ProfileStatId, type ProfileStatsData } from "#/lib/profile-stats";
import { fetchLivePlayerSkillsDirect } from "#/lib/live-backend";
import { qualifyingSkillModes, skillModeEntries, withMainKeymodeFirst } from "#/lib/skill-axes";
import { SelectMenu } from "#/components/ui/SelectMenu";
import { INSIGHT_CELL_CLASS, INSIGHT_LABEL_CLASS } from "./ProfileParts";

/* The insight cards a supporter can swap in for the usual four
   (lib/profile-stats.ts), and the owner's picker that swaps them. Same cell, label
   and number sizes as the usual four, so a swapped panel reads as one. */

function StatCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={INSIGHT_CELL_CLASS}>
      <div className={INSIGHT_LABEL_CLASS}>{label}</div>
      {children}
    </div>
  );
}

function Empty() {
  return <div className="mt-2 text-sm text-osu-f1">-</div>;
}

export function formatRatio(value: number): string {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(value >= 10 ? 1 : 2);
}

export function RatioCard({ ratio }: { ratio: ProfileStatsData["ratio"] }) {
  const { t } = useLingui();
  return (
    <StatCell label={t`Ratio`}>
      {ratio ? (
        <>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-[26px] font-black leading-none tabular-nums text-white">
              {ratio.great === 0 ? t`All MAX` : formatRatio(ratio.perfect / ratio.great)}
            </span>
            {ratio.great > 0 && <span className="text-[13px] font-bold text-osu-f1">: 1</span>}
          </div>
          <div className="mt-auto pt-2.5 text-[11px] text-osu-f1">{t`MAX to 300 over every tracked play`}</div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

export function LnSplitCard({ lnSplit }: { lnSplit: ProfileStatsData["lnSplit"] }) {
  const { t } = useLingui();
  const total = lnSplit ? lnSplit.ln + lnSplit.rice : 0;
  const lnShare = total > 0 ? Math.round((lnSplit!.ln / total) * 100) : 0;
  const riceLeads = lnShare < 50;
  return (
    <StatCell label={t`Rice / LN`}>
      {lnSplit && total > 0 ? (
        <>
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="flex items-baseline gap-1">
              <span className={`font-black leading-none tabular-nums text-osu-blue ${riceLeads ? "text-[26px]" : "text-[17px]"}`}>
                {100 - lnShare}<span className="text-[13px]">%</span>
              </span>
              <span className="text-[11px] font-bold text-osu-blue">{t`rice`}</span>
            </span>
            <span className="flex items-baseline gap-1">
              <span className={`font-black leading-none tabular-nums text-osu-orange ${riceLeads ? "text-[17px]" : "text-[26px]"}`}>
                {lnShare}<span className="text-[13px]">%</span>
              </span>
              <span className="text-[11px] font-bold text-osu-orange">{t`LN`}</span>
            </span>
          </div>
          <div className="mt-auto w-full pt-3">
            <div className="flex h-1 overflow-hidden rounded-full bg-osu-b3/50">
              <div className="bg-osu-blue" style={{ width: `${100 - lnShare}%` }} />
              <div className="bg-osu-orange" style={{ width: `${lnShare}%` }} />
            </div>
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

export function StreakCard({ streak }: { streak: ProfileStatsData["streak"] }) {
  const { t } = useLingui();
  return (
    <StatCell label={t`Longest streak`}>
      {streak && streak.longest > 0 ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[26px] font-black leading-none tabular-nums text-white">{formatNumber(streak.longest)}</span>
            <span className="text-[11px] font-semibold text-osu-f1">{streak.longest === 1 ? t`day` : t`days`}</span>
          </div>
          <div className="mt-auto pt-2.5 text-[11px] tabular-nums text-osu-f1">
            {streak.current > 0 ? <Trans>{formatNumber(streak.current)} going now</Trans> : t`In a row, with a play each day`}
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

export function PercentileCard({ percentile }: { percentile: ProfileStatsData["percentile"] }) {
  const { t } = useLingui();
  const top = percentile ? formatTopPercent(percentile.rank, percentile.players) : null;
  return (
    <StatCell label={t`Percentile`}>
      {percentile && top ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold text-osu-f1">{t`top`}</span>
            <span className="text-[26px] font-black leading-none tabular-nums text-osu-pink-light">{top}<span className="text-[15px]">%</span></span>
          </div>
          <div className="mt-auto pt-2.5 text-[11px] tabular-nums text-osu-f1">
            <Trans>#{formatNumber(percentile.rank)} of {formatNumber(percentile.players)} tracked players</Trans>
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

export function SessionCard({ session }: { session: ProfileStatsData["session"] }) {
  const { t } = useLingui();
  const length = session ? sessionLength(session.minutes) : null;
  return (
    <StatCell label={t`Longest session`}>
      {session && length ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[26px] font-black leading-none tabular-nums text-white">{length.value}</span>
            <span className="text-[11px] font-semibold text-osu-f1">{length.hours ? (length.value === "1" ? t`hour` : t`hours`) : t`min`}</span>
          </div>
          <div className="mt-auto pt-2.5 text-[11px] tabular-nums text-osu-f1">
            {session.plays === 1 ? t`1 play in one sitting` : <Trans>{formatNumber(session.plays)} plays in one sitting</Trans>}
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

export function NotesCard({ notes }: { notes: ProfileStatsData["notes"] }) {
  const { t } = useLingui();
  return (
    <StatCell label={t`Notes hit`}>
      {notes ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[26px] font-black leading-none tabular-nums text-white">{compactCount(notes.hit)}</span>
            <span className="text-[11px] font-semibold text-osu-f1">{t`notes`}</span>
          </div>
          <div className="mt-auto pt-2.5 text-[11px] tabular-nums text-osu-f1">
            <Trans>Over {formatNumber(notes.plays)} tracked plays</Trans>
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

/* What kind of player the busiest hour makes them. */
function hourKind(hour: number): MessageDescriptor {
  if (hour < 5) return msg`Night owl`;
  if (hour < 9) return msg`Early bird`;
  if (hour < 12) return msg`Morning player`;
  if (hour < 18) return msg`Afternoon player`;
  if (hour < 22) return msg`Evening player`;
  return msg`Night owl`;
}

export function HoursCard({ hours }: { hours: ProfileStatsData["hours"] }) {
  const { t, i18n } = useLingui();
  const peak = hours ? peakHour(hours) : null;
  const max = hours ? Math.max(...hours) : 0;
  return (
    <StatCell label={t`Peak hour`}>
      {hours && peak != null && max > 0 ? (
        <>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[26px] font-black leading-none tabular-nums text-white">{hourLabel(peak)}</span>
            <span className="text-[11px] font-semibold text-osu-pink-light">{i18n._(hourKind(peak))}</span>
          </div>
          {/* the day from midnight to midnight, one bar an hour */}
          <div className="mt-auto flex h-9 w-full items-end gap-px pt-2.5" aria-hidden>
            {hours.map((count, hour) => (
              <span
                key={hour}
                className={`flex-1 rounded-[1px] ${hour === peak ? "bg-osu-pink-light" : "bg-osu-f1/45"}`}
                style={{ height: `${Math.max(8, (count / max) * 100)}%` }}
              />
            ))}
          </div>
        </>
      ) : <Empty />}
    </StatCell>
  );
}

/* Their best skill, from the same public read as their Skills tab, so
   hiding their ratings hides this too: in the keymode they chose for the
   card, or else the one their Skills tab opens on. */
export interface StrongestSkill {
  label: string;
  color: string;
  value: number;
  keyCount: number;
  runnerUp: { label: string; value: number } | null;
}

type RatedModes = ReturnType<typeof qualifyingSkillModes>;

/* One read of a player's skills shared by every card and picker that wants
   it, kept for a minute: the card on the profile, the same card again in the
   stat picker, and the picker's keymode menu. */
const ratedModesCache = new Map<number, { at: number; value?: RatedModes | null; promise: Promise<RatedModes | null> }>();
const RATED_MODES_TTL_MS = 60_000;

function loadRatedModes(userId: number) {
  const cached = ratedModesCache.get(userId);
  if (cached && Date.now() - cached.at < RATED_MODES_TTL_MS) return cached;
  const entry: { at: number; value?: RatedModes | null; promise: Promise<RatedModes | null> } = {
    at: Date.now(),
    promise: fetchLivePlayerSkillsDirect(userId)
      .then((skills) => withMainKeymodeFirst(qualifyingSkillModes(skills), skills?.mainKeyCount ?? null))
      .catch(() => null)
      .then((modes) => {
        entry.value = modes;
        return modes;
      }),
  };
  ratedModesCache.set(userId, entry);
  return entry;
}

/* The keymodes they are rated in, main keymode first; undefined while loading. */
export function useRatedSkillModes(userId: number | null | undefined): RatedModes | null | undefined {
  const [state, setState] = useState<{ userId: number; modes: RatedModes | null } | null>(() => {
    const ready = userId ? ratedModesCache.get(userId) : undefined;
    return userId && ready && ready.value !== undefined ? { userId, modes: ready.value } : null;
  });
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const entry = loadRatedModes(userId);
    if (entry.value !== undefined) setState({ userId, modes: entry.value });
    else void entry.promise.then((modes) => {
      if (alive) setState({ userId, modes });
    });
    return () => {
      alive = false;
    };
  }, [userId]);
  return state && state.userId === userId ? state.modes : undefined;
}

export function useStrongestSkill(userId: number | null | undefined, keyCount: number | null = null): StrongestSkill | null | undefined {
  const { i18n } = useLingui();
  const modes = useRatedSkillModes(userId);
  if (modes === undefined) return undefined;
  const mode = modes?.find((entry) => entry.keyCount === keyCount) ?? modes?.[0];
  const [top, next] = mode ? skillModeEntries(mode) : [];
  if (!mode || !top) return null;
  return { label: i18n._(top.labelMsg), color: top.color, value: top.value, keyCount: mode.keyCount, runnerUp: next ? { label: i18n._(next.labelMsg), value: next.value } : null };
}

/* `sample` draws made-up numbers instead (the /support page's example);
   `keyCount` is the keymode the owner picked for it. */
export function SkillCard({ userId, keyCount = null, sample }: { userId: number | null | undefined; keyCount?: number | null; sample?: StrongestSkill }) {
  const { t } = useLingui();
  const fetched = useStrongestSkill(sample ? null : userId, keyCount);
  const skill = sample ?? fetched;
  return (
    <StatCell label={t`Strongest skill`}>
      {skill ? (
        <>
          <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-[22px] font-black leading-none" style={{ color: skill.color }}>{skill.label}</span>
            <span className="shrink-0 text-[15px] font-black tabular-nums text-white">{skill.value.toFixed(1)}</span>
          </div>
          <div className="mt-auto truncate pt-2.5 text-[11px] tabular-nums text-osu-f1">
            {skill.runnerUp
              ? <Trans>In {skill.keyCount}K, ahead of {skill.runnerUp.label} {skill.runnerUp.value.toFixed(1)}</Trans>
              : <Trans>In {skill.keyCount}K</Trans>}
          </div>
        </>
      ) : skill === undefined ? (
        <>
          <div className="mt-2 h-[22px] w-32 animate-pulse rounded bg-osu-b3/60" />
          <div className="mt-auto h-3 w-40 animate-pulse rounded bg-osu-b3/40" />
        </>
      ) : <Empty />}
    </StatCell>
  );
}

/* The owner's pick of keymode for the strongest-skill card, shown in the
   stat picker while that card is in a slot. */
export function SkillKeymodeChoice({ userId, value, onChange }: { userId: number; value: number | null; onChange: (keys: number | null) => void }) {
  const { t } = useLingui();
  const modes = useRatedSkillModes(userId);
  const keys = (modes ?? []).map((mode) => mode.keyCount).sort((a, b) => a - b);
  if (keys.length < 2 && value == null) return null;
  const shown = value != null && !keys.includes(value) ? [...keys, value].sort((a, b) => a - b) : keys;
  return (
    <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-osu-b4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-white">{t`Strongest skill keymode`}</div>
        <div className="text-[11px] text-osu-f1">{t`Main keymode follows the one your Skills tab opens on.`}</div>
      </div>
      <SelectMenu
        value={value == null ? "main" : String(value)}
        align="right"
        className="shrink-0 whitespace-nowrap"
        ariaLabel={t`Strongest skill keymode`}
        options={[{ value: "main", label: t`Main keymode` }, ...shown.map((keyCount) => ({ value: String(keyCount), label: `${keyCount}K` }))]}
        onChange={(next) => onChange(next === "main" ? null : Number(next))}
      />
    </div>
  );
}

/* A stat with nothing to draw it from here (the /supporter page has no
   profile insights): its name and what it would show. */
export function StatPreviewCell({ stat, preview }: { stat: ProfileStatId; preview: string | null | undefined }) {
  const { i18n } = useLingui();
  return (
    <StatCell label={i18n._(PROFILE_STAT_LABELS[stat])}>
      {preview ? <div className="mt-2 text-[20px] font-black leading-tight tabular-nums text-white">{preview}</div> : <Empty />}
    </StatCell>
  );
}

/* What the extra stats would show, as one line each. */
export function useExtraStatPreviews(data: ProfileStatsData): Partial<Record<ProfileStatId, string | null>> {
  const { t } = useLingui();
  const { ratio, lnSplit, streak, percentile, session, notes, hours } = data;
  const peak = hours ? peakHour(hours) : null;
  const lnTotal = lnSplit ? lnSplit.ln + lnSplit.rice : 0;
  const top = percentile ? formatTopPercent(percentile.rank, percentile.players) : null;
  return {
    ratio: ratio ? (ratio.great === 0 ? t`All MAX` : `${formatRatio(ratio.perfect / ratio.great)} : 1`) : null,
    lnSplit: lnSplit && lnTotal > 0 ? t`${Math.round((lnSplit.ln / lnTotal) * 100)}% LN` : null,
    streak: streak ? t`${streak.longest} days` : null,
    percentile: top ? t`top ${top}%` : null,
    notes: notes ? t`${compactCount(notes.hit)} notes` : null,
    hours: peak != null ? hourLabel(peak) : null,
    session: session ? (() => {
      const length = sessionLength(session.minutes);
      return length.hours ? t`${length.value} hours` : t`${length.value} min`;
    })() : null,
  };
}

/* Two arrows passing each other, for the owner's swap button. */
function SwapIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M2.5 5.2h9.6M9.6 2.6l2.6 2.6-2.6 2.6" />
      <path d="M13.5 10.8H3.9M6.4 8.2l-2.6 2.6 2.6 2.6" />
    </svg>
  );
}

function placeStat(slots: readonly ProfileStatId[], slot: number, stat: ProfileStatId): ProfileStatId[] {
  const next = [...slots];
  const other = next.indexOf(stat);
  if (other >= 0) next[other] = next[slot];
  next[slot] = stat;
  return next;
}

/* Every stat laid out as the real card it would be, with the player's own
   numbers, so the choice is made by looking rather than by name. Above
   them, the four as they sit on the profile: pointing at a card shows it in
   the slot being changed before anything is picked; picking it puts it
   there (swapping places if it already sits in another slot) and saves.
   A card can also be dragged onto any slot, and the slots onto each other. */
export function ProfileStatGallery({ slots, initialSlot, renderCell, onChange, onClose, extra }: {
  slots: readonly ProfileStatId[];
  initialSlot: number;
  renderCell: (stat: ProfileStatId) => ReactNode;
  onChange: (next: ProfileStatId[]) => void;
  onClose: () => void;
  /* Settings of the cards in the slots, under them (the skill card's keymode). */
  extra?: (slots: readonly ProfileStatId[]) => ReactNode;
}) {
  const { t } = useLingui();
  useBodyScrollLock(true);
  const [active, setActive] = useState(initialSlot);
  const [hovered, setHovered] = useState<ProfileStatId | null>(null);
  const [drag, setDrag] = useState<{ stat: ProfileStatId; x: number; y: number; dx: number; dy: number; width: number; over: number | null; tilt: number } | null>(null);
  const settle = useRef(0);
  const press = useRef<{ stat: ProfileStatId; x: number; y: number; rect: DOMRect; id: number; touch: boolean; timer: number } | null>(null);
  const dragged = useRef(false);
  const holdLift = useRef<((start: NonNullable<typeof press.current>, x: number, y: number) => void) | null>(null);
  const isDefault = slots.every((stat, index) => stat === DEFAULT_PROFILE_STATS[index]);
  const shown = drag
    ? (drag.over != null ? placeStat(slots, drag.over, drag.stat) : slots)
    : hovered ? placeStat(slots, active, hovered) : slots;
  const target = drag ? drag.over : active;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Dragging: a press that travels a few px lifts the card; it follows the
  // pointer and lands on whichever slot it is let go over.
  useEffect(() => {
    const slotAt = (x: number, y: number) => {
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-stat-slot]");
      return element ? Number(element.dataset.statSlot) : null;
    };
    const lift = (start: NonNullable<typeof press.current>, x: number, y: number) => {
      dragged.current = true;
      setHovered(null);
      setDrag({ stat: start.stat, x, y, dx: start.x - start.rect.left, dy: start.y - start.rect.top, width: start.rect.width, over: slotAt(x, y), tilt: 0 });
    };
    const onMove = (event: PointerEvent) => {
      const start = press.current;
      if (!start || event.pointerId !== start.id) return;
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (start.touch && !dragged.current) {
        // A finger that moves before the hold lifts the card is scrolling.
        if (moved > 8) {
          window.clearTimeout(start.timer);
          press.current = null;
        }
        return;
      }
      if (!dragged.current && moved < 6) return;
      dragged.current = true;
      setHovered(null);
      // It leans the way it is moved, harder the faster, and rights itself
      // once the hand stops.
      window.clearTimeout(settle.current);
      settle.current = window.setTimeout(() => setDrag((current) => (current ? { ...current, tilt: 0 } : current)), 90);
      setDrag((current) => ({
        tilt: Math.max(-6, Math.min(6, (event.clientX - (current?.x ?? event.clientX)) * 0.35)),
        stat: start.stat,
        x: event.clientX,
        y: event.clientY,
        dx: start.x - start.rect.left,
        dy: start.y - start.rect.top,
        width: start.rect.width,
        over: slotAt(event.clientX, event.clientY),
      }));
    };
    const onUp = (event: PointerEvent) => {
      const start = press.current;
      if (!start || event.pointerId !== start.id) return;
      window.clearTimeout(start.timer);
      press.current = null;
      if (!dragged.current) return;
      const over = event.type === "pointerup" ? slotAt(event.clientX, event.clientY) : null;
      if (over != null) {
        setActive(over);
        if (slots[over] !== start.stat) onChange(placeStat(slots, over, start.stat));
      }
      setDrag(null);
      // the click that follows a drop is not a pick
      window.setTimeout(() => {
        dragged.current = false;
      }, 0);
    };
    // Once a held card is lifted, the finger drags it rather than the page.
    const onTouchMove = (event: TouchEvent) => {
      if (dragged.current && press.current?.touch) event.preventDefault();
    };
    holdLift.current = lift;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [slots, onChange]);

  /* A mouse lifts a card by moving it; a finger by holding it still for a
     moment first (a quick swipe still scrolls the list), with a short buzz. */
  const startPress = (stat: ProfileStatId) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    dragged.current = false;
    const touch = event.pointerType !== "mouse";
    const start = { stat, x: event.clientX, y: event.clientY, rect: event.currentTarget.getBoundingClientRect(), id: event.pointerId, touch, timer: 0 };
    if (touch) {
      start.timer = window.setTimeout(() => {
        if (press.current !== start) return;
        navigator.vibrate?.(12);
        holdLift.current?.(start, start.x, start.y);
      }, 260);
    }
    press.current = start;
  };

  const pick = (stat: ProfileStatId) => {
    if (dragged.current) return;
    setHovered(null);
    if (slots[active] !== stat) onChange(placeStat(slots, active, stat));
  };

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className={`fixed inset-0 z-[140] flex justify-center overflow-y-auto bg-black/75 p-3 sm:p-6 sm:backdrop-blur-sm ${drag ? "cursor-grabbing select-none" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t`Profile stats`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.16, ease: "easeOut" }} className="my-auto w-full max-w-[960px] rounded-2xl border border-osu-b3/30 bg-osu-b5 p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-bold text-white">{t`Profile stats`}</h2>
          {!isDefault && (
            <button
              type="button"
              onClick={() => onChange([...DEFAULT_PROFILE_STATS])}
              className="cursor-pointer text-[11.5px] text-osu-f1 transition-colors hover:text-white"
            >
              {t`Back to the usual four`}
            </button>
          )}
        </div>
        <p className="mt-1 text-[12px] text-osu-f1">{t`Pick a slot, then the card to put in it, or drag a card onto a slot.`}</p>

        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {shown.map((stat, slot) => {
            const selected = slot === target;
            const previewing = selected && (drag ? drag.over === slot && drag.stat !== slots[slot] : hovered != null && hovered !== slots[slot]);
            return (
              <button
                key={slot}
                type="button"
                data-stat-slot={slot}
                onClick={() => {
                  if (!dragged.current) setActive(slot);
                }}
                onPointerDown={startPress(slots[slot])}
                aria-pressed={selected}
                aria-label={t`Slot ${slot + 1}`}
                style={{ touchAction: "pan-y", WebkitTouchCallout: "none" }}
                onContextMenu={(event) => event.preventDefault()}
                className="group/slot relative grid cursor-pointer overflow-hidden rounded-xl text-left"
              >
                <div className={`pointer-events-none grid transition-opacity ${selected ? "" : "opacity-55 group-hover/slot:opacity-90"}`}>{renderCell(stat)}</div>
                <span className={`pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset transition-colors ${selected ? "ring-osu-pink" : "ring-transparent"}`} />
                <span className={`pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${selected ? "bg-osu-pink text-white" : "bg-osu-b3/70 text-osu-f1"}`}>
                  {previewing ? t`Preview` : slot + 1}
                </span>
              </button>
            );
          })}
        </div>

        {extra?.(slots)}

        <div className="mt-5 text-[9px] font-semibold uppercase tracking-[0.18em] text-osu-f1">{t`Every stat`}</div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" onPointerLeave={() => setHovered(null)}>
          {PROFILE_STATS.map((stat) => {
            const at = slots.indexOf(stat);
            const current = at === active;
            const lifted = drag?.stat === stat;
            return (
              <button
                key={stat}
                type="button"
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse" && !drag) setHovered(stat);
                }}
                onPointerDown={startPress(stat)}
                onFocus={() => setHovered(stat)}
                onBlur={() => setHovered(null)}
                onClick={() => pick(stat)}
                aria-pressed={current}
                style={{ touchAction: "pan-y", WebkitTouchCallout: "none" }}
                onContextMenu={(event) => event.preventDefault()}
                className={`relative grid overflow-hidden rounded-xl text-left ring-1 ring-inset transition-[box-shadow,transform,opacity] duration-150 ${drag ? "cursor-grabbing" : "cursor-grab hover:-translate-y-0.5"} ${lifted ? "opacity-30" : ""} ${current ? "ring-2 ring-osu-pink" : "ring-white/[0.06] hover:ring-osu-pink/50"}`}
              >
                <div className="pointer-events-none grid">{renderCell(stat)}</div>
                {at >= 0 && (
                  <span className={`pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${current ? "bg-osu-pink text-white" : "bg-osu-b3/70 text-osu-f1"}`}>
                    {current ? t`In this slot` : t`In slot ${at + 1}`}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="cursor-pointer rounded-lg bg-osu-pink px-4 py-2 text-[12.5px] font-bold text-white transition hover:brightness-110">
            {t`Done`}
          </button>
        </div>
      </motion.div>
      {drag && (
        <div
          className="pointer-events-none fixed left-0 top-0 z-[150]"
          style={{ width: drag.width, transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px)` }}
        >
          <div
            className="grid overflow-hidden rounded-xl shadow-[0_18px_40px_rgba(0,0,0,0.55)] ring-2 ring-osu-pink transition-transform duration-200 ease-out"
            style={{ transform: `rotate(${drag.tilt}deg) scale(1.03)`, transformOrigin: `${drag.dx}px ${drag.dy}px` }}
          >
            {renderCell(drag.stat)}
          </div>
        </div>
      )}
    </motion.div>,
    document.body,
  );
}

/* The owner's way into the gallery: a small button in a profile card's
   corner (dim until the card is pointed at), or a full-width row naming the
   stat on the /supporter page. */
export function ProfileStatPicker({ slot, slots, previews, renderCell, onChange, extra, variant = "corner", disabled = false }: {
  slot: number;
  slots: readonly ProfileStatId[];
  previews: Partial<Record<ProfileStatId, string | null>>;
  renderCell: (stat: ProfileStatId) => ReactNode;
  onChange: (next: ProfileStatId[]) => void;
  extra?: (slots: readonly ProfileStatId[]) => ReactNode;
  /** "corner" sits in a profile card's corner; "field" is a full-width row naming the stat (the /supporter page). */
  variant?: "corner" | "field";
  disabled?: boolean;
}) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const current = slots[slot];

  return (
    <>
      {variant === "field" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg bg-osu-b4 px-3 py-2.5 text-left transition-colors hover:bg-osu-b3/70 disabled:cursor-default disabled:opacity-50"
        >
          <span className="w-4 shrink-0 text-[11px] font-bold tabular-nums text-osu-f1">{slot + 1}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">{i18n._(PROFILE_STAT_LABELS[current])}</span>
          {previews[current] && <span className="shrink-0 text-[12px] tabular-nums text-osu-f1">{previews[current]}</span>}
          <SwapIcon className="h-3.5 w-3.5 shrink-0 text-osu-f1" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t`Change this stat`}
          className="absolute right-[26px] top-[11px] z-10 grid h-6 w-6 cursor-pointer place-items-center rounded-md text-osu-f1 opacity-60 transition-[opacity,color,background-color] hover:bg-osu-b3/60 hover:text-white focus-visible:opacity-100 group-hover/stat:opacity-100"
        >
          <SwapIcon className="h-3.5 w-3.5" />
        </button>
      )}
      <AnimatePresence>
        {open && <ProfileStatGallery slots={slots} initialSlot={slot} renderCell={renderCell} onChange={onChange} extra={extra} onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </>
  );
}
