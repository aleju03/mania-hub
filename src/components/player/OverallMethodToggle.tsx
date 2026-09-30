import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { useLingui } from "@lingui/react/macro";
import { setOverallMethod, useOverallMethod, type OverallMethod } from "../../lib/overall-method";

// Etterna's mark, from its MIT-licensed repo (public/licenses/etterna.txt):
// the E with its corner cut, and the triangle that fills the cut. The
// triangle goes lavender so it still reads on the purple coin.
const ETTERNA_PURPLE = "#805faf";

function EtternaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="40 20 176 216" className={className} aria-hidden="true">
      <path fill="#fff" d="M195.3 78.7V39.2h-63.6l-70.4 70.4V216h134v-39.5h-82.4v-28.9h72.3v-40.1h-72.3V78.7z" />
      <path fill="#d9c8f2" d="M61.3 39.2h49.8L61.3 88.9z" />
    </svg>
  );
}

// The Classic face is the site's own logo, for the Overall it showed before,
// turned from its built-in pink (hue 333, the default theme) to the reader's
// theme the way the home page tints its backdrop.
const CLASSIC_LOGO_SRC = "/images/favicon-256.png";
const CLASSIC_LOGO_FILTER = "hue-rotate(calc((var(--theme-hue) - 333) * 1deg)) saturate(var(--theme-sat))";

const WORD_HEIGHT = 14;
const BURST_COUNT = 7;

// A handful of the destination's shapes thrown off the coin on a flip: the
// logo's triangle going to Etterna, arrowheads going to Classic.
function Burst({ to, onDone }: { to: OverallMethod; onDone: () => void }) {
  const [pieces] = useState(() => Array.from({ length: BURST_COUNT }, (_, index) => {
    const angle = (index / BURST_COUNT) * Math.PI * 2 + Math.random() * 0.6;
    const distance = 17 + Math.random() * 9;
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, spin: (Math.random() - 0.5) * 320, size: 4 + Math.random() * 3 };
  }));
  return (
    <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2">
      {pieces.map((piece, index) => (
        <motion.i
          key={index}
          className="absolute block"
          style={{
            width: piece.size,
            height: piece.size,
            marginLeft: -piece.size / 2,
            marginTop: -piece.size / 2,
            background: to === "etterna" ? ETTERNA_PURPLE : "var(--color-osu-pink)",
            clipPath: to === "etterna" ? "polygon(0 0, 100% 0, 0 100%)" : "polygon(0 0, 100% 50%, 0 100%)",
          }}
          initial={{ x: 0, y: 0, rotate: 0, scale: 1.2, opacity: 1 }}
          animate={{ x: piece.x, y: piece.y, rotate: piece.spin, scale: 0.4, opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          onAnimationComplete={index === 0 ? onDone : undefined}
        />
      ))}
    </span>
  );
}

// Etterna | Classic beside an Overall number, so a reader whose number moved
// when the headline switched to Etterna's method can see the one they had.
// One preference for every surface that shows it. The method is a coin: a
// click flips it, throws off a few of the new side's shapes, and rolls the
// word, while every Overall on the page rolls to the other value.
export function OverallMethodToggle({ keyCount, className = "" }: { keyCount: number; className?: string }) {
  const { t } = useLingui();
  const method = useOverallMethod();
  const reduceMotion = useReducedMotion();
  const classic = method === "classic";

  // One spring from 0 (Etterna face) to 1 (Classic face) drives the flip, the
  // pop and the word, so spamming it retargets instead of queueing. Hover
  // leans the coin a little toward its other side.
  // It starts on the side already chosen: jumping there from an effect lost
  // the update to StrictMode's remount, which cancels a scheduled frame.
  const progress = useSpring(classic ? 1 : 0, { stiffness: 260, damping: 22 });
  const lean = useSpring(0, { stiffness: 400, damping: 24 });
  const rotateY = useTransform([progress, lean], ([face, tilt]: number[]) => (face + tilt) * 180);
  const hovering = useRef(false);
  const leanToward = (from: OverallMethod) => lean.set(hovering.current && !reduceMotion ? (from === "classic" ? -0.09 : 0.09) : 0);
  const scale = useTransform(progress, (value) => 1 + Math.sin(Math.min(1, Math.max(0, value)) * Math.PI) * 0.22);
  const wordY = useTransform(progress, (value) => -value * WORD_HEIGHT);
  useEffect(() => {
    if (reduceMotion) progress.jump(classic ? 1 : 0);
    else progress.set(classic ? 1 : 0);
  }, [classic, reduceMotion, progress]);

  const [bursts, setBursts] = useState<Array<{ id: number; to: OverallMethod }>>([]);
  const burstId = useRef(0);
  const flip = () => {
    const next: OverallMethod = classic ? "etterna" : "classic";
    setOverallMethod(next);
    leanToward(next);
    if (reduceMotion) return;
    burstId.current += 1;
    const id = burstId.current;
    setBursts((current) => [...current.slice(-2), { id, to: next }]);
  };

  // Best 6 of 7 where MinaCalc rates Technical, best 5 of 6 elsewhere.
  const best = keyCount === 4 || keyCount === 5 ? 6 : 5;
  const title = classic
    ? t`The previous Overall, which follows the hardest plays in any skillset.`
    : t`The average of the best ${best} skillsets as Etterna rates players, with LN added as one more skillset.`;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={classic}
      aria-label={t`Overall method`}
      title={title}
      onClick={flip}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        hovering.current = true;
        leanToward(method);
      }}
      onPointerLeave={() => {
        hovering.current = false;
        leanToward(method);
      }}
      className={`group inline-flex cursor-pointer select-none items-center gap-2 ${className}`}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-f1 transition-colors group-hover:text-osu-l2">
        {t({ message: "Method", context: "overall rating method" })}
      </span>
      <motion.span className="relative h-[22px] w-[22px] shrink-0" whileTap={reduceMotion ? undefined : { scale: 0.86 }}>
        <motion.span
          className="absolute inset-0 block"
          style={{ rotateY, scale, transformPerspective: 220, transformStyle: "preserve-3d" }}
        >
          <span className="absolute inset-0 grid place-items-center rounded-full [backface-visibility:hidden]" style={{ background: ETTERNA_PURPLE }}>
            <EtternaMark className="h-[13px] w-[13px]" />
          </span>
          {/* The filter sits on the inner image so the face itself stays a
              plain 3D participant and its backface still hides. */}
          <span className="absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]">
            <img
              src={CLASSIC_LOGO_SRC}
              alt=""
              draggable={false}
              className="h-full w-full rounded-full"
              style={{ filter: CLASSIC_LOGO_FILTER }}
            />
          </span>
        </motion.span>
        {bursts.map((burst) => (
          <Burst key={burst.id} to={burst.to} onDone={() => setBursts((current) => current.filter((entry) => entry.id !== burst.id))} />
        ))}
      </motion.span>
      <span className="block overflow-hidden text-[11px] font-semibold uppercase leading-[14px] tracking-wide" style={{ height: WORD_HEIGHT }}>
        <motion.span className="block" style={{ y: wordY }}>
          <span className="block text-[#b89be0] transition-[filter] group-hover:brightness-125">{t`Etterna`}</span>
          <span className="block text-osu-pink-light transition-[filter] group-hover:brightness-110">{t({ message: "Classic", context: "overall rating method" })}</span>
        </motion.span>
      </span>
    </button>
  );
}

// An Overall that rolls to its new value instead of swapping, so flipping the
// method reads as the number moving. Server-rendered at its value. Torus has
// proportional digits, so the rolling text would change width every frame and
// shove whatever sits after it; the box takes the final value's width once and
// the rolling text is drawn over it.
export function RollingOverall({ value, className }: { value: number; className?: string }) {
  const reduceMotion = useReducedMotion();
  const shown = useMotionValue(value);
  const text = useTransform(shown, (current) => current.toFixed(2));
  useEffect(() => {
    if (reduceMotion) {
      shown.set(value);
      return;
    }
    const controls = animate(shown, value, { duration: 0.55, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [value, reduceMotion, shown]);
  return (
    <span className={`relative inline-block whitespace-nowrap ${className ?? ""}`}>
      <span className="invisible">{value.toFixed(2)}</span>
      <motion.span className="absolute left-0 top-0">{text}</motion.span>
    </span>
  );
}
