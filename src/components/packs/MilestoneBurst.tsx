import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import type { RgbaColor } from "../player/maniacard3d/types";

interface MilestoneBurstProps {
  glowColor: RgbaColor;
  /* Split around the card the way EternalBurst is: "behind" mounts under the
     card (the dim, the sunburst, the rings, the halo), "front" over it (the
     counter, the flash, the falling gold). */
  layer?: "behind" | "front";
  /* Where the counter rolls. In the reveal-all finale the card is hidden
     until the impact, so the number takes its place in the centre; in the
     one-at-a-time reveal the card is already face up, so it rolls above. */
  counter?: "center" | "above";
  /* The number the counter lands on. */
  target?: number;
}

interface Fleck {
  id: number;
  x: number;
  width: number;
  height: number;
  delay: number;
  duration: number;
  drift: number;
  spin: number;
  color: string;
}

interface Sparkle {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
}

/* Timing, shared with playMilestoneFanfare so the picture lands on the sound:
   the counter rolls for COUNT_S, the number locks and the impact lands, then
   the gold falls through the resolve. */
export const MILESTONE_COUNT_S = 1.7;
export const MILESTONE_IMPACT_S = 1.8;
const TOTAL_S = 4.6;
const AFTER_IMPACT_S = TOTAL_S - MILESTONE_IMPACT_S;
export const MILESTONE_CEREMONY_MS = TOTAL_S * 1000;

const CARD_CLEAR_PX = 190;
const CARD_FALLOFF_PX = 300;

const GOLDS = ["#fff3b0", "#f6c343", "#e0a422", "#b8860b", "#ffe680"];

/* The counter: rolls from zero and slows into the target, the way a tally
   lands, then holds. Driven by requestAnimationFrame rather than a spring so
   the digits keep changing right up to the lock. */
function RollingCount({ target }: { target: number }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let frame = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / (MILESTONE_COUNT_S * 1000));
      // Fast out of the gate, braking hard into the number.
      const eased = 1 - Math.pow(1 - progress, 4);
      setValue(Math.round(target * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return <>{value.toLocaleString("en-US")}</>;
}

/* The millionth pack. The Eternal ceremony is violet and slow-burning; this
   one is a tally landing on a round number and the room turning gold.

   Three movements against the fanfare. Count: the page dims and the number
   rolls up over a slowly turning sunburst while ticks accelerate under it.
   Impact: the number locks, a flash, two rings off the card, the sunburst
   snapping bright. Resolve: gold falls past the card, sparkles pop around it,
   the dark bleeds off. As with the Eternal, everything bright is behind the
   card or masked away from it; only the falling gold crosses it.

   The caller only mounts this when reduced motion is off. */
export function MilestoneBurst({ glowColor, layer = "front", counter = "center", target = 1_000_000 }: MilestoneBurstProps) {
  const gold = `rgb(${glowColor.r}, ${glowColor.g}, ${glowColor.b})`;
  const rgb = `${glowColor.r},${glowColor.g},${glowColor.b}`;
  const behind = layer === "behind";

  const flecks = useMemo<Fleck[]>(
    () =>
      behind
        ? []
        : Array.from({ length: 64 }, (_, index) => ({
            id: index,
            x: (Math.random() - 0.5) * 760,
            width: 4 + Math.random() * 6,
            height: 8 + Math.random() * 14,
            delay: MILESTONE_IMPACT_S + Math.random() * 1.1,
            duration: 1.7 + Math.random() * 1.1,
            drift: (Math.random() - 0.5) * 120,
            spin: 360 + Math.random() * 540,
            color: GOLDS[index % GOLDS.length],
          })),
    [behind],
  );

  const sparkles = useMemo<Sparkle[]>(
    () =>
      behind
        ? []
        : Array.from({ length: 10 }, (_, index) => {
            const angle = (index / 10) * Math.PI * 2 + Math.random() * 0.5;
            const distance = 210 + Math.random() * 150;
            return {
              id: index,
              x: Math.cos(angle) * distance,
              y: Math.sin(angle) * distance * 0.8,
              size: 14 + Math.random() * 18,
              delay: MILESTONE_IMPACT_S + 0.05 + Math.random() * 0.7,
            };
          }),
    [behind],
  );

  const cardCutout = `radial-gradient(circle at center, transparent 0px, transparent ${CARD_CLEAR_PX}px, black ${CARD_FALLOFF_PX}px)`;
  const sunburst = `repeating-conic-gradient(from 0deg, rgba(${rgb},0.55) 0deg 6deg, rgba(${rgb},0) 6deg 20deg)`;

  if (behind) {
    return (
      <div className="pointer-events-none absolute inset-0 z-[5] overflow-visible" aria-hidden="true">
        <motion.div
          className="fixed inset-0 bg-black"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.7, 0.72, 0.45, 0] }}
          transition={{
            duration: TOTAL_S,
            times: [0, 0.18, MILESTONE_IMPACT_S / TOTAL_S, 0.72, 1],
            ease: "easeInOut",
          }}
        />

        {/* The sunburst: dim and turning slowly through the count, snapping
            bright on the impact and turning faster through the resolve.
            Masked out of the card's footprint. */}
        <motion.div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 1500,
            height: 1500,
            background: sunburst,
            maskImage: `radial-gradient(circle, black 0%, black 30%, transparent 62%), ${cardCutout}`,
            WebkitMaskImage: `radial-gradient(circle, black 0%, black 30%, transparent 62%), ${cardCutout}`,
            maskComposite: "intersect",
            WebkitMaskComposite: "source-in",
            mixBlendMode: "screen",
          }}
          initial={{ opacity: 0, rotate: 0, scale: 0.9 }}
          animate={{ opacity: [0, 0.22, 0.28, 0.85, 0.6, 0], rotate: 70, scale: [0.9, 1, 1, 1.12, 1.16, 1.2] }}
          transition={{
            duration: TOTAL_S,
            times: [0, 0.12, MILESTONE_IMPACT_S / TOTAL_S - 0.005, MILESTONE_IMPACT_S / TOTAL_S + 0.03, 0.75, 1],
            ease: "easeInOut",
          }}
        />

        {/* Two rings off the impact, the second a beat behind the first. */}
        {[0, 0.14].map((stagger, ring) => (
          <motion.div
            key={ring}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: 320,
              height: 320,
              border: `${3 - ring}px solid ${gold}`,
              boxShadow: `0 0 ${28 - ring * 8}px rgba(${rgb},0.65)`,
            }}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: [0, 0.8, 0], scale: 3.6 - ring * 0.6 }}
            transition={{ duration: 1.3, delay: MILESTONE_IMPACT_S + stagger, ease: [0.1, 0.75, 0.25, 1] }}
          />
        ))}

        {/* The warm halo the card stands in once the number has landed. */}
        <motion.div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 820,
            height: 820,
            background: `radial-gradient(circle, rgba(${rgb},0) 20%, rgba(${rgb},0.48) 40%, rgba(${rgb},0.16) 60%, rgba(${rgb},0) 74%)`,
          }}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: [0, 1, 0.75, 0.85, 0], scale: [0.6, 1.05, 1, 1.05, 1.25] }}
          transition={{ duration: AFTER_IMPACT_S, delay: MILESTONE_IMPACT_S, times: [0, 0.08, 0.4, 0.7, 1], ease: "easeInOut" }}
        />
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-visible" aria-hidden="true">
      {/* The tally. Rolls through the count, locks on the impact with one
          hard scale hit, then fades as the card takes over. */}
      <motion.div
        className="absolute left-1/2 top-1/2 whitespace-nowrap text-center font-black tabular-nums"
        style={{
          x: "-50%",
          y: counter === "above" ? "calc(-50% - 280px)" : "-50%",
          fontSize: counter === "above" ? 44 : 64,
          lineHeight: 1,
          color: "#fff6cc",
          textShadow: `0 0 18px rgba(${rgb},0.9), 0 0 48px rgba(${rgb},0.6), 0 2px 0 rgba(120,80,0,0.6)`,
          letterSpacing: "0.02em",
        }}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{
          opacity: [0, 1, 1, 1, 0],
          scale: [0.8, 1, 1, 1.28, 1.1],
        }}
        transition={{
          duration: MILESTONE_IMPACT_S + 1.3,
          times: [0, 0.08, MILESTONE_COUNT_S / (MILESTONE_IMPACT_S + 1.3), MILESTONE_IMPACT_S / (MILESTONE_IMPACT_S + 1.3), 1],
          ease: "easeOut",
        }}
      >
        <RollingCount target={target} />
      </motion.div>

      {/* The flash on the lock. */}
      <motion.div
        className="fixed inset-0"
        style={{
          background: `radial-gradient(circle at center, rgba(255,250,225,0.9) 0%, rgba(${rgb},0.55) 30%, rgba(${rgb},0) 62%)`,
          mixBlendMode: "screen",
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.95, 0] }}
        transition={{ duration: 0.4, delay: MILESTONE_IMPACT_S, times: [0, 0.12, 1], ease: "easeOut" }}
      />

      {/* Sparkles popping around the card after the lock. */}
      {sparkles.map((sparkle) => (
        <motion.svg
          key={sparkle.id}
          className="absolute left-1/2 top-1/2"
          width={sparkle.size}
          height={sparkle.size}
          viewBox="0 0 24 24"
          style={{ marginLeft: -sparkle.size / 2, marginTop: -sparkle.size / 2, x: sparkle.x, y: sparkle.y }}
          initial={{ opacity: 0, scale: 0, rotate: 0 }}
          animate={{ opacity: [0, 1, 0], scale: [0, 1.15, 0.2], rotate: 90 }}
          transition={{ duration: 0.9, delay: sparkle.delay, ease: "easeOut" }}
        >
          <path d="M12 0 L14.2 9.8 L24 12 L14.2 14.2 L12 24 L9.8 14.2 L0 12 L9.8 9.8 Z" fill="#fff6cc" />
        </motion.svg>
      ))}

      {/* Gold falling past the card through the resolve. */}
      {flecks.map((fleck) => (
        <motion.div
          key={fleck.id}
          className="absolute left-1/2 top-1/2"
          style={{
            width: fleck.width,
            height: fleck.height,
            borderRadius: 2,
            background: `linear-gradient(180deg, ${fleck.color}, rgba(${rgb},0.85))`,
            boxShadow: `0 0 6px rgba(${rgb},0.6)`,
          }}
          initial={{ x: fleck.x, y: -420, opacity: 0, rotate: 0, scale: 0.6 }}
          animate={{
            x: fleck.x + fleck.drift,
            y: 420,
            opacity: [0, 1, 1, 0],
            rotate: fleck.spin,
            scale: [0.6, 1, 1, 0.8],
          }}
          transition={{ duration: fleck.duration, delay: fleck.delay, ease: [0.3, 0, 0.7, 1] }}
        />
      ))}
    </div>
  );
}
