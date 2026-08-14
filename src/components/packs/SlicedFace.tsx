import type { CSSProperties, ReactNode } from "react";
import { cutAngleDeg, cutHalfOffset, cutHalfPolygon, type PackDamage } from "#/lib/pack-damage";

/* A card face that the pack's blade went through: the same face drawn twice,
   clipped either side of the blade's path, left sitting where the cut dropped
   the two pieces. Used for the card backs dealing out of a butchered pack, the
   faces they flip into, and the ruined hand on the summary.

   A cut is a hairline. Parting the pieces far enough to see daylight between
   them stops reading as a cut and starts reading as a line drawn across the
   card, so almost all of the work here is done by the artwork failing to line
   up across the seam, which is a thing only a cut does. */

/* Both in percent of the card's own height, so a tray tile and a full-size
   reveal card come apart by the same visible amount. The gap across the blade
   is a hairline; the slip along it is far bigger, because what the eye reads
   as a cut is the card's own outline stepping where the two pieces no longer
   agree on where its edges are. */
const GAP = 0.28;
const SLIP = 1.3;
/* How far the pieces turn against each other, in degrees. A cut card never
   sits back down as a rectangle, and the turn is what stops the seam being a
   uniform stroke: it wedges open towards one edge of the card and closes to
   nothing towards the other. */
const TOP_TURN = -0.85;
const BOTTOM_TURN = 0.55;
/* The shade the upper piece throws down over the lower one, in pixels: a cut
   stays a hairline at every size a card is drawn at, so this one does too. */
const SHADE = 1.3;

function pieceStyles(damage: PackDamage) {
  const offset = cutHalfOffset(damage, GAP, SLIP);
  const radians = (cutAngleDeg(damage) * Math.PI) / 180;
  return {
    top: {
      clipPath: cutHalfPolygon(damage, "top"),
      transform: `translate(${offset.x.toFixed(2)}%, ${offset.y.toFixed(2)}%) rotate(${TOP_TURN}deg)`,
    } satisfies CSSProperties,
    bottom: {
      clipPath: cutHalfPolygon(damage, "bottom"),
      transform: `translate(${(-offset.x).toFixed(2)}%, ${(-offset.y).toFixed(
        2,
      )}%) rotate(${BOTTOM_TURN}deg)`,
    } satisfies CSSProperties,
    // Cast along the blade's own normal, so the shade stays tucked under the
    // cut edge whatever angle the cut came in at.
    shade: {
      filter: `drop-shadow(${(-Math.sin(radians) * SHADE).toFixed(2)}px ${(
        Math.cos(radians) * SHADE
      ).toFixed(2)}px 0.4px rgba(0,0,0,0.85))`,
    } satisfies CSSProperties,
  };
}

export function SlicedFace({
  damage,
  children,
  className,
}: {
  damage: PackDamage;
  /* The intact face. Rendered twice, so keep it free of refs and state. */
  children: ReactNode;
  className?: string;
}) {
  const pieces = pieceStyles(damage);
  return (
    <div className={`relative h-full w-full ${className ?? ""}`}>
      {/* The piece below the cut, drawn first so the piece above it can shade
          it. Hidden from the accessibility tree so the card is still named
          exactly once. */}
      <div className="absolute inset-0" style={pieces.bottom} aria-hidden="true">
        {children}
      </div>
      <div className="absolute inset-0" style={pieces.shade}>
        <div className="absolute inset-0" style={pieces.top}>
          {children}
        </div>
      </div>
    </div>
  );
}
