import { useEffect, useMemo, useState } from "react";
import { motion, useMotionValue } from "framer-motion";
import { useLingui } from "@lingui/react/macro";
import { PACK_ASPECT, PACK_TEAR_FRACTION } from "../../packArt";
import type { PackLook } from "../RunTable";

/* A chain pack on the table. Charging, it shudders harder and harder for
   `chargeMs`; torn, its top comes off as its own piece along a jagged line
   and flies away, a burst of scraps spraying from the tear, and the body
   drops away once the cards are out. */

const TEETH = 13;

/* The jagged tear line as x/y pairs in % of the pack, left to right. */
function tearLine(seed: number): Array<[number, number]> {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const base = PACK_TEAR_FRACTION * 100;
  return Array.from({ length: TEETH + 1 }, (_, index) => [
    (index / TEETH) * 100,
    base + (index % 2 === 0 ? -1 : 1) * (1.2 + rand() * 1.6),
  ]);
}

const SCRAPS = Array.from({ length: 14 }, (_, index) => {
  const angle = -Math.PI * (0.08 + (index / 13) * 0.84) + (index % 3) * 0.05;
  const reach = 70 + ((index * 37) % 60);
  return { dx: Math.cos(angle) * reach, dy: Math.sin(angle) * reach - 10, rotate: (index % 2 ? 1 : -1) * (120 + index * 23), w: 5 + (index % 4) * 2, light: index % 3 === 0 };
});

export function ChainPack({
  thumb,
  accent,
  look,
  height,
  chargeMs,
  disabled,
  reducedMotion,
  onOpen,
  packRef,
}: {
  thumb: string | null;
  accent: { r: number; g: number; b: number };
  look: PackLook;
  height: number;
  chargeMs: number;
  disabled: boolean;
  reducedMotion: boolean;
  onOpen: () => void;
  packRef: React.Ref<HTMLButtonElement>;
}) {
  const { t } = useLingui();
  const width = Math.round(height * PACK_ASPECT);
  const line = useMemo(() => tearLine(Math.round(height)), [height]);
  const fill = `rgb(${accent.r}, ${accent.g}, ${accent.b})`;
  const art: React.CSSProperties = thumb ? { backgroundImage: `url(${thumb})`, backgroundSize: "100% 100%" } : { background: fill };
  const topClip = `polygon(0% 0%, 100% 0%, ${line
    .slice()
    .reverse()
    .map(([x, y]) => `${x}% ${y}%`)
    .join(", ")})`;
  const bodyClip = `polygon(${line.map(([x, y]) => `${x}% ${y}%`).join(", ")}, 100% 100%, 0% 100%)`;
  const torn = look === "torn" || look === "gone";

  /* The shudder: a jitter whose reach grows over the charge. */
  const shakeX = useMotionValue(0);
  const shakeRotate = useMotionValue(0);
  const shakeScale = useMotionValue(1);
  useEffect(() => {
    if (look !== "charging" || reducedMotion) {
      shakeX.set(0);
      shakeRotate.set(0);
      shakeScale.set(1);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      // The shake's reach rises in a straight line across the charge.
      const reach = Math.min(1, (now - start) / Math.max(1, chargeMs));
      const time = (now - start) / 1000;
      shakeX.set(Math.sin(time * 2 * Math.PI * 23) * (1.5 + reach * 12));
      shakeRotate.set(Math.sin(time * 2 * Math.PI * 17 + 1.1) * (0.8 + reach * 8));
      shakeScale.set(1 + reach * 0.1);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [chargeMs, look, reducedMotion, shakeRotate, shakeScale, shakeX]);

  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (look === "torn") setBurst((value) => value + 1);
  }, [look]);

  const tearY = (PACK_TEAR_FRACTION * height) | 0;
  return (
    <motion.div
      initial={reducedMotion ? false : { y: 70, opacity: 0, scale: 0.92 }}
      animate={look === "gone" ? { y: 90, opacity: 0, scale: 0.9 } : { y: 0, opacity: 1, scale: 1 }}
      transition={look === "gone" ? { duration: 0.26, ease: [0.5, 0, 0.75, 0] } : { type: "spring", stiffness: 520, damping: 26 }}
    >
      <motion.div style={{ x: shakeX, rotate: shakeRotate, scale: shakeScale }}>
        <button
          ref={packRef}
          type="button"
          aria-label={t`Open the pack`}
          disabled={disabled}
          onClick={onOpen}
          className="relative block cursor-pointer disabled:cursor-default"
          style={{ width, height }}
        >
          <span className="absolute inset-0 translate-x-[4px] translate-y-[9px] rounded-[6px] bg-black/45" style={{ clipPath: torn ? bodyClip : undefined }} />
          {/* The body, its top edge the tear line once torn. */}
          <span className="absolute inset-0 rounded-[6px]" style={{ ...art, clipPath: torn ? bodyClip : undefined }} />
          {/* The top: part of the pack until it tears, then its own piece. */}
          <motion.span
            className="absolute inset-0 rounded-[6px]"
            style={{ ...art, clipPath: topClip, transformOrigin: "85% 10%" }}
            initial={false}
            animate={
              torn && !reducedMotion
                ? { x: width * 0.55, y: -height * 0.42, rotate: 38, opacity: [1, 1, 0] }
                : { x: 0, y: 0, rotate: 0, opacity: torn ? 0 : 1 }
            }
            transition={{ duration: 0.5, ease: [0.2, 0.7, 0.3, 1], opacity: { duration: 0.5, times: [0, 0.7, 1] } }}
          />
          {/* Scraps bursting from the tear line. */}
          {burst > 0 &&
            !reducedMotion &&
            SCRAPS.map((scrap, index) => (
              <motion.span
                key={`${burst}-${index}`}
                className="absolute"
                style={{ left: `${10 + (index / 13) * 80}%`, top: tearY, width: scrap.w, height: scrap.w * 0.6, background: scrap.light ? "#ffffff" : fill }}
                initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
                animate={{ x: scrap.dx, y: scrap.dy, rotate: scrap.rotate, opacity: 0 }}
                transition={{ duration: 0.55, ease: [0.15, 0.7, 0.4, 1] }}
              />
            ))}
        </button>
      </motion.div>
    </motion.div>
  );
}
