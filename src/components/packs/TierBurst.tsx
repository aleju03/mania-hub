import { motion } from "framer-motion";
import { useMemo } from "react";
import type { ManiaCardTier } from "#/lib/maniacard";
import type { RgbaColor } from "../player/maniacard3d/types";

const TIER_ORDER: ManiaCardTier[] = [
  "common",
  "rare",
  "elite",
  "superRare",
  "ultraRare",
  "legendary",
  "mythic",
  "ascendant",
  "worldClass",
  "eternal",
  "goat",
];

interface BurstParticle {
  id: number;
  angle: number;
  distance: number;
  size: number;
  rotate: number;
  delay: number;
  isTriangle: boolean;
}

interface TierBurstProps {
  tier: ManiaCardTier;
  glowColor: RgbaColor;
}

/* One-shot particle burst played when a card lands front-side-out. Particle
   count and flash strength scale with the tier; triangles keep the osu!
   motif. Parent unmounts it after the animation window. */
export function TierBurst({ tier, glowColor }: TierBurstProps) {
  const intensity = TIER_ORDER.indexOf(tier) / (TIER_ORDER.length - 1);

  const particles = useMemo<BurstParticle[]>(() => {
    const count = Math.round(10 + intensity * 18);
    return Array.from({ length: count }, (_, index) => ({
      id: index,
      angle: (index / count) * Math.PI * 2 + Math.random() * 0.5,
      distance: 90 + Math.random() * (120 + intensity * 140),
      size: 6 + Math.random() * (8 + intensity * 8),
      rotate: (Math.random() - 0.5) * 540,
      delay: Math.random() * 0.08,
      isTriangle: Math.random() > 0.35,
    }));
  }, [intensity]);

  const color = `rgb(${glowColor.r}, ${glowColor.g}, ${glowColor.b})`;
  const glow = `rgba(${glowColor.r}, ${glowColor.g}, ${glowColor.b}, 0.85)`;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-visible" aria-hidden="true">
      {/* Radial flash, stronger for high tiers */}
      <motion.div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: 200 + intensity * 240,
          height: 200 + intensity * 240,
          background: `radial-gradient(circle, rgba(${glowColor.r},${glowColor.g},${glowColor.b},${0.32 + intensity * 0.4}) 0%, rgba(${glowColor.r},${glowColor.g},${glowColor.b},0) 70%)`,
        }}
        initial={{ opacity: 0, scale: 0.4 }}
        animate={{ opacity: [0, 1, 0], scale: 1.35 }}
        transition={{ duration: 0.7, ease: "easeOut" }}
      />
      {particles.map((particle) => (
        <motion.div
          key={particle.id}
          className="absolute left-1/2 top-1/2"
          style={{
            width: particle.size,
            height: particle.size,
            background: color,
            boxShadow: `0 0 ${6 + particle.size}px ${glow}`,
            clipPath: particle.isTriangle ? "polygon(50% 0%, 100% 100%, 0% 100%)" : undefined,
            borderRadius: particle.isTriangle ? undefined : "9999px",
          }}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
          animate={{
            x: Math.cos(particle.angle) * particle.distance,
            y: Math.sin(particle.angle) * particle.distance,
            opacity: 0,
            rotate: particle.rotate,
            scale: 0.3,
          }}
          transition={{ duration: 0.85, delay: particle.delay, ease: [0.1, 0.6, 0.3, 1] }}
        />
      ))}
    </div>
  );
}
