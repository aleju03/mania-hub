import { useId } from "react";
import { getCountryFlagLargeUrl } from "#/lib/country";
import { useAuth } from "#/lib/auth-context";
import { GAME_ICON_BODIES } from "./gameIconBodies";

/* Charm art for the pack run: each charm is a solid silhouette painted in
   its rarity's gradient over a soft drop shadow, with no frame. Most
   silhouettes are game-icons.net's (gameIconBodies.ts); the pattern charms
   are notes and keys drawn here on the same 512 grid. Home Crowd is the
   viewer's own flag cut to the waving-flag silhouette. */

const NOTE_BODIES: Record<string, string> = {
  // Jump: two notes on one row over the judgement line.
  duet: '<rect x="36" y="176" width="190" height="96" rx="30"/><rect x="286" y="176" width="190" height="96" rx="30"/><rect x="20" y="352" width="472" height="34" rx="17"/>',
  // Hand: three notes on one row.
  trio: '<rect x="20" y="176" width="140" height="96" rx="30"/><rect x="186" y="176" width="140" height="96" rx="30"/><rect x="352" y="176" width="140" height="96" rx="30"/><rect x="20" y="352" width="472" height="34" rx="17"/>',
  // Stairs: four notes climbing.
  climber: '<rect x="16" y="372" width="112" height="78" rx="24"/><rect x="138" y="272" width="112" height="78" rx="24"/><rect x="260" y="172" width="112" height="78" rx="24"/><rect x="382" y="72" width="112" height="78" rx="24"/>',
  // 4K: four keys.
  fourKeys: '<rect x="28" y="120" width="98" height="250" rx="26"/><rect x="148" y="120" width="98" height="250" rx="26"/><rect x="268" y="120" width="98" height="250" rx="26"/><rect x="388" y="120" width="98" height="250" rx="26"/><rect x="20" y="400" width="472" height="34" rx="17"/>',
};

export const RARITY_GRADIENT: Record<string, readonly [string, string]> = {
  common: ["#cfe3ff", "#6f93c9"],
  uncommon: ["#8ff0b4", "#2f9e63"],
  rare: ["#ff9ab4", "#c9375f"],
  legendary: ["#e6c8ff", "#8f52d6"],
};

export function charmBody(id: string): string {
  return NOTE_BODIES[id] ?? GAME_ICON_BODIES[id] ?? '<circle cx="256" cy="256" r="160"/>';
}

export function CharmArt({ id, rarity, size = 48, className }: { id: string; rarity: string; size?: number; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const { viewer } = useAuth();
  const [top, bottom] = RARITY_GRADIENT[rarity] ?? RARITY_GRADIENT.common;
  const body = charmBody(id);
  const country = id === "homeCrowd" ? viewer?.countryCode?.trim().toUpperCase() : null;
  const shadow = `${uid}-shadow`;
  return (
    <svg viewBox="-16 -16 544 560" width={size} height={size} aria-hidden="true" className={className} overflow="visible">
      <defs>
        <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
        <filter id={shadow} x="-20%" y="-20%" width="140%" height="150%" colorInterpolationFilters="sRGB">
          <feDropShadow dx="0" dy="16" stdDeviation="12" floodColor="#000" floodOpacity="0.55" />
        </filter>
        {country && (
          <mask id={`${uid}-mask`}>
            <g fill="#fff" dangerouslySetInnerHTML={{ __html: body }} />
          </mask>
        )}
      </defs>
      {country ? (
        <g filter={`url(#${shadow})`}>
          <g mask={`url(#${uid}-mask)`}>
            <image href={getCountryFlagLargeUrl(country)} x="0" y="40" width="512" height="400" preserveAspectRatio="xMidYMid slice" />
            {/* The relic shading over the flag, so it sits with the others. */}
            <rect x="0" y="0" width="512" height="512" fill={`url(#${uid}-fill)`} opacity="0.35" style={{ mixBlendMode: "multiply" }} />
          </g>
        </g>
      ) : (
        <g fill={`url(#${uid}-fill)`} filter={`url(#${shadow})`} dangerouslySetInnerHTML={{ __html: body }} />
      )}
    </svg>
  );
}
