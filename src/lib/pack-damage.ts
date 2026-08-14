/* A pack cut through its middle instead of along the perforation. The blade
   goes past the foil and through the cards stacked inside, so every card in
   the hand comes out in two pieces: ruined, worth nothing but the shards the
   recycler pays for scrap.

   The damage is the blade's actual path, not a straight line fitted to it: a
   sawing, wandering cut has to come out of the pack as a sawing, wandering
   cut, or the cards do not look like the thing that just happened to them.
   This module is deliberately free of DOM and of pack art imports so the pack
   stage, the reveal, the summary and the pending-pack record can all share one
   description of the same cut. */

export interface PackDamage {
  /* The blade's path across a card: y as a fraction of the card's height,
     sampled at evenly spaced x from the left edge (index 0) to the right
     edge (the last index). */
  path: number[];
}

/* The cards sit below the pack's crimp and stop short of its bottom seal, so
   the pack's own midpoint is not a card's midpoint. */
const CARD_WINDOW_TOP = 0.2;
const CARD_WINDOW_BOTTOM = 0.94;
/* The path is held this far off the card's edges: a cut that runs off the
   card would leave one piece as a sliver, which reads as a rendering fault
   rather than as damage. */
const MIN_CUT_FRAC = 0.06;
const MAX_CUT_FRAC = 0.94;
/* Fewer sampled columns than this is a poke at the foil, not a slash. */
const MIN_CUT_POINTS = 4;
/* How finely the blade's path is kept. The stage records the cut in 48
   columns; half that is more shape than a 44px tray tile can show, and it
   keeps the clip-path strings short enough to sit in a style attribute. */
const CUT_PATH_SAMPLES = 24;

/* Cards are drawn at 5/7 everywhere in the pack flow. */
export const SLICED_CARD_ASPECT = 5 / 7;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/* Light three-tap smoothing. The recorded columns come from pointer samples,
   so a fast slash leaves steps in them; a blade edge should read as a stroke,
   not as stairs. Deliberately gentle, so a real zigzag survives it. */
function smoothPath(path: number[]): number[] {
  return path.map((value, index) => {
    const before = path[index - 1] ?? value;
    const after = path[index + 1] ?? value;
    return (before + 2 * value + after) / 4;
  });
}

/* Turns the blade's recorded path through the pack into the path the cards
   took. Points are pack-space fractions: x across the width, y down the
   height, in any order. Columns the blade never reached hold the nearest
   value it did reach, which is what the pack's own tear does. */
export function packDamageFromCut(
  points: ReadonlyArray<{ x: number; y: number }>,
): PackDamage | null {
  if (points.length < MIN_CUT_POINTS) return null;
  const sorted = [...points].sort((a, b) => a.x - b.x);

  const toCardFrac = (packY: number) =>
    clamp(
      (packY - CARD_WINDOW_TOP) / (CARD_WINDOW_BOTTOM - CARD_WINDOW_TOP),
      MIN_CUT_FRAC,
      MAX_CUT_FRAC,
    );

  let cursor = 0;
  const sampled: number[] = [];
  for (let index = 0; index < CUT_PATH_SAMPLES; index += 1) {
    const x = index / (CUT_PATH_SAMPLES - 1);
    while (cursor < sorted.length - 2 && sorted[cursor + 1].x < x) cursor += 1;
    const from = sorted[cursor];
    const to = sorted[cursor + 1] ?? from;
    const span = to.x - from.x;
    // Before the first column and after the last one the blade is off the
    // pack, so the cut holds level rather than running off on a slope.
    const t = span > 1e-6 ? clamp((x - from.x) / span, 0, 1) : 0;
    sampled.push(toCardFrac(from.y + (to.y - from.y) * t));
  }
  return { path: smoothPath(sampled) };
}

/* Damage read back from storage: a resumed pack has to stay cut, but nothing
   about the stored numbers is trustworthy. */
export function sanitizePackDamage(value: unknown): PackDamage | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as { path?: unknown }).path;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 128) return null;
  const path: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    path.push(clamp(entry, MIN_CUT_FRAC, MAX_CUT_FRAC));
  }
  return { path };
}

/* The cut as points on the card's box, in percent. */
export function cutPathPercents(damage: PackDamage): Array<[number, number]> {
  const last = Math.max(1, damage.path.length - 1);
  return damage.path.map((y, index) => [(index / last) * 100, y * 100]);
}

/* The card's face on one side of the cut, as a CSS polygon() in percentages:
   the two corners on that side of the card, plus the blade's whole path. */
export function cutHalfPolygon(damage: PackDamage, half: "top" | "bottom"): string {
  const path = cutPathPercents(damage);
  const points: Array<[number, number]> =
    half === "top"
      ? [[0, 0], [100, 0], ...[...path].reverse()]
      : [...path, [100, 100], [0, 100]];
  return `polygon(${points.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(", ")})`;
}

/* The blade's overall angle across the card, in degrees; positive runs down
   to the right. Read end to end, so a zigzag still parts along the direction
   the hand was travelling. */
export function cutAngleDeg(damage: PackDamage, aspect = SLICED_CARD_ASPECT): number {
  const path = damage.path;
  const rise = (path[path.length - 1] ?? 0) - (path[0] ?? 0);
  return (Math.atan(rise / aspect) * 180) / Math.PI;
}

/* Where the upper piece ends up, both distances measured in percent of the
   card's height. `gap` parts the pieces across the blade's normal; `slip`
   slides them along the blade, which is what leaves the artwork failing to
   line up from one piece to the other. The lower piece takes the negative of
   this. A steep cut moves its pieces sideways as much as it moves them
   apart, so both terms turn with the blade. */
export function cutHalfOffset(
  damage: PackDamage,
  gapPercentOfHeight: number,
  slipPercentOfHeight = 0,
  aspect = SLICED_CARD_ASPECT,
) {
  const radians = (cutAngleDeg(damage, aspect) * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return {
    // The x offset is in percent of width, which is the shorter side, so it
    // has to be scaled out of the height units both distances came in as.
    x: (sin * gapPercentOfHeight + cos * slipPercentOfHeight) / aspect,
    y: -cos * gapPercentOfHeight + sin * slipPercentOfHeight,
  };
}
