import { motion } from "framer-motion";
import { useMemo } from "react";
import type { RgbaColor } from "../player/maniacard3d/types";

interface GoatBurstProps {
  glowColor: RgbaColor;
}

interface DustMote {
  id: number;
  angle: number;
  distance: number;
  size: number;
  delay: number;
  drift: number;
}

/* The GOAT pull. Ten players carry this tier and the best pack drops it 3% of
   the time, so the reveal gets its own celebration rather than a louder copy of
   TierBurst: the screen dims, three gold shockwaves go out, the card's own
   laurel blooms behind it, and gold dust hangs in the air afterwards. It runs
   roughly 2.5s against TierBurst's 0.85s, which is the point - a World Class
   pull should not feel like this.

   The caller only mounts this when reduced motion is off. */
export function GoatBurst({ glowColor }: GoatBurstProps) {
  const gold = `rgb(${glowColor.r}, ${glowColor.g}, ${glowColor.b})`;

  const dust = useMemo<DustMote[]>(
    () =>
      Array.from({ length: 34 }, (_, index) => ({
        id: index,
        angle: (index / 34) * Math.PI * 2 + Math.random() * 0.4,
        distance: 120 + Math.random() * 220,
        size: 3 + Math.random() * 7,
        delay: 0.1 + Math.random() * 0.5,
        drift: 30 + Math.random() * 70,
      })),
    [],
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-visible" aria-hidden="true">
      {/* Screen dim, so the card is the only lit thing on the page. */}
      <motion.div
        className="fixed inset-0 bg-black"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.55, 0.34, 0] }}
        transition={{ duration: 2.5, times: [0, 0.12, 0.6, 1], ease: "easeInOut" }}
      />

      {/* Three shockwave rings, staggered so they read as one expanding pulse. */}
      {[0, 0.16, 0.32].map((delay, ring) => (
        <motion.div
          key={ring}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 180,
            height: 180,
            border: `${3 - ring * 0.6}px solid ${gold}`,
            boxShadow: `0 0 ${28 - ring * 6}px rgba(${glowColor.r},${glowColor.g},${glowColor.b},0.7)`,
          }}
          initial={{ opacity: 0, scale: 0.2 }}
          animate={{ opacity: [0, 0.9, 0], scale: 3.4 - ring * 0.4 }}
          transition={{ duration: 1.5, delay, ease: [0.12, 0.7, 0.3, 1] }}
        />
      ))}

      {/* Core flash. */}
      <motion.div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: 520,
          height: 520,
          background: `radial-gradient(circle, rgba(255,251,235,0.95) 0%, rgba(${glowColor.r},${glowColor.g},${glowColor.b},0.55) 28%, rgba(${glowColor.r},${glowColor.g},${glowColor.b},0) 68%)`,
        }}
        initial={{ opacity: 0, scale: 0.3 }}
        animate={{ opacity: [0, 0.72, 0.18, 0], scale: [0.3, 1.5, 1.8, 2] }}
        transition={{ duration: 2.2, times: [0, 0.1, 0.5, 1], ease: "easeOut" }}
      />

      {/* The card's own laurel, blooming behind it. Masked so the SVG's own
          fill doesn't matter and the wreath takes the tier gold. */}
      <motion.div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{
          width: 460,
          height: 402,
          backgroundColor: gold,
          maskImage: "url(/images/maniacard/laurel-wreath.svg)",
          maskRepeat: "no-repeat",
          maskSize: "contain",
          maskPosition: "center",
          WebkitMaskImage: "url(/images/maniacard/laurel-wreath.svg)",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          WebkitMaskPosition: "center",
        }}
        initial={{ opacity: 0, scale: 0.6, rotate: -8 }}
        animate={{ opacity: [0, 0.26, 0.14, 0], scale: [0.6, 1.12, 1.2, 1.3], rotate: 0 }}
        transition={{ duration: 2.4, times: [0, 0.16, 0.55, 1], ease: "easeOut" }}
      />

      {/* Gold dust: thrown outward, then drifting down as it fades. */}
      {dust.map((mote) => (
        <motion.div
          key={mote.id}
          className="absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: mote.size,
            height: mote.size,
            background: gold,
            boxShadow: `0 0 ${5 + mote.size}px rgba(${glowColor.r},${glowColor.g},${glowColor.b},0.9)`,
          }}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
          animate={{
            x: Math.cos(mote.angle) * mote.distance,
            y: [0, Math.sin(mote.angle) * mote.distance, Math.sin(mote.angle) * mote.distance + mote.drift],
            opacity: [0, 1, 0],
            scale: [0.4, 1, 0.5],
          }}
          transition={{ duration: 2.1, delay: mote.delay, ease: "easeOut" }}
        />
      ))}

      {/* Light sweep across the card, like tilting foil into the light. Taller
          than the card so its ends fall outside the frame, and masked to fade
          vertically - a plain rectangle terminates in two hard horizontal lines
          straight across the artwork. */}
      <motion.div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{
          width: 380,
          height: 660,
          background: `linear-gradient(105deg, transparent 38%, rgba(255,255,255,0.8) 50%, transparent 62%)`,
          maskImage: "linear-gradient(to bottom, transparent 0%, black 22%, black 78%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 22%, black 78%, transparent 100%)",
          mixBlendMode: "screen",
        }}
        initial={{ opacity: 0, x: "-60%" }}
        animate={{ opacity: [0, 1, 0], x: ["-60%", "60%", "60%"] }}
        transition={{ duration: 1.1, delay: 0.35, ease: "easeInOut" }}
      />
    </div>
  );
}
