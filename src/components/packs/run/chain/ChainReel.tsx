import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionTemplate, useMotionValue, useTransform, useVelocity, type MotionValue } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { Recycle } from "lucide-react";
import { CHAIN_REEL, CHAIN_REEL_IDS, CHAIN_REEL_INK, CHAIN_TRAITS, chainReelTile, type ChainReelId, type ChainReelPrize, type ChainRowBoost } from "#/lib/chain-run";
import { maniaTriangleOverlaySvg } from "#/lib/maniacard";
import { runSound } from "../runSound";

/* The reel a cleared round spins: a mania lane turned on its side, prize
   tiles running along it like notes and slowing onto the judgement line.
   The server has already rolled the prize (ChainReelPrize); the strip around
   it is decoration drawn here by the same weights, with a rarer tile
   sometimes stopping just past the line. The strip blurs with its speed and
   ticks as each tile crosses; it starts from rest and ends on a long
   crawl. The stop hits like a judgement: a flash on the
   line, the tile popping, sparks and (for the rarer prizes) rays in its
   colour, a shake scaled by rarity, then its name stamped under the lane.
   Two spins (a round finished at 2x its target) play one after the other.
   A click or Space skips to the stop, then on. */

const TILE_W = 122;
const TILE_H = 152;
const GAP = 12;
const STEP = TILE_W + GAP;
const WIN_AT = 30;
const STRIP = 38;
const SPIN_MS = 5200;

/* Rarity by how often a prize lands: 0 common .. 4 jackpot. */
const RANK: Record<ChainReelId, number> = { shards: 0, retry: 0, redraws: 0, warmup: 1, ez: 1, dt: 2, surge: 2, nf: 3, wysi: 4, wallet: 4 };
/* What stops just past the line for a near miss. */
const TEASE: ChainReelId[] = ["wallet", "wysi", "nf", "dt", "surge"];
/* osu!'s mod colours: difficulty reductions green, increases red. */
const MOD_FILL: Partial<Record<ChainReelId, [string, string]>> = { ez: ["#b2ff66", "#4c8a1c"], nf: ["#b2ff66", "#4c8a1c"], dt: ["#ff8a6b", "#a3281b"] };

function dress(id: ChainReelId): ChainReelPrize {
  if (id === "shards") return { id, amount: CHAIN_REEL.shards[0] + Math.floor(Math.random() * (CHAIN_REEL.shards[1] - CHAIN_REEL.shards[0] + 1)) };
  if (id === "surge") return { id, trait: CHAIN_TRAITS[Math.floor(Math.random() * CHAIN_TRAITS.length)] };
  if (id === "wallet") return { id, amount: CHAIN_REEL.wallet };
  return { id };
}

function filler(): ChainReelPrize {
  const total = CHAIN_REEL_IDS.reduce((sum, id) => sum + CHAIN_REEL.weights[id], 0);
  let roll = Math.random() * total;
  for (const id of CHAIN_REEL_IDS) {
    roll -= CHAIN_REEL.weights[id];
    if (roll < 0) return dress(id);
  }
  return dress("shards");
}

function strip(winner: ChainReelPrize): ChainReelPrize[] {
  const tiles = Array.from({ length: STRIP }, filler);
  tiles[WIN_AT] = winner;
  if (Math.random() < 0.55) {
    const tease = TEASE.filter((id) => id !== winner.id);
    tiles[WIN_AT + 1] = dress(tease[Math.floor(Math.random() * tease.length)]);
  }
  return tiles;
}

/* ------------------------------------------------------------- the icons */

/* An osu! mod badge: the rounded hexagon, in the mod's colour, its acronym
   cut into it. */
function ModBadge({ text, fill }: { text: string; fill: [string, string] }) {
  const id = `mod-${text}`;
  return (
    <svg viewBox="0 0 64 44" width={60} height={41} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={fill[0]} />
          <stop offset="1" stopColor={fill[1]} />
        </linearGradient>
      </defs>
      <path d="M14 3h36a6 6 0 0 1 5.2 3l7 12.2a6 6 0 0 1 0 6L55.2 37a6 6 0 0 1-5.2 3H14a6 6 0 0 1-5.2-3l-7-12.8a6 6 0 0 1 0-6L8.8 6A6 6 0 0 1 14 3z" fill={`url(#${id})`} />
      <path d="M14 3h36a6 6 0 0 1 5.2 3l7 12.2a6 6 0 0 1 0 6L55.2 37a6 6 0 0 1-5.2 3H14a6 6 0 0 1-5.2-3l-7-12.8a6 6 0 0 1 0-6L8.8 6A6 6 0 0 1 14 3z" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
      <text x="32" y="29" textAnchor="middle" fontSize="19" fontWeight="900" fontStyle="italic" fill="#13210a" fontFamily="inherit">
        {text}
      </text>
    </svg>
  );
}

function PrizeIcon({ prize, ink }: { prize: ChainReelPrize; ink: string }) {
  const stroke = { fill: "none", stroke: ink, strokeWidth: 2.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const mod = MOD_FILL[prize.id];
  if (mod) return <ModBadge text={prize.id.toUpperCase()} fill={mod} />;
  switch (prize.id) {
    case "shards":
      return <Recycle className="size-9" style={{ color: ink }} strokeWidth={2.2} aria-hidden />;
    case "wallet":
      // The wallet's own shard mark, on a glowing coin.
      return (
        <span className="relative flex size-12 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 35% 30%, #e8fff6, #7cf5c8 55%, #1f7a5c)", boxShadow: "0 0 18px #7cf5c8aa" }}>
          <Recycle className="size-7 text-[#0d3b2c]" strokeWidth={2.6} aria-hidden />
        </span>
      );
    case "retry":
      // One more row: three cards in a line and a plus.
      return (
        <svg viewBox="0 0 48 36" width={46} height={34} aria-hidden>
          {[4, 16, 28].map((x) => (
            <rect key={x} x={x} y={10} width={10} height={14} rx={2} {...stroke} strokeWidth={2.2} />
          ))}
          <path d="M42 11v12M36 17h12" {...stroke} />
        </svg>
      );
    case "redraws":
      return (
        <svg viewBox="0 0 40 40" width={38} height={38} aria-hidden>
          <path d="M31 15a12 12 0 0 0-21-3M9 25a12 12 0 0 0 21 3" {...stroke} />
          <path d="M10 5v7h7M30 35v-7h-7" {...stroke} />
        </svg>
      );
    case "warmup":
      return (
        <svg viewBox="0 0 40 44" width={36} height={40} aria-hidden>
          <path d="M20 41c-9 0-13-7-11-14 1.5-5 5-7 5-12 3 2 4 5 4 8 2-5 5-10 4-17 6 4 11 11 11 20 0 9-5 15-13 15z" fill={`${ink}33`} stroke={ink} strokeWidth={2.4} strokeLinejoin="round" />
          <path d="M20 37c-4 0-6-3-5-6 .7-2 2.5-3 3-6 3 2 6 5 6 8 0 2.5-1.6 4-4 4z" fill={ink} opacity={0.85} />
        </svg>
      );
    case "surge":
      // Two cards and the link over them, doubled.
      return (
        <svg viewBox="0 0 48 40" width={46} height={38} aria-hidden>
          <rect x={4} y={18} width={13} height={18} rx={2.5} {...stroke} strokeWidth={2.2} />
          <rect x={31} y={18} width={13} height={18} rx={2.5} {...stroke} strokeWidth={2.2} />
          <path d="M10.5 16C12 5 36 5 37.5 16" {...stroke} />
          <path d="M8.5 13C10 0 38 0 39.5 13" {...stroke} strokeWidth={1.6} opacity={0.6} />
        </svg>
      );
    case "wysi":
      // The approach circle closing on a hit circle.
      return (
        <svg viewBox="0 0 44 44" width={42} height={42} aria-hidden>
          <circle cx={22} cy={22} r={19} fill="none" stroke="#ffe9a8" strokeWidth={1.6} opacity={0.6} />
          <circle cx={22} cy={22} r={12.5} fill="#ffd36b" stroke="#fff6d8" strokeWidth={2.2} />
          <circle cx={22} cy={22} r={8} fill="none" stroke="#8a5a00" strokeWidth={1.4} opacity={0.5} />
        </svg>
      );
    default:
      return null;
  }
}

/* --------------------------------------------------------------- a tile */

/* Loot colours by rarity, light to deep: the tile's whole face. */
const RARITY_FACE: Array<[string, string]> = [
  ["#6a7894", "#262c3b"],
  ["#3d8de6", "#15335f"],
  ["#8a5cf0", "#2e1a63"],
  ["#ee4fa6", "#5e143e"],
  ["#f0b22c", "#5c3c06"],
];
const WALLET_FACE: [string, string] = ["#2fd3a0", "#0a4434"];
const TRIANGLES = `url("data:image/svg+xml,${encodeURIComponent(maniaTriangleOverlaySvg(100, 140))}")`;

function Tile({ prize, lit, dim }: { prize: ChainReelPrize; lit: boolean; dim: boolean }) {
  const { i18n } = useLingui();
  const tile = chainReelTile(prize, i18n);
  const ink = CHAIN_REEL_INK[prize.id];
  const rank = RANK[prize.id];
  const [light, deep] = prize.id === "wallet" ? WALLET_FACE : RARITY_FACE[rank];
  const plateH = 54;
  return (
    <motion.div
      className="relative flex shrink-0 flex-col overflow-hidden rounded-[14px]"
      animate={{ scale: lit ? 1.1 : 1, opacity: dim ? 0.32 : 1, y: lit ? -2 : 0 }}
      transition={{ type: "spring", stiffness: 480, damping: 15 }}
      style={{
        width: TILE_W,
        height: TILE_H,
        background: `radial-gradient(90% 60% at 50% 34%, ${light} 0%, ${deep} 78%)`,
        boxShadow: lit
          ? `inset 0 0 0 2px #ffffffcc, 0 0 36px ${light}cc, 0 16px 32px rgba(0,0,0,0.55)`
          : `inset 0 0 0 1px rgba(255,255,255,0.22), 0 10px 20px rgba(0,0,0,0.5)`,
      }}
    >
      {/* osu! triangles over the face, as on a maniacard. */}
      <div className="absolute inset-0 opacity-50" style={{ backgroundImage: TRIANGLES, backgroundSize: "100% 100%" }} />
      {/* Gloss across the top. */}
      <div className="absolute inset-x-0 top-0 h-[45%]" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0))" }} />
      {/* A foil sweep across the rarer tiles. */}
      {rank >= 2 && <div className="chain-face-sweep" style={{ animationDelay: `${(prize.id.length % 5) * -0.7}s` }} />}
      <div className="relative flex flex-1 items-center justify-center" style={{ filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.35))" }}>
        <PrizeIcon prize={prize} ink="#ffffff" />
      </div>
      {/* The name plate: dark glass along the bottom, the amount big. */}
      <div
        className="relative flex flex-col items-center justify-center gap-1"
        style={{ height: plateH, background: "linear-gradient(180deg, rgba(12,9,18,0.55), rgba(12,9,18,0.82))", borderTop: "1px solid rgba(255,255,255,0.14)" }}
      >
        <span
          className="font-black italic leading-none tabular-nums text-white"
          style={{ fontSize: tile.mark.length > 5 ? 20 : tile.mark.length > 3 ? 23 : 26, textShadow: "0 2px 0 rgba(0,0,0,0.4)" }}
        >
          {tile.mark}
        </span>
        <span className="max-w-[106px] truncate text-[10.5px] font-black uppercase leading-none tracking-[0.1em]" style={{ color: ink }}>
          {tile.word}
        </span>
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------- the stop's hit */

function Burst({ ink, rank, reducedMotion }: { ink: string; rank: number; reducedMotion: boolean }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: 10 + rank * 5 }, (_, index) => {
        const angle = (index / (10 + rank * 5)) * Math.PI * 2 + Math.random() * 0.4;
        const reach = 90 + Math.random() * (70 + rank * 30);
        return { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach * 0.7, size: 3 + Math.random() * 4, delay: Math.random() * 0.06 };
      }),
    [rank],
  );
  if (reducedMotion) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-[3]">
      {rank >= 2 && (
        <motion.div
          className="absolute -left-[170px] -top-[170px] size-[340px] rounded-full"
          style={{ background: `repeating-conic-gradient(from 0deg, ${ink}55 0deg 7deg, transparent 7deg 22deg)`, maskImage: "radial-gradient(circle, #000 18%, transparent 68%)", WebkitMaskImage: "radial-gradient(circle, #000 18%, transparent 68%)" }}
          initial={{ opacity: 0, scale: 0.4, rotate: 0 }}
          animate={{ opacity: [0, 1, 0.8], scale: [0.4, 1.1, 1], rotate: 40 }}
          transition={{ duration: 2.2, ease: "easeOut" }}
        />
      )}
      {sparks.map((spark, index) => (
        <motion.div
          key={index}
          className="absolute rounded-full"
          style={{ width: spark.size, height: spark.size, background: index % 3 ? ink : "#ffffff", boxShadow: `0 0 8px ${ink}` }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{ x: spark.x, y: spark.y, opacity: 0, scale: 0.3 }}
          transition={{ duration: 0.7 + rank * 0.08, delay: spark.delay, ease: [0.1, 0.7, 0.3, 1] }}
        />
      ))}
    </div>
  );
}

/* A tile on the drum: it faces you at the line and turns away toward the
   edges, smaller, like cards around a cylinder. */
function DepthTile({ x, index, windowW, prize, lit, dim }: { x: MotionValue<number>; index: number; windowW: number; prize: ChainReelPrize; lit: boolean; dim: boolean }) {
  const centre = index * STEP + TILE_W / 2;
  const away = useTransform(x, (value) => Math.max(-1.2, Math.min(1.2, (value + centre - windowW / 2) / (windowW / 2))));
  const scale = useTransform(away, (value) => 1 - Math.min(1, Math.abs(value)) * 0.2);
  const rotateY = useTransform(away, (value) => value * -34);
  return (
    <motion.div style={{ scale, rotateY }} className="shrink-0">
      <Tile prize={prize} lit={lit} dim={dim} />
    </motion.div>
  );
}

/* Jackpot confetti, falling across the whole room. */
function Confetti() {
  const bits = useMemo(
    () =>
      Array.from({ length: 70 }, (_, index) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.5,
        fall: 1.6 + Math.random() * 1.4,
        drift: (Math.random() - 0.5) * 160,
        spin: (Math.random() - 0.5) * 900,
        w: 6 + Math.random() * 6,
        h: 10 + Math.random() * 10,
        color: ["#ff9fd8", "#ffe07a", "#a5f3c4", "#8fd8ff", "#d2c2ff", "#ffffff"][index % 6],
      })),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-0 z-[1] overflow-hidden">
      {bits.map((bit, index) => (
        <motion.div
          key={index}
          className="absolute top-0 rounded-[2px]"
          style={{ left: `${bit.left}%`, width: bit.w, height: bit.h, background: bit.color }}
          initial={{ y: -30, x: 0, rotate: 0, opacity: 1 }}
          animate={{ y: "105vh", x: bit.drift, rotate: bit.spin, opacity: [1, 1, 0.8] }}
          transition={{ duration: bit.fall, delay: bit.delay, ease: [0.3, 0.1, 0.6, 1] }}
        />
      ))}
    </div>
  );
}

/* Stage lights swinging down onto the lane for the rarer stops. */
function Beams({ ink }: { ink: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 -top-[340px] bottom-0 z-[0] flex justify-center">
      {[-22, 0, 22].map((angle, index) => (
        <motion.div
          key={angle}
          className="absolute top-0 h-full w-[150px]"
          style={{ background: `linear-gradient(180deg, ${ink}00 0%, ${ink}55 55%, ${ink}00 100%)`, transformOrigin: "50% 0%", filter: "blur(6px)" }}
          initial={{ rotate: angle * 2.2, opacity: 0 }}
          animate={{ rotate: angle, opacity: [0, 0.9, 0.55] }}
          transition={{ duration: 0.9, delay: index * 0.06, ease: [0.2, 0.8, 0.3, 1] }}
        />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- the reel */

type Phase = "ready" | "spin" | "stopped" | "reveal";

/* The judgement the stop lands as: a 300 for the everyday prizes, the
   rainbow MAX for the rare ones. */
const JUDGEMENT: Array<{ word: string; fill: string }> = [
  { word: "300", fill: "#ffd36b" },
  { word: "300", fill: "#ffd36b" },
  { word: "MAX", fill: "linear-gradient(100deg, #ff9fd8 0%, #ffe07a 30%, #a5f3c4 55%, #8fd8ff 78%, #d2c2ff 100%)" },
  { word: "MAX", fill: "linear-gradient(100deg, #ff9fd8 0%, #ffe07a 30%, #a5f3c4 55%, #8fd8ff 78%, #d2c2ff 100%)" },
  { word: "MAX", fill: "linear-gradient(100deg, #ff9fd8 0%, #ffe07a 30%, #a5f3c4 55%, #8fd8ff 78%, #d2c2ff 100%)" },
];

function GradientWord({ text, fill, size }: { text: string; fill: string; size: number }) {
  const gradient = fill.startsWith("linear-gradient");
  return (
    <span className="relative inline-block px-[0.14em] font-black italic leading-none" style={{ fontSize: size }}>
      <span style={{ color: gradient ? "#120f1a" : fill, WebkitTextStroke: `${Math.round(size / 9)}px #120f1a`, paintOrder: "stroke fill" }}>{text}</span>
      {gradient && (
        <span className="absolute inset-0 px-[0.14em]" style={{ backgroundImage: fill, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
          {text}
        </span>
      )}
    </span>
  );
}

export function ChainReel({
  prizes,
  narrow,
  reducedMotion,
  onPrize,
  onShake,
  onDone,
}: {
  prizes: ChainReelPrize[];
  narrow: boolean;
  reducedMotion: boolean;
  /* A spin stopped on its prize (shards land on the HUD here). */
  onPrize: (prize: ChainReelPrize) => void;
  onShake: (amount: number) => void;
  onDone: () => void;
}) {
  const { i18n } = useLingui();
  const [spin, setSpin] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [lean, setLean] = useState(false);
  const prize = prizes[spin];
  const tiles = useMemo(() => (prize ? strip(prize) : []), [prize]);
  const x = useMotionValue(0);
  // The strip blurs with its speed.
  const speed = useVelocity(x);
  const blur = useTransform(speed, (value) => (reducedMotion ? 0 : Math.min(7, Math.abs(value) / 800)));
  const filter = useMotionTemplate`blur(${blur}px)`;
  // Speed streaks across the lane while it runs fast.
  const streaks = useTransform(speed, (value) => (reducedMotion ? 0 : Math.min(0.55, Math.abs(value) / 5200)));
  // A phone draws the lane wider and scales it down to fit.
  const windowW = narrow ? 470 : 880;
  const fit = narrow ? 340 / 470 : 1;
  const lightRef = useRef<HTMLDivElement>(null);
  const control = useRef<{ stop: () => void } | null>(null);
  const next = useRef<() => void>(() => {});
  const callbacks = useRef({ onPrize, onShake, onDone });
  callbacks.current = { onPrize, onShake, onDone };
  const stopped = phase === "stopped" || phase === "reveal";

  /* A new spin: the stage settles in before it rolls. */
  useEffect(() => {
    if (!prize) return;
    setPhase("ready");
    setLean(false);
    x.set(0);
    if (reducedMotion) {
      setPhase("spin");
      return;
    }
    // A beat for the stage to settle in, then it rolls.
    const timer = window.setTimeout(() => setPhase("spin"), 420);
    return () => window.clearTimeout(timer);
    // One countdown per prize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin]);

  useEffect(() => {
    if (!prize || phase !== "spin") return;
    // Lands somewhere on the winning tile, never dead centre.
    const jitter = (Math.random() - 0.5) * TILE_W * 0.62;
    const end = -(WIN_AT * STEP + TILE_W / 2 - windowW / 2 + jitter);
    let lastTile = -1;
    let landed = false;
    const rank = RANK[prize.id];
    const land = () => {
      if (landed) return;
      landed = true;
      x.set(end);
      setPhase("stopped");
      callbacks.current.onPrize(prize);
      callbacks.current.onShake([0.4, 0.6, 1, 1.4, 1.9][rank]);
      if (prize.id === "wysi") runSound.wysi(true);
      else if (rank >= 2) {
        runSound.stepMultiplier(8);
        runSound.charmFire(6);
      } else if (rank === 1) runSound.charmFire(3);
      else runSound.tallyTotal();
    };
    if (!reducedMotion) runSound.fireIgnite();
    const duration = reducedMotion ? 450 : SPIN_MS;
    // The camera leans in as it slows.
    const leanTimer = window.setTimeout(() => setLean(true), duration * 0.6);
    const playback = animate(x, end, {
      duration: duration / 1000,
      // Eases in from rest, runs, then a long slow crawl onto the line.
      ease: [0.42, 0, 0.08, 1],
      onUpdate: (value) => {
        // A tick and a flash of the key light each time a tile crosses.
        const tile = Math.floor((windowW / 2 - value) / STEP);
        if (tile !== lastTile) {
          lastTile = tile;
          if (!reducedMotion) {
            runSound.charmMove();
            lightRef.current?.animate([{ opacity: 0.95 }, { opacity: 0.18 }], { duration: 170, easing: "ease-out" });
          }
        }
      },
      onComplete: land,
    });
    control.current = {
      stop: () => {
        playback.stop();
        land();
      },
    };
    return () => {
      playback.stop();
      window.clearTimeout(leanTimer);
    };
    // One spin per prize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === "spin", spin]);

  // The stop's judgement holds a beat, then the prize takes the stage.
  useEffect(() => {
    if (phase !== "stopped") return;
    const timer = window.setTimeout(() => setPhase("reveal"), reducedMotion ? 300 : 700);
    return () => window.clearTimeout(timer);
  }, [phase, reducedMotion]);

  useEffect(() => {
    next.current = () => {
      if (phase === "ready") return;
      if (phase === "spin") {
        control.current?.stop();
        return;
      }
      if (phase === "stopped") {
        setPhase("reveal");
        return;
      }
      if (spin + 1 < prizes.length) setSpin(spin + 1);
      else callbacks.current.onDone();
    };
  }, [phase, prizes.length, spin]);

  // Moves on by itself once the prize has been seen, longer for the rarer.
  useEffect(() => {
    if (phase !== "reveal" || !prize) return;
    const timer = window.setTimeout(() => next.current(), reducedMotion ? 1100 : 2000 + RANK[prize.id] * 300);
    return () => window.clearTimeout(timer);
  }, [phase, prize, reducedMotion]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      next.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!prize) return null;
  const won = chainReelTile(prize, i18n);
  const ink = CHAIN_REEL_INK[prize.id];
  const rank = RANK[prize.id];
  const judgement = JUDGEMENT[rank];
  const laneH = TILE_H + 40;
  return (
    <motion.div
      className="absolute inset-0 z-[65] flex flex-col items-center justify-center overflow-hidden bg-[#0a0810]/85 backdrop-blur-[4px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
      onClick={() => next.current()}
    >
      {/* The room takes the prize's colour once it lands. */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(60% 55% at 50% 52%, ${ink}40 0%, transparent 70%)` }}
        animate={{ opacity: stopped ? 1 : 0 }}
        transition={{ duration: 0.5 }}
      />
      {stopped && rank >= 4 && !reducedMotion && <Confetti key={`confetti-${spin}`} />}
      {/* Spotlight on the stage while it spins. */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(45% 40% at 50% 52%, rgba(255,102,170,0.12) 0%, transparent 70%)" }} />

      <motion.div
        className="relative flex flex-col items-center"
        initial={reducedMotion ? false : { y: 40, scale: 0.9, opacity: 0 }}
        animate={{ y: 0, scale: lean && !stopped ? 1.045 : 1, opacity: 1 }}
        transition={lean && !stopped ? { duration: 1.6, ease: "easeOut" } : { type: "spring", stiffness: 300, damping: 24 }}
      >
        {/* Room above the lane for the stop's judgement and the lifted prize. */}
        <div className={`flex items-center gap-3 ${narrow ? "mb-12" : "mb-16"}`}>
          <span className={`font-black italic uppercase leading-none tracking-[0.04em] text-white ${narrow ? "text-[24px]" : "text-[36px]"}`} style={{ textShadow: "0 0 24px rgba(255,102,170,0.55)" }}>
            <Trans>Bonus spin</Trans>
          </span>
          {prizes.length > 1 && (
            <span className="text-[14px] font-black tabular-nums text-osu-f1">
              <Trans>
                {spin + 1} of {prizes.length}
              </Trans>
            </span>
          )}
        </div>

        <div className="relative" style={{ width: windowW * fit, height: laneH * fit }}>
          {stopped && rank >= 3 && !reducedMotion && <Beams key={`beams-${spin}`} ink={ink} />}
          <div className="relative" style={{ width: windowW, height: laneH, transform: fit < 1 ? `scale(${fit})` : undefined, transformOrigin: "0 0" }}>
            {/* The stage's bezel: a lit rim like a playfield's edge. */}
            <div
              className="absolute -inset-[6px] rounded-[24px]"
              style={{
                background: "linear-gradient(180deg, #3a2d52 0%, #1a1426 40%, #120e1b 60%, #2c2140 100%)",
                boxShadow: `0 0 0 1px rgba(255,255,255,0.08), 0 30px 70px rgba(0,0,0,0.6), 0 0 50px ${stopped ? ink : "#ff66aa"}33`,
                transition: "box-shadow 400ms ease-out",
              }}
            />
            <motion.div
              className="absolute inset-0 overflow-hidden rounded-[18px]"
              animate={{ opacity: phase === "reveal" ? 0.3 : 1 }}
              transition={{ duration: 0.35 }}
              style={{
                background: "repeating-linear-gradient(90deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 134px), linear-gradient(180deg, #171222 0%, #0d0a14 100%)",
                boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.09), inset 0 -44px 64px -30px ${stopped ? ink : "#ff66aa"}66`,
              }}
            >
              {/* The key light at the judgement line, flashing as tiles cross. */}
              <div
                ref={lightRef}
                className="pointer-events-none absolute inset-y-0 left-1/2 w-[150px] -translate-x-1/2"
                style={{ opacity: 0.18, background: `linear-gradient(0deg, ${stopped ? ink : "#ff66aa"}cc 0%, ${stopped ? ink : "#ff66aa"}22 55%, transparent 100%)` }}
              />
              <motion.div
                className="pointer-events-none absolute inset-0"
                style={{ opacity: streaks, background: "repeating-linear-gradient(180deg, transparent 0 17px, rgba(255,255,255,0.22) 17px 18px, transparent 18px 41px, rgba(255,140,200,0.18) 41px 42px)" }}
              />
              <div className="absolute inset-0" style={{ perspective: 1100 }}>
                <motion.div className="absolute top-[20px] flex will-change-transform" style={{ x, gap: GAP, filter, transformStyle: "preserve-3d" }}>
                  {tiles.map((tile, index) => (
                    <DepthTile key={`${spin}-${index}`} x={x} index={index} windowW={windowW} prize={tile} lit={stopped && index === WIN_AT} dim={stopped && index !== WIN_AT} />
                  ))}
                </motion.div>
              </div>
              <div className="pointer-events-none absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-[#0d0a14] via-[#0d0a14]/75 to-transparent" />
              <div className="pointer-events-none absolute inset-y-0 right-0 w-32 bg-gradient-to-l from-[#0d0a14] via-[#0d0a14]/75 to-transparent" />
              {/* The judgement line; on the stop it flashes wide and steps back. */}
              <motion.div
                className="pointer-events-none absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2"
                style={{ background: "#ff66aa", boxShadow: "0 0 18px #ff66aa, 0 0 4px #fff" }}
                animate={stopped ? { opacity: [1, 1, 0], scaleX: [1, 8, 1] } : { opacity: 1, scaleX: 1 }}
                transition={{ duration: 0.45, times: [0, 0.25, 1] }}
              />
            </motion.div>
            <svg className="pointer-events-none absolute -top-[4px] left-1/2 z-[2] -translate-x-1/2" width="24" height="13" viewBox="0 0 24 13" aria-hidden>
              <path d="M0 0h24L12 13z" fill={stopped ? ink : "#ff66aa"} />
            </svg>
            <svg className="pointer-events-none absolute -bottom-[4px] left-1/2 z-[2] -translate-x-1/2" width="24" height="13" viewBox="0 0 24 13" aria-hidden>
              <path d="M0 13h24L12 0z" fill={stopped ? ink : "#ff66aa"} />
            </svg>

            {/* The stop's judgement over the line. */}
            <AnimatePresence>
              {phase === "stopped" && (
                <motion.div
                  className="pointer-events-none absolute left-1/2 top-0 z-[5] -translate-x-1/2 -translate-y-[62%]"
                  initial={reducedMotion ? { opacity: 0 } : { scale: 0.3, opacity: 0, y: 10 }}
                  animate={{ scale: [0.3, 1.25, 1], opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -16, transition: { duration: 0.2 } }}
                  transition={{ duration: 0.4, times: [0, 0.6, 1] }}
                >
                  <GradientWord text={judgement.word} fill={judgement.fill} size={narrow ? 64 : 76} />
                </motion.div>
              )}
            </AnimatePresence>

            {stopped && <Burst key={spin} ink={ink} rank={rank} reducedMotion={reducedMotion} />}

            {/* The prize takes the stage: lifted off the lane, big, framed in
                its colour, rays behind the rarer ones. */}
            <AnimatePresence>
              {phase === "reveal" && (
                <motion.div
                  className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center"
                  initial={reducedMotion ? { opacity: 0 } : { scale: 0.75, opacity: 0, y: 10 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ type: "spring", stiffness: 380, damping: 18 }}
                >
                  {rank >= 1 && !reducedMotion && (
                    <motion.div
                      className="absolute size-[420px] rounded-full"
                      style={{ background: `repeating-conic-gradient(from 0deg, ${ink}44 0deg 6deg, transparent 6deg 20deg)`, maskImage: "radial-gradient(circle, #000 20%, transparent 66%)", WebkitMaskImage: "radial-gradient(circle, #000 20%, transparent 66%)" }}
                      animate={{ rotate: 360 }}
                      transition={{ duration: 18, ease: "linear", repeat: Infinity }}
                    />
                  )}
                  <div style={{ transform: "scale(1.45)" }}>
                    <Tile prize={prize} lit dim={false} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="mt-7 flex h-[72px] flex-col items-center justify-start text-center">
          <AnimatePresence>
            {phase === "reveal" && (
              <motion.div
                key={spin}
                className="flex flex-col items-center gap-1.5"
                initial={reducedMotion ? false : { opacity: 0, y: 10, scale: 1.3 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 520, damping: 22 }}
              >
                <span className="font-black italic uppercase leading-none" style={{ color: ink, fontSize: narrow ? 26 : 36, textShadow: `0 0 26px ${ink}99, 0 3px 0 rgba(0,0,0,0.4)` }}>
                  {won.mark} {won.word}
                </span>
                <span className="text-[14px] font-bold text-white/85">{won.text}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* The reel as it waits in the shop: a short stretch of the lane, its tiles
   drifting past the judgement line on a slow loop. */
export function ReelOffer({ width, height, still }: { width: number; height: number; still: boolean }) {
  const loop: ChainReelPrize[] = useMemo(() => [{ id: "dt" }, { id: "shards", amount: 6 }, { id: "wysi" }, { id: "ez" }, { id: "warmup" }, { id: "nf" }], []);
  const scale = height / (TILE_H + 24);
  const span = loop.length * STEP;
  return (
    <div
      className="relative overflow-hidden rounded-[12px]"
      style={{
        width,
        height,
        background: "repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0 1px, transparent 1px 40px), linear-gradient(180deg, #171222 0%, #0d0a14 100%)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1), inset 0 -24px 40px -24px #ff66aa66, 0 10px 24px rgba(0,0,0,0.45)",
      }}
    >
      <div className="absolute left-0 top-1/2" style={{ transform: `translateY(-50%) scale(${scale})`, transformOrigin: "0 50%" }}>
        <motion.div
          className="flex"
          style={{ gap: GAP }}
          animate={still ? { x: -STEP * 1.5 } : { x: [0, -span] }}
          transition={still ? { duration: 0 } : { duration: 9, ease: "linear", repeat: Infinity }}
        >
          {[...loop, ...loop, ...loop].map((prize, index) => (
            <Tile key={index} prize={prize} lit={false} dim={false} />
          ))}
        </motion.div>
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[#0d0a14] to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[#0d0a14] to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2" style={{ background: "#ff66aa", boxShadow: "0 0 12px #ff66aa" }} />
    </div>
  );
}

/* What the reel left on the round: chips for the first row's boost, shown
   until that row is played. */
export function ChainBoostChips({ boost }: { boost: ChainRowBoost | null }) {
  const { i18n } = useLingui();
  if (!boost) return null;
  const prizes: ChainReelPrize[] = [];
  if (boost.warmup) prizes.push({ id: "warmup" });
  if (boost.dt) prizes.push({ id: "dt" });
  if (boost.surge) prizes.push({ id: "surge", trait: boost.surge });
  if (boost.nf) prizes.push({ id: "nf" });
  if (boost.wysi) prizes.push({ id: "wysi" });
  if (!prizes.length) return null;
  const chips: ReactNode[] = prizes.map((prize) => {
    const tile = chainReelTile(prize, i18n);
    const ink = CHAIN_REEL_INK[prize.id];
    return (
      <span
        key={prize.id}
        title={tile.text}
        className="rounded-md px-2 py-1 text-[12px] font-black italic leading-none"
        style={{ color: ink, background: `${ink}1f`, boxShadow: `inset 0 0 0 1px ${ink}66, 0 0 14px ${ink}33` }}
      >
        {tile.mark} {tile.word}
      </span>
    );
  });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-osu-f1">
        <Trans>First row</Trans>
      </span>
      {chips}
    </div>
  );
}
