import { useEffect, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { CHAIN_RUN_NAME } from "#/lib/chain-run";
import { readBestStreak } from "#/lib/streak-game";
import { setChainEntryOrigin } from "./run/chain/chainEntry";

/* The pack page's two games, Higher or lower and the chain run, as hand-drawn
   doodles in a column beside the pack being opened (or in a row under it on
   narrow pages), each with its name and the player's best under it. The
   sketch style is the /bbcode margins' (BBCodeDoodles.tsx): hand-placed paths
   with small wobbles, a faint offset second stroke and a roughen filter; the
   game's colour picks out what the game is about. The whole doodle is the
   button. */

/* The run's name is one shared message, CHAIN_RUN_NAME in src/lib/chain-run.ts. */
const CHAIN_NAME = CHAIN_RUN_NAME;

export type GameKind = "streak" | "chain";

const INK = "var(--color-osu-l2)";
const ACCENT: Record<GameKind, string> = { streak: "#66ccff", chain: "#ff66aa" };
const ROUGH = "game-doodle-rough";

function Sketch({ children }: { children: ReactNode }) {
  return (
    <>
      <g>{children}</g>
      <g transform="translate(0.9 -0.7)" opacity={0.4}>
        {children}
      </g>
    </>
  );
}

/* A sketched card: wobbly outline, a hatched portrait and a name line. */
function card(x: number, y: number, w: number, h: number, wobble: [number, number]) {
  const [a, b] = wobble;
  const portrait = h * 0.48;
  return (
    <>
      <path
        d={`M ${x + 5} ${y + a} C ${x + 1} ${y} ${x} ${y + 2} ${x} ${y + 6} L ${x + 1 + b} ${y + h - 6} C ${x + 1} ${y + h - 2} ${x + 3} ${y + h} ${x + 7} ${y + h} L ${x + w - 5} ${y + h - 0.5 + a} C ${x + w - 1} ${y + h - 0.5} ${x + w} ${y + h - 3} ${x + w} ${y + h - 7} L ${x + w - 0.5 + a} ${y + 5} C ${x + w - 0.5} ${y + 1} ${x + w - 3} ${y} ${x + w - 6} ${y} Z`}
      />
      <path d={`M ${x + 7} ${y + 8} L ${x + w - 7} ${y + 7.5 + b} L ${x + w - 6.5} ${y + 8 + portrait} L ${x + 7.5} ${y + 8.5 + portrait} Z`} />
      <path
        d={`M ${x + 10} ${y + 4 + portrait} L ${x + w * 0.38} ${y + 12} M ${x + w * 0.3} ${y + 6 + portrait} L ${x + w * 0.66} ${y + 12} M ${x + w * 0.55} ${y + 6 + portrait} L ${x + w - 10} ${y + 15}`}
        strokeWidth={1.1}
        opacity={0.7}
      />
      <path d={`M ${x + 8} ${y + portrait + 20} L ${x + w * 0.68} ${y + portrait + 19.5 + a}`} />
      <path d={`M ${x + 8} ${y + portrait + 29} L ${x + w * 0.42} ${y + portrait + 29}`} strokeWidth={1.2} opacity={0.7} />
    </>
  );
}

/* Higher or lower: two cards face to face, the next one a question mark,
   an arrow up and an arrow down between them. */
function StreakDoodle({ accent }: { accent: string }) {
  return (
    <Sketch>
      <g transform="rotate(-7 70 75)">{card(36, 22, 68, 106, [0, 1])}</g>
      <g transform="rotate(6 170 75)">
        <path d="M 142 22 C 138 22 136 24 136 28 L 137 122 C 137 126 139 128 143 128 L 198 127.5 C 202 127.5 204 125 204 121 L 203.5 28 C 203.5 24 201 22 197 22 Z" />
        <path d="M 158 52 C 157 39 182 37 182 51 C 182 60 170 61 170 70 M 170 81 L 170.6 81.6" stroke={accent} strokeWidth={3.2} />
        <path d="M 148 104 L 190 103.5 M 148 113 L 172 113" strokeWidth={1.2} opacity={0.7} />
      </g>
      <path d="M 120 70 L 120.5 36 M 110.5 46 L 120.5 35 L 130 45.5" stroke={accent} strokeWidth={2.6} />
      <path d="M 120.5 82 L 120 116 M 110.5 106 L 120 117 L 130.5 106.5" strokeWidth={2.6} />
    </Sketch>
  );
}

/* The chain run: a row of cards linked over their tops by arcs, each arc
   with its +6, and the fire the combo lights at the end. */
function ChainDoodle({ accent }: { accent: string }) {
  const xs = [10, 70, 130, 190];
  const tilt = [-4, 2, -2, 5];
  return (
    <Sketch>
      {xs.map((x, i) => (
        <g key={x} transform={`rotate(${tilt[i]} ${x + 24} 100)`}>
          {card(x, 66, 48, 68, [i % 2 ? 1 : -1, i % 2 ? -1 : 1])}
        </g>
      ))}
      {xs.slice(0, 3).map((x, i) => {
        const from = x + 26;
        const to = xs[i + 1] + 22;
        const mid = (from + to) / 2;
        return (
          <g key={x} stroke={accent}>
            <path d={`M ${from} 62 C ${from + 8} ${42 - i} ${to - 8} ${42 + i} ${to} 62`} strokeWidth={2} />
            <path d={`M ${mid - 11} 35 C ${mid - 14} 35 ${mid - 14} 46 ${mid - 11} 46 L ${mid + 11} 46.5 C ${mid + 14} 46.5 ${mid + 14} 35 ${mid + 11} 35 Z`} fill={accent} fillOpacity={0.14} />
            <path d={`M ${mid - 7.5} 40.5 L ${mid - 1.5} 40.5 M ${mid - 4.5} 37.5 L ${mid - 4.5} 43.5`} strokeWidth={1.4} />
            <path d={`M ${mid + 6} 37 C ${mid + 2.5} 37 ${mid + 1.5} 40.5 ${mid + 1.5} 41.5 C ${mid + 1.5} 44.5 ${mid + 6.5} 44.5 ${mid + 6.5} 42 C ${mid + 6.5} 39.5 ${mid + 2} 39.5 ${mid + 1.5} 42`} strokeWidth={1.4} />
          </g>
        );
      })}
      <path
        d="M 236 50 C 225 46 225 33 231 25 C 232 31 235 32 236.5 29 C 236.5 21 241 16 246 11 C 244 21 252.5 26 251.5 36.5 C 250.5 45 244 50 236 50 Z"
        stroke={accent}
        fill={accent}
        fillOpacity={0.12}
      />
      <path d="M 238 45.5 C 234 42.5 235 37.5 238 33.5 C 239 36.5 241 36.5 242 34.5 C 244.5 38.5 243.5 43.5 238 45.5 Z" stroke={accent} />
    </Sketch>
  );
}

/* The player's best Higher or lower streak across its pools, as the game
   keeps it in this browser; null when there is none yet. Read after mount
   (localStorage), so the server render shows the name alone. */
export function useBestStreak(): number | null {
  const [best, setBest] = useState<number | null>(null);
  useEffect(() => {
    const value = Math.max(readBestStreak("top500"), readBestStreak("top"), readBestStreak("anyone"));
    setBest(value > 0 ? value : null);
  }, []);
  return best;
}

/* `width` "fluid" fills the button's box, for the compact row on phones. */
export function GameDoodle({ kind, best, width, onOpen }: { kind: GameKind; best: number | null; width: number | "fluid"; onOpen: () => void }) {
  const fluid = width === "fluid";
  const { t, i18n } = useLingui();
  const name = kind === "streak" ? t`Higher or lower` : i18n._(CHAIN_NAME);
  const bestLabel = kind === "streak" ? t`best streak` : t`best round`;
  const accent = ACCENT[kind];
  const viewW = kind === "streak" ? 240 : 260;
  return (
    <button
      type="button"
      onClick={(event) => {
        if (kind === "chain") {
          const art = event.currentTarget.querySelector("svg")?.getBoundingClientRect();
          if (art) setChainEntryOrigin(art.left + art.width / 2, art.top + art.height / 2);
        }
        onOpen();
      }}
      aria-label={name}
      className={`group flex cursor-pointer flex-col items-center rounded-lg ${fluid ? "min-w-0 gap-1.5" : "gap-2"} focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-osu-pink`}
    >
      <svg
        viewBox={`0 0 ${viewW} 150`}
        width={fluid ? undefined : width}
        height={fluid ? undefined : (width * 150) / viewW}
        fill="none"
        stroke={INK}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={`overflow-visible opacity-75 transition-[opacity,transform] duration-300 ease-out group-hover:-translate-y-1 group-hover:-rotate-2 group-hover:opacity-100 group-focus-visible:opacity-100 ${fluid ? "h-auto w-full" : ""}`}
      >
        <g filter={`url(#${ROUGH})`}>{kind === "streak" ? <StreakDoodle accent={accent} /> : <ChainDoodle accent={accent} />}</g>
      </svg>
      <div className="flex flex-col items-center gap-1 text-center">
        <div className={`${fluid ? "text-[15px]" : "text-[17px]"} font-black leading-tight text-white transition-colors group-hover:text-[var(--game-accent)]`} style={{ ["--game-accent" as string]: accent }}>
          {name}
        </div>
        {best !== null && (
          <div className="flex items-baseline gap-1.5">
            <span className={`${fluid ? "text-[18px]" : "text-[22px]"} font-black leading-none text-white tabular-nums`}>{best.toLocaleString("en-US")}</span>
            <span className="text-[11px] font-bold text-osu-f1">{bestLabel}</span>
          </div>
        )}
      </div>
    </button>
  );
}

/* The column's heading, lettered by hand in the doodles' pen: one stroke per
   letter, the same ink, offset second stroke and roughen filter. Each
   language gets its own lettering; one without falls back to plain text. */
const LETTERING: Record<string, { width: number; height: number; paths: string[] }> = {
  en: {
    width: 68,
    height: 24,
    paths: [
      "M 14.2 6.2 C 12.6 3.6 10 2.7 7.4 3.1 C 3.6 3.8 1.8 8.6 2.1 13.4 C 2.4 18.6 5.6 21.9 9.6 21.6 C 13 21.3 14.8 18.9 14.9 15.4 L 14.8 13.2 L 10.2 13.4",
      "M 27 12.4 C 25.6 10.4 22.4 10 20.6 11.8 C 18.4 14 18.3 18.6 20.4 20.6 C 22.6 22.4 25.8 21 26.8 17.6 M 27.1 10.6 L 27.4 21.6",
      "M 31.2 21.5 L 31 10.6 M 31.1 13.6 C 32 10.9 34.8 10.2 36.4 11.4 C 37.6 12.4 37.5 15.2 37.6 21.4 M 37.6 13.6 C 38.6 10.9 41.4 10.2 42.9 11.4 C 44.1 12.4 44 15.2 44.2 21.5",
      "M 47.6 16.1 L 56 15.7 C 56.1 12.6 54.2 10.4 51.6 10.5 C 48.6 10.7 47 13.4 47.2 16.6 C 47.4 19.8 49.6 21.7 52.4 21.5 C 54.2 21.4 55.4 20.6 56.3 19.4",
      "M 65.8 12.2 C 64.9 10.7 63 10.2 61.6 10.6 C 59.6 11.2 59.4 13.8 61.4 14.8 L 63.9 15.9 C 66.3 17 66.2 20.5 63.8 21.3 C 61.8 21.9 59.8 21.2 58.8 19.8",
    ],
  },
  es: {
    width: 70,
    height: 30,
    paths: [
      "M 3 3.2 L 11.2 2.9 M 8 3.1 L 8.1 17 C 8.2 20.4 6.2 21.8 4.2 21.5 C 2.7 21.2 1.9 20.1 1.6 18.6",
      "M 14 10.6 L 14.1 17 C 14.1 20 15.6 21.6 17.8 21.5 C 20 21.4 21.4 19.5 21.6 17 M 21.6 10.5 L 21.8 21.5",
      "M 25.6 16.1 L 34 15.7 C 34.1 12.6 32.2 10.4 29.6 10.5 C 26.6 10.7 25 13.4 25.2 16.6 C 25.4 19.8 27.6 21.7 30.4 21.5 C 32.2 21.4 33.4 20.6 34.3 19.4",
      "M 45 12.2 C 43.8 10.4 41.4 10 39.8 11.2 C 37.6 12.8 37.3 17 38.9 19.1 C 40.6 21.1 43.6 20.6 45 17.8 M 45.2 10.5 L 45.3 23.2 C 45.3 27 42.6 28.5 40 28.1 C 38.5 27.8 37.5 26.9 37 25.8",
      "M 53 10.5 C 50 10.6 48.5 13.5 48.6 16.3 C 48.7 19.3 50.5 21.6 53.2 21.5 C 56 21.4 57.6 18.8 57.5 15.8 C 57.4 12.8 55.8 10.4 52.4 10.9",
      "M 67.8 12.2 C 66.9 10.7 65 10.2 63.6 10.6 C 61.6 11.2 61.4 13.8 63.4 14.8 L 65.9 15.9 C 68.3 17 68.2 20.5 65.8 21.3 C 63.8 21.9 61.8 21.2 60.8 19.8",
    ],
  },
};

function GamesHeading({ label, locale }: { label: string; locale: string }) {
  const lettering = LETTERING[locale.split("-")[0]];
  if (!lettering) return <div className="-mb-3 text-center text-[15px] font-black opacity-75" style={{ color: INK }}>{label}</div>;
  const scale = 1.15;
  return (
    <div className="-mb-3 flex justify-center">
      <svg
        viewBox={`0 0 ${lettering.width} ${lettering.height}`}
        width={lettering.width * scale}
        height={lettering.height * scale}
        role="img"
        aria-label={label}
        fill="none"
        stroke={INK}
        strokeWidth={1.8 / scale}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="-rotate-2 overflow-visible opacity-75"
      >
        <g filter={`url(#${ROUGH})`}>
          <Sketch>
            {lettering.paths.map((d) => (
              <path key={d} d={d} />
            ))}
          </Sketch>
        </g>
      </svg>
    </div>
  );
}

/* The two game doodles for one layout. `side` stacks them in a column right
   of the pack stage (the caller positions the box around the 270 x 450
   pack); `row` puts them side by side under it. The run's only appears for
   a viewer the backend has released it to. */
export function GamePacks({
  layout,
  chain,
  onStreak,
  onChain,
  className = "",
}: {
  layout: "side" | "row";
  /* Null hides the run's doodle; otherwise its best round, or null for none. */
  chain: { best: number | null } | null;
  onStreak: () => void;
  onChain: () => void;
  className?: string;
}) {
  const { t, i18n } = useLingui();
  const bestStreak = useBestStreak();
  const width = layout === "side" ? 230 : "fluid";
  const doodles = (
    <>
      <svg width="0" height="0" className="absolute" aria-hidden>
        <filter id={ROUGH}>
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves={2} seed={7} />
          <feDisplacementMap in="SourceGraphic" scale={2.4} />
        </filter>
      </svg>
      <GameDoodle kind="streak" best={bestStreak} width={width} onOpen={onStreak} />
      {chain && <GameDoodle kind="chain" best={chain.best} width={width} onOpen={onChain} />}
    </>
  );
  /* Side by side even on a phone, each half the width, so the pair costs one
     short row of scrolling. */
  if (layout === "row") return <div className={`mx-auto grid items-start gap-x-6 px-4 ${chain ? "max-w-[420px] grid-cols-2" : "max-w-[210px] grid-cols-1"} ${className}`}>{doodles}</div>;
  /* Right of the pack, out toward the page edge on wide screens, the column
     centred on the pack's height. */
  return (
    <div className={`pointer-events-none absolute inset-x-0 top-0 ${className}`}>
      <div className="pointer-events-auto absolute flex h-[450px] flex-col justify-center gap-7" style={{ left: "calc(50% + max(220px, 23vw))" }}>
        <GamesHeading label={t`Games`} locale={i18n.locale} />
        {doodles}
      </div>
    </div>
  );
}
