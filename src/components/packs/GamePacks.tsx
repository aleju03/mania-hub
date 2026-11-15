import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
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

/* The column's heading, in the game names' font and the doodles' ink. */
/* "Extra" opens and closes the games, so a player here only for packs can
   fold them away; closed until opened, and the choice is remembered. */
const EXTRA_OPEN_KEY = "packs-extra-open";

function useExtraOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(EXTRA_OPEN_KEY) === "1");
    } catch {
      // Storage unavailable: stays closed.
    }
  }, []);
  return [
    open,
    (next) => {
      setOpen(next);
      try {
        window.localStorage.setItem(EXTRA_OPEN_KEY, next ? "1" : "0");
      } catch {
        // Storage unavailable: holds for this page.
      }
    },
  ];
}

function GamesHeading({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mx-auto flex cursor-pointer items-center gap-1.5 text-[20px] font-black opacity-75 transition hover:opacity-100"
      style={{ color: INK }}
    >
      {label}
      <svg viewBox="0 0 12 12" width={13} height={13} aria-hidden className="transition-transform duration-200" style={{ transform: open ? "rotate(180deg)" : undefined }}>
        <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/* The two game doodles for one layout. `side` stacks them in a column right
   of the pack stage (the caller positions the box around the 270 x 450
   pack); `row` puts them side by side under it. The run's is left out
   when there is no backend to play it on. */
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
  const { t } = useLingui();
  const bestStreak = useBestStreak();
  const [open, setOpen] = useExtraOpen();
  const heading = <GamesHeading label={t`Extra`} open={open} onToggle={() => setOpen(!open)} />;
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
  if (layout === "row") {
    return (
      <div className={`flex flex-col items-center gap-4 ${className}`}>
        {heading}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="games"
              className={`mx-auto grid w-full items-start gap-x-6 px-4 ${chain ? "max-w-[420px] grid-cols-2" : "max-w-[210px] grid-cols-1"}`}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10, transition: { duration: 0.12 } }}
              transition={{ duration: 0.2 }}
            >
              {doodles}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }
  /* Right of the pack, out toward the page edge on wide screens, the column
     centred on the pack's height. */
  return (
    <div className={`pointer-events-none absolute inset-x-0 top-0 ${className}`}>
      {/* "Extra" holds its place at the top whether open or closed (the
          column keeps the doodles' 230px width, so it stays centred over
          them); the games drop in under it. */}
      <div className="pointer-events-auto absolute flex w-[230px] flex-col items-center gap-4 pt-2" style={{ left: "calc(50% + max(220px, 23vw))" }}>
        {heading}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="games"
              className="flex flex-col gap-7"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10, transition: { duration: 0.12 } }}
              transition={{ duration: 0.2 }}
            >
              {doodles}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
