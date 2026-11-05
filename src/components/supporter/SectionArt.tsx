import { useId } from "react";

import { SUPPORTER_RANKS } from "../../lib/supporter-ranks";
import type { SupporterSection } from "./loadout";
import { SupporterRankIcon } from "./SupporterRankBadge";

/* A tiny angled picture of what each /supporter section changes, drawn
   before its name in the section chips so the many sections tell apart at a
   glance: a theme's backdrop, a crowned frame, a styled name, a font, a
   sitting cat, stat bars, a foil card, card art, a graded slab, a binder, a pack,
   a slash, the workshop's pencil, the rank badge itself and a gift. Objects only, no
   faces. Drawn on a 44x36 box. */
export type SectionArtId = SupporterSection | "workshop";

export function SectionArt({ section, className }: { section: SectionArtId; className?: string }) {
  const uid = useId().replace(/:/g, "");
  // the real rank badge (hexagon and heart), in Gold
  if (section === "you") return <SupporterRankIcon rank={SUPPORTER_RANKS[5]} className={className} />;
  const g = (name: string) => `${name}-${uid}`;
  const art = ((): React.ReactNode => {
    switch (section) {
      case "theme":
        return (
          <>
            <defs>
              <linearGradient id={g("t")} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#3a7bff" />
                <stop offset=".55" stopColor="#9b4dff" />
                <stop offset="1" stopColor="#ff5fae" />
              </linearGradient>
            </defs>
            <g transform="rotate(-6 22 18)">
              <rect x="6" y="5" width="32" height="26" rx="5" fill={`url(#${g("t")})`} />
              <circle cx="22" cy="18" r="5.5" fill="#0d0b18" opacity=".7" />
            </g>
            <circle cx="22" cy="18" r="2.4" fill="#ffe7a8" />
          </>
        );
      case "frame":
        return (
          <>
            <circle cx="22" cy="19" r="11.5" fill="#5a4a7a" />
            <circle cx="22" cy="19" r="11.5" fill="none" stroke="#ffd36b" strokeWidth="3" />
            <path d="M13 10l3-5.5 3 4 3-5 3 5 3-4 3 5.5z" fill="#ffd36b" stroke="#b9862a" strokeWidth=".8" strokeLinejoin="round" />
          </>
        );
      case "nameStyle":
        return (
          <>
            <defs>
              <linearGradient id={g("n")} x1="0" x2="1">
                <stop offset="0" stopColor="#ff7ad8" />
                <stop offset="1" stopColor="#7fd8ff" />
              </linearGradient>
            </defs>
            <text x="22" y="25.5" textAnchor="middle" fontSize="19" fontWeight="800" fill={`url(#${g("n")})`} fontFamily="system-ui, sans-serif">Aa</text>
          </>
        );
      case "nameFont":
        return <text x="22" y="26" textAnchor="middle" fontSize="21" fill="#e8dcff" fontFamily="Georgia, serif" fontStyle="italic">Ag</text>;
      case "companion":
        // a cat sitting, in silhouette, its tail curled round
        return (
          <g transform="translate(-0.5 -4)">
            <path d="M14 33c-2-6 0-12 4-15l-1-7 4 4h2l4-4-1 7c4 3 6 9 4 15z" fill="#2b2533" stroke="#d9c8ff" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M30 31c4 0 6-3 5-6" stroke="#d9c8ff" strokeWidth="2" fill="none" strokeLinecap="round" />
          </g>
        );
      case "stats":
        return (
          <>
            <rect x="7" y="7" width="30" height="22" rx="4" fill="#2b3550" transform="rotate(-5 22 18)" />
            <rect x="11" y="20" width="4" height="6" rx="1" fill="#7fd8ff" />
            <rect x="17" y="15" width="4" height="11" rx="1" fill="#a678ff" />
            <rect x="23" y="11" width="4" height="15" rx="1" fill="#ff7ad8" />
            <rect x="29" y="17" width="4" height="9" rx="1" fill="#ffd36b" />
          </>
        );
      case "foil":
        return (
          <>
            <defs>
              <linearGradient id={g("f")} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#99ffff" />
                <stop offset=".35" stopColor="#ff99ff" />
                <stop offset=".6" stopColor="#ffff99" />
                <stop offset="1" stopColor="#99ccff" />
              </linearGradient>
            </defs>
            <g transform="rotate(12 22 18)">
              <rect x="12.5" y="3" width="19" height="30" rx="3" fill={`url(#${g("f")})`} />
              <rect x="12.5" y="3" width="19" height="30" rx="3" fill="none" stroke="#fff" strokeOpacity=".6" />
            </g>
          </>
        );
      case "motif":
        return (
          <g transform="rotate(-8 22 18)">
            <rect x="12" y="3" width="20" height="30" rx="3" fill="#f4e3c4" />
            <rect x="14.5" y="6" width="15" height="13" rx="1.5" fill="#6aa6ff" />
            <path d="M14.5 19l5-6 4 4 3-3 3 5z" fill="#3d7a4f" />
            <circle cx="26" cy="9.5" r="2" fill="#ffe27a" />
          </g>
        );
      case "sleeve":
        return (
          <g transform="rotate(14 22 18)">
            <rect x="11" y="1" width="22" height="34" rx="2.5" fill="#cfe3f5" fillOpacity=".3" stroke="#e9f4ff" strokeWidth="1.3" />
            <rect x="11" y="1" width="22" height="7" rx="2" fill="#e04848" />
            <rect x="13.5" y="10" width="17" height="22" rx="1.5" fill="#6d55a8" />
            <path d="M14.5 11l7.5 20" stroke="#fff" strokeOpacity=".45" strokeWidth="1.5" />
          </g>
        );
      case "binder":
        return (
          <g transform="rotate(-6 22 18)">
            <rect x="9" y="5" width="26" height="27" rx="3" fill="#2f5aa0" />
            <rect x="9" y="5" width="5" height="27" rx="2" fill="#24467d" />
            <rect x="18" y="12" width="12" height="9" rx="2" fill="#c9d8ff" opacity=".8" />
            <circle cx="11.5" cy="11" r="1.2" fill="#c9d8ff" />
            <circle cx="11.5" cy="18.5" r="1.2" fill="#c9d8ff" />
            <circle cx="11.5" cy="26" r="1.2" fill="#c9d8ff" />
          </g>
        );
      case "wrapper":
        return (
          <g transform="rotate(10 22 18)">
            <path d="M13 3h18l-1 2 1 2v22l-1 2 1 2H13l1-2-1-2V7l1-2z" fill="#3b2f57" stroke="#7d64b8" strokeWidth=".8" />
            <circle cx="22" cy="16" r="5" fill="#a678ff" />
            <rect x="16" y="24" width="12" height="2.5" rx="1" fill="#a678ff" />
          </g>
        );
      case "blade":
        return (
          <>
            <path d="M5 27C14 23 26 15 39 8" stroke="#7fd8ff" strokeWidth="6" strokeLinecap="round" opacity=".35" fill="none" />
            <path d="M5 27C14 23 26 15 39 8" stroke="#fff" strokeWidth="2" strokeLinecap="round" fill="none" />
            <circle cx="39" cy="8" r="2.6" fill="#fff" />
          </>
        );
      case "workshop":
        return (
          <>
            <rect x="7" y="8" width="22" height="22" rx="3" fill="#2c3a5a" stroke="#7fa7ff" strokeWidth="1.2" transform="rotate(-6 18 19)" />
            <g transform="rotate(40 28 16)">
              <rect x="25.5" y="2" width="5" height="22" rx="1" fill="#ffd36b" />
              <rect x="25.5" y="2" width="5" height="4" rx="1" fill="#ff8fb3" />
              <path d="M25.5 24h5l-2.5 5z" fill="#f4e3c4" />
            </g>
          </>
        );
      case "perks":
        return (
          <>
            <rect x="9" y="14" width="26" height="17" rx="2.5" fill="#ff7ad8" />
            <rect x="7.5" y="10" width="29" height="6" rx="2" fill="#ff9be3" />
            <rect x="19.5" y="10" width="5" height="21" fill="#ffd36b" />
            <path d="M22 10c-3-5-9-5-8-1 1 2.5 5 1.5 8 1zM22 10c3-5 9-5 8-1-1 2.5-5 1.5-8 1z" fill="#ffd36b" />
          </>
        );
    }
  })();
  return (
    <svg viewBox="0 0 44 36" className={className} aria-hidden>
      {art}
    </svg>
  );
}
