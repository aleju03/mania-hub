// osu-web's difficulty colour spectrum and the badge drawn from it. Lives in
// ui/ rather than next to the map search card so score panels can show a star
// pill without pulling the search card's audio-preview machinery into their
// bundles.

// Interpolated between the official stops with gamma-2.2 RGB
// (d3 interpolateRgb.gamma(2.2), same as osu-web) so diff dots read the same
// as on the osu! site.
const STAR_COLOR_STOPS: Array<[number, number, number, number]> = [
  [0.1, 0x42, 0x90, 0xfb],
  [1.25, 0x4f, 0xc0, 0xff],
  [2.0, 0x4f, 0xff, 0xd5],
  [2.5, 0x7c, 0xff, 0x4f],
  [3.3, 0xf6, 0xf0, 0x5c],
  [4.2, 0xff, 0x80, 0x68],
  [4.9, 0xff, 0x4e, 0x6f],
  [5.8, 0xc6, 0x45, 0xb8],
  [6.7, 0x65, 0x63, 0xde],
  [7.7, 0x18, 0x15, 0x8e],
  [9.0, 0x00, 0x00, 0x00],
];

export function starRatingColor(stars: number): string {
  const first = STAR_COLOR_STOPS[0];
  const last = STAR_COLOR_STOPS[STAR_COLOR_STOPS.length - 1];
  if (!Number.isFinite(stars) || stars <= first[0]) return `rgb(${first[1]}, ${first[2]}, ${first[3]})`;
  if (stars >= last[0]) return `rgb(${last[1]}, ${last[2]}, ${last[3]})`;
  for (let i = 1; i < STAR_COLOR_STOPS.length; i++) {
    const [hiStars, hr, hg, hb] = STAR_COLOR_STOPS[i];
    if (stars > hiStars) continue;
    const [loStars, lr, lg, lb] = STAR_COLOR_STOPS[i - 1];
    const t = (stars - loStars) / (hiStars - loStars);
    const GAMMA = 2.2;
    const mix = (a: number, b: number) =>
      Math.round(Math.pow(Math.pow(a, GAMMA) + (Math.pow(b, GAMMA) - Math.pow(a, GAMMA)) * t, 1 / GAMMA));
    return `rgb(${mix(lr, hr)}, ${mix(lg, hg)}, ${mix(lb, hb)})`;
  }
  return `rgb(${last[1]}, ${last[2]}, ${last[3]})`;
}

// CSS gradient of the spectrum across [lo, hi] stars, for painting slider
// tracks. Stops past the last defined star (9.0) stay black, like osu-web.
// `position` maps a star value to its 0..1 spot in the gradient, for tracks
// that don't lay stars out linearly (defaults to linear).
export function starSpectrumGradient(lo: number, hi: number, position?: (stars: number) => number): string {
  const span = hi - lo || 1;
  const pos = position ?? ((stars: number) => (stars - lo) / span);
  const stops = [`${starRatingColor(lo)} 0%`];
  for (const [stars] of STAR_COLOR_STOPS) {
    if (stars <= lo || stars >= hi) continue;
    stops.push(`${starRatingColor(stars)} ${(pos(stars) * 100).toFixed(2)}%`);
  }
  stops.push(`${starRatingColor(hi)} 100%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

// osu-web's difficulty-badge: pill filled with the spectrum colour, dark text
// that flips to the expert-plus yellow at 6.5★ and above.
export function StarRatingBadge({ stars, label, className = "", size = 1 }: { stars: number; label?: string; className?: string; size?: number }) {
  const textColor = stars >= 6.5 ? "hsl(45, 100%, 70%)" : "hsl(200, 10%, 10%)";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-bold leading-none tabular-nums ${className}`}
      style={{
        background: starRatingColor(stars),
        color: textColor,
        fontSize: 10 * size,
        padding: `${2 * size}px ${8 * size}px`,
      }}
    >
      <svg viewBox="0 0 24 24" style={{ width: 9 * size, height: 9 * size }} fill="currentColor" aria-hidden="true">
        <path d="M12 1.7l3.1 6.9 7.2.8-5.4 5 1.5 7.2L12 17.9l-6.4 3.7 1.5-7.2-5.4-5 7.2-.8L12 1.7z" />
      </svg>
      {label ?? stars.toFixed(2)}
    </span>
  );
}
