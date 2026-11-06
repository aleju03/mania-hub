import { useId, type ReactNode } from "react";

/* A card from a pack Ember set alight (the easter egg in PackStage: the blade
   held still on the pack until it caught). The face is browned and darkened,
   its edges eaten into ragged char with a thin glowing line where the burn
   stops, and a few embers still pulse in it. Looks only: the card is kept and
   collected as it is. `seed` gives each card its own burn. */
export function BurntFace({ seed, children }: { seed: number; children: ReactNode }) {
  const uid = useId().replace(/:/g, "");
  const embers = [0, 1, 2].map((i) => {
    const r = (n: number) => ((Math.sin((seed + 1) * 12.9898 + n * 78.233 + i * 37.719) * 43758.5453) % 1 + 1) % 1;
    const side = Math.floor(r(1) * 4);
    const along = 8 + r(2) * 84;
    const inset = 6 + r(3) * 8;
    const [left, top] = side === 0 ? [along, inset] : side === 1 ? [100 - inset, along] : side === 2 ? [along, 100 - inset] : [inset, along];
    return { left, top, delay: r(4) * 1.6 };
  });
  return (
    <div className="relative h-full w-full overflow-hidden rounded-[inherit]">
      <div className="h-full w-full" style={{ filter: "sepia(0.55) saturate(0.75) brightness(0.72) contrast(1.12)" }}>
        {children}
      </div>
      <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 140" preserveAspectRatio="none">
        <defs>
          {/* char rises towards the edges: the edge gradient plus noise,
              cut at one level for the char and just under it for the glow */}
          <radialGradient id={`e${uid}`} cx="50%" cy="50%" r="70%">
            <stop offset="0.3" stopColor="#000" />
            <stop offset="1" stopColor="#fff" />
          </radialGradient>
          <filter id={`b${uid}`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.07 0.05" numOctaves="3" seed={seed} result="noise" />
            <feComposite in="SourceGraphic" in2="noise" operator="arithmetic" k1="0" k2="1.1" k3="0.7" k4="-0.36" result="mix" />
            <feColorMatrix in="mix" type="luminanceToAlpha" result="heat" />
            <feComponentTransfer in="heat" result="char">
              <feFuncA type="discrete" tableValues="0 0 0 0 0 0 1 1 1 1" />
            </feComponentTransfer>
            <feComponentTransfer in="heat" result="edge">
              <feFuncA type="discrete" tableValues="0 0 0 0 0 1 0 0 0 0" />
            </feComponentTransfer>
            <feFlood floodColor="#140904" result="soot" />
            <feComposite in="soot" in2="char" operator="in" result="charred" />
            <feFlood floodColor="#ff7a1f" result="ember" />
            <feComposite in="ember" in2="edge" operator="in" result="lit" />
            <feGaussianBlur in="lit" stdDeviation="0.5" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="charred" />
            </feMerge>
          </filter>
        </defs>
        <rect width="100" height="140" fill={`url(#e${uid})`} filter={`url(#b${uid})`} />
      </svg>
      {embers.map((ember, i) => (
        <span
          key={i}
          aria-hidden
          className="pointer-events-none absolute h-1 w-1 animate-pulse rounded-full bg-[#ffb347] shadow-[0_0_6px_2px_rgba(255,122,31,0.7)]"
          style={{ left: `${ember.left}%`, top: `${ember.top}%`, animationDelay: `${ember.delay}s` }}
        />
      ))}
    </div>
  );
}
