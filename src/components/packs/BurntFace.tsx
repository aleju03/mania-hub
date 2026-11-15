import { useId, type ReactNode } from "react";
import { SPELL_TINT, spellDots, spellLayersMarkup } from "#/lib/pack-spell-art";

/* A card from a pack Ember set alight (the easter egg in PackStage: the blade
   held still on the pack until it caught). The face is browned and darkened,
   its edges eaten into ragged char with a thin glowing line where the burn
   stops, and a few embers still pulse in it (spellArt.ts, the same drawing
   the card texture bakes in). Looks only: the card is kept and collected as
   it is. `seed` gives each card its own burn. */
export function BurntFace({ seed, children }: { seed: number; children: ReactNode }) {
  const uid = useId().replace(/:/g, "");
  return (
    <div className="relative h-full w-full overflow-hidden rounded-[inherit]">
      <div className="h-full w-full" style={{ filter: SPELL_TINT.burnt }}>
        {children}
      </div>
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 140"
        preserveAspectRatio="none"
        dangerouslySetInnerHTML={{ __html: spellLayersMarkup("burnt", seed, uid) }}
      />
      {spellDots("burnt", seed).map((ember, i) => (
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
