import type { ReactNode } from "react";

const INK = "var(--color-osu-l2)";
const ACCENT = "var(--color-osu-h1)";

/** Draws its children twice, the second pass nudged and fainter, so lines
    read as pen strokes gone over twice. */
function Sketch({ children }: { children: ReactNode }) {
  return (
    <>
      <g>{children}</g>
      <g transform="translate(0.9 -0.7)" opacity={0.4}>{children}</g>
    </>
  );
}

function Doodle({ viewBox, className, children }: { viewBox: string; className: string; children: ReactNode }) {
  return (
    <svg
      viewBox={viewBox}
      className={`absolute ${className}`}
      fill="none"
      stroke={INK}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g filter="url(#bbcode-doodle-rough)">{children}</g>
    </svg>
  );
}

function sparkle(cx: number, cy: number, s: number) {
  return `M ${cx} ${cy - s} Q ${cx} ${cy} ${cx + s} ${cy} Q ${cx} ${cy} ${cx} ${cy + s} Q ${cx} ${cy} ${cx - s} ${cy} Q ${cx} ${cy} ${cx} ${cy - s} Z`;
}

const KEYS = [
  { letter: "Z", wobble: [0, 1, -1] },
  { letter: "X", wobble: [1, -1, 0] },
  { letter: ".", wobble: [-1, 0, 1], pressed: true },
  { letter: "/", wobble: [0, -1, 1] },
] as const;

function keyLetter(letter: string, cx: number) {
  switch (letter) {
    case "Z":
      return `M ${cx - 4} 74 L ${cx + 5} 74.5 L ${cx - 4} 86 L ${cx + 5} 86`;
    case "X":
      return `M ${cx - 4} 74 L ${cx + 5} 86 M ${cx + 5} 74 L ${cx - 4} 86`;
    case ".":
      return `M ${cx} 84 L ${cx + 0.5} 84.5`;
    default:
      return `M ${cx + 4} 73 L ${cx - 4} 87`;
  }
}

/** Four keycaps with notes falling onto them, one key held down. */
function KeysDoodle() {
  return (
    <Doodle viewBox="0 0 230 120" className="left-1/2 top-[12%] w-[min(250px,82%)] -translate-x-1/2 -rotate-3">
      <Sketch>
        {KEYS.map((key, i) => {
          const x = 12 + i * 54;
          const [a, b, c] = key.wobble;
          const cx = x + 23;
          return (
            <g key={key.letter} transform={"pressed" in key ? "translate(0 4)" : undefined}>
              <path
                d={`M ${x + 6} ${60 + a} C ${x + 2} 60 ${x + 1} 62 ${x + 1} 66 L ${x + 2 + b} 106 C ${x + 2} 110 ${x + 4} 112 ${x + 8} 112 L ${x + 40} ${111 + c} C ${x + 44} 111 ${x + 46} 109 ${x + 46} 105 L ${x + 45 + a} 65 C ${x + 45} 61 ${x + 43} 60 ${x + 39} 60 Z`}
              />
              <path
                d={`M ${x + 11} 64 C ${x + 8} 64 ${x + 7} 66 ${x + 7} 69 L ${x + 8} ${92 + b} C ${x + 8} 95 ${x + 10} 96 ${x + 13} 96 L ${x + 35} ${96 + a} C ${x + 38} 96 ${x + 39} 94 ${x + 39} 91 L ${x + 38 + c} 68 C ${x + 38} 65 ${x + 37} 64 ${x + 34} 64 Z`}
              />
              <path d={`M ${x + 9} 95 L ${x + 4} 109 M ${x + 37} 95 L ${x + 43} 109`} />
              <path d={keyLetter(key.letter, cx)} strokeWidth={key.letter === "." ? 3 : 1.6} />
            </g>
          );
        })}
        {/* Press marks around the held key */}
        <path d="M 120 58 L 115 51 M 168 58 L 173 51 M 117 67 L 110 66 M 171 67 L 178 66" strokeWidth={1.4} />
        {/* Notes */}
        <path d="M 19 26 C 19 23 21 22 24 22 L 51 22.5 C 54 22.5 55 24 55 26 L 55 29 C 55 31 54 32 51 32 L 23 32 C 20 32 19 31 19 29 Z" />
        <path d="M 74 4 C 74 2 75 1 78 1 L 104 1.5 C 107 1.5 108 3 108 5 L 108 8 C 108 10 107 11 104 11 L 77 11 C 75 11 74 10 74 8 Z" />
        <path d="M 182 34 C 182 31 183 30 186 30 L 212 30.5 C 215 30.5 216 32 216 34 L 216 37 C 216 39 215 40 212 40 L 186 40 C 183 40 182 39 182 37 Z" />
        {/* Hold note ending on the held key */}
        <path
          d="M 135 3 L 153 3.5 L 153.5 50 L 135.5 50 Z"
          stroke={ACCENT}
          fill={ACCENT}
          fillOpacity={0.12}
        />
        <path d="M 129 50 C 129 48 130 47 133 47 L 155 47 C 158 47 159 48 159 50 L 159 53 C 159 55 158 56 155 56 L 133 56 C 130 56 129 55 129 53 Z" stroke={ACCENT} />
        {/* Speed lines */}
        <path d="M 30 8 L 30 15 M 44 4 L 44 13 M 194 14 L 194 22 M 206 10 L 206 21" strokeWidth={1.3} />
      </Sketch>
    </Doodle>
  );
}

/** A bold tag with a looping arrow pointing at the editor. */
function TagArrowDoodle() {
  return (
    <Doodle viewBox="0 0 200 135" className="left-1/2 top-[66%] w-[min(220px,76%)] -translate-x-[45%] rotate-2">
      <Sketch>
        <g transform="rotate(-7 44 30)" strokeWidth={2.2}>
          <path d="M 27 11 L 20 11.5 L 20.5 45 L 27.5 44.5" />
          <path d="M 35 8 L 35.5 44 M 35.5 31 C 37 21 50 21 50 32 C 50 44 37 45 35.5 38" />
          <path d="M 58 11 L 65 11 L 64.5 44.5 L 57.5 45" />
        </g>
        <path d="M 18 57 C 30 54 48 58 66 53" stroke={ACCENT} strokeWidth={2.2} />
        <path d="M 20 118 C 26 90 56 72 78 84 C 98 96 86 120 70 112 C 54 104 70 72 110 68 C 130 66 150 68 168 70" />
        <path d="M 155 59 L 169 70 L 154 80" />
        <path d={sparkle(124, 32, 7)} stroke={ACCENT} />
        <path d={sparkle(150, 108, 4.5)} />
      </Sketch>
    </Doodle>
  );
}

/** A pencil mid-scribble. */
function PencilDoodle() {
  return (
    <Doodle viewBox="0 0 220 165" className="left-1/2 top-[11%] w-[min(240px,82%)] -translate-x-[55%] rotate-3">
      <Sketch>
        <g transform="translate(72 112) rotate(-40)">
          <path d="M 0 0 L 22 -8 M 0 0 L 22 8" />
          <path d="M 0.5 0 L 7 -2.6 Q 8.5 0 7 2.6 Z" fill={INK} />
          <path d="M 22 -8 Q 18.5 0 22 8" />
          <path d="M 22 -8 L 98 -8.6 L 98.4 8.2 L 22 8 M 27 0.2 L 95 0.8" />
          <path d="M 98 -8.6 L 110 -8.8 L 110.3 8.6 L 98.4 8.2 M 102 -8.6 L 102.2 8.4 M 106 -8.7 L 106.2 8.5" />
          <path
            d="M 110 -8.8 L 117 -8.8 C 124 -8.6 124.5 8.4 117.5 8.6 L 110.3 8.6"
            stroke={ACCENT}
            fill={ACCENT}
            fillOpacity={0.15}
          />
        </g>
        <path d="M 71 114 C 61 121 48 119 50 110 C 52 101 63 105 59 114 C 55 124 38 124 36 114 C 34 105 45 105 43 116 C 41 127 23 129 12 121" />
      </Sketch>
    </Doodle>
  );
}

/** Headphones with a loose cable. */
function HeadphonesDoodle() {
  return (
    <Doodle viewBox="0 0 160 145" className="left-1/2 top-[64%] w-[min(170px,62%)] -translate-x-[45%] -rotate-6">
      <Sketch>
        <path d="M 32 80 C 26 40 48 16 80 16 C 112 16 134 40 128 80 M 40 79 C 36 46 54 26 80 26 C 106 26 124 46 120 79" />
        <path
          d="M 26 76 C 22 76 20 78 20 82 L 20.5 112 C 20.5 116 22 118 26 118 L 40 117.5 C 44 117.5 46 116 46 112 L 45.5 82 C 45.5 78 44 76 40 76 Z M 120 76 C 116 76 114 78 114 82 L 114.5 112 C 114.5 116 116 118 120 118 L 134 117.5 C 138 117.5 140 116 140 112 L 139.5 82 C 139.5 78 138 76 134 76 Z"
          stroke={ACCENT}
          fill={ACCENT}
          fillOpacity={0.12}
        />
        <path d="M 46 84 L 50 85 L 50.5 110 L 46 111 M 114 84 L 110 85 L 110.5 110 L 114 111" />
        <path d="M 33 118 C 33 128 40 133 50 131 C 62 128 66 137 78 134" />
      </Sketch>
    </Doodle>
  );
}

/** A judgement number with a wavy underline. */
function JudgementDoodle() {
  return (
    <Doodle viewBox="0 0 150 80" className="left-1/2 top-[40%] w-[min(130px,50%)] -translate-x-[70%] rotate-6">
      <Sketch>
        <g stroke={ACCENT} strokeWidth={2.2}>
          <path d="M 14 18 C 24 8 40 14 32 28 C 28 33 24 34 22 34 C 30 34 40 40 34 52 C 28 62 14 58 10 52" />
          <path d="M 62 16 C 74 16 76 30 75 38 C 74 50 68 55 61 54 C 51 53 48 42 49 32 C 50 22 55 16 62 16 Z" />
          <path d="M 98 16 C 110 16 112 30 111 38 C 110 50 104 55 97 54 C 87 53 84 42 85 32 C 86 22 91 16 98 16 Z" />
        </g>
        <path d="M 8 68 C 30 62 60 72 112 64" />
        <path d={sparkle(134, 18, 6)} />
      </Sketch>
    </Doodle>
  );
}

/** A mug of something hot. */
function MugDoodle() {
  return (
    <Doodle viewBox="0 0 140 120" className="left-1/2 top-[38%] w-[min(120px,45%)] -translate-x-[45%] rotate-3">
      <Sketch>
        <path d="M 30 40 C 30 34 94 34 94 40 C 94 46 30 46 30 40 Z" />
        <path d="M 30 40 L 32 100 C 32 106 36 109 42 109 L 82 108.5 C 88 108.5 91.5 105 91.5 100 L 94 40" />
        <path d="M 93 52 C 112 50 117 60 115 70 C 113 82 102 86 92 84 M 92.5 60 C 104 58 106.5 64 105.5 70 C 104.5 76 98 78 92 77" />
        <path d="M 31 66 L 93 65.5 M 31.5 74 L 92.5 73.5" stroke={ACCENT} />
        <path d="M 52 28 C 46 21 57 16 51 7 M 72 28 C 66 21 77 16 71 7" strokeWidth={1.5} />
      </Sketch>
    </Doodle>
  );
}

/** Pen doodles in the empty margins either side of the editor column. Only
    shown when the margins are wide enough to hold them clear of the editor. */
export function BBCodeDoodles() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 hidden opacity-35 min-[1560px]:block">
      <svg width="0" height="0" className="absolute">
        <filter id="bbcode-doodle-rough">
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves={2} seed={7} />
          <feDisplacementMap in="SourceGraphic" scale={2.4} />
        </filter>
      </svg>
      <div className="absolute inset-y-0 left-0 w-[calc(50%-600px)]">
        <KeysDoodle />
        <JudgementDoodle />
        <TagArrowDoodle />
      </div>
      <div className="absolute inset-y-0 right-0 w-[calc(50%-600px)]">
        <PencilDoodle />
        <MugDoodle />
        <HeadphonesDoodle />
      </div>
    </div>
  );
}
