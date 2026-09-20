import { useEffect, useId, useRef, useState } from "react";
import { Plural, useLingui } from "@lingui/react/macro";
import { ChevronDown, ChevronRight, Info, Music2, TrendingUp } from "lucide-react";
import { fetchLiveManiacardHistoryDirect, type LiveManiacardHistoryEntry } from "#/lib/live-backend";
import { MANIA_TIER_STYLES, maniaTierTextStyle } from "#/lib/maniacard";
import { Skeleton } from "../../ui/LoadingSkeleton";
import { ModBadge } from "../../ui/ModBadge";
import { parseCssRgba } from "./renderData";
import { intlLocaleTag } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import type { AppLocale } from "#/lib/locale";

function delta(value: number, locale: AppLocale) {
  return `${value > 0 ? "+" : ""}${value.toLocaleString(intlLocaleTag(locale))}`;
}

function deltaColor(value: number) {
  return value > 0 ? "text-emerald-300" : value < 0 ? "text-rose-300" : "text-osu-f1";
}

export function ManiacardHistory({ userId }: { userId: number }) {
  const { t } = useLingui();
  const [items, setItems] = useState<LiveManiacardHistoryEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const loadPage = async (before?: number) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(false);
    try {
      const page = await fetchLiveManiacardHistoryDirect(userId, { before, signal: controller.signal });
      if (controller.signal.aborted) return;
      setItems((previous) => before ? [...previous, ...page.items] : page.items);
      setNextBefore(page.nextBefore);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setNextBefore(null);
    void loadPage();
    return () => controllerRef.current?.abort();
  }, [userId]);

  return (
    <div>
      {items.length > 1 && <RatingTrend items={items} />}
      {items.length > 0 && <ol className="space-y-3">
        {items.map((entry) => <HistoryEntry key={entry.id} entry={entry} />)}
      </ol>}
      {loading ? (
        <div role="status" aria-label={t`Loading history…`} className="space-y-4 py-3">
          {Array.from({ length: items.length ? 2 : 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-3" aria-hidden="true">
              <div className="flex-1 space-y-2"><Skeleton className="h-3 w-28" /><Skeleton className="h-2.5 w-20" /></div>
              <Skeleton className="h-4 w-10" /><Skeleton className="h-3 w-8" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div role="alert" className="py-5 text-center text-xs text-osu-f1">
          <p>{t`Could not load Maniacard history.`}</p>
          <button type="button" onClick={() => void loadPage(nextBefore ?? undefined)} className="mt-2 cursor-pointer text-osu-pink-light hover:underline">{t`Try again`}</button>
        </div>
      ) : items.length === 0 ? (
        <p className="py-7 text-center text-xs text-osu-f1">{t`No Maniacard history has been recorded yet.`}</p>
      ) : nextBefore != null ? (
        <button type="button" onClick={() => void loadPage(nextBefore)} className="mt-4 w-full cursor-pointer rounded-lg bg-osu-b3/40 py-2 text-xs font-semibold text-osu-l2 hover:bg-osu-b3/60">{t`Load older changes`}</button>
      ) : (
        <p className="mt-5 text-center text-xs text-osu-f1/70">{t`Beginning of recorded history`}</p>
      )}
    </div>
  );
}

function RatingTrend({ items }: { items: LiveManiacardHistoryEntry[] }) {
  const { t } = useLingui();
  const locale = useLocale();
  const intlLocale = intlLocaleTag(locale);
  const gradientId = useId();
  const tooltipId = useId();
  const pointRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const recent = items.slice(0, 7).reverse();
  const first = recent[0];
  const last = recent[recent.length - 1];
  const gain = last.snapshot.rating - first.snapshot.rating;
  const values = recent.map((entry) => entry.snapshot.rating);
  const min = Math.min(...values);
  const span = Math.max(10, Math.max(...values) - min);
  const points = recent.map((entry, i) => ({
    x: 8 + i / (recent.length - 1) * 384,
    y: 58 - (entry.snapshot.rating - min) / span * 44,
  }));
  const line = points.map((point, i) => `${i === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  const dateLabel = (date: string) => new Date(date).toLocaleDateString(intlLocale, { month: "short", day: "numeric" });
  const activeIndex = recent.findIndex((entry) => entry.id === (hoveredId ?? focusedId));
  const active = recent[activeIndex];
  const activePoint = points[activeIndex];
  const activeChange = active?.previous ? active.snapshot.rating - active.previous.rating : null;

  return (
    <div className="mb-5 px-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-osu-f1"><TrendingUp className="h-3.5 w-3.5" />{t`Recent progression`}</span>
        <span className={`font-semibold tabular-nums ${deltaColor(gain)}`}>{delta(gain, locale)} {t`points`}</span>
      </div>
      <div
        role="group"
        aria-label={t`Rating history chart`}
        className="relative mt-2 h-[66px] w-full"
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (bounds.width <= 0) return;
          const x = (event.clientX - bounds.left) / bounds.width * 400;
          const index = Math.max(0, Math.min(recent.length - 1, Math.round((x - 8) / 384 * (recent.length - 1))));
          setHoveredId(recent[index].id);
        }}
        onPointerLeave={() => setHoveredId(null)}
      >
        <svg viewBox="0 0 400 72" className="h-full w-full overflow-visible text-osu-pink-light" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity="0.18" /><stop offset="100%" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
          <path d={`${line} L392,72 L8,72 Z`} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {activePoint && <line x1={activePoint.x} x2={activePoint.x} y1="6" y2="72" stroke="currentColor" strokeOpacity="0.3" strokeDasharray="3 3" />}
          {points.map((point, i) => <g key={recent[i].id}>
            {activeIndex === i && <circle cx={point.x} cy={point.y} r="9" fill="currentColor" fillOpacity="0.15" />}
            <circle cx={point.x} cy={point.y} r={activeIndex === i ? 5 : 3.5} className={activeIndex === i ? "fill-current" : "fill-osu-b4"} stroke="currentColor" strokeWidth="2" />
          </g>)}
        </svg>
        {points.map((point, i) => {
          const entry = recent[i];
          const date = new Date(entry.recordedAt).toLocaleString(intlLocale, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
          const rating = entry.snapshot.rating;
          return <button
            key={entry.id}
            ref={(element) => { pointRefs.current[i] = element; }}
            type="button"
            aria-label={t`${date}: ${rating} points`}
            aria-describedby={activeIndex === i ? tooltipId : undefined}
            className="absolute h-11 w-11 -translate-y-1/2 cursor-crosshair rounded-lg focus-visible:outline-2 focus-visible:outline-osu-pink-light"
            style={{ left: `clamp(0px, calc(${point.x / 4}% - 22px), calc(100% - 44px))`, top: `${point.y / 72 * 100}%` }}
            onPointerEnter={() => setHoveredId(entry.id)}
            onFocus={() => { setHoveredId(null); setFocusedId(entry.id); }}
            onBlur={() => { setHoveredId(null); setFocusedId(null); }}
            onClick={() => setFocusedId(entry.id)}
            onKeyDown={(event) => {
              const index = event.key === "ArrowLeft" ? Math.max(0, i - 1)
                : event.key === "ArrowRight" ? Math.min(recent.length - 1, i + 1)
                  : event.key === "Home" ? 0 : event.key === "End" ? recent.length - 1 : null;
              if (index == null) return;
              event.preventDefault();
              pointRefs.current[index]?.focus();
            }}
          />;
        })}
        {active && activePoint && <div
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none absolute z-30 w-44 rounded-xl border border-osu-b2/60 bg-osu-b5 px-3 py-2.5 shadow-xl"
          style={{ left: `clamp(0px, calc(${activePoint.x / 4}% - 88px), calc(100% - 176px))`, top: `calc(${activePoint.y / 72 * 100}% + 14px)` }}
        >
          <time dateTime={active.recordedAt} className="block text-[11px] text-osu-f1">
            {new Date(active.recordedAt).toLocaleString(intlLocale, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
          </time>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-xl font-bold tabular-nums text-white">{active.snapshot.rating}</span>
            {activeChange != null && <span className={`text-xs font-semibold tabular-nums ${deltaColor(activeChange)}`}>{delta(activeChange, locale)} {t`pts`}</span>}
          </div>
          <span className="mt-1 block text-xs font-medium" style={maniaTierTextStyle(active.snapshot.tier, parseCssRgba(MANIA_TIER_STYLES[active.snapshot.tier].glowColor))}>
            {MANIA_TIER_STYLES[active.snapshot.tier].label}
          </span>
          {activeChange == null && <span className="mt-1 block text-[11px] text-osu-f1">{t`Starting rating`}</span>}
        </div>}
      </div>
      <div className="flex justify-between text-[11px] text-osu-f1">
        <span>{dateLabel(first.recordedAt)} <span className="ml-1 font-semibold tabular-nums text-osu-l2">{first.snapshot.rating}</span></span>
        <span>{dateLabel(last.recordedAt)} <span className="ml-1 font-semibold tabular-nums text-osu-l2">{last.snapshot.rating}</span></span>
      </div>
    </div>
  );
}

function MapCover({ setId, className = "" }: { setId?: number | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-lg bg-osu-b3/50 ${className}`}>
      <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-osu-pink/15 to-osu-b5/40"><Music2 className="h-5 w-5 text-osu-f1/50" aria-hidden="true" /></div>
      {setId && !failed ? <img src={`https://assets.ppy.sh/beatmaps/${setId}/covers/card.jpg`} alt="" loading="lazy" onError={() => setFailed(true)} className="relative h-full w-full object-cover" /> : null}
    </div>
  );
}

function DetailHint({ label, explanation }: { label: string; explanation: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen(true)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} aria-label={label} aria-describedby={open ? id : undefined} className="inline-flex cursor-pointer items-center gap-1 rounded text-[11px] text-osu-f1 transition-colors hover:text-osu-l2 focus-visible:outline-osu-pink-light">
        {label}<Info className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && <span id={id} role="tooltip" className="absolute right-0 bottom-full z-20 mb-2 w-52 rounded-lg border border-osu-b2/50 bg-osu-b5 px-3 py-2 text-left text-xs leading-relaxed text-osu-l2 shadow-xl">
        {explanation}
      </span>}
    </span>
  );
}

function HistoryEntry({ entry }: { entry: LiveManiacardHistoryEntry }) {
  const { t } = useLingui();
  const locale = useLocale();
  const intlLocale = intlLocaleTag(locale);
  const [expanded, setExpanded] = useState(false);
  const { snapshot, previous } = entry;
  const change = previous ? snapshot.rating - previous.rating : 0;
  const tierChanged = previous && previous.tier !== snapshot.tier;
  const tierLabel = MANIA_TIER_STYLES[snapshot.tier].label;
  const date = new Date(entry.recordedAt);
  const mapCount = entry.maps.length;
  const mapTotal = entry.maps.reduce((total, map) => total + map.ratingChange, 0);
  const tierStyle = maniaTierTextStyle(snapshot.tier, parseCssRgba(MANIA_TIER_STYLES[snapshot.tier].glowColor));
  const label = !previous ? t`Starting rating` : mapCount ? <Plural value={mapCount} one="# top play" other="# top plays" /> : t`Rating update`;
  const panelId = useId();

  return (
    <li className={`relative rounded-xl border transition-colors ${expanded ? "border-osu-pink-light/20 bg-osu-b5/40" : "border-white/5 bg-osu-b5/20"}`}>
      <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)} className="w-full cursor-pointer rounded-xl p-3.5 text-left transition-colors hover:bg-white/[0.025] focus-visible:outline-osu-pink-light">
        <div className="flex items-center gap-3">
          {mapCount ? <div className="relative h-11 w-12 shrink-0">
            {mapCount > 1 && <div className="absolute -right-0.5 top-1 h-10 w-10 rotate-6 rounded-lg border border-white/10 bg-osu-b3" />}
            <MapCover setId={entry.maps[0].beatmapsetId} className="h-11 w-11 shadow-md" />
          </div> : <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-white/5"><TrendingUp className="h-5 w-5 text-osu-f1" /></div>}
          <div className="min-w-0 flex-1">
            <time dateTime={entry.recordedAt} title={date.toLocaleString(intlLocale)} className="block text-sm font-semibold text-osu-l1">
              {date.toLocaleDateString(intlLocale, { month: "short", day: "numeric" })}
              <span className="ml-2 hidden text-[11px] font-normal text-osu-f1 sm:inline">{date.toLocaleTimeString(intlLocale, { hour: "numeric", minute: "2-digit" })}</span>
            </time>
            <span className="mt-1 block text-xs text-osu-f1">{label}</span>
          </div>
          <div className="shrink-0 text-right">
            <span className="block text-[23px] leading-none font-bold tabular-nums text-white">{snapshot.rating}</span>
            {previous ? <span className={`mt-1.5 block text-xs font-semibold tabular-nums ${deltaColor(change)}`}>{delta(change, locale)} {t`pts`}</span>
              : <span className="mt-1.5 block text-[11px] font-medium" style={tierStyle}>{MANIA_TIER_STYLES[snapshot.tier].label}</span>}
          </div>
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-osu-f1" /> : <ChevronRight className="h-4 w-4 shrink-0 text-osu-f1" />}
        </div>
        {tierChanged && <div className="mt-3 border-t border-white/5 pt-2.5 text-xs font-semibold" style={tierStyle}>
          {change > 0 ? t`Promoted to ${tierLabel}` : t`Tier changed to ${tierLabel}`}
        </div>}
      </button>
      {expanded && (
        <div id={panelId} className="border-t border-white/5 px-3.5 pb-3.5">
          {mapCount > 0 && <>
            <div className="mb-1 mt-3 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-osu-l2">{t({ context: "Maniacard history", message: "Top plays" })}</span>
              <DetailHint label={t`Estimated impact`} explanation={t`Includes new top plays and PBs on existing maps. Per-play gains use estimated pp between updates. The session total is the recorded rating change.`} />
            </div>
            <ul className="space-y-1">
              {entry.maps.map((map) => (
                <li key={`${map.beatmapId}:${map.playedAt}`} className="flex items-center gap-3 py-2">
                  <MapCover setId={map.beatmapsetId} className="h-12 w-14 sm:h-14 sm:w-20" />
                  <div className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[13px] leading-[1.35] font-semibold text-osu-l1">{map.title}</span>
                    <span className="mt-1 block truncate text-[11px] text-osu-f1">{map.difficulty}</span>
                    {map.mods.length > 0 && <span className="mt-1 flex flex-wrap gap-1">{map.mods.map((mod) => <ModBadge key={mod} mod={mod} size={0.7} />)}</span>}
                  </div>
                  <span className={`shrink-0 text-base font-bold tabular-nums ${deltaColor(map.ratingChange)}`}>{delta(map.ratingChange, locale)}</span>
                </li>
              ))}
            </ul>
          </>}
          <div className="mt-3 grid grid-cols-3 divide-x divide-white/10 rounded-lg bg-white/[0.025] py-3">
            {([
              [t`Control`, snapshot.control, previous?.control],
              [t({ context: "Maniacard stat", message: "Speed" }), snapshot.speed, previous?.speed],
              [t`Precision`, snapshot.precision, previous?.precision],
            ] as const).map(([name, value, old]) => (
              <div key={name} className="px-2.5 sm:px-3">
                <span className="block text-[11px] text-osu-f1">{name}</span>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-base font-semibold tabular-nums text-osu-l1">{value}</span>
                  {old != null && value !== old && <span className={`text-[11px] font-medium tabular-nums ${deltaColor(value - old)}`}>{delta(value - old, locale)}</span>}
                </div>
              </div>
            ))}
          </div>
          {entry.otherRatingChange !== 0 && <div className="mt-3 flex justify-end">
            <DetailHint label={t`Difference: ${delta(entry.otherRatingChange, locale)}`} explanation={t`The session changed by ${delta(change, locale)} points; the map estimates add up to ${delta(mapTotal, locale)}. This is the difference between them, not a separate bonus.`} />
          </div>}
        </div>
      )}
    </li>
  );
}
