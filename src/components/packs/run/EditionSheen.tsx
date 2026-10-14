import type { RunEdition } from "#/lib/pack-run";

/* The edition a copy rolled, laid over a flat card (a tile, the summary, a
   thumbnail). Purely visual: the parent supplies the rounded, clipped box. */
export function EditionSheen({ edition }: { edition: RunEdition | null | undefined }) {
  if (!edition) return null;
  return <span aria-hidden="true" className={`edition-sheen edition-${edition} z-[5]`} />;
}
