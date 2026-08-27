import { useState } from "react";

// The collage that fronts a collection tile, shared by the auto packs and the
// ones players build. Covers that 404ed this session are remembered across
// every tile: axis/keymode switches remount them all, and per-instance state
// would retry known-dead covers on each switch, flashing a 3-slot collage that
// collapses back to 2.
const failedCoverSetIds = new Set<number>();

export function CoverStrip({ setIds, className = "" }: { setIds: number[]; className?: string }) {
  // Covers can 404 even for sets the backend vetted (backgrounds removed after
  // upload, e.g. DMCA). Dropping the failed image and re-flowing the collage
  // beats leaving a blank cell.
  const [, bumpFailures] = useState(0);
  const visible = setIds.filter((setId) => !failedCoverSetIds.has(setId));
  if (visible.length === 0) return <div className={`bg-osu-b3/40 ${className}`} />;
  return (
    <div className={`grid ${visible.length >= 3 ? "grid-cols-3" : visible.length === 2 ? "grid-cols-2" : "grid-cols-1"} gap-px ${className}`}>
      {visible.map((setId) => (
        <img
          key={setId}
          src={`https://assets.ppy.sh/beatmaps/${setId}/covers/card.jpg`}
          alt=""
          className="h-full w-full object-cover opacity-80"
          loading="lazy"
          onError={() => {
            failedCoverSetIds.add(setId);
            bumpFailures((count) => count + 1);
          }}
        />
      ))}
    </div>
  );
}
