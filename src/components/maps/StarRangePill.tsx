import { useLingui } from "@lingui/react/macro";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { starRatingColor, starSpectrumGradient } from "./SearchCard";

// The difficulty filter as a stretchable difficulty badge: the osu-web star
// pill itself sits on a faint spectrum rail, its ends drag to set min/max and
// its body drags to shift the whole range. Values of 0 mean "unset" like
// RangeSlider, so the parent stores 0/0 for "any". Commits on release.
interface Props {
  lo: number;
  hi: number;
  min: number;
  max: number;
  step: number;
  onChange: (min: number, max: number) => void;
  ariaLabel: string;
}

type DragMode = "min" | "max" | "body";

const STAR_PATH = "M12 1.7l3.1 6.9 7.2.8-5.4 5 1.5 7.2L12 17.9l-6.4 3.7 1.5-7.2-5.4-5 7.2-.8L12 1.7z";

// Last real spectrum stop; osu-web paints everything at or past it black.
const SPECTRUM_END = 9;
// Share of the rail given to the black SPECTRUM_END..hi tail.
const TAIL_FRACTION = 0.15;

export function StarRangePill({ lo, hi, min, max, step, onChange, ariaLabel }: Props) {
  const { t } = useLingui();
  const active = min > 0 || max > 0;
  const [localMin, setLocalMin] = useState(min > 0 ? min : lo);
  const [localMax, setLocalMax] = useState(max > 0 ? max : hi);
  const [dragging, setDragging] = useState<DragMode | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [railPx, setRailPx] = useState(280);
  // Live values + drag bookkeeping, so commit never reads a stale closure.
  const dragRef = useRef<{ mode: DragMode; startX: number; startMin: number; startMax: number } | null>(null);
  const liveRef = useRef({ min: localMin, max: localMax });
  const keyDirtyRef = useRef(false);

  const span = hi - lo || 1;
  const gap = step * 2;
  const round = (v: number) => Number((Math.round(v / step) * step).toFixed(4));

  // osu-web's spectrum ends at 9★ (everything past it is pure black), but the
  // filter runs to `hi`. Lay the live spectrum across most of the rail and
  // squeeze the dead 9..hi black tail into a short stub so the pill isn't
  // 40% black at rest.
  const knee = Math.min(SPECTRUM_END, hi);
  const hasTail = hi > SPECTRUM_END && lo < SPECTRUM_END;
  const posFrac = (stars: number) => {
    if (!hasTail) return (stars - lo) / span;
    if (stars <= knee) return ((stars - lo) / (knee - lo)) * (1 - TAIL_FRACTION);
    return 1 - TAIL_FRACTION + ((stars - knee) / (hi - knee)) * TAIL_FRACTION;
  };
  const fracToStars = (frac: number) => {
    if (!hasTail) return lo + frac * span;
    if (frac <= 1 - TAIL_FRACTION) return lo + (frac / (1 - TAIL_FRACTION)) * (knee - lo);
    return knee + ((frac - (1 - TAIL_FRACTION)) / TAIL_FRACTION) * (hi - knee);
  };
  const setMin = (v: number) => { liveRef.current.min = v; setLocalMin(v); };
  const setMax = (v: number) => { liveRef.current.max = v; setLocalMax(v); };

  useEffect(() => {
    if (dragRef.current) return;
    liveRef.current = { min: min > 0 ? min : lo, max: max > 0 ? max : hi };
    setLocalMin(liveRef.current.min);
    setLocalMax(liveRef.current.max);
  }, [min, max, lo, hi]);

  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const update = () => setRailPx(el.getBoundingClientRect().width || 280);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const starsAt = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return lo;
    return fracToStars(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
  };

  const commit = () => {
    const { min: m, max: x } = liveRef.current;
    onChange(m <= lo + 1e-9 ? 0 : m, x >= hi - 1e-9 ? 0 : x);
  };

  const beginDrag = (mode: DragMode) => (e: ReactPointerEvent) => {
    if (dragRef.current) return;
    // A full-span pill has nowhere to shift; let the press fall through to the
    // rail so the first drag on the resting "Any" pill grabs the nearest end.
    if (mode === "body" && liveRef.current.min <= lo + 1e-9 && liveRef.current.max >= hi - 1e-9) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode, startX: e.clientX, startMin: liveRef.current.min, startMax: liveRef.current.max };
    setDragging(mode);
  };

  // Pressing the bare rail jumps the nearest end to the pointer and keeps dragging it.
  const onRailDown = (e: ReactPointerEvent) => {
    if (dragRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const stars = round(Math.max(lo, Math.min(hi, starsAt(e.clientX))));
    const nearMin = Math.abs(stars - liveRef.current.min) <= Math.abs(stars - liveRef.current.max);
    if (nearMin) setMin(Math.min(stars, liveRef.current.max - gap));
    else setMax(Math.max(stars, liveRef.current.min + gap));
    dragRef.current = { mode: nearMin ? "min" : "max", startX: e.clientX, startMin: liveRef.current.min, startMax: liveRef.current.max };
    setDragging(nearMin ? "min" : "max");
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = railRef.current?.getBoundingClientRect();
    const width = rect?.width || railPx;
    const deltaFrac = (e.clientX - drag.startX) / width;
    if (drag.mode === "min") {
      setMin(Math.max(lo, Math.min(round(fracToStars(posFrac(drag.startMin) + deltaFrac)), drag.startMax - gap)));
    } else if (drag.mode === "max") {
      setMax(Math.min(hi, Math.max(round(fracToStars(posFrac(drag.startMax) + deltaFrac)), drag.startMin + gap)));
    } else {
      const size = drag.startMax - drag.startMin;
      const nextMin = Math.max(lo, Math.min(round(fracToStars(posFrac(drag.startMin) + deltaFrac)), hi - size));
      setMin(nextMin);
      setMax(nextMin + size);
    }
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(null);
    commit();
  };

  const onHandleKey = (mode: "min" | "max") => (e: ReactKeyboardEvent) => {
    const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    keyDirtyRef.current = true;
    const amount = delta * (e.shiftKey ? 1 : step);
    if (mode === "min") setMin(Math.max(lo, Math.min(round(liveRef.current.min + amount), liveRef.current.max - gap)));
    else setMax(Math.min(hi, Math.max(round(liveRef.current.max + amount), liveRef.current.min + gap)));
  };
  const onHandleKeyUp = () => {
    if (!keyDirtyRef.current) return;
    keyDirtyRef.current = false;
    commit();
  };

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // Typed ranges: "3.6-6.7", "5+"/">5", "<4"/"≤4", bare "5" = the 5..6 bucket
  // (osu-web's star filter buttons), ""/"any" = clear. Comma decimals accepted.
  const parseDraft = (raw: string): { min: number; max: number } | null => {
    const text = raw
      .replace(/[★\s]/g, "")
      .replace(/,/g, ".")
      .replace(/[–—]/g, "-")
      .replace(/≤/g, "<")
      .replace(/≥/g, ">")
      .toLowerCase();
    if (text === "" || text === "any") return { min: lo, max: hi };
    const num = (s: string) => (/^\d*\.?\d+$/.test(s) ? Number(s) : null);
    let nextMin = lo;
    let nextMax = hi;
    if (text.endsWith("+")) {
      const v = num(text.slice(0, -1));
      if (v == null) return null;
      nextMin = v;
    } else if (text.startsWith(">")) {
      const v = num(text.replace(/^>=?/, ""));
      if (v == null) return null;
      nextMin = v;
    } else if (text.startsWith("<")) {
      const v = num(text.replace(/^<=?/, ""));
      if (v == null) return null;
      nextMax = v;
    } else if (text.startsWith("-")) {
      const v = num(text.slice(1));
      if (v == null) return null;
      nextMax = v;
    } else if (text.includes("-")) {
      const [a, b] = text.split("-");
      const va = num(a);
      const vb = num(b);
      if (va == null || vb == null) return null;
      nextMin = Math.min(va, vb);
      nextMax = Math.max(va, vb);
    } else {
      const v = num(text);
      if (v == null) return null;
      nextMin = v;
      nextMax = v + 1;
    }
    nextMin = Math.max(lo, Math.min(hi, round(nextMin)));
    nextMax = Math.max(lo, Math.min(hi, round(nextMax)));
    if (nextMax - nextMin < gap) nextMax = Math.min(hi, nextMin + gap);
    if (nextMax - nextMin < gap) nextMin = Math.max(lo, nextMax - gap);
    return { min: nextMin, max: nextMax };
  };

  const commitDraft = () => {
    setEditing(false);
    const parsed = parseDraft(draft);
    if (!parsed) return;
    onChange(parsed.min <= lo + 1e-9 ? 0 : parsed.min, parsed.max >= hi - 1e-9 ? 0 : parsed.max);
  };

  const minFrac = posFrac(localMin);
  const maxFrac = posFrac(localMax);
  const minPct = minFrac * 100;
  const maxPct = maxFrac * 100;
  const sliceSpan = maxFrac - minFrac || 1;
  const atFloor = localMin <= lo + 1e-9;
  const atCeiling = localMax >= hi - 1e-9;
  const fmt = (v: number) => v.toFixed(1);
  const label = atFloor && atCeiling
    ? "Any"
    : atCeiling
      ? `${fmt(localMin)}+`
      : atFloor
        ? `≤ ${fmt(localMax)}`
        : `${fmt(localMin)}–${fmt(localMax)}`;

  // Same text rule as StarRatingBadge, keyed on the colour under the label
  // (the pill's visual centre), since the pill spans a slice of the spectrum.
  const midStars = (localMin + localMax) / 2;
  const centerStars = fracToStars((minFrac + maxFrac) / 2);
  const textColor = centerStars >= 6.5 ? "hsl(45, 100%, 70%)" : "hsl(200, 10%, 10%)";

  const pillPx = ((maxPct - minPct) / 100) * railPx;
  const labelPx = 12 + label.length * 6.2 + 16;
  const showText = pillPx >= labelPx;
  const showStar = pillPx >= 26;

  const handleClass =
    "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-[26px] w-4 cursor-ew-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70";

  return (
    <div className="flex items-center gap-3 w-[280px] max-w-full">
      <div
        ref={railRef}
        className="relative h-[26px] flex-1 min-w-[140px] touch-none select-none"
        onPointerDown={onRailDown}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="absolute top-1/2 -translate-y-1/2 inset-x-0 h-[3px] rounded-full opacity-30"
          style={{ background: starSpectrumGradient(lo, hi, posFrac) }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 h-[22px] rounded-full flex items-center justify-center gap-1 overflow-hidden whitespace-nowrap text-[11px] font-bold leading-none tabular-nums"
          style={{
            left: `${minPct}%`,
            width: `${maxPct - minPct}%`,
            background: starSpectrumGradient(localMin, localMax, (stars) => (posFrac(stars) - minFrac) / sliceSpan),
            color: textColor,
            boxShadow: "0 0 0 1px rgba(255,255,255,0.15), 0 1px 4px rgba(0,0,0,0.4)",
            cursor: dragging === "body" ? "grabbing" : "grab",
          }}
          onPointerDown={beginDrag("body")}
        >
          {showStar && (
            <svg viewBox="0 0 24 24" className="h-[9px] w-[9px] shrink-0" fill="currentColor" aria-hidden="true">
              <path d={STAR_PATH} />
            </svg>
          )}
          {showText && label}
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label={t`${ariaLabel} minimum`}
          aria-valuemin={lo}
          aria-valuemax={hi}
          aria-valuenow={localMin}
          aria-valuetext={`${fmt(localMin)} stars`}
          className={handleClass}
          style={{ left: `${minPct}%`, zIndex: 3 }}
          onPointerDown={beginDrag("min")}
          onKeyDown={onHandleKey("min")}
          onKeyUp={onHandleKeyUp}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-label={t`${ariaLabel} maximum`}
          aria-valuemin={lo}
          aria-valuemax={hi}
          aria-valuenow={localMax}
          aria-valuetext={`${fmt(localMax)} stars`}
          className={handleClass}
          style={{ left: `${maxPct}%`, zIndex: 3 }}
          onPointerDown={beginDrag("max")}
          onKeyDown={onHandleKey("max")}
          onKeyUp={onHandleKeyUp}
        />
      </div>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDraft();
            else if (e.key === "Escape") setEditing(false);
          }}
          placeholder="3.6-6.7"
          aria-label={t`${ariaLabel} range`}
          className="shrink-0 w-24 bg-transparent text-[11px] font-semibold tabular-nums text-osu-l2 border-b border-osu-b3 outline-none focus:border-osu-pink placeholder:text-osu-f1/30"
        />
      ) : (
        <span className="shrink-0 w-24 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setDraft(
                atFloor && atCeiling
                  ? ""
                  : atCeiling
                    ? `${fmt(localMin)}+`
                    : atFloor
                      ? `<${fmt(localMax)}`
                      : `${fmt(localMin)}-${fmt(localMax)}`,
              );
              setEditing(true);
            }}
            title={t`Type a range: 3.6-6.7, 5+, <4`}
            className={`text-left text-[11px] font-semibold tabular-nums cursor-text transition-[filter,color] ${active ? "hover:brightness-125" : "text-osu-f1/55 hover:text-osu-f1"}`}
            style={active ? { color: starRatingColor(Math.min(midStars, 6)) } : undefined}
          >
            {label}
          </button>
          {active && (
            <button
              type="button"
              onClick={() => onChange(0, 0)}
              title={t`Clear`}
              className="text-[11px] font-semibold text-osu-f1/50 hover:text-osu-pink-light cursor-pointer"
            >
              ✕
            </button>
          )}
        </span>
      )}
    </div>
  );
}
