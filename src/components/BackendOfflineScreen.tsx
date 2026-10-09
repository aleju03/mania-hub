import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

const INK = "var(--color-osu-l2)";
const ACCENT = "var(--color-osu-h1)";
const FLOOR = 112;

/* Same hand-drawn look as the /bbcode margin doodles: every path is drawn
   twice, the second pass offset and faint, so the lines read as pencil. */
function Sketch({ children }: { children: ReactNode }) {
  return (
    <>
      <g>{children}</g>
      <g transform="translate(0.9 -0.7)" opacity={0.4}>{children}</g>
    </>
  );
}

function keycap(x: number, [a, b, c]: readonly [number, number, number]) {
  return [
    `M ${x + 6} ${60 + a} C ${x + 2} 60 ${x + 1} 62 ${x + 1} 66 L ${x + 2 + b} 106 C ${x + 2} 110 ${x + 4} ${FLOOR} ${x + 8} ${FLOOR} L ${x + 40} ${111 + c} C ${x + 44} 111 ${x + 46} 109 ${x + 46} 105 L ${x + 45 + a} 65 C ${x + 45} 61 ${x + 43} 60 ${x + 39} 60 Z`,
    `M ${x + 11} 64 C ${x + 8} 64 ${x + 7} 66 ${x + 7} 69 L ${x + 8} ${92 + b} C ${x + 8} 95 ${x + 10} 96 ${x + 13} 96 L ${x + 35} ${96 + a} C ${x + 38} 96 ${x + 39} 94 ${x + 39} 91 L ${x + 38 + c} 68 C ${x + 38} 65 ${x + 37} 64 ${x + 34} 64 Z`,
    `M ${x + 9} 95 L ${x + 4} 109 M ${x + 37} 95 L ${x + 43} 109`,
  ].join(" ");
}

function OfflineDoodle() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 290 128"
      className="w-[min(380px,86vw)]"
      fill="none"
      stroke={INK}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <filter id="offline-doodle-rough">
        <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves={2} seed={7} />
        <feDisplacementMap in="SourceGraphic" scale={1.6} />
      </filter>
      <g filter="url(#offline-doodle-rough)">
        <Sketch>
          <path d={keycap(14, [0, 1, -1])} transform="rotate(-2 36 112)" />
          <path d={keycap(68, [1, -1, 0])} transform="rotate(1.5 90 112)" />
          {/* Where the third key used to sit: the bare switch, stem showing. */}
          <path d="M 126 112 L 126.5 103 L 148 102.5 L 148.5 112" />
          <path d="M 137 102.5 L 137.3 92 M 132 97 L 142.5 97.3" strokeWidth={2.2} />
          <path d={keycap(0, [-1, 0, 1])} transform="translate(212 -1) rotate(-90 0 112)" stroke={ACCENT} />
          <path d={keycap(226, [0, -1, 1])} transform="rotate(-1.5 246 112)" />
          <path d="M 4 113 C 60 112 100 114.5 150 113 C 200 111.5 240 113.5 286 112.5" opacity={0.45} />
        </Sketch>
      </g>
    </svg>
  );
}

export function BackendOfflineScreen() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <OfflineDoodle />
      <h1 className="mt-4 text-lg font-bold text-white">
        <Trans>Temporarily offline</Trans>
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-osu-f1">
        <Trans>Either restarting or under maintenance. Try again later.</Trans>
      </p>
      <button
        type="button"
        onClick={() => {
          if (typeof window !== "undefined") window.location.reload();
        }}
        className="group relative mt-1 px-6 py-2.5 text-[13px] font-semibold text-osu-pink"
      >
        {/* Outlined in the same pencil line as the drawing above it. */}
        <svg
          aria-hidden
          viewBox="0 0 120 40"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
          fill="none"
          stroke={ACCENT}
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <g filter="url(#offline-doodle-rough)">
            <Sketch>
              <path
                d="M 7 3 C 3 3 2 5 2 9 L 2.5 32 C 2.5 36 4 37.5 8 37.5 L 112 37 C 116 37 118 35 118 31 L 117.5 8 C 117.5 4 116 2.5 112 2.5 Z"
                fill={ACCENT}
                className="[fill-opacity:0] transition-[fill-opacity] group-hover:[fill-opacity:0.15]"
              />
            </Sketch>
          </g>
        </svg>
        <span className="relative">
          <Trans>Try again</Trans>
        </span>
      </button>
    </div>
  );
}
