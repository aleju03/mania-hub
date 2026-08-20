/* The page's own backdrop, in place of OsuTriangleBackdrop.
 *
 * Two things made that one wrong here. Its polygons tile at 1920x1080, so on a
 * page as tall as a shelf of collections they arrive as a couple of diagonal
 * bands cutting across the cards rather than as texture, which is the same
 * complaint api/signature/-art.ts already records about drawing them small.
 * And the wash it closes with runs b6/40 -> b5/70 -> b6/90, so the further you
 * scroll the darker the page gets, and the bottom of a long shelf sits in
 * near-black.
 *
 * What replaces it holds one tone the whole way down, with no gradient in it
 * at all. The tone is b5 under a white veil: b5 by itself at this lightness is
 * a muddy maroon in the default hue, and the veil is what lifts it clear of
 * the body colour and pulls enough saturation out that the cards laid on it
 * are the only saturated thing in view. 5% is the ceiling on that veil, since
 * past about 7% the b4 panels the page puts on top stop reading as a step up
 * from it; ListSurface answers that by tinting relative to this surface rather
 * than naming a fixed shade.
 */

/* The texture is cards, because that is what the page is. Blank silhouettes at
   the card's own 5:7, tilted a few degrees each, at an opacity where they read
   as grain in the surface rather than as artwork sitting behind the content.
   Positions are one jittered tile rather than a formula: a run this faint only
   needs to not line up with itself, and a fixed list is the one thing that
   cannot drift between server and client render. */
const TILE_WIDTH = 1240;
const TILE_HEIGHT = 900;
const CARD_ASPECT = 1.4;
const CARD_OPACITY = 0.01;

const CARDS = [
  { x: 90, y: 70, width: 130, rotate: -8 },
  { x: 430, y: 190, width: 96, rotate: 6 },
  { x: 760, y: 40, width: 150, rotate: 11 },
  { x: 200, y: 470, width: 108, rotate: 14 },
  { x: 560, y: 560, width: 140, rotate: -5 },
  { x: 950, y: 480, width: 100, rotate: -13 },
  { x: 300, y: 250, width: 84, rotate: 20 },
  { x: 1080, y: 220, width: 120, rotate: -18 },
  { x: 60, y: 640, width: 92, rotate: 9 },
  { x: 790, y: 700, width: 110, rotate: 16 },
];

export function CollectionsBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-osu-b5" aria-hidden="true">
      <div className="absolute inset-0 bg-white/[0.05]" />
      <svg className="absolute inset-0 h-full w-full text-white">
        <defs>
          <pattern
            id="collections-card-scatter"
            width={TILE_WIDTH}
            height={TILE_HEIGHT}
            patternUnits="userSpaceOnUse"
          >
            {CARDS.map((card, index) => (
              <rect
                key={index}
                x={card.x}
                y={card.y}
                width={card.width}
                height={card.width * CARD_ASPECT}
                rx={card.width * 0.075}
                fill="currentColor"
                fillOpacity={CARD_OPACITY}
                transform={`rotate(${card.rotate} ${card.x + card.width / 2} ${
                  card.y + (card.width * CARD_ASPECT) / 2
                })`}
              />
            ))}
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#collections-card-scatter)" />
      </svg>
    </div>
  );
}
