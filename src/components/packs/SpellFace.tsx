import type { ReactNode } from "react";
import type { PackSpell } from "#/lib/pack-pending";
import { BurntFace } from "./BurntFace";
import { FrozenFace } from "./FrozenFace";

/* A card face from a pack a blade's easter egg got to (PackStage): burnt by
   Ember or frozen by Frost. Looks only. `seed` gives each card its own. */
export function SpellFace({ spell, seed, children }: { spell: PackSpell | null; seed: number; children: ReactNode }) {
  if (spell === "burnt") return <BurntFace seed={seed}>{children}</BurntFace>;
  if (spell === "frozen") return <FrozenFace seed={seed}>{children}</FrozenFace>;
  return <>{children}</>;
}
