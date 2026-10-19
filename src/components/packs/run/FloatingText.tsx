import { motion } from "framer-motion";
import { RUN_FEEL } from "./runFeel";

export interface FloatingTextItem {
  id: number;
  /* Which card or charm it belongs to; a newer text on the same anchor
     replaces the older one. */
  anchor: string;
  x: number;
  y: number;
  /* Above a hand card, below a charm, or centred on a spot in the play area. */
  place: "above" | "below" | "center";
  text: string;
  /* The step's colour; the numerals are drawn in it over a dark outline. */
  fill: string;
  /* A word (AGAIN, MISS) rather than a number: set a size smaller. */
  word: boolean;
  /* A multiplier: drawn over every other number. */
  top: boolean;
  lifeMs: number;
}

const OUTLINE = "#120f1a";

/* The number a step pops over the card or charm that fired it (feel §3):
   big numerals in the step's colour with a dark outline, popping in past
   their size, floating up and fading. On the real clock, so a fast chain
   never cuts one short; a newer one on the same card replaces it. */
export function FloatingText({ item, reducedMotion }: { item: FloatingTextItem; reducedMotion: boolean }) {
  const translate = item.place === "above" ? "-50%, -100%" : item.place === "below" ? "-50%, 0" : "-50%, -50%";
  const riseBy = RUN_FEEL.scoring.floatRisePx;
  const rise = item.place === "below" ? riseBy * 0.6 : -riseBy;
  const size = item.word ? "text-[26px] md:text-[44px]" : "text-[32px] md:text-[60px]";
  return (
    <div className={`pointer-events-none absolute ${item.top ? "z-[7]" : "z-[5]"}`} style={{ left: item.x, top: item.y, transform: `translate(${translate})` }}>
      <motion.div
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.35, y: 0 }}
        animate={
          reducedMotion
            ? { opacity: [0, 1, 1, 0] }
            : { opacity: [0, 1, 1, 0], scale: [0.35, 1.22, 1, 1], y: [0, rise * 0.25, rise * 0.7, rise] }
        }
        exit={{ opacity: 0, transition: { duration: 0.08 } }}
        transition={{ duration: item.lifeMs / 1000, times: [0, 0.14, 0.62, 1], ease: "easeOut" }}
        className={`whitespace-nowrap font-black italic leading-none tabular-nums ${size}`}
        style={{
          color: item.fill,
          WebkitTextStroke: `7px ${OUTLINE}`,
          paintOrder: "stroke fill",
        }}
      >
        {item.text}
      </motion.div>
    </div>
  );
}
