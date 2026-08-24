import { motion } from "framer-motion";
import { useMemo } from "react";
import type { RgbaColor } from "../player/maniacard3d/types";

interface EternalBurstProps {
  glowColor: RgbaColor;
  /* Which half of the ceremony to draw. The light show is split around the
     card rather than stacked on top of it: "behind" is everything that should
     read as coming from behind the card (the dim, the rays, the pillar, the
     halo and the shockwaves) and mounts under it, "front" is the handful of
     things that may cross it (the infalling stars, one brief flash, the
     embers). Drawn as one layer, the effect simply erased the card it was
     celebrating. */
  layer?: "behind" | "front";
}

interface InfallingStar {
  id: number;
  angle: number;
  distance: number;
  size: number;
  delay: number;
}

interface Ember {
  id: number;
  x: number;
  size: number;
  delay: number;
  rise: number;
  drift: number;
  duration: number;
}

interface Ray {
  id: number;
  angle: number;
  length: number;
  width: number;
}

/* Timing, shared with the audio so the picture lands on the sound. These are
   the same beats playEternalFanfare is built on: a wind-up, an impact, a
   climb, then the resolve held. */
export const ETERNAL_WINDUP_S = 0.95;
const IMPACT = ETERNAL_WINDUP_S;
const TOTAL_S = 4.4;
const RESOLVE = IMPACT + 0.42 + 3 * 0.34;
const AFTER_IMPACT_S = TOTAL_S - IMPACT;
/* Total ceremony length. The caller holds the card on screen for this long
   and unmounts the burst afterwards. */
export const ETERNAL_CEREMONY_MS = TOTAL_S * 1000;

/* How much room the card takes in the middle of the effect. The rays and the
   halo are cut out of this radius so nothing bright crosses the artwork; the
   card is the subject, and the light is what is behind it. */
const CARD_CLEAR_PX = 190;
const CARD_FALLOFF_PX = 300;

/* The Eternal card: the one-time reward for completing the entire collection,
   and the opener's own card. The GOAT ceremony is a 2.5s burst of gold; this
   runs about four seconds, because it happens once per collector and never
   again.

   Three movements against the fanfare. Wind-up: the page dims and starlight
   is pulled in from off screen while a ring winds down onto the card. Impact:
   it all arrives on the downbeat, a short flash, shockwaves, and rays snapping
   on behind the card. Resolve: the rays turn slowly, embers drift up, and the
   dark bleeds off. Everything bright is either behind the card or masked away
   from it, so the card stays readable from the first frame to the last.

   The caller only mounts this when reduced motion is off. */
export function EternalBurst({ glowColor, layer = "front" }: EternalBurstProps) {
  const violet = `rgb(${glowColor.r}, ${glowColor.g}, ${glowColor.b})`;
  const rgb = `${glowColor.r},${glowColor.g},${glowColor.b}`;
  const behind = layer === "behind";

  const stars = useMemo<InfallingStar[]>(
    () =>
      behind
        ? []
        : Array.from({ length: 38 }, (_, index) => ({
            id: index,
            angle: (index / 38) * Math.PI * 2 + Math.random() * 0.4,
            distance: 400 + Math.random() * 440,
            size: 2 + Math.random() * 4,
            // Every star is timed to arrive at the impact rather than
            // scattered across the run: they land together, which is what
            // makes the hit read as one event instead of a drizzle.
            delay: Math.random() * (IMPACT - 0.45),
          })),
    [behind],
  );

  const rays = useMemo<Ray[]>(
    () =>
      behind
        ? Array.from({ length: 12 }, (_, index) => ({
            id: index,
            angle: (index / 12) * 360 + Math.random() * 8,
            length: 560 + Math.random() * 420,
            width: 14 + Math.random() * 44,
          }))
        : [],
    [behind],
  );

  const embers = useMemo<Ember[]>(
    () =>
      behind
        ? []
        : Array.from({ length: 22 }, (_, index) => ({
            id: index,
            // Kept out along the card's flanks so the tail frames it instead
            // of drifting across the face.
            x: (Math.random() < 0.5 ? -1 : 1) * (150 + Math.random() * 190),
            size: 2 + Math.random() * 5,
            delay: IMPACT + Math.random() * 1.9,
            rise: 200 + Math.random() * 320,
            drift: (Math.random() - 0.5) * 70,
            duration: 1.6 + Math.random() * 1.4,
          })),
    [behind],
  );

  /* Cuts the card's footprint out of a full-bleed layer. */
  const cardCutout = `radial-gradient(circle at center, transparent 0px, transparent ${CARD_CLEAR_PX}px, black ${CARD_FALLOFF_PX}px)`;

  if (behind) {
    return (
      <div className="pointer-events-none absolute inset-0 z-[5] overflow-visible" aria-hidden="true">
        {/* The page goes dark behind the card, deep enough for the light to
            register but not so deep that the rest of the reveal disappears. */}
        <motion.div
          className="fixed inset-0 bg-black"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.74, 0.76, 0.5, 0] }}
          transition={{
            duration: TOTAL_S,
            times: [0, IMPACT / TOTAL_S, (IMPACT + 0.3) / TOTAL_S, RESOLVE / TOTAL_S, 1],
            ease: "easeInOut",
          }}
        />

        {/* The ring winding down onto the card during the wind-up, landing
            just outside its edges. */}
        <motion.div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 300,
            height: 300,
            border: `2px solid ${violet}`,
            boxShadow: `0 0 30px rgba(${rgb},0.7)`,
          }}
          initial={{ opacity: 0, scale: 4.5, rotate: 0 }}
          animate={{ opacity: [0, 0.5, 0.85, 0], scale: [4.5, 1.3, 1.05, 0.95], rotate: 120 }}
          transition={{ duration: IMPACT + 0.5, times: [0, 0.6, 0.92, 1], ease: [0.4, 0, 0.2, 1] }}
        />

        {/* Shockwaves off the impact. Sized to sweep past the card rather than
            to fill the viewport. */}
        {[0, 0.1, 0.22].map((stagger, ring) => (
          <motion.div
            key={ring}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: 300,
              height: 300,
              border: `${3 - ring * 0.6}px solid ${violet}`,
              boxShadow: `0 0 ${26 - ring * 6}px rgba(${rgb},0.6)`,
            }}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: [0, 0.75, 0], scale: 3.4 - ring * 0.5 }}
            transition={{ duration: 1.4, delay: IMPACT + stagger, ease: [0.1, 0.75, 0.25, 1] }}
          />
        ))}

        {/* Rays, snapping on at the impact and turning through the resolve.
            The container is masked so every ray begins outside the card. */}
        <motion.div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: 0,
            height: 0,
            mixBlendMode: "screen",
            maskImage: cardCutout,
            WebkitMaskImage: cardCutout,
          }}
          initial={{ opacity: 0, rotate: 0, scale: 0.6 }}
          animate={{ opacity: [0, 0.6, 0.42, 0], rotate: 24, scale: [0.6, 1, 1.08, 1.2] }}
          transition={{ duration: AFTER_IMPACT_S, delay: IMPACT, times: [0, 0.07, 0.55, 1], ease: "easeOut" }}
        >
          {rays.map((ray) => (
            <div
              key={ray.id}
              className="absolute left-0 top-0"
              style={{
                width: ray.width,
                height: ray.length,
                marginLeft: -ray.width / 2,
                transform: `rotate(${ray.angle}deg)`,
                transformOrigin: "50% 0%",
                background: `linear-gradient(to bottom, rgba(${rgb},0.55) 0%, rgba(${rgb},0.3) 30%, rgba(${rgb},0) 80%)`,
                filter: "blur(4px)",
              }}
            />
          ))}
        </motion.div>

        {/* The pillar the card stands in. Wider than the card so it reads as
            light behind it, and masked at both ends. */}
        <motion.div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: 520,
            height: 1100,
            background: `linear-gradient(90deg, transparent 0%, rgba(${rgb},0.42) 30%, rgba(${rgb},0.5) 50%, rgba(${rgb},0.42) 70%, transparent 100%)`,
            maskImage: "linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)",
            filter: "blur(6px)",
          }}
          initial={{ opacity: 0, scaleX: 0.08 }}
          animate={{ opacity: [0, 1, 0.6, 0], scaleX: [0.08, 1, 1.05, 1.4] }}
          transition={{ duration: AFTER_IMPACT_S, delay: IMPACT, times: [0, 0.08, 0.6, 1], ease: "easeOut" }}
        />

        {/* The glow the card sits in while the chord is held: a ring around
            it, not a wash over it. */}
        <motion.div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 760,
            height: 760,
            background: `radial-gradient(circle, rgba(${rgb},0) 22%, rgba(${rgb},0.5) 42%, rgba(${rgb},0.18) 60%, rgba(${rgb},0) 74%)`,
          }}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: [0, 1, 0.7, 0.85, 0], scale: [0.6, 1.05, 1, 1.06, 1.3] }}
          transition={{
            duration: AFTER_IMPACT_S,
            delay: IMPACT,
            times: [0, 0.08, 0.4, (RESOLVE - IMPACT) / AFTER_IMPACT_S, 1],
            ease: "easeInOut",
          }}
        />
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-visible" aria-hidden="true">
      {/* Wind-up: starlight dragged in from off screen, all of it arriving on
          the downbeat. These do cross the card, which is the point: they are
          what the card is being assembled out of. */}
      {stars.map((star) => (
        <motion.div
          key={star.id}
          className="absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: star.size,
            height: star.size,
            background: "rgba(248, 244, 255, 0.98)",
            boxShadow: `0 0 ${7 + star.size * 2}px rgba(${rgb},0.9)`,
          }}
          initial={{
            x: Math.cos(star.angle) * star.distance,
            y: Math.sin(star.angle) * star.distance,
            opacity: 0,
            scale: 0.3,
          }}
          animate={{ x: 0, y: 0, opacity: [0, 0.85, 1, 0], scale: [0.3, 1, 0.4] }}
          transition={{ duration: IMPACT - star.delay, delay: star.delay, ease: [0.65, 0, 0.85, 0.4] }}
        />
      ))}

      {/* The flash. One bright frame on the downbeat and gone: long enough to
          punctuate the hit, too short to hide what it is celebrating. */}
      <motion.div
        className="fixed inset-0"
        style={{
          background: `radial-gradient(circle at center, rgba(255,255,255,0.85) 0%, rgba(${rgb},0.5) 30%, rgba(${rgb},0) 62%)`,
          mixBlendMode: "screen",
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.9, 0] }}
        transition={{ duration: 0.36, delay: IMPACT, times: [0, 0.12, 1], ease: "easeOut" }}
      />

      {/* Embers rising past the card through the resolve, the long tail. */}
      {embers.map((ember) => (
        <motion.div
          key={ember.id}
          className="absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: ember.size,
            height: ember.size,
            background: violet,
            boxShadow: `0 0 ${6 + ember.size * 2}px rgba(${rgb},0.85)`,
          }}
          initial={{ x: ember.x, y: 140, opacity: 0, scale: 0.5 }}
          animate={{
            x: ember.x + ember.drift,
            y: 140 - ember.rise,
            opacity: [0, 0.95, 0],
            scale: [0.5, 1, 0.3],
          }}
          transition={{ duration: ember.duration, delay: ember.delay, ease: "easeOut" }}
        />
      ))}
    </div>
  );
}
