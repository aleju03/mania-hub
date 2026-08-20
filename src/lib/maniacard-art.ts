/* The maniacard front, as one satori element tree.
 *
 * Every flat picture of a card comes from here: the /api/og share image, the
 * Discord /maniacard reply, the pull permalink embed, and the "Card front"
 * dynamic render. They are the same card because they are the same code -
 * before this lived on its own, a layout change had to be copied by hand into
 * whichever surface had gone out of step, and the numbers agreeing while the
 * art did not is exactly the failure a share image cannot afford.
 *
 * Coordinates are absolute against a 720x1008 card and were tuned there. A
 * caller that needs it smaller rasterizes at this size and scales the pixels
 * rather than re-tuning them, because satori has no layout scale and the
 * positions here mirror maniacard3d/cardTexture.ts, which is where they came
 * from.
 */

import { createElement as h } from "react";

import { formatOgInt } from "./og-render";
import { getAssetOrigin } from "./origin";
import { MANIA_TIER_STYLES } from "./maniacard";
import type { ManiaCardTier } from "./maniacard";
import type { CardMotif } from "./card-motif";
import { readImageSize, sniffImageMime } from "./image-sniff";
import { getCosmicTierPalette } from "./maniacard-cosmic";
import type { CosmicTierPalette } from "./maniacard-cosmic";
import {
  CARD_CORNER_RADIUS,
  CARD_TEXTURE_HEIGHT,
  CARD_TEXTURE_WIDTH,
} from "../components/player/maniacard3d/layout";

export const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

// The mania glyph is authored y-up (the in-app canvas flips it), so flip it for
// svg's y-down space. Inlined as a data url since Satori rasterizes svg images.
function maniaGlyphDataUrl(): string {
  // Baseline sits at 0.86 of the glyph height (matches the in-app card); pad the
  // viewBox so the flipped glyph is centred and never clips.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -40 1080 1080"><g transform="matrix(1,0,0,-1,0,860)"><path d="${MANIA_GLYPH_D}" fill="#ffffff"/></g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function starDataUrl(fill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 4 L62 38 L98 38 L69 60 L80 96 L50 74 L20 96 L31 60 L2 38 L38 38 Z" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Floating osu-style triangles: a jittered grid so positions never line up,
// varied sizes, up or down but never tilted, overlapping into soft facets.
// Baked as explicit paths so resvg rasterizes it reliably as an img.
export function triangleOverlayDataUrl(w: number, height: number): string {
  const sx = w / 1000;
  const sy = height / 1400;
  const rand = (n: number) => {
    const v = Math.sin(n) * 43758.5453123;
    return v - Math.floor(v);
  };
  const poly = (pts: Array<[number, number]>, fill: string) =>
    `<path d="${pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} Z" fill="${fill}"/>`;
  let paths = "";
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const i = row * 11 + col;
      if (rand(i * 19.17 + 4.2) < 0.4) continue;
      const cx = (col * 200 + 100 + (rand(i * 43.91 + 8.5) - 0.5) * 130) * sx;
      const cy = (row * 233 + 117 + (rand(i * 29.37 + 12.4) - 0.5) * 130) * sy;
      const side = (230 + rand(i * 13.81 + 2.7) * 300) * sx;
      const hgt = side * 0.866;
      const up = rand(i * 7.3 + 3.1) > 0.5;
      const pts: Array<[number, number]> = up
        ? [[cx, cy - (hgt * 2) / 3], [cx + side / 2, cy + hgt / 3], [cx - side / 2, cy + hgt / 3]]
        : [[cx, cy + (hgt * 2) / 3], [cx + side / 2, cy - hgt / 3], [cx - side / 2, cy - hgt / 3]];
      // Fewer, larger, low-contrast facets (subtle like the reference). Dark
      // ones stay extra faint since dark-on-light reads strongly; ~50/50
      // light/dark so the pale top and dark bottom each show some.
      const dark = rand(i * 3.11 + 6.9) > 0.5;
      const a = dark ? 0.035 + rand(i * 5.21 + 1.3) * 0.04 : 0.05 + rand(i * 5.21 + 1.3) * 0.06;
      paths += poly(pts, dark ? `rgba(0,0,0,${a.toFixed(3)})` : `rgba(255,255,255,${a.toFixed(3)})`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}">${paths}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/* A granted card's background art, inlined so resvg never has to reach the
   network mid-render.

   Fetched here rather than pointed at: satori resolves remote images itself,
   but a slow or dead host would then stall (or fail) the whole embed, and this
   one is a URL somebody typed into an admin form. Bounded and cached for the
   life of the process, like the laurel above - a motif URL names one picture,
   and the handful of granted cards share very few of them. */
const MOTIF_OG_MAX_BYTES = 2 * 1024 * 1024;
const MOTIF_OG_TIMEOUT_MS = 4_000;
interface InlinedMotif {
  dataUrl: string;
  /* Width over height, read straight from the header: satori will not measure
     a data URL, so every copy is laid out from this. Falls back to square for
     a format readImageSize does not parse. */
  aspect: number;
}

const motifDataUrlCache = new Map<string, Promise<InlinedMotif | null>>();

export function cardMotifDataUrl(motif: CardMotif): Promise<InlinedMotif | null> {
  const cached = motifDataUrlCache.get(motif.url);
  if (cached) return cached;
  const pending = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MOTIF_OG_TIMEOUT_MS);
    try {
      const response = await fetch(motif.url, { redirect: "follow", signal: controller.signal });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MOTIF_OG_MAX_BYTES) return null;
      const mime = sniffImageMime(buffer);
      if (!mime) return null;
      const size = readImageSize(buffer);
      return {
        dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
        aspect: size && size.width > 0 && size.height > 0 ? size.width / size.height : 1,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })();
  motifDataUrlCache.set(motif.url, pending);
  return pending;
}

/* The motif scattered over the card, one absolutely positioned img per copy.

   Same jittered grid, sizes and per-copy alpha as drawMotifPattern in
   maniacard3d/cardTexture.ts, which in turn mirrors the overlay shader's
   drifting copies, on the same 1000x1400 texture space, so a card shared into
   Discord scatters its art the way the card on the page does.
   Emitted as elements rather than as one nested SVG because satori hands an
   img straight to resvg, while a raster embedded inside an SVG that is itself
   an img is a rasterizer path this endpoint has no reason to depend on. */
function motifSpriteElements(motif: CardMotif, dataUrl: string, aspect: number, w: number, height: number) {
  const sx = w / CARD_TEXTURE_WIDTH;
  const sy = height / CARD_TEXTURE_HEIGHT;
  const rand = (value: number) => {
    const v = Math.sin(value) * 43758.5453123;
    return v - Math.floor(v);
  };
  const cellWidth = CARD_TEXTURE_WIDTH / 3;
  const cellHeight = CARD_TEXTURE_HEIGHT / 4;
  const sprites = [];
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const index = row * 13 + col;
      const size = (86 + rand(index * 13.81 + 2.7) * 54) * motif.scale;
      const spriteW = (aspect >= 1 ? size : size * aspect) * sx;
      const spriteH = (aspect >= 1 ? size / aspect : size) * sy;
      const cx = (col + 0.5 + (rand(index * 43.91 + 8.5) - 0.5) * 0.78) * cellWidth * sx;
      const cy = (row + 0.5 + (rand(index * 29.37 + 12.4) - 0.5) * 0.78) * cellHeight * sy;
      if (cx - spriteW / 2 < 6 || cx + spriteW / 2 > w - 6) continue;
      if (cy - spriteH / 2 < 6 || cy + spriteH / 2 > height - 6) continue;
      const rotation = (rand(index * 31.7 + 11.2) - 0.5) * 0.62;
      sprites.push(
        h("img", {
          key: `motif${index}`,
          src: dataUrl,
          style: {
            position: "absolute",
            left: `${(cx - spriteW / 2).toFixed(1)}px`,
            top: `${(cy - spriteH / 2).toFixed(1)}px`,
            width: `${spriteW.toFixed(1)}px`,
            height: `${spriteH.toFixed(1)}px`,
            opacity: motif.opacity * (0.46 + rand(index * 5.21 + 1.3) * 0.32),
            transform: `rotate(${((rotation * 180) / Math.PI).toFixed(2)}deg)`,
          },
        }),
      );
    }
  }
  return sprites;
}

/* World Class and GOAT do not use the flat tier gradient: the in-app card
   paints a near-black base under two radial foil blooms, an aurora sweep, a
   seeded starfield, sparkle glints, and a foil rim. Satori has no canvas, so
   the whole front goes out as one SVG on the card texture's own 1000x1400
   viewBox (same aspect as the OG card, so the <img> just scales it). Every
   coordinate, stop, and seed below is the one drawCosmicBackground /
   drawCosmicStarfield / drawCosmicFoilAccents use in cardTexture.ts. */
function svgColorParts(color: string): { fill: string; opacity: string } {
  const match = color.match(/^rgba\(([^)]+)\)$/i);
  if (!match) return { fill: color, opacity: "1" };
  const parts = match[1].split(",").map((part) => part.trim());
  return { fill: `rgb(${parts.slice(0, 3).join(",")})`, opacity: parts[3] ?? "1" };
}

function svgGradientStops(stops: Array<[number, string]>): string {
  return stops
    .map(([offset, color]) => {
      const { fill, opacity } = svgColorParts(color);
      return `<stop offset="${offset}" stop-color="${fill}" stop-opacity="${opacity}"/>`;
    })
    .join("");
}

export function cosmicBackgroundDataUrl(palette: CosmicTierPalette, starfield = true): string {
  const W = CARD_TEXTURE_WIDTH;
  const H = CARD_TEXTURE_HEIGHT;
  const rand = (value: number) => {
    const v = Math.sin(value) * 43758.5453123;
    return v - Math.floor(v);
  };
  // Same 18px margin test as the canvas starfield, so no star lands on the
  // rounded corner the real card cuts away.
  const inside = (x: number, y: number) => {
    const r = CARD_CORNER_RADIUS;
    if (x < 18 || x > W - 18 || y < 18 || y > H - 18) return false;
    const cornerX = x < r ? r : x > W - r ? W - r : null;
    const cornerY = y < r ? r : y > H - r ? H - r : null;
    if (cornerX !== null && cornerY !== null && Math.hypot(x - cornerX, y - cornerY) > r - 18) return false;
    return true;
  };

  let stars = "";
  for (let index = 0; index < 130; index += 1) {
    const x = rand(index * 19.43 + 2.1) * W;
    const y = rand(index * 31.77 + 8.4) * H;
    if (!inside(x, y)) continue;
    const radius = 0.8 + rand(index * 7.91 + 4.6) * 2.4;
    const alpha = 0.14 + rand(index * 11.23 + 1.9) * 0.46;
    const color = palette.stars[Math.floor(rand(index * 5.37 + 3.3) * palette.stars.length) % palette.stars.length];
    // Every 16th star carries a soft halo, so the field reads as depth
    // rather than uniform noise.
    if (index % 16 === 5) {
      stars +=
        `<radialGradient id="h${index}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(radius * 7).toFixed(1)}" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0" stop-color="rgb(${color})" stop-opacity="${(alpha * 0.5).toFixed(3)}"/>` +
        `<stop offset="1" stop-color="rgb(${color})" stop-opacity="0"/>` +
        `</radialGradient>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(radius * 7).toFixed(1)}" fill="url(#h${index})"/>`;
    }
    stars +=
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" fill="rgb(${color})" fill-opacity="${alpha.toFixed(3)}"/>`;
  }

  const glint = svgColorParts(palette.glint);
  const glints = ([
    [152, 130, 42, 0.7],
    [832, 178, 26, 0.46],
    [808, 1010, 36, 0.42],
    [214, 1140, 22, 0.36],
  ] as Array<[number, number, number, number]>)
    .map(([x, y, size, opacity]) => {
      const d =
        `M${x} ${y - size} L${x + size * 0.22} ${y - size * 0.22} L${x + size} ${y} ` +
        `L${x + size * 0.22} ${y + size * 0.22} L${x} ${y + size} L${x - size * 0.22} ${y + size * 0.22} ` +
        `L${x - size} ${y} L${x - size * 0.22} ${y - size * 0.22} Z`;
      return `<path d="${d}" fill="${glint.fill}" fill-opacity="${(Number(glint.opacity) * opacity).toFixed(3)}"/>`;
    })
    .join("");

  const rimGlow = svgColorParts(palette.rimGlow);
  const svg =
    // preserveAspectRatio="none": the pack fan's mini cards are a hair wider
    // than the texture's ratio, and a stretch of ~1% beats letterboxed bars.
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<defs>` +
    `<linearGradient id="base" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">${svgGradientStops(palette.base)}</linearGradient>` +
    `<radialGradient id="foilA" cx="250" cy="210" r="560" gradientUnits="userSpaceOnUse">${svgGradientStops([
      [0, palette.foilA[0]],
      [0.2, palette.foilA[1]],
      [0.62, "rgba(0,0,0,0)"],
    ])}</radialGradient>` +
    `<radialGradient id="foilB" cx="800" cy="1110" r="520" gradientUnits="userSpaceOnUse">${svgGradientStops([
      [0, palette.foilB[0]],
      [0.26, palette.foilB[1]],
      [0.76, "rgba(0,0,0,0)"],
    ])}</radialGradient>` +
    `<linearGradient id="aurora" x1="0" y1="180" x2="${W}" y2="880" gradientUnits="userSpaceOnUse">${svgGradientStops([
      [0, palette.aurora[0]],
      [0.34, palette.aurora[1]],
      [0.46, palette.aurora[2]],
      [0.66, palette.aurora[3]],
      [1, palette.aurora[4]],
    ])}</linearGradient>` +
    `<linearGradient id="rim" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">${svgGradientStops(palette.rim)}</linearGradient>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#base)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#foilA)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#foilB)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#aurora)"/>` +
    // Dropped when the holding floats a motif: that image takes the place of
    // this field, exactly as it does on the canvas card.
    (starfield ? stars : "") +
    glints +
    // The canvas rim leans on a shadow blur for its bloom; resvg filters are a
    // gamble, so a wide soft pass under the crisp stroke stands in for it.
    `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="${CARD_CORNER_RADIUS - 6}" fill="none" stroke="${rimGlow.fill}" stroke-opacity="${(Number(rimGlow.opacity) * 0.5).toFixed(3)}" stroke-width="18"/>` +
    `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="${CARD_CORNER_RADIUS - 6}" fill="none" stroke="url(#rim)" stroke-width="6"/>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/* GOAT's laurel watermark: the card back's wreath, tinted to the tier glow and
   dropped behind the avatar at 13%. The asset paints every leaf in one green,
   so recolouring is a straight swap of that fill. Null when the asset cannot be
   fetched — the card just loses the watermark rather than the render.
   Unkeyed on purpose (the asset is the same for every request), which means the
   first origin to fill it wins for the life of the process. That is only safe
   because getAssetOrigin prefers the configured origin and refuses hosts that
   are not ours; if that ever loosens again, key this by origin. */
let laurelSvgCache: Promise<string | null> | undefined;

export async function cosmicLaurelDataUrl(request: Request, tier: ManiaCardTier): Promise<string | null> {
  if (!getCosmicTierPalette(tier)?.laurelWatermark) return null;
  if (!laurelSvgCache) {
    laurelSvgCache = (async () => {
      const url = new URL("/images/maniacard/laurel-wreath.svg", getAssetOrigin(request)).toString();
      const response = await fetch(url);
      if (!response.ok) throw new Error(`laurel ${response.status}`);
      return response.text();
    })().catch(() => null);
  }
  const svg = await laurelSvgCache;
  if (!svg) return null;
  const tint = svgColorParts(MANIA_TIER_STYLES[tier].glowColor).fill;
  const tinted = svg.replaceAll('fill="#6D9D30"', `fill="${tint}"`);
  return `data:image/svg+xml;base64,${Buffer.from(tinted).toString("base64")}`;
}

// The card art shared by the maniacard and pull OGs: everything the portrait
// needs, decoupled from where the numbers came from (live top plays vs the
// minted skills snapshot stored on a collection card).
export interface ManiaTierCardArt {
  username: string;
  avatarUrl: string;
  tier: ManiaCardTier;
  /* Overrides the tier's own name on the badge, for a holding that was given
     one. Mirrors labelOverride in maniacard3d/renderData.ts. */
  label?: string | null;
  skills: { fingerControl: number; speed: number; accuracy: number; starAvg: number };
  laurelUrl?: string | null;
  /* Background art for a holding that was granted some: the numbers, plus the
     image already inlined by cardMotifDataUrl and its aspect ratio. All three
     or none - a motif whose image did not load leaves the tier's own pattern
     in place. */
  motif?: CardMotif | null;
  motifUrl?: string | null;
  motifAspect?: number;
}

export const MANIACARD_W = 720;
export const MANIACARD_H = 1008;
export const MANIACARD_FOOTER_H = 72;

export function maniaTierCardElement(art: ManiaTierCardArt) {
  const { skills, tier, avatarUrl } = art;
  const style = MANIA_TIER_STYLES[tier];
  const cosmic = getCosmicTierPalette(tier);
  const statRows: Array<[string, number]> = [
    ["Control", skills.fingerControl],
    ["Speed", skills.speed],
    ["Precision", skills.accuracy],
  ];
  // Same star logic as the in-app card: ceil(starAvg) segments, full/half/empty.
  const segCount = Math.min(10, Math.max(1, Math.ceil(skills.starAvg)));
  const starUrls = Array.from({ length: segCount }, (_, i) => {
    const remaining = skills.starAvg - i;
    const fill = remaining >= 1 ? "#fcd34d" : remaining >= 0.5 ? "rgba(252,211,77,0.55)" : "rgba(252,211,77,0.22)";
    return starDataUrl(fill);
  });

  const CARD_W = MANIACARD_W;
  const CARD_H = MANIACARD_H;
  const motifSprites =
    art.motif && art.motifUrl
      ? motifSpriteElements(art.motif, art.motifUrl, art.motifAspect ?? 1, CARD_W, CARD_H)
      : null;
  const textShadow = "0 2px 5px rgba(0,0,0,0.55)";

  return h(
      "div",
      {
        style: {
          width: `${CARD_W}px`,
          height: `${CARD_H}px`,
          flexShrink: 0,
          position: "relative",
          display: "flex",
          overflow: "hidden",
          background: cosmic ? "#000000" : style.badgeGradient,
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        // Cosmic tiers get the starfield front in place of the tier gradient
        // and its triangle flecks, the same swap the in-app card makes. A
        // granted motif takes the place of whichever of the two this tier
        // would have drawn, so the flecks go entirely and the cosmic base
        // keeps everything but its stars.
        motifSprites && !cosmic
          ? null
          : h("img", {
              key: "tris",
              src: cosmic
                ? cosmicBackgroundDataUrl(cosmic, !motifSprites)
                : triangleOverlayDataUrl(CARD_W, CARD_H),
              style: { position: "absolute", top: "0", left: "0", width: "100%", height: "100%" },
            }),
        motifSprites,
        // GOAT's laurel, behind everything the card puts over it.
        art.laurelUrl
          ? h("img", {
              key: "laurel",
              src: art.laurelUrl,
              // Texture-space 740px tall, centred on (500, 600), at the SVG's
              // own ~1.145 aspect; scaled by this card's 0.72 of the texture.
              style: {
                position: "absolute",
                left: `${(500 - (740 * 1.145) / 2) * 0.72}px`,
                top: `${(600 - 740 / 2) * 0.72}px`,
                width: `${740 * 1.145 * 0.72}px`,
                height: `${740 * 0.72}px`,
                opacity: 0.13,
              },
            })
          : null,
        // Mode badge (top-left).
        h(
          "div",
          {
            key: "badge",
            style: {
              position: "absolute",
              left: "28px",
              top: "28px",
              width: "96px",
              height: "96px",
              borderRadius: "22px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.20)",
              border: "2px solid rgba(255,255,255,0.34)",
              boxShadow: `0 0 28px ${style.glowColor}`,
            },
          },
          h("img", { src: maniaGlyphDataUrl(), style: { width: "66px", height: "66px" } }),
        ),
        // Username plate (top-center).
        h(
          "div",
          {
            key: "plate",
            style: {
              position: "absolute",
              left: "176px",
              top: "54px",
              width: "458px",
              height: "76px",
              borderRadius: "18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.34)",
              overflow: "hidden",
            },
          },
          h(
            "div",
            { style: { fontSize: "40px", fontWeight: 900, color: "#ffffff", textShadow, whiteSpace: "nowrap" } },
            art.username,
          ),
        ),
        // Tier label (right).
        h(
          "div",
          {
            key: "tier",
            style: {
              position: "absolute",
              right: "34px",
              top: "152px",
              display: "flex",
              fontSize: "42px",
              fontWeight: 900,
              color: "#ffffff",
              textShadow: `0 0 22px ${style.glowColor}, 0 2px 5px rgba(0,0,0,0.6)`,
            },
          },
          art.label?.trim() || style.label,
        ),
        // Avatar.
        h(
          "div",
          {
            key: "avatar",
            style: {
              position: "absolute",
              left: "133px",
              top: "202px",
              width: "454px",
              height: "454px",
              borderRadius: "26px",
              display: "flex",
              border: "6px solid rgba(255,255,255,0.18)",
              boxSizing: "border-box",
              overflow: "hidden",
            },
          },
          h("img", { src: avatarUrl, style: { width: "100%", height: "100%", objectFit: "cover" } }),
        ),
        // Stats box.
        h(
          "div",
          {
            key: "stats",
            style: {
              position: "absolute",
              left: "148px",
              top: "678px",
              width: "424px",
              height: "180px",
              borderRadius: "24px",
              background: "rgba(0,0,0,0.32)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "0 38px",
            },
          },
          statRows.map(([label, value], i) =>
            h(
              "div",
              {
                key: `stat-${i}`,
                style: {
                  display: "flex",
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  marginBottom: i < statRows.length - 1 ? "10px" : "0",
                },
              },
              [
                h("div", { key: "l", style: { fontSize: "30px", fontWeight: 700, color: "rgba(255,255,255,0.85)", textShadow } }, label),
                h("div", { key: "v", style: { fontSize: "40px", fontWeight: 900, color: "#ffffff", textShadow } }, formatOgInt(value)),
              ],
            ),
          ),
        ),
        // Star rating row.
        h(
          "div",
          {
            key: "starwrap",
            style: {
              position: "absolute",
              left: "0",
              bottom: "46px",
              width: `${CARD_W}px`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            },
          },
          [
            h(
              "div",
              { key: "stars", style: { display: "flex", flexDirection: "row" } },
              starUrls.map((src, i) =>
                h("img", { key: `s-${i}`, src, style: { width: "46px", height: "46px", marginLeft: i ? "6px" : "0" } }),
              ),
            ),
            h(
              "div",
              { key: "avg", style: { display: "flex", flexDirection: "row", alignItems: "center", marginTop: "10px" } },
              [
                h("img", { key: "as", src: starDataUrl("#fcd34d"), style: { width: "24px", height: "24px", marginRight: "8px" } }),
                h("div", { key: "an", style: { fontSize: "28px", fontWeight: 900, color: "rgba(255,255,255,0.82)", textShadow } }, skills.starAvg.toFixed(2)),
              ],
            ),
          ],
        ),
      ],
    );
}

