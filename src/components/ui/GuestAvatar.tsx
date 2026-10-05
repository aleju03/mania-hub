import { useId } from "react";

const INK = "var(--color-osu-l2)";
const HEAD = "M 16 6.6 C 20.3 6.4 22.6 9.6 22.4 13.4 C 22.2 17.3 19.6 19.9 15.8 19.8 C 12.1 19.7 9.6 17 9.7 13.1 C 9.9 9.3 12.3 6.8 16 6.6 Z";
const SHOULDERS = "M 5.6 31 C 6.3 26.2 10 22.8 15.9 22.6 C 22 22.5 25.7 26 26.6 31.2";

export function GuestAvatar({ className }: { className?: string }) {
  const roughId = `guest-avatar-rough-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <defs>
        <filter id={roughId} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={3} />
          <feDisplacementMap in="SourceGraphic" scale={0.7} />
        </filter>
      </defs>
      <rect width="32" height="32" fill="var(--color-osu-b4)" />
      <g fill={INK} opacity={0.22} transform="translate(0.9 0.8)">
        <path d={HEAD} />
        <path d={`${SHOULDERS} L 26.6 33 L 5.6 33 Z`} />
      </g>
      <g
        fill="none"
        stroke={INK}
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${roughId})`}
      >
        <path d={HEAD} />
        <path d={SHOULDERS} />
        <g transform="translate(0.5 -0.4)" opacity={0.35}>
          <path d={HEAD} />
          <path d={SHOULDERS} />
        </g>
      </g>
    </svg>
  );
}
