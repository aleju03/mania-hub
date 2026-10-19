import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { pathRoundRect } from "#/lib/canvas";
import { CHAIN_RULES } from "#/lib/chain-run";
import { MANIA_TIER_STYLES, maniaTriangleOverlaySvg, type ManiaCardTier } from "#/lib/maniacard";
import { getCosmicTierPalette } from "#/lib/maniacard-cosmic";
import type { PackWallet } from "#/lib/pack-collection";
import { readBestStreak } from "#/lib/streak-game";
import { getCachedPackFrontCanvas, type PackArtStyle } from "./packArt";

/* The pack page's two games, drawn as packs standing beside the one you
   open: Higher or lower, and the chain run. Each is the site's own pack
   wrapper (packArt.ts) in the game's colour with the game's mark in the seal,
   the game's cards standing up behind it, and its name and the player's best
   underneath. The whole pack is the button. */

/* The chain run's working name. The owner has not settled it, so it lives in
   this one message: renaming the run is this line. */
export const MARATHON_NAME = msg`Marathon`;

export type GameKind = "streak" | "marathon";

type Rgb = { r: number; g: number; b: number };

const ACCENT: Record<GameKind, Rgb> = {
  streak: { r: 102, g: 204, b: 255 },
  marathon: { r: 255, g: 102, b: 170 },
};

const mix = (color: Rgb, target: Rgb, amount: number, alpha: number) =>
  `rgba(${Math.round(color.r + (target.r - color.r) * amount)}, ${Math.round(color.g + (target.g - color.g) * amount)}, ${Math.round(color.b + (target.b - color.b) * amount)}, ${alpha})`;
const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

/* The seal's disc with the game's mark, drawn on a 24-unit grid: two arrows
   passing for Higher or lower, three linked cards for the run. packArt
   cover-fits it into the coin in place of the mania glyph. */
function gameEmblem(kind: GameKind): HTMLCanvasElement {
  const size = 192;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const accent = ACCENT[kind];
  const disc = context.createLinearGradient(0, 0, size, size);
  disc.addColorStop(0, mix(accent, WHITE, 0.3, 1));
  disc.addColorStop(0.5, mix(accent, BLACK, 0.3, 1));
  disc.addColorStop(1, mix(accent, BLACK, 0.8, 1));
  context.fillStyle = disc;
  context.fillRect(0, 0, size, size);
  const glyph = 108;
  context.save();
  context.translate((size - glyph) / 2, (size - glyph) / 2);
  context.scale(glyph / 24, glyph / 24);
  context.shadowColor = "rgba(0,0,0,0.4)";
  context.shadowBlur = 2;
  context.fillStyle = "rgba(255,255,255,0.96)";
  context.strokeStyle = "rgba(255,255,255,0.96)";
  if (kind === "streak") {
    context.lineWidth = 2.6;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke(new Path2D("M8 19V5M3.5 9.5 8 5l4.5 4.5M16 5v14M11.5 14.5 16 19l4.5-4.5"));
  } else {
    // A fanned hand of three cards.
    for (const angle of [-22, 0, 22]) {
      context.save();
      context.translate(12, 21);
      context.rotate((angle * Math.PI) / 180);
      context.beginPath();
      pathRoundRect(context, -3.6, -16, 7.2, 10.5, 1.4);
      context.fill();
      context.restore();
    }
  }
  context.restore();
  return canvas;
}

const packUrlCache = new Map<string, string>();

/* The game's wrapper at full drawn size (600 x 1000), crisp at 2x. */
function gamePackUrl(kind: GameKind, bandName: string): string | null {
  if (typeof document === "undefined") return null;
  const key = `${kind}:${bandName}`;
  const known = packUrlCache.get(key);
  if (known) return known;
  const style: PackArtStyle =
    kind === "streak"
      ? { accent: ACCENT.streak, name: bandName, cardCount: 2, poolLabel: "TOP 500", rank: 2, motif: "scatter" }
      : { accent: ACCENT.marathon, name: bandName, cardCount: CHAIN_RULES.packSize, poolLabel: "ENDLESS", rank: 3, motif: "lanes7" };
  try {
    const url = getCachedPackFrontCanvas({ ...style, emblem: gameEmblem(kind), emblemKey: `game:${kind}` }).toDataURL("image/png");
    packUrlCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

/* A card standing behind a game pack. */
export interface GamePackCard {
  avatarUrl: string;
  tier: ManiaCardTier;
  /* Shown on the name plate; a showcase card has none. */
  name: string | null;
}

/* For a player with no cards yet: portraits only, no names, so the art
   claims nothing about anyone. */
const SHOWCASE: GamePackCard[] = [
  { avatarUrl: "https://a.ppy.sh/2558286", tier: "legendary", name: null },
  { avatarUrl: "https://a.ppy.sh/6447454", tier: "superRare", name: null },
  { avatarUrl: "https://a.ppy.sh/1653229", tier: "mythic", name: null },
  { avatarUrl: "https://a.ppy.sh/5052899", tier: "ultraRare", name: null },
  { avatarUrl: "https://a.ppy.sh/7095193", tier: "elite", name: null },
];

const TIER_RANK: ManiaCardTier[] = [
  "common",
  "rare",
  "elite",
  "superRare",
  "ultraRare",
  "legendary",
  "mythic",
  "ascendant",
  "worldClass",
  "eternal",
  "goat",
];

/* The player's own best cards (highest tier, then pp), five of them, topped up
   from the showcase while the collection is small. */
export function gamePackCards(wallet: PackWallet | null): GamePackCard[] {
  const own = wallet
    ? Object.values(wallet.cards)
        .filter((card) => card.copies > 0 && card.avatarUrl)
        .map((card) => {
          const tier = card.tier ?? "common";
          return { card, tier, rank: TIER_RANK.indexOf(tier) };
        })
        .sort((a, b) => b.rank - a.rank || b.card.pp - a.card.pp)
        .slice(0, 5)
        .map(({ card, tier }) => ({ avatarUrl: card.avatarUrl, tier, name: card.username }))
    : [];
  return [...own, ...SHOWCASE].slice(0, 5);
}

const TRIANGLES = `url("data:image/svg+xml,${encodeURIComponent(maniaTriangleOverlaySvg(100, 140))}")`;

/* A small maniacard face, from the card's own pieces: the tier's fill (or
   its cosmic wash), the triangles, the name plate and the framed portrait.
   Only its top shows above the pack. */
function StandingCard({ card, width, style }: { card: GamePackCard; width: number; style: CSSProperties }) {
  const tierStyle = MANIA_TIER_STYLES[card.tier];
  const cosmic = getCosmicTierPalette(card.tier);
  const radius = Math.max(5, width * 0.08);
  const plate = card.name !== null && width >= 64;
  const plateH = 15;
  const portrait = Math.round(width * 0.68);
  return (
    <div
      className="absolute overflow-hidden shadow-[0_6px_14px_rgba(0,0,0,0.35)]"
      style={{
        width,
        height: width * 1.4,
        borderRadius: radius,
        background: cosmic ? `linear-gradient(145deg, ${cosmic.base.map(([offset, color]) => `${color} ${Math.round(offset * 100)}%`).join(", ")})` : tierStyle.badgeGradient,
        transformOrigin: "50% 100%",
        ...style,
      }}
    >
      {!cosmic && <div className="absolute inset-0" style={{ backgroundImage: TRIANGLES, backgroundSize: "100% 100%" }} />}
      {plate && (
        <div
          className="absolute truncate rounded-[4px] px-[3px] text-center text-[11px] font-black text-white"
          style={{ left: width * 0.07, right: width * 0.07, top: width * 0.06, height: plateH, lineHeight: `${plateH}px`, background: "rgba(0,0,0,0.34)", textShadow: "0 1px 3px rgba(0,0,0,0.55)" }}
        >
          {card.name}
        </div>
      )}
      <img
        src={card.avatarUrl}
        alt=""
        draggable={false}
        loading="lazy"
        className="absolute block bg-black/25 object-cover"
        style={{
          left: (width - portrait) / 2,
          top: plate ? width * 0.06 + plateH + width * 0.05 : width * 0.12,
          width: portrait,
          height: portrait,
          borderRadius: Math.max(4, portrait * 0.12),
          border: "1px solid rgba(255,255,255,0.6)",
        }}
      />
      <div className={`absolute inset-0 border ${tierStyle.border}`} style={{ borderRadius: radius }} />
    </div>
  );
}

/* Where the cards stand behind the pack: [card index, rotation, left as a
   fraction of the pack's width]. */
const FAN: Record<GameKind, Array<[number, number, number]>> = {
  streak: [
    [0, -14, -0.18],
    [1, 12, 0.68],
  ],
  marathon: [
    [2, -18, -0.28],
    [3, 0, 0.25],
    [4, 18, 0.78],
  ],
};

/* How far the standing cards rise above the pack, as a fraction of its
   width: what a caller leaves free above it. */
export const GAME_PACK_RISE = 0.36;

export function GamePack({
  kind,
  width,
  cards,
  best,
  tilt = 0,
  spread = 1,
  onOpen,
}: {
  kind: GameKind;
  width: number;
  cards: GamePackCard[];
  /* The player's best, or null to show the name alone. */
  best: number | null;
  tilt?: number;
  /* How wide the standing cards fan, 1 = full; a row of packs on a phone
     narrows it so neighbours do not collide. */
  spread?: number;
  onOpen: () => void;
}) {
  const { t, i18n } = useLingui();
  const name = kind === "streak" ? t`Higher or lower` : i18n._(MARATHON_NAME);
  // Printed on the foil in the pack's own capitals.
  const bandName = name.toLocaleUpperCase("en-US");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => setUrl(gamePackUrl(kind, bandName)), [kind, bandName]);
  const cardWidth = Math.round(width * 0.5);
  const height = width / 0.6;
  const bestLabel = kind === "streak" ? t`best streak` : t`best round`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={name}
      className="group flex cursor-pointer flex-col items-center gap-3.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-osu-pink"
    >
      <div style={{ transform: tilt ? `rotate(${tilt}deg)` : undefined, transformOrigin: "50% 100%" }}>
        <div
          className="relative transition-transform duration-200 ease-out group-hover:-translate-y-1.5"
          style={{ width, height, filter: "drop-shadow(0 18px 22px rgba(0,0,0,0.45))" }}
        >
          {FAN[kind].map(([index, rotate, left]) => (
            <StandingCard
              key={index}
              card={cards[index % cards.length]}
              width={cardWidth}
              style={{ left: (0.25 + (left - 0.25) * spread) * width, top: -cardWidth * 0.62, transform: `rotate(${rotate * spread}deg)` }}
            />
          ))}
          {url ? (
            <img src={url} alt="" draggable={false} className="relative z-[1] block h-full w-full rounded-[3px]" />
          ) : (
            <div className="relative z-[1] h-full w-full rounded-[3px] bg-osu-b4" />
          )}
        </div>
      </div>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[16px] font-black leading-tight text-white">{name}</div>
        {best !== null && (
          <div className="flex items-baseline gap-1.5">
            <span className="text-[26px] font-black leading-none text-white tabular-nums">{best.toLocaleString("en-US")}</span>
            <span className="text-[11px] font-bold text-osu-f1">{bestLabel}</span>
          </div>
        )}
      </div>
    </button>
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

/* The two game packs for one layout. `side` stands them either side of the
   pack stage (the caller positions the box around the 270px pack); `row`
   puts them side by side under the pack picker. Marathon only appears for a
   viewer the backend has released the run to. */
export function GamePacks({
  layout,
  wallet,
  marathon,
  onStreak,
  onMarathon,
  className = "",
}: {
  layout: "side" | "row";
  wallet: PackWallet | null;
  /* Null hides the run's pack; otherwise its best round, or null for none. */
  marathon: { best: number | null } | null;
  onStreak: () => void;
  onMarathon: () => void;
  className?: string;
}) {
  const cards = useMemo(() => gamePackCards(wallet), [wallet]);
  const bestStreak = useBestStreak();
  if (layout === "row") {
    const width = 112;
    return (
      <div className={`flex justify-center gap-16 ${className}`} style={{ paddingTop: Math.round(width * GAME_PACK_RISE) + 18 }}>
        <GamePack kind="streak" width={width} cards={cards} best={bestStreak} spread={0.55} onOpen={onStreak} />
        {marathon && <GamePack kind="marathon" width={width} cards={cards} best={marathon.best} spread={0.55} onOpen={onMarathon} />}
      </div>
    );
  }
  /* Side by side with the 270 x 450 pack: each game pack is 168 wide, its
     foot level with the pack's, 100px clear of it. */
  const width = 168;
  const gap = 100;
  const top = 450 - width / 0.6;
  return (
    <div className={`pointer-events-none absolute inset-x-0 top-0 ${className}`}>
      <div className="pointer-events-auto absolute" style={{ top, left: `calc(50% - ${135 + gap + width}px)` }}>
        <GamePack kind="streak" width={width} cards={cards} best={bestStreak} tilt={-3} onOpen={onStreak} />
      </div>
      {marathon && (
        <div className="pointer-events-auto absolute" style={{ top, left: `calc(50% + ${135 + gap}px)` }}>
          <GamePack kind="marathon" width={width} cards={cards} best={marathon.best} tilt={3} onOpen={onMarathon} />
        </div>
      )}
    </div>
  );
}
