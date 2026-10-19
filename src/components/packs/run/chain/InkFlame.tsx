import { motion } from "framer-motion";

/* The fire on the round score once it passes the target, cut like the scene
   cards' linocut prints: three layers of smooth tongues in flat ink (deep
   red, orange, gold) with carved paper lines through the back layer, each
   layer swaying on its own clock, with embers lifting off. It burns under
   the chain's headline number once the row carries the round past its
   target. Its height follows `level` on a spring that flares when it
   catches. */

const W = 200;
const H = 120;

function tongues(count: number, height: number, seed: number, inset: number): string {
  const span = (W - inset * 2) / count;
  let d = "";
  for (let index = 0; index < count; index += 1) {
    const x0 = inset + index * span - span * 0.35;
    const x1 = inset + (index + 1) * span + span * 0.35;
    const wobble = Math.sin(seed + index * 2.3);
    const h = height * (0.62 + 0.38 * Math.abs(Math.sin(seed * 1.7 + index * 1.3)));
    const tipX = (x0 + x1) / 2 + wobble * span * 0.35;
    const w = x1 - x0;
    d += `M${x0} ${H} C${x0 + w * 0.05} ${H - h * 0.45}, ${tipX - w * 0.32} ${H - h * 0.62}, ${tipX} ${H - h} C${tipX + w * 0.22} ${H - h * 0.66}, ${x1 - w * 0.05} ${H - h * 0.42}, ${x1} ${H} Z `;
  }
  return d;
}

const BACK = tongues(6, 112, 0.6, 2);
const MID = tongues(5, 84, 2.1, 18);
const FRONT = tongues(4, 52, 4.4, 40);
const CUTS = [
  "M38 112 C40 92, 34 80, 40 64",
  "M78 116 C82 96, 74 82, 82 58",
  "M120 114 C116 94, 126 78, 118 54",
  "M160 112 C158 94, 166 84, 160 66",
];

const EMBERS = [
  { x: 46, delay: 0, size: 5 },
  { x: 92, delay: 0.55, size: 4 },
  { x: 138, delay: 0.25, size: 6 },
  { x: 70, delay: 0.9, size: 3 },
  { x: 160, delay: 1.2, size: 4 },
  { x: 116, delay: 1.5, size: 3 },
];

/* `width` in px; the flame stands `width * 0.6 * scale` tall on its base
   line, where the caller puts it (the chain's headline number). Its height
   comes from `level`, which already grows with log(score / target). */
export function InkFlame({ level, width, reducedMotion }: { level: number; width: number; reducedMotion: boolean }) {
  if (level <= 0) return null;
  const scale = Math.min(1.35, 0.62 + level * 0.42);
  const sway = (name: string) => (reducedMotion ? undefined : name);
  return (
    <div aria-hidden="true" className="pointer-events-none" style={{ width }}>
      <motion.svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full overflow-visible"
        style={{ transformOrigin: "50% 100%" }}
        initial={reducedMotion ? false : { scaleY: 0, opacity: 0 }}
        animate={{ scaleY: scale, opacity: 1 }}
        transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 150, damping: 6, mass: 0.8 }}
      >
        <g className={sway("chain-flame-breathe")} style={{ transformOrigin: "50% 100%" }}>
          <g className={sway("chain-flame-a")} style={{ transformOrigin: "50% 100%" }}>
            <path d={BACK} fill="#b03e17" />
            {CUTS.map((cut) => (
              <path key={cut} d={cut} fill="none" stroke="#f7e3cd" strokeWidth={2.6} strokeLinecap="round" opacity={0.55} />
            ))}
          </g>
          <g className={sway("chain-flame-b")} style={{ transformOrigin: "50% 100%" }}>
            <path d={MID} fill="#ee7a2b" />
          </g>
          <g className={sway("chain-flame-c")} style={{ transformOrigin: "50% 100%" }}>
            <path d={FRONT} fill="#ffc24d" />
          </g>
          {!reducedMotion &&
            EMBERS.map((ember) => (
              <rect
                key={ember.x}
                className="chain-ember"
                x={ember.x}
                y={H - 30}
                width={ember.size}
                height={ember.size}
                fill={ember.size > 4 ? "#ffc24d" : "#ee7a2b"}
                style={{ animationDelay: `${ember.delay}s`, transformBox: "fill-box", transformOrigin: "50% 50%" }}
              />
            ))}
        </g>
      </motion.svg>
    </div>
  );
}
