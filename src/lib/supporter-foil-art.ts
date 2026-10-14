/* The still version of the supporter foil, for every picture of a card that
   has no shader behind it: thumbnails, the reveal tray, the 2D fallbacks
   (drawn in maniacard3d/cardTexture.ts) and the share images (satori, in
   maniacard-art.ts). One SVG on the card texture's own 1000x1400 space, so
   both draw the same foil.

   It is the moving foil frozen at rest: a soft diagonal band of pastel hues
   across the card with a fainter echo above it, and the fine diamond lattice
   of a holo sheet showing through mostly where the band is. Both callers lay
   it over the card art with a screen blend, which only ever lightens, so the
   tier's colours stay underneath rather than being washed toward grey. */

const W = 1000;
const H = 1400;

/* Overall strength. Kept low: the foil should be what makes a supporter's
   card recognisable in a grid, not a stripe across it. */
export const SUPPORTER_FOIL_OPACITY = 0.7;
/* A second, overlay-blended pass of the same art. Screen alone barely moves a
   pale tier (Legendary's gold, Rare's sky), so this one tints the band into
   the card's own colours where screening cannot lighten it any further. */
export const SUPPORTER_FOIL_TINT_OPACITY = 0.6;

const BAND_STOPS: Array<[number, string, number]> = [
  [0.0, "#ddd6fe", 0],
  [0.14, "#ddd6fe", 0.08],
  [0.2, "#bfdbfe", 0.16],
  [0.26, "#ddd6fe", 0.03],
  [0.4, "#ddd6fe", 0.06],
  [0.45, "#fbcfe8", 0.34],
  [0.5, "#fef3c7", 0.42],
  [0.55, "#bbf7d0", 0.36],
  [0.6, "#bfdbfe", 0.32],
  [0.66, "#ddd6fe", 0.16],
  [0.76, "#ddd6fe", 0],
  [1.0, "#ddd6fe", 0],
];

let cached: string | null = null;

export function supporterFoilSvg(): string {
  if (cached) return cached;
  const stops = BAND_STOPS.map(
    ([offset, color, opacity]) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`,
  ).join("");
  /* The band runs lower-left to upper-right, the way the moving foil's main
     beam crosses the card at rest; the gradient runs across it. */
  cached =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<defs>` +
    `<linearGradient id="band" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>` +
    `<linearGradient id="reach" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="#fff" stop-opacity=".25"/>` +
    `<stop offset=".5" stop-color="#fff" stop-opacity="1"/>` +
    `<stop offset="1" stop-color="#fff" stop-opacity=".25"/>` +
    `</linearGradient>` +
    `<pattern id="lattice" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<path d="M0 0H20M0 0V20" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.2"/>` +
    `</pattern>` +
    `<mask id="inBand"><rect width="${W}" height="${H}" fill="url(#reach)"/></mask>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#band)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#lattice)" opacity=".38" mask="url(#inBand)"/>` +
    `</svg>`;
  return cached;
}

export function supporterFoilDataUrl(): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(supporterFoilSvg())}`;
}
