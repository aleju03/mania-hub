import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useWindowActive } from "#/lib/window-activity";
import { createCardBackCanvas } from "./packArt";
import { playShuffleWhisk } from "./packSfx";

/* Shown between the pack rip and the reveal when the player draw is still in
   flight: a face-down stack that keeps riffling until the cards exist. Every
   dimension mirrors RevealStage's stack (same footprint, same card back, same
   stacked transforms) so the moment the draw resolves, the shuffle hands off
   to the real stack without a visual jump. */

// Same apparent card size as RevealStage's stack (its cards shrink by the
// renderer's 1.05 breathing-room factor).
const STACK_CARD_SCALE = 1 / 1.05;
// One riffle every CYCLE_MS; the sweep itself takes SWEEP_S. The gap between
// them is the beat where the stack reads as settled.
const CYCLE_MS = 780;
const SWEEP_S = 0.62;

interface ShuffleStageProps {
  reducedMotion: boolean;
  /* Backs in the pile; matches the pack type's card count so the handoff to
     the reveal stack keeps the same silhouette. */
  count: number;
}

export function ShuffleStage({ reducedMotion, count }: ShuffleStageProps) {
  const windowActive = useWindowActive();
  const [cardBack, setCardBack] = useState<string | null>(null);
  const [cycle, setCycle] = useState(0);
  /* The draw is usually done before the first sweep finishes; past a few
     seconds, say why the shuffle is still going. */
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setCardBack(createCardBackCanvas().toDataURL("image/png"));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 4500);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (reducedMotion || !windowActive) return;
    const timer = window.setInterval(() => {
      setCycle((current) => current + 1);
      playShuffleWhisk();
    }, CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [reducedMotion, windowActive]);

  // Each tick the top card sweeps out and tucks under the bottom; everyone
  // else shifts up a slot. Alternating sweep direction reads as a hand
  // working the deck instead of a conveyor.
  const sweeper = cycle > 0 ? (cycle - 1) % count : -1;
  const dir = cycle % 2 === 1 ? -1 : 1;
  const bottom = count - 1;

  return (
    <div className="flex flex-col items-center">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">shuffling</div>

      <div className="relative mt-4 w-[min(340px,84vw)]" style={{ aspectRatio: "5 / 7" }}>
        {cardBack &&
          Array.from({ length: count }, (_, card) => {
            const pos = (((card - cycle) % count) + count) % count;
            const isSweeper = card === sweeper && !reducedMotion;
            return (
              <motion.div
                key={card}
                className="absolute inset-0 rounded-[18px] bg-cover bg-center"
                style={{
                  backgroundImage: `url(${cardBack})`,
                  willChange: "transform",
                  backfaceVisibility: "hidden",
                }}
                initial={false}
                // Only the top card gets the big drop shadow (buried cards
                // overlap almost fully; stacked shadows compound into an
                // opaque blob). It lives in animate because pos rotates.
                animate={
                  isSweeper
                    ? {
                        // Out to the side above the stack, then under it: the
                        // z-order flips mid-sweep at max displacement, where
                        // the swap is hardest to see.
                        x: [0, dir * 175, bottom * 7],
                        y: [0, 6, bottom * 1],
                        rotate: [0, dir * -9, bottom * 0.9],
                        scale: [STACK_CARD_SCALE, STACK_CARD_SCALE * 0.955, STACK_CARD_SCALE],
                        zIndex: 0,
                        boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                      }
                    : {
                        x: pos * 7,
                        y: pos * 1,
                        rotate: pos * 0.9,
                        scale: STACK_CARD_SCALE,
                        zIndex: 10 - pos,
                        boxShadow:
                          pos === 0 ? "0 14px 36px rgba(0,0,0,0.5)" : "0 2px 6px rgba(0,0,0,0.35)",
                      }
                }
                transition={
                  isSweeper
                    ? {
                        duration: SWEEP_S,
                        times: [0, 0.5, 1],
                        ease: "easeInOut",
                        zIndex: { delay: SWEEP_S * 0.45, duration: 0 },
                      }
                    : { duration: 0.34, ease: "easeOut", zIndex: { duration: 0 } }
                }
              />
            );
          })}
      </div>

      <div className="mt-5 h-[58px] text-center" aria-live="polite">
        <div className="text-[12px] text-osu-f1">Shuffling players...</div>
        {slow && (
          <motion.div
            className="mt-1 text-[12px] text-osu-f1/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            The rankings lookup is taking a moment
          </motion.div>
        )}
      </div>

      {/* Holds the height of RevealStage's button row so the handoff to the
          real stack doesn't shift the page. */}
      <div className="mt-2 h-9" aria-hidden="true" />
    </div>
  );
}
