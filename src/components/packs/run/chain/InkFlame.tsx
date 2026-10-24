import { motion } from "framer-motion";

/* The fire on the round score once it passes the target, cut like the scene
   cards' linocut prints: layers of tongues in flat ink with carved paper
   lines through the back one, each layer swaying on its own clock, embers
   lifting off. Each layer is one silhouette with a rounded base (a flame's
   foot, not a flat cut), tallest in the middle.

   It burns hotter the further past the target the round is (`ratio`, the
   round score over the target), in five looks: an ember fire just past it,
   a blaze from 1.5x, white-hot with a blue root from 3x, the Overjoy pink
   inferno from 10x, and a violet star fire from 100x (endless numbers).
   Crossing into the next look flares. Its height follows `level` on a
   spring that flares when it catches. */

const W = 200;
const H = 120;

type Layer = { count: number; height: number; inset: number; seed: number; fill: string };
interface Look {
  layers: Layer[];
  /* The carved lines through the back layer. */
  cut: string;
  /* A small hot core at the foot, and the blue root under it. */
  core?: string;
  root?: string;
  embers: number;
  emberInk: [string, string];
  /* Sway speed: 1 is the ember fire's clocks. */
  speed: number;
  /* The flare when the fire crosses into this look. */
  flare: number;
}

/* Deterministic jitter, so every render of a look is the same print. */
function jitter(seed: number, index: number): number {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/* One layer's silhouette: rounded tongues leaning this way and that,
   tallest in the middle, their valleys well up the body, and a rounded foot
   whose lowest point is the base line's centre. */
function silhouette({ count, height, inset, seed }: Layer): string {
  const left = inset;
  const right = W - inset;
  const span = (right - left) / count;
  const side = H - 16;
  const valley = (index: number) => (index === 0 || index === count ? side : H - height * (0.38 + 0.14 * jitter(seed, index + 40)));
  let d = `M${left} ${side}`;
  for (let index = 0; index < count; index += 1) {
    const x0 = left + index * span;
    const x1 = x0 + span;
    const centre = 1 - Math.abs((2 * (index + 0.5)) / count - 1);
    const h = height * (0.55 + 0.33 * centre ** 0.7 + 0.12 * jitter(seed, index));
    // The tip leans toward the middle on the outside tongues, either way inside.
    const outward = (2 * (index + 0.5)) / count - 1;
    const lean = (-outward * 0.5 + (jitter(seed, index + 20) - 0.5) * 0.7) * span;
    const tipX = (x0 + x1) / 2 + lean;
    const tipY = H - h;
    const y0 = valley(index);
    const y1 = valley(index + 1);
    // Rising edge bulges out, then hooks into the tip; falling edge the same.
    d += ` C${x0 - span * 0.12} ${y0 - (y0 - tipY) * 0.5}, ${tipX - span * 0.42 - lean * 0.3} ${tipY + h * 0.2}, ${tipX} ${tipY}`;
    d += ` C${tipX + span * 0.1 - lean * 0.4} ${tipY + h * 0.28}, ${x1 + span * 0.12} ${y1 - (y1 - tipY) * 0.48}, ${x1} ${y1}`;
  }
  // The foot: round under the middle, tucked in at the sides.
  d += ` C${right + 6} ${H - 2}, ${W / 2 + (right - left) * 0.3} ${H + 6}, ${W / 2} ${H + 6}`;
  d += ` C${W / 2 - (right - left) * 0.3} ${H + 6}, ${left - 6} ${H - 2}, ${left} ${side} Z`;
  return d;
}

/* A loose wisp torn off a tongue: a small teardrop with its point up. */
function wisp(cx: number, cy: number, r: number, lean: number): string {
  return `M${cx} ${cy + r} C${cx - r * 1.1} ${cy + r}, ${cx - r} ${cy - r * 0.6}, ${cx + lean} ${cy - r * 2.2} C${cx + r} ${cy - r * 0.6}, ${cx + r * 1.1} ${cy + r}, ${cx} ${cy + r} Z`;
}

const LOOKS: Look[] = [
  {
    layers: [
      { count: 4, height: 104, inset: 8, seed: 0.6, fill: "#b03e17" },
      { count: 3, height: 76, inset: 28, seed: 2.1, fill: "#ee7a2b" },
      { count: 2, height: 48, inset: 52, seed: 4.4, fill: "#ffc24d" },
    ],
    cut: "#f7e3cd",
    embers: 5,
    emberInk: ["#ffc24d", "#ee7a2b"],
    speed: 1,
    flare: 1,
  },
  {
    layers: [
      { count: 5, height: 114, inset: 4, seed: 1.3, fill: "#c2361a" },
      { count: 4, height: 88, inset: 18, seed: 3.2, fill: "#ff7a1f" },
      { count: 3, height: 60, inset: 38, seed: 5.1, fill: "#ffd24d" },
    ],
    cut: "#ffe8c8",
    core: "#fff1b8",
    embers: 8,
    emberInk: ["#ffd24d", "#ff7a1f"],
    speed: 1.2,
    flare: 1.18,
  },
  {
    layers: [
      { count: 5, height: 118, inset: 0, seed: 2.7, fill: "#d23a1e" },
      { count: 4, height: 96, inset: 14, seed: 4.6, fill: "#ff8f2e" },
      { count: 3, height: 70, inset: 32, seed: 6.2, fill: "#ffe066" },
      { count: 2, height: 40, inset: 62, seed: 7.9, fill: "#fffaf0" },
    ],
    cut: "#fff4dc",
    core: "#ffffff",
    root: "#4fb4ff",
    embers: 11,
    emberInk: ["#fffaf0", "#ffe066"],
    speed: 1.45,
    flare: 1.25,
  },
  {
    layers: [
      { count: 6, height: 120, inset: 0, seed: 3.9, fill: "#8c1a5e" },
      { count: 5, height: 100, inset: 10, seed: 5.7, fill: "#ff4f9a" },
      { count: 3, height: 74, inset: 28, seed: 8.1, fill: "#ffb3d6" },
      { count: 2, height: 46, inset: 60, seed: 9.4, fill: "#fff3d6" },
    ],
    cut: "#ffe0ef",
    core: "#ffffff",
    root: "#ffd36b",
    embers: 14,
    emberInk: ["#ffd36b", "#ff9cc3"],
    speed: 1.7,
    flare: 1.32,
  },
  {
    layers: [
      { count: 6, height: 120, inset: 0, seed: 4.8, fill: "#3b1a8c" },
      { count: 5, height: 104, inset: 8, seed: 6.6, fill: "#7a5cff" },
      { count: 4, height: 80, inset: 24, seed: 9.9, fill: "#6fe3ff" },
      { count: 2, height: 52, inset: 58, seed: 11.3, fill: "#ffffff" },
    ],
    cut: "#d9ccff",
    core: "#ffffff",
    root: "#ff9cc3",
    embers: 18,
    emberInk: ["#ffffff", "#6fe3ff"],
    speed: 2,
    flare: 1.4,
  },
];

/* Where each look starts, as the round score over the target. */
const LOOK_AT = [1, 1.5, 3, 10, 100];

export function inkFlameLook(ratio: number): number {
  let look = 0;
  for (let index = 0; index < LOOK_AT.length; index += 1) if (ratio >= LOOK_AT[index]) look = index;
  return look;
}

const PATHS = LOOKS.map((look) => look.layers.map(silhouette));
const WISPS = LOOKS.map((look, index) =>
  Array.from({ length: index + 1 }, (_, k) => {
    const layer = k % 2;
    const top = H - look.layers[layer].height;
    return { layer, d: wisp(50 + jitter(index + 11, k) * (W - 100), top - 6 - jitter(index + 13, k) * 14, 4 + jitter(index + 17, k) * 3, (jitter(index + 19, k) - 0.5) * 8) };
  }),
);
const CUT_LINES = [
  "M44 110 C46 92, 40 80, 46 64",
  "M80 114 C84 96, 76 82, 84 58",
  "M120 112 C116 94, 126 78, 118 54",
  "M156 110 C154 94, 162 84, 156 66",
];
const SWAY = ["chain-flame-a", "chain-flame-b", "chain-flame-c", "chain-flame-b"];
const SWAY_MS = [1300, 900, 620, 760];

/* `width` in px; the flame stands `width * 0.6 * scale` tall on its base
   line, where the caller puts it (the chain's headline number). Its height
   comes from `level`, which already grows with log(score / target). */
export function InkFlame({ level, ratio = 1, width, reducedMotion, height }: { level: number; ratio?: number; width: number; reducedMotion: boolean; height?: number }) {
  if (level <= 0) return null;
  // `height` overrides the level's own scale (the desktop table's tall fire).
  const scale = height ?? Math.min(1.35, 0.62 + level * 0.42);
  const index = inkFlameLook(ratio);
  const look = LOOKS[index];
  const paths = PATHS[index];
  const sway = (name: string) => (reducedMotion ? undefined : name);
  return (
    <div aria-hidden="true" className="pointer-events-none" style={{ width }}>
      <motion.svg
        viewBox={`0 0 ${W} ${H + 8}`}
        className="block w-full overflow-visible"
        style={{ transformOrigin: "50% 100%" }}
        initial={reducedMotion ? false : { scaleY: 0, opacity: 0 }}
        animate={{ scaleY: scale, opacity: 1 }}
        transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 150, damping: 6, mass: 0.8 }}
      >
        {/* A new look flares in from the foot. */}
        <motion.g
          key={index}
          style={{ transformOrigin: "50% 100%" }}
          initial={reducedMotion || index === 0 ? false : { scale: look.flare, opacity: 0.6 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 9 }}
        >
          <g className={sway("chain-flame-breathe")} style={{ transformOrigin: "50% 100%", animationDuration: `${Math.round(1700 / look.speed)}ms` }}>
            {look.root && <ellipse cx={W / 2} cy={H + 1} rx={W * 0.3} ry={9} fill={look.root} />}
            {paths.map((d, layer) => (
              <g
                key={layer}
                className={sway(SWAY[layer])}
                style={{ transformOrigin: "50% 100%", animationDuration: `${Math.round(SWAY_MS[layer] / look.speed)}ms` }}
              >
                <path d={d} fill={look.layers[layer].fill} />
                {layer === 0 &&
                  CUT_LINES.map((cut) => <path key={cut} d={cut} fill="none" stroke={look.cut} strokeWidth={2.6} strokeLinecap="round" opacity={0.5} />)}
              </g>
            ))}
            {/* Wisps torn off the top, more the hotter it burns. */}
            {WISPS[index].map((w, k) => (
              <path key={k} className={sway(SWAY[k % 3])} style={{ transformOrigin: "50% 100%" }} d={w.d} fill={look.layers[w.layer].fill} />
            ))}
            {look.core && <ellipse cx={W / 2} cy={H - 6} rx={W * 0.09} ry={7} fill={look.core} />}
            {!reducedMotion &&
              Array.from({ length: look.embers }, (_, ember) => {
                const size = 3 + Math.round(jitter(index + 1, ember) * 3);
                return (
                  <rect
                    key={ember}
                    className="chain-ember"
                    x={30 + jitter(index + 7, ember) * (W - 60)}
                    y={H - 30 - jitter(index + 3, ember) * 20}
                    width={size}
                    height={size}
                    fill={size > 4 ? look.emberInk[0] : look.emberInk[1]}
                    style={{
                      animationDelay: `${(jitter(index + 5, ember) * 1.8).toFixed(2)}s`,
                      animationDuration: `${Math.round(1800 / Math.sqrt(look.speed))}ms`,
                      transformBox: "fill-box",
                      transformOrigin: "50% 50%",
                    }}
                  />
                );
              })}
          </g>
        </motion.g>
      </motion.svg>
    </div>
  );
}
