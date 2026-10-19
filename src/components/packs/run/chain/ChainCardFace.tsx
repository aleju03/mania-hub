import { memo, useId, type CSSProperties, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { CountryFlag } from "#/components/ui/CountryFlag";
import { chainCardColor, chainCardFace, chainCardRarityLabel, chainSkillShort, type ChainCard } from "#/lib/chain-run";
import { MANIA_GLYPH_D, MANIA_TIER_STYLES, maniaTriangleOverlaySvg } from "#/lib/maniacard";
import { getCosmicTierPalette, type CosmicTierPalette } from "#/lib/maniacard-cosmic";

/* The avatar as the card draws it: osu!'s own URL, or a.ppy.sh by id when the
   card carries none. */
export function chainAvatarSrc(card: Pick<ChainCard, "id" | "avatarUrl">): string {
  return card.avatarUrl || `https://a.ppy.sh/${card.id}`;
}

const KEY_INK = "#ffd36b";
const SKILL_INK = "#8ff2b7";
const FLAG_INK = "#7fd3ff";
const LIT_INK: Record<"cc" | "key" | "skill", string> = { cc: FLAG_INK, key: KEY_INK, skill: SKILL_INK };
const TEXT_SHADOW = "0 1px 3px rgba(0,0,0,0.55)";

/* Trait text widths at 11px Torus Heavy (measured), for picking the widest
   chip set a narrow card can hold without wrapping or clipping. */
const SKILL_TEXT_W: Record<ChainCard["skill"], number> = {
  Stream: 34, Jumpstream: 11.6, Handstream: 14.7, Stamina: 39.1, Jack: 22, Chordjack: 13.4, Tech: 22.2, Speed: 28.1,
};
/* The short skill codes a phone hand card falls back to. */
const SKILL_CODE: Record<ChainCard["skill"], [string, number]> = {
  Stream: ["Str", 14.7], Jumpstream: ["JS", 11.6], Handstream: ["HS", 14.7], Stamina: ["Sta", 15.3],
  Jack: ["Jk", 11.6], Chordjack: ["CJ", 13.4], Tech: ["Tec", 16.1], Speed: ["Spd", 18.4],
};

/* Rough width of a rarity word at 11px, to squeeze (never clip) the longest
   ones onto a phone card. CJK glyphs run about a full em. */
function wordWidth11(text: string): number {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) > 0x2e80 ? 11 : char === " " ? 3 : 5.75;
  return width;
}

/* How much finish each rarity gets, one step per tier: osu! triangles (1),
   the card's sheen (2), a foil band (3), foil triangles (4), the notched frame
   from the card back (5), a moving foil sweep (6), full holo (7), and World
   Class's starfield with glints (8, from its cosmic palette). */
const FINISH: Record<ChainCard["tier"], number> = {
  common: 0,
  rare: 1,
  elite: 2,
  superRare: 3,
  ultraRare: 4,
  legendary: 5,
  mythic: 6,
  ascendant: 7,
  worldClass: 8,
};

/* The pale tiers, whose light corners white text cannot sit on. */
const PALE_INK: Partial<Record<ChainCard["tier"], string>> = { legendary: "#78350f", ascendant: "#581c87" };

const HOLO = "#ff8fd0, #ffd36b, #a5f3c4, #7fd3ff, #c4b2ff, #ff8fd0";
const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
// Drawn once on a 100x140 box and stretched: the card is always 1:1.4.
const TRIANGLES = svgUrl(maniaTriangleOverlaySvg(100, 140));
const TRIANGLE_MASK = svgUrl(maniaTriangleOverlaySvg(100, 140, true));

const starfieldCache = new Map<CosmicTierPalette, string>();
function starfield(palette: CosmicTierPalette): string {
  let url = starfieldCache.get(palette);
  if (!url) {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let dots = "";
    for (let index = 0; index < 46; index += 1) {
      const color = palette.stars[Math.floor(rand() * palette.stars.length) % palette.stars.length];
      dots += `<circle cx='${(rand() * 100).toFixed(1)}' cy='${(rand() * 140).toFixed(1)}' r='${(0.22 + rand() * 0.6).toFixed(2)}' fill='rgba(${color},${(0.25 + rand() * 0.6).toFixed(2)})'/>`;
    }
    url = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 140' preserveAspectRatio='none'>${dots}</svg>`);
    starfieldCache.set(palette, url);
  }
  return url;
}

function stops(list: Array<[number, string]>): string {
  return list.map(([offset, color]) => `${color} ${Math.round(offset * 100)}%`).join(", ");
}

/* The cosmic front: the palette's base wash, its two foil pools and the
   aurora band, as drawCosmicBackground paints them on the 3D card. */
function cosmicBackground(palette: CosmicTierPalette): string {
  return [
    `radial-gradient(56% 40% at 25% 15%, ${palette.foilA[0]}, ${palette.foilA[1]} 20%, transparent 62%)`,
    `radial-gradient(52% 37% at 80% 79%, ${palette.foilB[0]}, ${palette.foilB[1]} 26%, transparent 76%)`,
    `linear-gradient(125deg, ${palette.aurora[0]} 0%, ${palette.aurora[1]} 34%, ${palette.aurora[2]} 46%, ${palette.aurora[3]} 66%, ${palette.aurora[4]} 100%)`,
    `linear-gradient(145deg, ${stops(palette.base)})`,
  ].join(", ");
}

function withAlpha(rgba: string, alpha: number): string {
  const match = rgba.match(/rgba?\(([^,]+),([^,]+),([^,)]+)/);
  return match ? `rgba(${match[1].trim()}, ${match[2].trim()}, ${match[3].trim()}, ${alpha})` : rgba;
}

function ManiaGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="-40 -40 1080 1080" aria-hidden className="block">
      <g transform="matrix(1,0,0,-1,0,860)">
        <path d={MANIA_GLYPH_D} fill="#ffffff" />
      </g>
    </svg>
  );
}

/* The four-point glints the cosmic front scatters, at the 3D card's spots. */
const GLINTS: Array<[number, number, number, number]> = [
  [15.2, 9.3, 0.084, 0],
  [83.2, 12.7, 0.052, 1.1],
  [80.8, 72.1, 0.072, 2.0],
  [21.4, 81.4, 0.044, 0.6],
];

/* A player as a chain card, drawn as a pocket maniacard: the tier's own
   gradient, osu! triangles, the mode badge, the name plate and the italic
   tier name, with the three trait marks (what links are made of) on one dark
   strip. Each rarity up adds one finish (see FINISH). Drawn at the size it is
   shown, so every text keeps an 11px floor: under 116px wide it switches to a
   compact face (number and avatar on top, name, then the marks on two lines),
   and under 56px (the deck preview) to just the avatar and number. `lit`
   marks are the ones a link matches, filled in their ink; a rarity link edges
   the card in the rarity's ink. Each mark carries data-trait so the scoring
   chain can flash it. Animated finishes are transform/opacity only, pause
   under reduced motion and are left out while `dim`. */
export const ChainCardFace = memo(function ChainCardFace({
  card: dealt,
  width,
  dim = false,
  lit = null,
}: {
  card: ChainCard;
  width: number;
  dim?: boolean;
  lit?: ReadonlySet<string> | null;
}) {
  const { i18n } = useLingui();
  const id = useId();
  // A GOAT wears the maniacard GOAT's own face and the roster's name and avatar.
  const card = chainCardFace(dealt);
  const rarity = card.goat ? ("goat" as const) : card.tier;
  const style = MANIA_TIER_STYLES[rarity];
  const cosmic = getCosmicTierPalette(rarity);
  const finish = card.goat ? FINISH.worldClass : FINISH[card.tier];
  const animate = !dim;
  const on = (trait: string) => Boolean(lit?.has(trait));
  const w = width;
  const h = w * 1.4;
  const layout = w >= 116 ? "full" : w >= 56 ? "compact" : "micro";
  const radius = Math.max(6, Math.round(w * 0.08));
  const pale = card.goat ? undefined : PALE_INK[card.tier];
  const tierLit = on("tier");
  const tierWord = chainCardRarityLabel(card, i18n);
  /* The rarity word lights like a trait chip when a rarity link matches. */
  const tierWordStyle: CSSProperties = tierLit
    ? { background: chainCardColor(card).ink, color: "#120f1a", padding: "1px 4px", borderRadius: 3 }
    : { color: "#ffffff", textShadow: "0 1px 0 rgba(0,0,0,0.35)" };

  // ---- the surface ---------------------------------------------------------
  const layers: ReactNode[] = [];
  if (cosmic) {
    layers.push(<div key="stars" className="absolute inset-0" style={{ backgroundImage: starfield(cosmic), backgroundSize: "100% 100%" }} />);
  } else if (finish >= 1) {
    layers.push(<div key="tri" className="absolute inset-0" style={{ backgroundImage: TRIANGLES, backgroundSize: "100% 100%", opacity: Math.min(1, 0.75 + finish * 0.06) }} />);
  }
  if (finish >= 2 && !cosmic) {
    // The 3D card's sheen: light from the top-left, a little shade bottom-right.
    layers.push(
      <div key="sheen" className="absolute inset-0" style={{ background: "linear-gradient(118deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 26%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.22) 100%)" }} />,
    );
  }
  if (finish >= 3 && finish <= 5) {
    layers.push(
      <div
        key="band"
        className="absolute inset-0"
        style={{
          background: `linear-gradient(118deg, transparent 30%, ${HOLO.split(", ").map((color, index) => `${color} ${34 + index * 6}%`).join(", ")}, transparent 72%)`,
          mixBlendMode: finish === 3 ? "soft-light" : "overlay",
          opacity: finish === 3 ? 0.85 : 0.5,
        }}
      />,
    );
  }
  if (finish >= 4 && !cosmic) {
    layers.push(
      <div
        key="holo-tri"
        className="absolute inset-0"
        style={{
          background: `linear-gradient(135deg, ${HOLO})`,
          WebkitMaskImage: TRIANGLE_MASK,
          maskImage: TRIANGLE_MASK,
          WebkitMaskSize: "100% 100%",
          maskSize: "100% 100%",
          opacity: 0.4,
        }}
      />,
    );
  }
  if (finish === 7 && animate) {
    layers.push(
      <div key="holo" className="chain-face-holo">
        <i />
      </div>,
    );
  }
  if (finish >= 6 && animate) {
    layers.push(<div key="sweep" className={`chain-face-sweep${cosmic ? " chain-face-sweep-cosmic" : ""}`} style={{ animationDelay: `${-finish * 0.7}s` }} />);
  }

  // The notched frame from the card back, in its own stroke recipe (white
  // into the tier's glow), or the cosmic palette's rim.
  let frame: ReactNode = null;
  if (finish >= 5 && layout !== "micro") {
    const rim: Array<[number, string]> = cosmic
      ? cosmic.rim
      : [
          [0, "rgba(255,255,255,0.9)"],
          [0.34, "rgba(255,255,255,0.34)"],
          [0.62, withAlpha(style.glowColor, 0.92)],
          [1, "rgba(255,255,255,0.5)"],
        ];
    const gradient = `${id}-rim`;
    frame = (
      <svg className="absolute inset-0 h-full w-full" viewBox="56 32 888 1336" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
            {rim.map(([offset, color]) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
        </defs>
        <path
          d="M86 96 Q86 60 122 60 H878 Q914 60 914 96 V340 Q882 356 882 388 V1012 Q882 1044 914 1060 V1304 Q914 1340 878 1340 H122 Q86 1340 86 1304 V1060 Q118 1044 118 1012 V388 Q118 356 86 340 Z"
          fill="none"
          stroke={`url(#${gradient})`}
          strokeWidth={layout === "compact" ? 1.2 : 1.6}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }
  const glints =
    cosmic && animate && layout !== "micro"
      ? GLINTS.map(([x, y, size, delay]) => {
          const px = Math.max(5, w * size);
          return (
            <svg
              key={`${x}`}
              className="chain-face-glint absolute"
              style={{ left: `calc(${x}% - ${px / 2}px)`, top: `calc(${y}% - ${px / 2}px)`, width: px, height: px, animationDelay: `${delay}s` }}
              viewBox="-1 -1 2 2"
              aria-hidden
            >
              <path d="M0 -1Q.16 -.16 1 0Q.16 .16 0 1Q-.16 .16 -1 0Q-.16 -.16 0 -1Z" fill={cosmic.glint} />
            </svg>
          );
        })
      : null;

  // ---- the marks -----------------------------------------------------------
  const markStyle = (trait: "cc" | "key" | "skill"): CSSProperties | undefined =>
    on(trait) ? { background: LIT_INK[trait], color: "#120f1a" } : undefined;
  const flag = <CountryFlag code={card.cc} size="xs" decorative className="!h-[1.05em] !w-[1.55em]" />;
  const skill = chainSkillShort(card.skill);
  const avatar = (size: number, extra: CSSProperties) => (
    <img
      src={chainAvatarSrc(card)}
      alt=""
      draggable={false}
      loading="lazy"
      className="absolute block bg-black/25 object-cover"
      style={{ width: size, height: size, border: `${size > 48 ? 1.5 : 1}px solid rgba(255,255,255,0.6)`, ...extra }}
      onError={(event) => {
        const img = event.currentTarget;
        if (!img.src.endsWith("/avatar-guest.png")) img.src = "https://osu.ppy.sh/images/layout/avatar-guest.png";
      }}
    />
  );

  let content: ReactNode;
  if (layout === "full") {
    const s = w / 130;
    const pad = 7 * s;
    const badge = 22 * s;
    const plateH = Math.max(18, 21 * s);
    const baseSize = Math.round(28 * s);
    const avatarTop = pad + badge + 6 * s;
    const av = Math.round(Math.min(w * 0.66, h - (avatarTop + 6 * s + plateH + 4 * s + baseSize * 0.9 + pad)));
    const cell = { padding: `0 ${Math.max(4, 6 * s)}px` };
    content = (
      <>
        <div className="absolute flex items-stretch" style={{ left: pad, right: pad, top: pad, height: badge, gap: 4 * s }}>
          <div
            className="flex shrink-0 items-center justify-center"
            style={{ width: badge, borderRadius: 6 * s, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.35)" }}
          >
            <ManiaGlyph size={badge * 0.72} />
          </div>
          <div
            className="min-w-0 flex-1 truncate px-[5px] text-center font-black text-white"
            style={{ borderRadius: 6 * s, background: "rgba(0,0,0,0.34)", fontSize: Math.max(11, Math.round(12.5 * s)), lineHeight: `${badge}px`, textShadow: TEXT_SHADOW }}
          >
            {card.name}
          </div>
        </div>
        {avatar(av, { top: avatarTop, left: (w - av) / 2, borderRadius: 9 * s })}
        <div
          className="absolute left-1/2 flex -translate-x-1/2 items-stretch whitespace-nowrap font-black leading-none text-white"
          style={{ top: avatarTop + av + 6 * s, height: plateH, borderRadius: 6 * s, background: "rgba(10,6,24,0.36)", fontSize: Math.max(11, Math.round(12 * s)) }}
        >
          <span data-trait="cc" className="flex items-center rounded-[5px]" style={{ ...cell, ...markStyle("cc") }}>
            {flag}
          </span>
          <span className="h-1/2 w-px self-center bg-white/15" />
          <span data-trait="key" className="flex items-center rounded-[5px]" style={{ ...cell, ...markStyle("key") }}>
            {card.key}K
          </span>
          <span className="h-1/2 w-px self-center bg-white/15" />
          <span data-trait="skill" className="flex items-center rounded-[5px]" style={{ ...cell, ...markStyle("skill") }}>
            {skill}
          </span>
        </div>
        <div
          data-chain-base=""
          className="absolute font-black italic leading-[0.9] tabular-nums tracking-[-0.02em]"
          style={{
            left: pad + 1,
            bottom: pad - 1,
            fontSize: baseSize,
            color: card.tier === "ascendant" ? pale : "#ffffff",
            textShadow: card.tier === "ascendant" ? "0 1.5px 0 rgba(255,255,255,0.6)" : "0 2px 0 rgba(0,0,0,0.28)",
          }}
        >
          {card.base}
        </div>
        <div
          className="absolute whitespace-nowrap font-black italic leading-none"
          style={{ right: pad + 1 - (tierLit ? 4 : 0), bottom: pad + 3 * s - (tierLit ? 2 : 0), fontSize: Math.max(11, Math.round(11 * s)), ...tierWordStyle }}
        >
          {tierWord}
        </div>
      </>
    );
  } else if (layout === "compact") {
    /* A small maniacard: the number in the badge spot beside the name plate,
       the rarity word under the plate where the real card prints it, the
       portrait central and framed, the trait strip along the bottom. When the
       strip runs out of room it gives up text first: full chips, then flag +
       keymode + a skill code, then flag + keymode + a bare skill mark. */
    const pad = Math.max(3, Math.round(w * 0.05));
    const inner = w - pad * 2;
    const plateH = Math.max(15, Math.round(w * 0.16));
    const baseSize = Math.max(12, Math.round(w * 0.15));
    const baseTileW = Math.ceil(baseSize * 0.6 * String(card.base).length) + 6;
    /* Under 80px the number leaves the plate (the name needs it) and stands
       at the portrait's bottom-left, as on the full face. */
    const tight = w < 80;
    const wordTop = pad + plateH + 1;
    const stripH = 15;
    const stripTop = h - pad - stripH;
    const room = stripTop - 3 - (wordTop + 12 + 2);
    const av = Math.floor(Math.min(room, tight ? inner - baseTileW - 2 : inner * 0.8));
    const avTop = wordTop + 12 + 2 + Math.max(0, (room - av) / 2);
    const avLeft = tight ? Math.max((w - av) / 2, pad + baseTileW - 3) : (w - av) / 2;
    const wordScale = Math.min(1, (inner + 1) / (wordWidth11(tierWord) + (tierLit ? 8 : 0)));
    // "4K"/"7K" stays text in every layout; the flag's padding and then the
    // skill code give way first.
    const keyW = 14.1;
    const fullW = 16 + 14.1 + SKILL_TEXT_W[card.skill] + 3 * 5 + 2;
    const [code, codeW] = SKILL_CODE[card.skill];
    const codeFits = 12 + keyW + codeW + 2 * 3 + 1 + 2 <= inner;
    const mode = fullW <= inner ? "full" : codeFits ? "code" : "glyph";
    const chip = mode === "full" ? "px-[2.5px]" : "px-[1.5px]";
    content = (
      <>
        <div className="absolute flex items-stretch gap-[2px]" style={{ left: pad, right: pad, top: pad, height: plateH }}>
          {!tight && (
            <div
              data-chain-base=""
              className="flex shrink-0 items-center justify-center font-black italic leading-none tabular-nums tracking-[-0.02em]"
              style={{ width: baseTileW, fontSize: baseSize, borderRadius: 4, background: "rgba(0,0,0,0.24)", border: "1px solid rgba(255,255,255,0.35)", textShadow: TEXT_SHADOW }}
            >
              {card.base}
            </div>
          )}
          <div
            className="min-w-0 flex-1 truncate px-[3px] text-center text-[11px] font-black text-white"
            style={{ borderRadius: 4, background: "rgba(0,0,0,0.34)", lineHeight: `${plateH}px`, textShadow: TEXT_SHADOW }}
          >
            {card.name}
          </div>
        </div>
        <div
          className="absolute whitespace-nowrap text-[11px] font-black italic leading-[12px]"
          style={{
            right: pad,
            top: wordTop,
            transform: wordScale < 1 ? `scaleX(${wordScale.toFixed(3)})` : undefined,
            transformOrigin: "100% 50%",
            ...tierWordStyle,
            // The pale tiers are light up here, so their word prints dark.
            ...(pale && !tierLit ? { color: pale, textShadow: "none" } : null),
          }}
        >
          {tierWord}
        </div>
        {avatar(av, { top: avTop, left: avLeft, borderRadius: Math.max(5, av * 0.12) })}
        {tight && (
          <div
            data-chain-base=""
            className="absolute font-black italic leading-none tabular-nums tracking-[-0.02em]"
            style={{ left: pad, top: avTop + av - baseSize, fontSize: baseSize, color: pale ?? "#ffffff", textShadow: pale ? "0 1px 0 rgba(255,255,255,0.5)" : TEXT_SHADOW }}
          >
            {card.base}
          </div>
        )}
        <div
          className="absolute flex items-stretch justify-center whitespace-nowrap rounded-[4px] text-[11px] font-black leading-none text-white"
          style={{ left: pad, right: pad, top: stripTop, height: stripH, background: "rgba(10,6,24,0.36)" }}
        >
          <span data-trait="cc" className={`flex items-center rounded-[3px] ${mode === "full" ? chip : "px-[0.5px]"}`} style={markStyle("cc")}>
            <CountryFlag code={card.cc} size="xs" decorative className={mode === "full" ? "!h-[11px] !w-[16px]" : "!h-[8.5px] !w-[12px]"} />
          </span>
          <span className="h-1/2 w-px self-center bg-white/15" />
          <span data-trait="key" className={`flex items-center rounded-[3px] ${chip}`} style={markStyle("key")}>
            {card.key}K
          </span>
          <span className="h-1/2 w-px self-center bg-white/15" />
          <span data-trait="skill" className={`flex items-center rounded-[3px] ${chip}`} style={markStyle("skill")} title={card.skill}>
            {mode === "full" ? skill : mode === "code" ? code : <span className="block h-[5px] w-[5px] rotate-45 bg-current" />}
          </span>
        </div>
      </>
    );
  } else {
    const pad = 3;
    const av = Math.round(w - pad * 2);
    content = (
      <>
        {avatar(av, { top: pad, left: pad, borderRadius: 5 })}
        <div
          data-chain-base=""
          className="absolute inset-x-0 text-center text-[12px] font-black italic leading-none tabular-nums"
          style={{ bottom: Math.max(2, (h - pad - av - 12) / 2), color: pale ?? "#ffffff", textShadow: pale ? "none" : "0 1px 0 rgba(0,0,0,0.3)" }}
        >
          {card.base}
        </div>
      </>
    );
  }

  return (
    <div
      className="relative h-full w-full select-none overflow-hidden text-white"
      style={{
        borderRadius: radius,
        background: cosmic ? cosmicBackground(cosmic) : style.badgeGradient,
        filter: dim ? "saturate(0.35) brightness(0.55)" : undefined,
      }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ borderRadius: radius }}>
        {layers}
        {frame}
        {glints}
      </div>
      {content}
      {/* The tier edge, which a rarity link inks: what the chain flashes for it. */}
      <div
        data-trait="tier"
        className={`pointer-events-none absolute inset-0 ${on("tier") ? "" : `border ${style.border}`}`}
        style={{
          borderRadius: radius,
          borderWidth: on("tier") ? 0 : layout === "full" ? 1.5 : 1,
          // The ink ring with a dark hairline inside, so it reads even on the
          // tier's own colour.
          boxShadow: on("tier")
            ? `inset 0 0 0 ${Math.max(3, Math.round(w * 0.028))}px ${chainCardColor(card).ink}, inset 0 0 0 ${Math.max(3, Math.round(w * 0.028)) + 1.5}px rgba(10,6,24,0.55)`
            : undefined,
        }}
      />
    </div>
  );
});
