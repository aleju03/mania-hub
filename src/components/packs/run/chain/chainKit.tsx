import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { motion, type MotionStyle } from "framer-motion";

/* The chain run's drawn pieces, all grown from its one mechanic: cards
   linking along arcs. The score is two rings bridged by an arc that fills
   toward the target, the round a medallion whose rings count rows and
   redraws, buttons capsules joined by chain links, prices cream tags.
   Numbers are marker-written; lines are cream on a dark ground. */

export const KIT = {
  cream: "#f3e9d8",
  dark: "#120c18",
  /* The site theme's colour (--overjoy-accent), Overjoy's pink by default.
     A CSS value: canvas drawing uses KIT_PINK_HEX. */
  pink: "var(--overjoy-accent, #ff7ab8)",
  gold: "#ffd36b",
  blue: "#7fc4ff",
  mint: "#9df0d6",
  red: "#ff6b6b",
  dim: "rgba(243,233,216,0.3)",
} as const;

export const KIT_PINK_HEX = "#ff7ab8";

/* The accent at `percent` opacity. */
export function kitPinkAlpha(percent: number): string {
  return `color-mix(in srgb, ${KIT.pink} ${percent}%, transparent)`;
}

export const MARKER = '"Name Permanent Marker", var(--font-sans)';

export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const rad = (a: number) => (a * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0));
  const y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1));
  const y1 = cy + r * Math.sin(rad(a1));
  const large = (((a1 - a0) % 360) + 360) % 360 > 180 ? 1 : 0;
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/* The round in a medallion: the inner ring is cut into one segment per row
   of the round (lit while left), the outer into one per redraw. */
export function RoundMedallion({
  size,
  rowsLeft,
  rowsTotal,
  redrawsLeft,
  redrawsTotal,
  label,
  children,
}: {
  size: number;
  rowsLeft: number;
  rowsTotal: number;
  redrawsLeft: number;
  redrawsTotal: number;
  label: ReactNode;
  children: ReactNode;
}) {
  const c = size / 2;
  const core = size * 0.31;
  const rowsR = size * 0.385;
  const drawsR = size * 0.465;
  const segments = (total: number, r: number, gap: number) =>
    Array.from({ length: total }, (_, index) => {
      const span = 360 / total;
      const a0 = -90 + index * span + gap / 2;
      return arcPath(c, c, r, a0, a0 + span - gap);
    });
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 overflow-visible" aria-hidden="true">
        {segments(rowsTotal, rowsR, 14).map((d, index) => (
          <motion.path
            key={`r${index}`}
            d={d}
            fill="none"
            strokeLinecap="round"
            strokeWidth={size * 0.058}
            initial={false}
            animate={{ opacity: index < rowsLeft ? 1 : 0.6 }}
            style={{ stroke: index < rowsLeft ? KIT.pink : KIT.dim, transition: "stroke 0.3s", filter: index < rowsLeft ? `drop-shadow(0 0 4px ${KIT.pink})` : undefined }}
          />
        ))}
        {segments(redrawsTotal, drawsR, 22).map((d, index) => (
          <motion.path
            key={`d${index}`}
            d={d}
            fill="none"
            strokeLinecap="round"
            strokeWidth={size * 0.032}
            initial={false}
            animate={{ stroke: index < redrawsLeft ? KIT.blue : KIT.dim }}
          />
        ))}
        <circle cx={c} cy={c} r={core} fill={KIT.dark} stroke={KIT.cream} strokeWidth={Math.max(2, size * 0.02)} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="font-black uppercase leading-none text-[#f3e9d8]/60" style={{ fontSize: Math.max(7, size * 0.064), letterSpacing: "0.22em", marginBottom: size * 0.01 }}>
          {label}
        </div>
        <div className="leading-none text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: size * 0.3 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/* A point along the bridge's curve, for markers placed by share. */
function cubicAt(p0: number[], p1: number[], p2: number[], p3: number[], t: number): [number, number] {
  const u = 1 - t;
  const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
  const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
  return [x, y];
}

/* The score against the target: two rings (score left, target right)
   bridged by an arc. The bridge fills with the score, a fainter stretch
   shows what the arranged row would add, and it turns gold once the target
   falls. `star` puts Once Forgotten's 3x mark at the bridge's end, the
   target then a tick part of the way along. */
export function ScoreBridge({
  width,
  height,
  share,
  ghostShare,
  passed,
  ghostPassed,
  targetAt,
  star,
  flash,
  scoreNode,
  targetNode,
  scoreLabel,
  targetLabel,
  meterProps,
}: {
  width: number;
  height: number;
  share: number;
  ghostShare: number;
  passed: boolean;
  ghostPassed: boolean;
  targetAt: number;
  star: { ink: string; lit: boolean } | null;
  flash: number;
  scoreNode: ReactNode;
  targetNode: ReactNode;
  scoreLabel: ReactNode;
  targetLabel: ReactNode;
  meterProps?: Record<string, string>;
}) {
  const id = useId().replace(/:/g, "");
  const scoreR = height * 0.37;
  const targetR = height * 0.29;
  const cy = height * 0.6;
  const left = [scoreR + 4, cy];
  const right = [width - targetR - 4, cy];
  const p0 = [left[0] + scoreR * 0.74, cy - scoreR * 0.68];
  const p3 = [right[0] - targetR * 0.72, cy - targetR * 0.72];
  const p1 = [width * 0.36, -height * 0.04];
  const p2 = [width * 0.64, -height * 0.04];
  const d = `M${p0[0]} ${p0[1]} C ${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${p3[0]} ${p3[1]}`;
  const band = Math.max(10, height * 0.15);
  const fill = passed ? "#ffb347" : KIT.pink;
  const ghost = ghostPassed ? "rgba(255,179,71,0.42)" : kitPinkAlpha(32);
  const lit = Math.max(0, Math.min(1, share)) * 100;
  const ghostLit = Math.max(lit, Math.min(1, ghostShare) * 100);
  const tick = star ? cubicAt(p0, p1, p2, p3, targetAt) : null;
  const end = cubicAt(p0, p1, p2, p3, 1);
  return (
    <div {...meterProps} className="relative" style={{ width, height }}>
      <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden="true">
        <defs>
          <path id={`b${id}`} d={d} />
        </defs>
        <use href={`#b${id}`} fill="none" stroke={KIT.dark} strokeWidth={band + 8} strokeLinecap="round" />
        <use href={`#b${id}`} fill="none" stroke={KIT.cream} strokeOpacity={0.14} strokeWidth={band + 8} strokeLinecap="round" />
        <motion.path
          d={d}
          fill="none"
          stroke={ghost}
          strokeWidth={band}
          strokeLinecap="round"
          pathLength={100}
          initial={false}
          animate={{ strokeDasharray: `${ghostLit} 100` }}
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
        />
        <motion.path
          d={d}
          fill="none"
          strokeWidth={band}
          strokeLinecap="round"
          pathLength={100}
          initial={false}
          animate={{ strokeDasharray: `${lit} 100`, opacity: lit > 0 ? 1 : 0 }}
          transition={{ type: "spring", stiffness: 160, damping: 24 }}
          style={{ stroke: fill, transition: "stroke 0.3s", filter: `drop-shadow(0 0 7px ${fill})` }}
        />
        <use href={`#b${id}`} fill="none" stroke={KIT.cream} strokeOpacity={0.45} strokeWidth={1.5} pathLength={100} strokeDasharray="0.6 4.4" />
        {flash > 0 && (
          <motion.path
            key={flash}
            d={d}
            fill="none"
            stroke="#ffd36b"
            strokeWidth={band + 10}
            strokeLinecap="round"
            initial={{ opacity: 0.95 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
          />
        )}
        {tick && <circle cx={tick[0]} cy={tick[1]} r={band * 0.42} fill={KIT.dark} stroke={KIT.cream} strokeWidth={2} />}
        {star && (
          <path
            transform={`translate(${end[0] - 9} ${end[1] - 26}) scale(0.9)`}
            d="M10 1 L12.6 7 L19 7.6 L14.1 11.8 L15.6 18.2 L10 14.8 L4.4 18.2 L5.9 11.8 L1 7.6 L7.4 7Z"
            fill={star.lit ? star.ink : "#6d6878"}
          />
        )}
        <circle cx={left[0]} cy={left[1]} r={scoreR} fill={KIT.dark} stroke={KIT.cream} strokeWidth={3} />
        <circle cx={left[0]} cy={left[1]} r={scoreR - 8} fill="none" stroke={fill} strokeOpacity={0.55} strokeWidth={2} />
        <circle cx={right[0]} cy={right[1]} r={targetR} fill={KIT.dark} stroke={KIT.cream} strokeWidth={3} />
        <circle cx={right[0]} cy={right[1]} r={targetR - 7} fill="none" stroke={KIT.gold} strokeOpacity={0.5} strokeWidth={2} />
      </svg>
      <div className="absolute flex flex-col items-center justify-center" style={{ left: left[0] - scoreR, top: cy - scoreR, width: scoreR * 2, height: scoreR * 2 }}>
        <div className="font-black uppercase leading-none text-[#f3e9d8]/60" style={{ fontSize: Math.max(7, height * 0.055), letterSpacing: "0.22em" }}>
          {scoreLabel}
        </div>
        {scoreNode}
      </div>
      <div className="absolute flex flex-col items-center justify-center" style={{ left: right[0] - targetR, top: cy - targetR, width: targetR * 2, height: targetR * 2 }}>
        <div className="font-black uppercase leading-none text-[#f3e9d8]/60" style={{ fontSize: Math.max(7, height * 0.05), letterSpacing: "0.2em" }}>
          {targetLabel}
        </div>
        {targetNode}
      </div>
    </div>
  );
}

/* The run's shard: the rendered gem. `turn` plays one full turn of it
   (a 36-frame sprite sheet) each time the value changes, so a shard count
   that moves catches the light. A gem with `turn` can also be grabbed and
   spun sideways: it coasts on the flick, slows, then settles back on its
   front face. */
const GEM_STILL = "/images/packs/run/gem-v1.webp";
const GEM_TURN = "/images/packs/run/gem-turn-v1.webp";
const GEM_FRAMES = 36;
/* Degrees of turn per pixel dragged. */
const GEM_DRAG = 1.6;

export function KitGem({ size = 24, turn }: { size?: number; turn?: number }) {
  const [spinning, setSpinning] = useState(false);
  /* Grabbed, or still coasting from a flick. */
  const [held, setHeld] = useState(false);
  const sprite = useRef<HTMLSpanElement>(null);
  const motionRef = useRef({ angle: 0, velocity: 0, x: 0, t: 0, dragging: false, raf: 0 });
  const first = useRef(true);
  useEffect(() => {
    if (turn === undefined) return;
    if (first.current) {
      first.current = false;
      return;
    }
    if (held || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setSpinning(true);
    const timer = window.setTimeout(() => setSpinning(false), 1000);
    return () => window.clearTimeout(timer);
    // A count that moves mid-spin doesn't restart the turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn]);
  useEffect(() => () => cancelAnimationFrame(motionRef.current.raf), []);

  const showFrame = () => {
    const el = sprite.current;
    if (!el) return;
    const step = 360 / GEM_FRAMES;
    const frame = (((Math.round(motionRef.current.angle / step) % GEM_FRAMES) + GEM_FRAMES) % GEM_FRAMES);
    el.style.backgroundPosition = `-${frame * size}px 0`;
  };
  /* Coasts on the release speed with friction, then eases onto the nearest
     whole turn and hands back to the still image. */
  const coast = () => {
    const m = motionRef.current;
    let last = performance.now();
    const tick = (now: number) => {
      if (m.dragging) return;
      const dt = Math.min(48, now - last);
      last = now;
      m.velocity *= Math.pow(0.94, dt / 16);
      if (Math.abs(m.velocity) > 0.08) {
        m.angle += m.velocity * dt;
      } else {
        const rest = Math.round(m.angle / 360) * 360;
        m.angle += (rest - m.angle) * Math.min(1, dt * 0.012);
        if (Math.abs(rest - m.angle) < 1.5) {
          m.angle = 0;
          m.velocity = 0;
          setHeld(false);
          return;
        }
      }
      showFrame();
      m.raf = requestAnimationFrame(tick);
    };
    m.raf = requestAnimationFrame(tick);
  };

  const sheet = { width: size, height: size, backgroundImage: `url(${GEM_TURN})`, backgroundSize: `${size * GEM_FRAMES}px ${size}px` };
  const face = held ? (
    <span ref={sprite} aria-hidden="true" className="inline-block shrink-0" style={sheet} />
  ) : spinning ? (
    <span aria-hidden="true" className="kit-gem-turn inline-block shrink-0" style={{ ...sheet, ["--gem-end" as string]: `-${size * GEM_FRAMES}px` }} />
  ) : (
    <img src={GEM_STILL} alt="" aria-hidden="true" draggable={false} className="shrink-0 select-none" style={{ width: size, height: size }} />
  );
  if (turn === undefined) return face;
  return (
    <span
      className="inline-flex shrink-0 cursor-grab select-none active:cursor-grabbing"
      style={{ touchAction: "none" }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A pointer the browser no longer tracks: the drag still works over the gem.
        }
        const m = motionRef.current;
        cancelAnimationFrame(m.raf);
        m.dragging = true;
        m.velocity = 0;
        m.x = event.clientX;
        m.t = performance.now();
        setSpinning(false);
        setHeld(true);
      }}
      onPointerMove={(event) => {
        const m = motionRef.current;
        if (!m.dragging) return;
        const now = performance.now();
        const delta = (event.clientX - m.x) * GEM_DRAG;
        const dt = Math.max(1, now - m.t);
        m.velocity = m.velocity * 0.6 + (delta / dt) * 0.4;
        m.angle += delta;
        m.x = event.clientX;
        m.t = now;
        showFrame();
      }}
      onPointerUp={() => {
        const m = motionRef.current;
        if (!m.dragging) return;
        m.dragging = false;
        // A hold that ended without moving lets go of its speed.
        if (performance.now() - m.t > 80) m.velocity = 0;
        coast();
      }}
      onPointerCancel={() => {
        motionRef.current.dragging = false;
        coast();
      }}
    >
      {face}
    </span>
  );
}

/* Button icons, drawn on a 42 x 42 grid. */
export function IconFan({ ink = KIT.pink, size = 30 }: { ink?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 42 44" aria-hidden="true" className="shrink-0 overflow-visible">
      <g strokeLinejoin="round" fill={KIT.dark} stroke={KIT.cream} strokeWidth={2.4}>
        <rect x={6} y={8} width={15} height={22} rx={2.5} transform="rotate(-18 14 30)" />
        <rect x={14} y={5} width={15} height={22} rx={2.5} />
        <rect x={22} y={8} width={15} height={22} rx={2.5} transform="rotate(18 29 30)" />
      </g>
      <path d="M8 35 Q 21 43 34 35" fill="none" stroke={ink} strokeWidth={2.8} strokeLinecap="round" />
      <circle cx={21} cy={39} r={3} fill={ink} />
    </svg>
  );
}

export function IconSwap({ ink = KIT.blue, size = 30 }: { ink?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 42 44" aria-hidden="true" className="shrink-0 overflow-visible">
      <g strokeLinejoin="round" strokeLinecap="round">
        <rect x={4} y={10} width={16} height={22} rx={2.5} fill={KIT.dark} stroke={KIT.cream} strokeWidth={2.4} transform="rotate(-10 12 21)" />
        <rect x={22} y={12} width={16} height={22} rx={2.5} fill={KIT.dark} stroke={KIT.cream} strokeWidth={2.4} transform="rotate(10 30 23)" />
        <path d="M10 7 Q 21 -3 32 7" fill="none" stroke={ink} strokeWidth={2.8} />
        <path d="M28.5 3 L32 7 L27.5 8.6" fill="none" stroke={ink} strokeWidth={2.8} />
        <path d="M32 38 Q 21 48 10 38" fill="none" stroke={ink} strokeWidth={2.8} />
        <path d="M13.5 42 L10 38 L14.5 36.4" fill="none" stroke={ink} strokeWidth={2.8} />
      </g>
    </svg>
  );
}

export function IconCut({ ink = KIT.red, size = 30 }: { ink?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 42 44" aria-hidden="true" className="shrink-0 overflow-visible">
      <g strokeLinejoin="round" strokeLinecap="round">
        <rect x={12} y={6} width={18} height={26} rx={3} fill={KIT.dark} stroke={KIT.cream} strokeWidth={2.4} />
        <path d="M2 20 Q 6 14 12 16" fill="none" stroke={ink} strokeWidth={2.8} />
        <path d="M30 16 Q 36 14 40 20" fill="none" stroke={ink} strokeWidth={2.8} />
        <path d="M15 37 L27 25 M15 25 L27 37" stroke={ink} strokeWidth={2.8} />
      </g>
    </svg>
  );
}

export interface ChainButtonItem {
  key: string;
  label: ReactNode;
  /* Read out when the label is hidden (a phone shows side buttons as icons). */
  title: string;
  icon?: ReactNode;
  primary?: boolean;
  /* The side button's rim colour. */
  tone?: string;
  disabled?: boolean;
  active?: boolean;
  /* Nothing to act on yet: drawn quiet but still pressable. */
  muted?: boolean;
  /* A small count beside the main button's label (rows left, say). */
  sub?: ReactNode;
  /* A count bubble on the button's corner, for phones where `sub` and side
     labels do not fit. */
  badge?: ReactNode;
  style?: MotionStyle;
  onClick: () => void;
}

/* Capsules joined by chain links: the main action in the middle as the big
   pink one, the others dark with an icon. `compact` (phones) shows the side
   buttons as icons only. */
/* The primary button's face: the rendered pink enamel pill with its cream rim
   and embossed chain (3d-modelling/overjoy/build_button.py), in three pieces
   so its caps keep their shape at any width: the full render's 96px ends as
   caps, and its 144px middle (cropped to its own file) repeating whole links
   between them. The pieces overlap a pixel; a border-image's slices left
   hairline seams at the caps. */
const PRIMARY_FACE = "/images/packs/run/button-pink-full-v1.webp";
const PRIMARY_MIDDLE = "/images/packs/run/button-pink-mid-v1.webp";

/* The render is pink (hue 333, the site default); it turns to the site
   theme's hue, and greys with a grey theme. The cream rim barely moves. */
const PRIMARY_TINT = "hue-rotate(calc((var(--theme-hue) - 333) * 1deg)) saturate(var(--theme-sat))";

function PrimaryFace({ height }: { height: number }) {
  const cap = (side: "left" | "right") => (
    <span
      className="shrink-0"
      style={{
        width: height / 2 + 1,
        backgroundImage: `url(${PRIMARY_FACE})`,
        backgroundSize: `auto ${height}px`,
        backgroundPosition: `${side} top`,
        backgroundRepeat: "no-repeat",
        [side === "left" ? "marginRight" : "marginLeft"]: -1,
      }}
    />
  );
  return (
    <span aria-hidden="true" className="pointer-events-none absolute -inset-[3px] -z-10 flex" style={{ filter: PRIMARY_TINT }}>
      {cap("left")}
      <span className="min-w-0 flex-1" style={{ backgroundImage: `url(${PRIMARY_MIDDLE})`, backgroundSize: `auto ${height}px`, backgroundRepeat: "round no-repeat" }} />
      {cap("right")}
    </span>
  );
}
const CHAIN_LINK = { front: "/images/packs/run/link-front-v1.webp", side: "/images/packs/run/link-side-v1.webp" };

export function ChainButtons({ items, compact = false, big = false }: { items: ChainButtonItem[]; compact?: boolean; big?: boolean }) {
  /* The rendered chain between buttons: an open link lying flat, one turned
     edge-on through it, and another flat one, tucked behind the buttons. */
  const link = (key: string) => {
    const size = compact ? 26 : 34;
    const ring = (src: string, index: number) => (
      <img
        key={index}
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none select-none"
        style={{ width: size, height: size, transform: "rotate(90deg)", margin: `0 ${-size * 0.3}px` }}
      />
    );
    return (
      <span key={key} aria-hidden="true" className="relative z-0 -mx-1.5 flex shrink-0 items-center">
        {[CHAIN_LINK.front, CHAIN_LINK.side, CHAIN_LINK.front].map(ring)}
      </span>
    );
  };
  const out: ReactNode[] = [];
  items.forEach((item, index) => {
    if (index > 0) out.push(link(`l${item.key}`));
    const height = item.primary ? (compact ? 50 : big ? 74 : 64) : compact ? 44 : 54;
    out.push(
      <motion.button
        key={item.key}
        type="button"
        title={item.title}
        aria-label={item.title}
        disabled={item.disabled}
        onClick={item.onClick}
        whileTap={item.disabled ? undefined : { scale: 0.95, y: 2 }}
        className="relative z-[1] inline-flex shrink-0 items-center justify-center gap-2 rounded-full border-[3px] leading-none transition-[filter] hover:brightness-110 disabled:cursor-default disabled:brightness-50 disabled:saturate-50 disabled:hover:brightness-50"
        style={{
          ...item.style,
          height,
          padding: item.primary ? `0 ${compact ? 22 : big ? 40 : 32}px` : compact ? "0 10px" : "0 18px 0 12px",
          background: item.primary && !item.muted ? "transparent" : item.active ? KIT.pink : KIT.dark,
          borderColor: item.primary ? (item.muted ? "rgba(243,233,216,0.4)" : "transparent") : item.active ? KIT.cream : item.tone ?? KIT.cream,
          // The face's centre sits a little above the middle; the side wall is below it.
          ...(item.primary && !item.muted ? { paddingBottom: Math.round(height * 0.06) } : {}),
          color: (item.primary && !item.muted) || item.active ? KIT.dark : item.muted ? "rgba(243,233,216,0.5)" : KIT.cream,
          fontFamily: MARKER,
          fontSize: item.primary ? (compact ? 20 : big ? 28 : 25) : compact ? 15 : 19,
          boxShadow: item.primary && !item.muted ? undefined : "0 5px 0 rgba(0,0,0,0.45)",
        }}
      >
        {item.primary && !item.muted && <PrimaryFace height={height} />}
        {item.icon}
        {compact && item.badge !== undefined && (
          <span
            className="absolute -right-1.5 -top-1.5 grid h-[20px] min-w-[20px] place-items-center rounded-full border-2 px-1 font-sans text-[11px] font-black leading-none"
            style={{ background: KIT.dark, borderColor: item.tone ?? KIT.cream, color: item.tone ?? KIT.cream }}
          >
            {item.badge}
          </span>
        )}
        {(!compact || item.primary || !item.icon) &&
          (item.sub ? (
            <span className="flex items-center gap-3">
              <span className="whitespace-nowrap">{item.label}</span>
              <span className="flex items-center gap-1 whitespace-nowrap font-sans text-[10px] font-black uppercase leading-none tracking-[0.12em] opacity-70">{item.sub}</span>
            </span>
          ) : (
            <span className="whitespace-nowrap">{item.label}</span>
          ))}
      </motion.button>,
    );
  });
  return <div className="flex items-center">{out}</div>;
}

/* A cream price tag with a punched hole: the gem and the price. */
export function PriceTag({ price, affordable = true }: { price: ReactNode; affordable?: boolean }) {
  return (
    <span
      className="relative inline-flex items-center gap-1.5 py-1 pl-6 pr-3 leading-none"
      style={{
        background: affordable ? KIT.cream : "#a59d92",
        color: KIT.dark,
        clipPath: "polygon(14px 0, 100% 0, 100% 100%, 14px 100%, 0 50%)",
        fontFamily: MARKER,
        fontSize: 22,
        filter: "drop-shadow(0 3px 0 rgba(0,0,0,0.4))",
      }}
    >
      <span className="absolute left-[11px] top-1/2 h-[9px] w-[9px] -translate-y-1/2 rounded-full" style={{ background: KIT.dark }} />
      <KitGem size={20} />
      {price}
    </span>
  );
}

/* An empty row slot: a card-shaped socket with a ring on top where its
   links attach; the next one to fill stands out. */
export function RowSocket({ width, height, next, label }: { width: number; height: number; next: boolean; label: ReactNode }) {
  const n = Math.min(14, width * 0.1);
  const ring = Math.min(9, width * 0.07);
  const d = `M${n} 0 L${width - n} 0 L${width} ${n} L${width} ${height - n} L${width - n} ${height} L${n} ${height} L0 ${height - n} L0 ${n} Z`;
  const ink = next ? KIT.pink : "rgba(243,233,216,0.22)";
  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden="true">
        <path
          d={d}
          fill="rgba(10,6,14,0.42)"
          stroke={ink}
          strokeWidth={next ? 2.5 : 1.6}
          strokeDasharray={next ? undefined : "7 6"}
          style={next ? { filter: `drop-shadow(0 0 8px ${KIT.pink})` } : undefined}
        />
        {height > 60 && <circle cx={width / 2} cy={0} r={ring} fill={KIT.dark} stroke={ink} strokeWidth={2} />}
      </svg>
      <div className="absolute inset-x-0 bottom-[10%] text-center leading-none" style={{ fontFamily: MARKER, fontSize: Math.max(14, Math.min(26, width * 0.17)), color: ink }}>
        {label}
      </div>
    </div>
  );
}

/* The round's objective, numbers first: score "of" target, a hairline of
   progress under it with what the arranged row would add, a gold dot at the
   target. `star` stretches the line to Once Forgotten's 3x mark, the target
   then a tick along it. `flash` bumps when the chain carries the round past
   its target. */
export function ObjectiveLine({
  width,
  share,
  ghostShare,
  passed,
  ghostLabel,
  targetAt,
  star,
  flash,
  meterProps,
}: {
  width: number;
  share: number;
  ghostShare: number;
  passed: boolean;
  ghostLabel: ReactNode;
  targetAt: number;
  star: { ink: string; lit: boolean } | null;
  flash: number;
  meterProps?: Record<string, string>;
}) {
  const fill = passed ? "#ffb347" : KIT.pink;
  const lit = Math.max(0, Math.min(1, share));
  const ghost = Math.max(lit, Math.min(1, ghostShare));
  return (
    <div {...meterProps} className="relative h-[6px] rounded-full bg-[rgba(243,233,216,0.14)]" style={{ width }}>
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full"
        initial={false}
        animate={{ width: `${ghost * 100}%` }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
        style={{ backgroundColor: passed || ghostShare >= targetAt ? "rgba(255,179,71,0.4)" : kitPinkAlpha(35), transitionProperty: "background-color", transitionDuration: "0.3s" }}
      />
      <motion.div
        className="absolute inset-y-0 left-0 rounded-full"
        initial={false}
        animate={{ width: `${lit * 100}%` }}
        transition={{ type: "spring", stiffness: 160, damping: 24 }}
        style={{ backgroundColor: fill, boxShadow: `0 0 10px ${fill}`, transitionProperty: "background-color, box-shadow", transitionDuration: "0.3s" }}
      />
      {flash > 0 && (
        <motion.div
          key={flash}
          className="absolute -inset-y-[6px] inset-x-0 rounded-full bg-[#ffd36b]"
          initial={{ opacity: 0.9, scaleY: 1.4 }}
          animate={{ opacity: 0, scaleY: 1 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
        />
      )}
      {ghost > lit + 0.01 && (
        <div className="absolute top-[12px] -translate-x-1/2 whitespace-nowrap leading-none" style={{ left: `${Math.min(92, Math.max(8, ghost * 100))}%`, fontFamily: MARKER, fontSize: 16, color: kitPinkAlpha(85) }}>
          {ghostLabel}
        </div>
      )}
      {star && <div className="absolute -top-[4px] h-[14px] w-[3px] rounded bg-[#f3e9d8]/70" style={{ left: `${targetAt * 100}%` }} />}
      <div
        className="absolute -right-[7px] -top-[5px] h-4 w-4 rounded-full border-[3px]"
        style={{ background: KIT.dark, borderColor: star ? (star.lit ? star.ink : "#6d6878") : KIT.gold }}
      />
    </div>
  );
}

/* A held scene in the rendered gold medallion, its art round under the
   bezel's lip. */
const MEDALLION = "/images/packs/run/medallion-v1.webp";
export function SceneMedallion({ size, children }: { size: number; children: ReactNode }) {
  const hole = size * 0.476;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="absolute overflow-hidden rounded-full" style={{ left: size * 0.5 - hole / 2, top: size * 0.574 - hole / 2, width: hole, height: hole }}>
        <div className="grid h-full w-full place-items-center">{children}</div>
      </div>
      <img src={MEDALLION} alt="" aria-hidden="true" draggable={false} className="pointer-events-none absolute inset-0 select-none" style={{ width: size, height: size }} />
    </div>
  );
}
