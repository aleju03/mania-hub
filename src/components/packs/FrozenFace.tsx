import { useId, type ReactNode } from "react";
import { FROST_GLAZE, SPELL_TINT, spellDots, spellLayersMarkup } from "#/lib/pack-spell-art";

/* A card from a pack Frost froze (the easter egg in PackStage: the blade held
   still on the pack until the ice took it). The face is cooled and paled
   under a glaze, rime grows in from its edges in feathery spikes, a crack
   runs in from one side and a few glints catch the light (spellArt.ts, the
   same drawing the card texture bakes in). Looks only: the card is kept and
   collected as it is. `seed` gives each card its own ice. */
export function FrozenFace({ seed, children }: { seed: number; children: ReactNode }) {
  const uid = useId().replace(/:/g, "");
  const glaze = FROST_GLAZE.map(([at, color]) => `${color} ${at * 100}%`).join(", ");
  return (
    <div className="relative h-full w-full overflow-hidden rounded-[inherit]">
      <div className="h-full w-full" style={{ filter: SPELL_TINT.frozen }}>
        {children}
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `linear-gradient(170deg, ${glaze})`, mixBlendMode: "screen" }} />
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 140"
        preserveAspectRatio="none"
        dangerouslySetInnerHTML={{ __html: spellLayersMarkup("frozen", seed, uid) }}
      />
      {spellDots("frozen", seed).map((glint, i) => (
        <span
          key={i}
          aria-hidden
          className="pointer-events-none absolute h-[3px] w-[3px] animate-pulse rounded-full bg-white shadow-[0_0_5px_2px_rgba(190,230,255,0.85)]"
          style={{ left: `${glint.left}%`, top: `${glint.top}%`, animationDelay: `${glint.delay}s` }}
        />
      ))}
    </div>
  );
}
