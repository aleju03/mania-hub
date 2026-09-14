import { useLingui } from "@lingui/react/macro";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

// A range filter as a stretchable badge: the pill itself sits on a faint rail,
// its ends drag to set min/max and its body drags to shift the whole range.
// Values of 0 mean "unset" like RangeSlider, so the parent stores 0/0 for
// "any". Commits on release. The look (gradient, label format, icon, typed
// range hints) comes from the skin; StarRangePill and LnSharePill are the two.
export interface RangePillSkin {
  /** Rail position of a value, 0..1; linear when omitted. */
  posFrac?: (value: number) => number;
  /** Inverse of posFrac; linear when omitted. */
  fracToValue?: (frac: number) => number;
  /** Background for a value span, given a function from value to 0..1 across that span. */
  gradient: (
    from: number,
    to: number,
    frac: (value: number) => number,
  ) => string;
  /** Number as shown in the label and the typed range. */
  format: (value: number) => string;
  /** Screen reader value text. */
  valueText: (value: number) => string;
  /** Label colour inside the pill, keyed on the value under its centre. */
  textColor: (centerValue: number) => string;
  /** Colour of the label beside the rail while a range is set. */
  labelColor: (midValue: number) => string;
  /** Glyph inside the pill when it is wide enough. */
  icon?: ReactNode;
  /** A bare typed number selects [value, value + bucket]. */
  bucket: number;
  /** Characters the typed range may carry beside digits, e.g. a star or a percent sign. */
  decorations: RegExp;
  placeholder: string;
  typeHint: string;
}

interface Props {
  lo: number;
  hi: number;
  min: number;
  max: number;
  step: number;
  onChange: (min: number, max: number) => void;
  ariaLabel: string;
  skin: RangePillSkin;
  /** With a heading the pill takes two rows: heading + value on top, the rail full width below. */
  heading?: ReactNode;
}

type DragMode = "min" | "max" | "body";

export function RangePill({
  lo,
  hi,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  skin,
  heading,
}: Props) {
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
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startMin: number;
    startMax: number;
  } | null>(null);
  const liveRef = useRef({ min: localMin, max: localMax });
  const keyDirtyRef = useRef(false);

  const span = hi - lo || 1;
  const gap = step * 2;
  const round = (v: number) => Number((Math.round(v / step) * step).toFixed(4));
  const posFrac = skin.posFrac ?? ((value: number) => (value - lo) / span);
  const fracToValue = skin.fracToValue ?? ((frac: number) => lo + frac * span);
  const setMin = (v: number) => {
    liveRef.current.min = v;
    setLocalMin(v);
  };
  const setMax = (v: number) => {
    liveRef.current.max = v;
    setLocalMax(v);
  };

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

  const valueAt = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return lo;
    return fracToValue(
      Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    );
  };

  const commit = () => {
    const { min: m, max: x } = liveRef.current;
    onChange(m <= lo + 1e-9 ? 0 : m, x >= hi - 1e-9 ? 0 : x);
  };

  const beginDrag = (mode: DragMode) => (e: ReactPointerEvent) => {
    if (dragRef.current) return;
    // A full-span pill has nowhere to shift; let the press fall through to the
    // rail so the first drag on the resting "Any" pill grabs the nearest end.
    if (
      mode === "body" &&
      liveRef.current.min <= lo + 1e-9 &&
      liveRef.current.max >= hi - 1e-9
    )
      return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      startX: e.clientX,
      startMin: liveRef.current.min,
      startMax: liveRef.current.max,
    };
    setDragging(mode);
  };

  // Pressing the bare rail jumps the nearest end to the pointer and keeps dragging it.
  const onRailDown = (e: ReactPointerEvent) => {
    if (dragRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const value = round(Math.max(lo, Math.min(hi, valueAt(e.clientX))));
    const nearMin =
      Math.abs(value - liveRef.current.min) <=
      Math.abs(value - liveRef.current.max);
    if (nearMin) setMin(Math.min(value, liveRef.current.max - gap));
    else setMax(Math.max(value, liveRef.current.min + gap));
    dragRef.current = {
      mode: nearMin ? "min" : "max",
      startX: e.clientX,
      startMin: liveRef.current.min,
      startMax: liveRef.current.max,
    };
    setDragging(nearMin ? "min" : "max");
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = railRef.current?.getBoundingClientRect();
    const width = rect?.width || railPx;
    const deltaFrac = (e.clientX - drag.startX) / width;
    if (drag.mode === "min") {
      setMin(
        Math.max(
          lo,
          Math.min(
            round(fracToValue(posFrac(drag.startMin) + deltaFrac)),
            drag.startMax - gap,
          ),
        ),
      );
    } else if (drag.mode === "max") {
      setMax(
        Math.min(
          hi,
          Math.max(
            round(fracToValue(posFrac(drag.startMax) + deltaFrac)),
            drag.startMin + gap,
          ),
        ),
      );
    } else {
      const size = drag.startMax - drag.startMin;
      const nextMin = Math.max(
        lo,
        Math.min(
          round(fracToValue(posFrac(drag.startMin) + deltaFrac)),
          hi - size,
        ),
      );
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
    const delta =
      e.key === "ArrowLeft" || e.key === "ArrowDown"
        ? -1
        : e.key === "ArrowRight" || e.key === "ArrowUp"
          ? 1
          : 0;
    if (!delta) return;
    e.preventDefault();
    keyDirtyRef.current = true;
    const amount = delta * (e.shiftKey ? skin.bucket : step);
    if (mode === "min")
      setMin(
        Math.max(
          lo,
          Math.min(
            round(liveRef.current.min + amount),
            liveRef.current.max - gap,
          ),
        ),
      );
    else
      setMax(
        Math.min(
          hi,
          Math.max(
            round(liveRef.current.max + amount),
            liveRef.current.min + gap,
          ),
        ),
      );
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

  // Typed ranges: "3.6-6.7", "5+"/">5", "<4"/"≤4", a bare "5" = the 5..5+bucket
  // slice (osu-web's star filter buttons), ""/"any" = clear. Comma decimals accepted.
  const parseDraft = (raw: string): { min: number; max: number } | null => {
    const text = raw
      .replace(skin.decorations, "")
      .replace(/\s/g, "")
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
      nextMax = v + skin.bucket;
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
    onChange(
      parsed.min <= lo + 1e-9 ? 0 : parsed.min,
      parsed.max >= hi - 1e-9 ? 0 : parsed.max,
    );
  };

  const minFrac = posFrac(localMin);
  const maxFrac = posFrac(localMax);
  const minPct = minFrac * 100;
  const maxPct = maxFrac * 100;
  const sliceSpan = maxFrac - minFrac || 1;
  const atFloor = localMin <= lo + 1e-9;
  const atCeiling = localMax >= hi - 1e-9;
  const fmt = skin.format;
  const label =
    atFloor && atCeiling
      ? "Any"
      : atCeiling
        ? `${fmt(localMin)}+`
        : atFloor
          ? `≤ ${fmt(localMax)}`
          : `${fmt(localMin)}–${fmt(localMax)}`;

  // Text colour keyed on the colour under the label (the pill's visual
  // centre), since the pill spans a slice of the gradient.
  const midValue = (localMin + localMax) / 2;
  const centerValue = fracToValue((minFrac + maxFrac) / 2);
  const textColor = skin.textColor(centerValue);

  const pillPx = ((maxPct - minPct) / 100) * railPx;
  const labelPx = 12 + label.length * 6.2 + 16;
  const showText = pillPx >= labelPx;
  const showIcon = skin.icon != null && pillPx >= 26;

  const handleClass =
    "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-[26px] w-4 cursor-ew-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70";

  const rail = (
    <div
      ref={railRef}
      className={`relative h-[26px] touch-none select-none ${heading ? "w-full" : "flex-1 min-w-[140px]"}`}
      onPointerDown={onRailDown}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="absolute top-1/2 -translate-y-1/2 inset-x-0 h-[3px] rounded-full opacity-30"
        style={{ background: skin.gradient(lo, hi, posFrac) }}
      />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-[22px] rounded-full flex items-center justify-center gap-1 overflow-hidden whitespace-nowrap text-[11px] font-bold leading-none tabular-nums"
        style={{
          left: `${minPct}%`,
          width: `${maxPct - minPct}%`,
          background: skin.gradient(
            localMin,
            localMax,
            (value) => (posFrac(value) - minFrac) / sliceSpan,
          ),
          color: textColor,
          boxShadow:
            "0 0 0 1px rgba(255,255,255,0.15), 0 1px 4px rgba(0,0,0,0.4)",
          cursor: dragging === "body" ? "grabbing" : "grab",
        }}
        onPointerDown={beginDrag("body")}
      >
        {showIcon && skin.icon}
        {showText && label}
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={t`${ariaLabel} minimum`}
        aria-valuemin={lo}
        aria-valuemax={hi}
        aria-valuenow={localMin}
        aria-valuetext={skin.valueText(localMin)}
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
        aria-valuetext={skin.valueText(localMax)}
        className={handleClass}
        style={{ left: `${maxPct}%`, zIndex: 3 }}
        onPointerDown={beginDrag("max")}
        onKeyDown={onHandleKey("max")}
        onKeyUp={onHandleKeyUp}
      />
    </div>
  );
  const value = editing ? (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitDraft}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitDraft();
        else if (e.key === "Escape") setEditing(false);
      }}
      placeholder={skin.placeholder}
      aria-label={t`${ariaLabel} range`}
      className="shrink-0 w-24 bg-transparent text-[11px] font-semibold tabular-nums text-osu-l2 border-b border-osu-b3 outline-none focus:border-osu-pink placeholder:text-osu-f1/30"
    />
  ) : (
    <span
      className={`shrink-0 flex items-center gap-1.5 ${heading ? "justify-end" : "w-24"}`}
    >
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
        title={skin.typeHint}
        className={`text-left text-[11px] font-semibold tabular-nums cursor-text transition-[filter,color] ${active ? "hover:brightness-125" : "text-osu-f1/55 hover:text-osu-f1"}`}
        style={active ? { color: skin.labelColor(midValue) } : undefined}
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
  );

  if (heading) {
    return (
      <div className="flex w-full flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          {heading}
          {value}
        </div>
        {rail}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 w-[280px] max-w-full">
      {rail}
      {value}
    </div>
  );
}
