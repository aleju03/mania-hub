import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  fetchLivePlayerSkillHistorySeriesDirect,
  type LivePlayerSkillHistorySeries,
} from "../../lib/live-backend";
import { useOverallMethod } from "../../lib/overall-method";
import { useLocale } from "../../lib/locale-context";
import { useExperimentalLn, useNoDans } from "../../store";
import { Skeleton } from "../ui/LoadingSkeleton";
import { SKILL_HISTORY_NOTES } from "./skill-history-notes";
import { historyOverall, overallTicks } from "./skill-history-overall";

const PAD = { top: 12, right: 12, bottom: 26, left: 34 };
const DAY_MS = 86_400_000;
const STROKE = "hsl(var(--theme-hue),calc(100% * var(--theme-sat)),70%)";

interface Point {
  at: number;
  value: number;
  // The rice dan recorded with the reading, null when it had none.
  dan: string | null;
}

// Notes carry the day they went live on the site clock (UTC-6).
function noteTime(date: string): number {
  return Date.parse(`${date}T12:00:00-06:00`);
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function changeColor(value: number): string {
  return value > 0 ? "text-osu-green-light" : value < 0 ? "text-osu-red-light" : "text-osu-f1";
}

/** The keymode's Overall since the last rating-scale change, with the rice
 * dan recorded at each reading. The skill history modal's Graph tab; its
 * Changes tab carries the full text of the notes marked along the axis. */
export function SkillHistoryGraph({ userId, keyCount, height = 200 }: { userId: number; keyCount: number; height?: number }) {
  const HEIGHT = height;
  const { t } = useLingui();
  const locale = useLocale();
  const noDans = useNoDans();
  const showLn = useExperimentalLn();
  const hideLn = keyCount === 4 && !showLn;
  const etterna = useOverallMethod() === "etterna";
  const [series, setSeries] = useState<LivePlayerSkillHistorySeries | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Read once per load, so the right edge does not creep while the graph is open.
  const [now, setNow] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setSeries(null);
    setError(false);
    setHover(null);
    fetchLivePlayerSkillHistorySeriesDirect(userId, keyCount, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setNow(Date.now());
        setSeries(data);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [userId, keyCount, attempt]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(box.getBoundingClientRect().width));
    observer.observe(box);
    setWidth(box.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [series != null]);

  // A removed keymode is recorded as Overall 0; it is a gap, not a fall to zero.
  const notes = useMemo(() => SKILL_HISTORY_NOTES.filter((note) => !note.keyCounts || note.keyCounts.includes(keyCount)), [keyCount]);
  // Only readings on today's scale: everything from the newest rating-scale
  // change on (SkillHistoryNote.rescalesFrom). The History tab keeps the rest.
  const scaleVersion = Math.max(0, ...notes.map((note) => note.rescalesFrom ?? 0));
  const points = useMemo<Point[]>(() => (series?.points ?? [])
    .filter((point) => !(point.version < scaleVersion))
    .map((point) => ({
      at: Date.parse(point.recordedAt),
      value: historyOverall(point.ratings, keyCount, etterna, hideLn),
      dan: point.danRc ? `${point.danRc.beyondTable ? "> " : ""}${point.danRc.label.charAt(0).toUpperCase()}${point.danRc.label.slice(1)}` : null,
    }))
    .filter((point) => Number.isFinite(point.at) && point.value > 0), [series, keyCount, etterna, hideLn, scaleVersion]);

  const header = (
    <div className="mb-2 flex min-h-[24px] flex-wrap items-baseline gap-x-2.5 gap-y-1">
      {points.length ? (
        <>
          <span className="text-[22px] font-bold leading-none text-white tabular-nums">{points.at(-1)!.value.toFixed(2)}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3"><Trans>overall</Trans></span>
          {points.length > 1 ? (
            <span className="text-[12px] text-osu-l2">
              <span className={`font-semibold tabular-nums ${changeColor(points.at(-1)!.value - points[0].value)}`}>{signed(points.at(-1)!.value - points[0].value)}</span>
              {" "}<Trans>since {new Date(points[0].at).toLocaleDateString(locale, { month: "short", day: "numeric", ...(new Date(points[0].at).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) })}</Trans>
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );

  if (error) {
    return (
      <div role="alert" className="flex flex-col items-center justify-center text-center text-[12px] text-osu-f1" style={{ height: HEIGHT + 32 }}>
        <p><Trans>Could not load skill history.</Trans></p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-2 cursor-pointer text-osu-pink-light hover:text-white"><Trans>Try again</Trans></button>
      </div>
    );
  }
  if (!series) {
    return (
      <div role="status" aria-label={t`Loading history…`}>
        <Skeleton className="mb-2 h-[24px] w-40" />
        <div style={{ height: HEIGHT }}><Skeleton className="h-full w-full rounded-lg" /></div>
      </div>
    );
  }
  if (!points.length) {
    return <p className="flex items-center justify-center text-center text-[12px] text-osu-f1" style={{ height: HEIGHT + 32 }}><Trans>No skill ratings have been recorded yet.</Trans></p>;
  }

  const first = points[0].at;
  // At least two weeks wide, so a history of one afternoon is not a cliff,
  // but never reaching back past a scale change into readings left out.
  const cut = series.points.some((point) => point.version < scaleVersion);
  const start = cut ? first : Math.min(first, now - 14 * DAY_MS);
  const end = Math.max(now, points.at(-1)!.at);
  const values = points.map((point) => point.value);
  let min = Math.min(...values) - 0.75;
  let max = Math.max(...values) + 0.75;
  if (max - min < 4) {
    const mid = (max + min) / 2;
    min = mid - 2;
    max = mid + 2;
  }
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (at: number) => PAD.left + ((at - start) / (end - start || 1)) * plotW;
  const y = (value: number) => PAD.top + (1 - (value - min) / (max - min)) * plotH;

  // Ratings move in steps: each one holds until the next recompute changes it.
  let path = `M${x(points[0].at)},${y(points[0].value)}`;
  for (const point of points.slice(1)) path += `H${x(point.at)}V${y(point.value)}`;
  path += `H${x(end)}`;

  const ticks = overallTicks(min, max);
  const visibleNotes = notes.filter((note) => noteTime(note.date) > start && noteTime(note.date) <= end);
  // Weekly ticks on a short history, monthly on a long one, thinned to fit.
  const weekly = end - start < 75 * DAY_MS;
  const dateTicks: number[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  if (weekly) cursor.setDate(cursor.getDate() + ((8 - cursor.getDay()) % 7));
  else cursor.setDate(1);
  for (; cursor.getTime() <= end; weekly ? cursor.setDate(cursor.getDate() + 7) : cursor.setMonth(cursor.getMonth() + 1)) {
    if (cursor.getTime() > start) dateTicks.push(cursor.getTime());
  }
  const tickEvery = Math.max(1, Math.ceil(dateTicks.length / Math.max(1, Math.floor(plotW / 72))));
  const spanYears = new Date(start).getFullYear() !== new Date(end).getFullYear();
  const tickLabel = (tick: number) => new Date(tick).toLocaleDateString(locale, weekly
    ? { month: "short", day: "numeric" }
    : { month: "short", ...(spanYears ? { year: "2-digit" } : {}) });

  const hovered = hover != null ? points[hover] : null;
  const previous = hover != null && hover > 0 ? points[hover - 1] : null;
  const hoveredNotes = hovered ? visibleNotes.filter((note) => {
    const at = noteTime(note.date);
    // The changes that landed between the last reading and this one.
    return at <= hovered.at + DAY_MS / 2 && (!previous || at > previous.at - DAY_MS / 2);
  }) : [];

  const pickPoint = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const at = start + ((clientX - box.left - PAD.left) / (plotW || 1)) * (end - start);
    let index = 0;
    for (let i = 0; i < points.length; i += 1) if (points[i].at <= at) index = i;
    setHover(index);
  };

  return (
    <div>
      {header}
      <div
        ref={boxRef}
        className="relative touch-pan-y select-none"
        style={{ height: HEIGHT }}
        onPointerMove={(event) => pickPoint(event.clientX)}
        onPointerDown={(event) => pickPoint(event.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        {width > 0 ? (
          <svg width={width} height={HEIGHT} className="block overflow-visible" role="img" aria-label={t`${keyCount}K Overall over time`}>
            {ticks.map((tick) => (
              <line key={`grid:${tick}`} x1={PAD.left} x2={PAD.left + plotW} y1={y(tick)} y2={y(tick)} stroke="#fff" strokeOpacity={0.05} />
            ))}
            {ticks.map((tick) => (
              <text key={tick} x={PAD.left - 8} y={y(tick)} dy="0.35em" textAnchor="end" className="fill-osu-f1 text-[11px] tabular-nums">{tick}</text>
            ))}
            {dateTicks.filter((_, index) => index % tickEvery === 0).map((tick) => (
              <text key={tick} x={x(tick)} y={HEIGHT - 6} textAnchor="middle" className="fill-osu-f1 text-[11px]">{tickLabel(tick)}</text>
            ))}
            {visibleNotes.map((note) => (
              <line key={`${note.date}:${note.text}`} x1={x(noteTime(note.date))} x2={x(noteTime(note.date))} y1={PAD.top + plotH - 6} y2={PAD.top + plotH} stroke="#fff" strokeOpacity={0.35} strokeWidth={2} />
            ))}
            <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#fff" strokeOpacity={0.1} />
            <path d={path} fill="none" stroke={STROKE} strokeWidth={2} strokeLinejoin="round" />
            {hovered ? (
              <>
                <line x1={x(hovered.at)} x2={x(hovered.at)} y1={PAD.top} y2={PAD.top + plotH} stroke="#fff" strokeOpacity={0.2} />
                <circle cx={x(hovered.at)} cy={y(hovered.value)} r={4.5} fill={STROKE} stroke="var(--color-osu-b4)" strokeWidth={2} />
              </>
            ) : (
              <circle cx={x(points.at(-1)!.at)} cy={y(points.at(-1)!.value)} r={4} fill={STROKE} />
            )}
          </svg>
        ) : null}
        {hovered && width > 0 ? (
          <div
            className="pointer-events-none absolute z-10 w-max max-w-[240px] rounded-lg bg-osu-b5/95 px-3 py-2 text-[11px] leading-snug text-osu-l2 shadow-lg"
            style={{
              top: PAD.top,
              ...(x(hovered.at) > width / 2 ? { right: width - x(hovered.at) + 10 } : { left: x(hovered.at) + 10 }),
            }}
          >
            <div className="text-osu-f1">{new Date(hovered.at).toLocaleDateString(locale, { dateStyle: "medium" })}</div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="text-[14px] font-bold text-white tabular-nums">{hovered.value.toFixed(2)}</span>
              {previous ? <span className={`font-semibold tabular-nums ${changeColor(hovered.value - previous.value)}`}>{signed(hovered.value - previous.value)}</span> : null}
            </div>
            {hovered.dan && !noDans ? <div className="mt-0.5"><Trans>Dan {hovered.dan}</Trans></div> : null}
            {hoveredNotes.length ? <div className="mt-1 text-osu-f1"><Trans>Rating system update</Trans></div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
