import { starTextColor } from "../components/ui/StarRating";

// Where osu!'s star spectrum turns navy (7.7 stars) and black (9.0) on the MSD
// scale, from players' hardest 1.0x passes at 95%+: navy at the top 10% of
// players, black at the top 1%. 4K, 5K and 6K share the 4K pair; 7K players
// pass about five MSD higher. 8K and up have too few players to place, so they
// use the 4K pair.
const NAVY_STARS = 7.7;
const BLACK_STARS = 9.0;

function anchors(keyCount?: number | null): { navy: number; black: number } {
  return keyCount === 7 ? { navy: 36, black: 43 } : { navy: 32, black: 38 };
}

// The star rating whose colour an MSD takes: even steps up to navy, then on
// to black.
export function msdStarEquivalent(msd: number, keyCount?: number | null): number {
  if (!Number.isFinite(msd) || msd <= 0) return 0.1;
  const { navy, black } = anchors(keyCount);
  if (msd <= navy) return 0.1 + (msd / navy) * (NAVY_STARS - 0.1);
  return NAVY_STARS + Math.min(1, (msd - navy) / (black - navy)) * (BLACK_STARS - NAVY_STARS);
}

// The spectrum's pinks and purples are dark next to its yellows and hard to
// read over a cover, so colours under a lightness floor mix toward white,
// keeping their hue.
const MIN_LUMINANCE = 0.4;

export function msdColor(msd: number, keyCount?: number | null): string {
  const rgb = starTextColor(msdStarEquivalent(msd, keyCount)).match(/\d+/g)?.map(Number) ?? [255, 255, 255];
  const luminance = relativeLuminance(rgb);
  if (luminance >= MIN_LUMINANCE) return `rgb(${rgb.join(", ")})`;
  // White's luminance is 1, so this mix lands on the floor (near enough: the
  // blend is in sRGB, the luminance is linear).
  const k = (MIN_LUMINANCE - luminance) / (1 - luminance);
  const lift = (channel: number) => Math.round(channel + (255 - channel) * k);
  return `rgb(${rgb.map(lift).join(", ")})`;
}

function relativeLuminance([r, g, b]: number[]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
