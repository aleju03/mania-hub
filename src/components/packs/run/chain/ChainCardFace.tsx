import { memo, useId, type CSSProperties, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { CountryFlag } from "#/components/ui/CountryFlag";
import { CHAIN_VARIANT_COPY, chainCardColor, chainCardFace, chainCardRarityLabel, chainSkillShort, type ChainCard } from "#/lib/chain-run";
import { MANIA_TIER_STYLES, maniaTriangleOverlaySvg } from "#/lib/maniacard";
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
  Chordstream: 13.4, Bracket: 40.5, Delay: 28.4,
};
/* The short skill codes a phone hand card falls back to. */
const SKILL_CODE: Record<ChainCard["skill"], [string, number]> = {
  Stream: ["Str", 14.7], Jumpstream: ["JS", 11.6], Handstream: ["HS", 14.7], Stamina: ["Sta", 15.3],
  Jack: ["Jk", 11.6], Chordjack: ["CJ", 13.4], Tech: ["Tec", 16.1], Speed: ["Spd", 18.4],
  Chordstream: ["CS", 13.4], Bracket: ["Brk", 18.4], Delay: ["Dly", 17.2],
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

/* The four-point glints the cosmic front scatters, at the 3D card's spots. */
const GLINTS: Array<[number, number, number, number]> = [
  [15.2, 9.3, 0.084, 0],
  [83.2, 12.7, 0.052, 1.1],
  [80.8, 72.1, 0.072, 2.0],
  [21.4, 81.4, 0.044, 0.6],
];

/* A player as a chain card: the portrait edge to edge across the top under
   the name, and a panel in the tier's deep tone holding the three trait marks
   (what links are made of), the number and the rarity pill, all inside a
   rim in the tier's ink. The tier's maniacard surface (gradient, osu!
   triangles) shows through the panel, and each rarity up adds one finish
   (see FINISH); the moving ones run over the portrait too. Drawn at the size
   it is shown, so every text keeps an 11px floor: under 116px wide it
   switches to a compact face, and under 56px (the deck preview) to just the
   portrait and number. `lit` marks are the ones a link matches, filled in
   their ink; a rarity link thickens the rim in the rarity's ink. Each mark
   carries data-trait so the scoring chain can flash it. Animated finishes
   are transform/opacity only, pause under reduced motion and are left out
   while `dim`. */
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
  const color = chainCardColor(card);
  const tierLit = on("tier");
  const tierWord = chainCardRarityLabel(card, i18n);
  const variant = card.variant ? CHAIN_VARIANT_COPY[card.variant] : null;

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
  // The moving finishes run over the portrait too.
  const over: ReactNode[] = [];
  if (finish === 7 && animate) {
    over.push(
      <div key="holo" className="chain-face-holo">
        <i />
      </div>,
    );
  }
  if (finish >= 6 && animate) {
    over.push(<div key="sweep" className={`chain-face-sweep${cosmic ? " chain-face-sweep-cosmic" : ""}`} style={{ animationDelay: `${-finish * 0.7}s` }} />);
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
  const skill = chainSkillShort(card.skill);
  /* The portrait, edge to edge across the top, fading into the panel. */
  const art = (artH: number) => (
    <>
      <img
        src={chainAvatarSrc(card)}
        alt=""
        draggable={false}
        loading="lazy"
        className="absolute left-0 top-0 block object-cover"
        style={{ width: w, height: artH, objectPosition: "50% 30%", background: color.deep, transform: card.variant === "mirror" ? "scaleX(-1)" : undefined }}
        onError={(event) => {
          const img = event.currentTarget;
          if (!img.src.endsWith("/avatar-guest.png")) img.src = "https://osu.ppy.sh/images/layout/avatar-guest.png";
        }}
      />
      {card.variant === "mirror" && (
        // A chrome pane over the flipped portrait: two cold streaks.
        <div
          className="absolute inset-x-0 top-0"
          style={{
            height: artH,
            background: "linear-gradient(118deg, transparent 18%, rgba(224,242,254,0.55) 24%, transparent 31%, transparent 52%, rgba(186,230,253,0.35) 57%, transparent 61%)",
            mixBlendMode: "screen",
          }}
        />
      )}
      <div className="absolute inset-x-0" style={{ top: artH * 0.5, height: artH * 0.5 + 1, background: `linear-gradient(180deg, transparent, ${color.deep}d9)` }} />
    </>
  );
  /* The info panel under the portrait: the tier's deep tone over its surface,
     so the triangles and finishes still show through toward the bottom. */
  const panel = (top: number) => (
    <div
      className="absolute inset-x-0 bottom-0 overflow-hidden"
      style={{
        top,
        background:
          card.variant === "silver"
            ? // Brushed silver: fine horizontal grain over a cold steel wash.
              `repeating-linear-gradient(180deg, rgba(255,255,255,0.07) 0 1px, transparent 1px 3px), linear-gradient(115deg, #3b4350e6 0%, #8a94a3d9 38%, #4b5563e6 62%, #9aa4b2cc 100%)`
            : `linear-gradient(180deg, ${color.deep}e0 0%, ${color.deep}a6 55%, ${color.deep}73 100%)`,
        borderTop: `1px solid ${variant && card.variant === "silver" ? "#e2e8f0aa" : `${color.ink}40`}`,
      }}
    >
      {card.variant === "max" && animate && (
        // MAX's rainbow shimmer runs under the panel's text, off the face.
        <div className="chain-face-holo" style={{ opacity: 0.6 }}>
          <i />
        </div>
      )}
    </div>
  );
  /* The variant's badge, top right over the portrait. */
  const badgeFont = Math.max(11, Math.round(10 * (w / 130)));
  const badgeW = variant ? Math.ceil(wordWidth11(variant.badge) * 1.25 * (badgeFont / 11)) + 8 : 0;
  const badge = (pad: number) =>
    variant ? (
      <div
        className="absolute whitespace-nowrap font-black italic leading-none tracking-[0.04em]"
        style={{
          right: pad,
          top: pad - 1,
          fontSize: badgeFont,
          padding: "2px 4px",
          borderRadius: 4,
          background: variant.fill,
          color: card.variant === "max" ? "#1a1020" : card.variant === "pfc" ? "#3b2500" : card.variant === "mirror" ? "#0c4a6e" : card.variant === "replay" ? "#053d36" : "#1e293b",
          boxShadow: "0 1px 3px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.7)",
        }}
      >
        {variant.badge}
      </div>
    ) : null;
  const nameplate = (fontSize: number, pad: number) => (
    <>
      <div className="absolute inset-x-0 top-0" style={{ height: fontSize * 2.6, background: "linear-gradient(180deg, rgba(6,8,18,0.72), rgba(6,8,18,0))" }} />
      <div
        className="absolute truncate font-bold leading-none text-white"
        style={{ left: pad, right: pad + (badgeW ? badgeW + 3 : 0), top: pad, fontSize, lineHeight: `${Math.round(fontSize * 1.2)}px`, textShadow: TEXT_SHADOW }}
      >
        {card.name}
      </div>
    </>
  );

  let content: ReactNode;
  if (layout === "full") {
    const s = w / 130;
    const pad = 8 * s;
    const panelH = Math.round(h * 0.34);
    const panelTop = h - panelH;
    const baseSize = Math.round(28 * s);
    const traitH = Math.max(16, 17 * s);
    const traitSize = Math.max(11, Math.round(12 * s));
    const cell = { padding: `0 ${Math.max(3, 4 * s)}px` };
    const pillSize = Math.max(11, Math.round(10 * s));
    const pillPad = Math.round(6 * s);
    // The rarity pill squeezes (never clips) beside a wide number.
    const pillRoom = w - pad * 2 - baseSize * 0.62 * String(card.base + (card.grown ?? 0)).length - 6 * s;
    const pillW = wordWidth11(tierWord.toUpperCase()) * 1.28 * (pillSize / 11) + pillPad * 2;
    const pillScale = Math.min(1, pillRoom / pillW);
    content = (
      <>
        {art(panelTop)}
        {panel(panelTop)}
        {nameplate(Math.max(11, Math.round(13 * s)), pad)}
        {badge(pad)}
        <div
          className="absolute flex items-stretch whitespace-nowrap font-bold leading-none text-white"
          style={{ left: pad - 4 * s, top: panelTop + 6 * s, height: traitH, fontSize: traitSize, textShadow: TEXT_SHADOW }}
        >
          <span data-trait="cc" className="flex items-center rounded-[4px]" style={{ ...cell, ...markStyle("cc") }}>
            <CountryFlag code={card.cc} size="xs" decorative className="!h-[1.05em] !w-[1.55em]" />
          </span>
          <span className="h-3/5 w-px self-center bg-white/25" />
          <span data-trait="key" className="flex items-center rounded-[4px]" style={{ ...cell, ...markStyle("key") }}>
            {card.key}K
          </span>
          <span className="h-3/5 w-px self-center bg-white/25" />
          <span data-trait="skill" className="flex items-center rounded-[4px]" style={{ ...cell, ...markStyle("skill") }}>
            {skill}
          </span>
        </div>
        <div
          data-chain-base=""
          className="absolute font-black leading-[0.82] tabular-nums tracking-[-0.03em] text-white"
          style={{ left: pad, bottom: pad, fontSize: baseSize, textShadow: "0 2px 4px rgba(0,0,0,0.45)" }}
        >
          {card.base + (card.grown ?? 0)}
        </div>
        <div
          className="absolute whitespace-nowrap font-black uppercase leading-none tracking-[0.08em]"
          style={{
            right: pad,
            bottom: pad + 1 * s,
            fontSize: pillSize,
            padding: `${Math.round(3 * s)}px ${pillPad}px`,
            borderRadius: 5 * s,
            transform: pillScale < 1 ? `scaleX(${pillScale.toFixed(3)})` : undefined,
            transformOrigin: "100% 50%",
            ...(tierLit
              ? { background: color.ink, color: "#120f1a" }
              : { background: `${color.fill}8c`, color: color.ink, boxShadow: `inset 0 0 0 1px ${color.ink}66`, textShadow: "0 1px 0 rgba(0,0,0,0.35)" }),
          }}
        >
          {tierWord}
        </div>
      </>
    );
  } else if (layout === "compact") {
    /* The same card in small: name over the portrait, then the trait strip,
       then the number and the rarity word. When the strip runs out of room
       it gives up text first: full chips, then flag + keymode + a skill code,
       then flag + keymode + a bare skill mark. */
    const pad = Math.max(3, Math.round(w * 0.06));
    const inner = w - pad * 2;
    const stripH = 15;
    const baseSize = Math.max(13, Math.round(w * 0.17));
    const panelH = 3 + stripH + 2 + Math.round(baseSize * 0.85) + pad;
    const panelTop = Math.round(h - panelH);
    const baseW = baseSize * 0.62 * String(card.base + (card.grown ?? 0)).length;
    const wordScale = Math.min(1, (inner - baseW - 3) / (wordWidth11(tierWord.toUpperCase()) * 1.2 + (tierLit ? 8 : 0)));
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
        {art(panelTop)}
        {panel(panelTop)}
        {nameplate(11, pad)}
        {badge(pad)}
        <div
          className="absolute flex items-stretch whitespace-nowrap text-[11px] font-bold leading-none text-white"
          style={{ left: pad - (mode === "full" ? 2.5 : 1.5), top: panelTop + 3, height: stripH, textShadow: TEXT_SHADOW }}
        >
          <span data-trait="cc" className={`flex items-center rounded-[3px] ${mode === "full" ? chip : "px-[0.5px]"}`} style={markStyle("cc")}>
            <CountryFlag code={card.cc} size="xs" decorative className={mode === "full" ? "!h-[11px] !w-[16px]" : "!h-[8.5px] !w-[12px]"} />
          </span>
          <span className="h-1/2 w-px self-center bg-white/25" />
          <span data-trait="key" className={`flex items-center rounded-[3px] ${chip}`} style={markStyle("key")}>
            {card.key}K
          </span>
          <span className="h-1/2 w-px self-center bg-white/25" />
          <span data-trait="skill" className={`flex items-center rounded-[3px] ${chip}`} style={markStyle("skill")} title={card.skill}>
            {mode === "full" ? skill : mode === "code" ? code : <span className="block h-[5px] w-[5px] rotate-45 bg-current" />}
          </span>
        </div>
        <div
          data-chain-base=""
          className="absolute font-black leading-[0.82] tabular-nums tracking-[-0.03em] text-white"
          style={{ left: pad, bottom: pad, fontSize: baseSize, textShadow: TEXT_SHADOW }}
        >
          {card.base + (card.grown ?? 0)}
        </div>
        <div
          className="absolute whitespace-nowrap text-[11px] font-black uppercase leading-[12px] tracking-[0.04em]"
          style={{
            right: pad - (tierLit ? 3 : 0),
            bottom: pad,
            transform: wordScale < 1 ? `scaleX(${Math.max(0.5, wordScale).toFixed(3)})` : undefined,
            transformOrigin: "100% 50%",
            ...(tierLit ? { background: color.ink, color: "#120f1a", padding: "0 3px", borderRadius: 3 } : { color: color.ink, textShadow: TEXT_SHADOW }),
          }}
        >
          {tierWord}
        </div>
      </>
    );
  } else {
    const numberH = 15;
    content = (
      <>
        {art(h)}
        <div
          data-chain-base=""
          className="absolute inset-x-0 text-center text-[12px] font-black leading-none tabular-nums text-white"
          style={{ bottom: Math.max(2, (numberH - 12) / 2 + 1), textShadow: TEXT_SHADOW }}
        >
          {card.base + (card.grown ?? 0)}
        </div>
      </>
    );
  }

  const rimW = layout === "full" ? Math.max(1.5, 2 * (w / 130)) : 1.25;
  /* A variant inks the rim in its own colour; MAX's is a rainbow ring. */
  const rimInk = variant && card.variant !== "max" ? variant.ink : color.ink;
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
        {glints}
      </div>
      {content}
      {card.variant === "max" && !tierLit && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: radius,
            padding: rimW + 0.5,
            background: `linear-gradient(135deg, ${HOLO})`,
            WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
            WebkitMaskComposite: "xor",
            maskComposite: "exclude",
          }}
        />
      )}
      {(frame || over.length > 0) && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ borderRadius: radius }}>
          {over}
          {frame}
        </div>
      )}
      {/* The tier rim, which a rarity link inks: what the chain flashes for it. */}
      <div
        data-trait="tier"
        className="pointer-events-none absolute inset-0"
        style={{
          borderRadius: radius,
          // The ink ring with a dark hairline inside, so it reads even on the
          // tier's own colour.
          boxShadow: tierLit
            ? `inset 0 0 0 ${Math.max(3, Math.round(w * 0.028))}px ${color.ink}, inset 0 0 0 ${Math.max(3, Math.round(w * 0.028)) + 1.5}px rgba(10,6,24,0.55)`
            : card.variant === "max"
              ? `inset 0 0 ${Math.round(w * 0.08)}px rgba(255,255,255,0.35)`
              : `inset 0 0 0 ${rimW + (variant ? 0.5 : 0)}px ${rimInk}d9, inset 0 0 ${Math.round(w * (variant ? 0.09 : 0.06))}px ${rimInk}${variant ? "73" : "4d"}`,
        }}
      />
    </div>
  );
});
