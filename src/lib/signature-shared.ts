// Dynamic renders: the one place that says which signature variants exist.
//
// Shared by the /dynamic-renders page, the image route, and the tests, because
// the render route validates against this allowlist *before* it resolves a
// token or touches R2. That check is what bounds cache-key cardinality to
// (opted-in players x types x designs) instead of letting a query string mint
// an unbounded number of stored objects.

import { OSU_PROFILE_COLUMN_WIDTH } from "./bbcode-layout";

export const SIGNATURE_TYPES = ["insights", "goals", "skills", "dan", "maniacard"] as const;
export type SignatureType = (typeof SIGNATURE_TYPES)[number];

export interface SignatureDesign {
  /* Stable id. It keys the stored render in R2 and it is what a legacy
     `<type>-<n>.png` url resolves through, so it is never reused or
     renumbered - not even when a layout moves to the front of the list. */
  design: number;
  /* What the url says. A name rather than the id, because the id is an
     ordering artefact: the maniacard's card front is the first layout and the
     fourth ever added, and `maniacard-4.png` was the number leaking out. */
  slug: string;
  label: string;
  width: number;
  height: number;
  /* The layout draws a finished piece of art edge to edge, so the per-type
     background and accent have nothing to act on. The page hides those
     controls for it rather than offering settings that change nothing. */
  ownArt?: true;
}

/* Widths never exceed OSU_PROFILE_COLUMN_WIDTH: osu! emits
   style="width:<intrinsic>px" per [img] and caps at the column, so anything
   wider is silently scaled down and stops matching what the preview showed.
   Rendered at exact display pixels for the same reason - a 2x render would
   just appear twice as large on a profile. */
export const SIGNATURE_DESIGNS: Record<SignatureType, SignatureDesign[]> = {
  /* Declaration order is presentation order, on the page and in a stored
     enabled-types list. Ids are never renumbered to match it - they key the
     stored renders, and a legacy url still resolves through them. */
  maniacard: [
    /* The real card front, not a signature-shaped summary of it: the same
       element tree /api/og and the Discord command draw. Sized at the card's
       own 5:7, which is why the numbers are not round. */
    { design: 4, slug: "card-front", label: "Card front", width: 480, height: 672, ownArt: true },
    { design: 1, slug: "banner", label: "Banner", width: 880, height: 200 },
    { design: 2, slug: "strip", label: "Strip", width: 600, height: 140 },
    { design: 3, slug: "card", label: "Card", width: 420, height: 588 },
  ],
  goals: [
    { design: 1, slug: "progress-list", label: "Progress list", width: 880, height: 230 },
    { design: 2, slug: "single-focus", label: "Single focus", width: 560, height: 150 },
    { design: 3, slug: "full-list", label: "Full list", width: 880, height: 300 },
  ],
  skills: [
    { design: 1, slug: "radar-and-axes", label: "Radar and axes", width: 880, height: 260 },
    { design: 2, slug: "bars", label: "Bars", width: 700, height: 220 },
    { design: 3, slug: "radar", label: "Radar", width: 320, height: 320 },
  ],
  dan: [
    { design: 1, slug: "rice-and-ln", label: "Rice and LN", width: 880, height: 200 },
    { design: 2, slug: "single", label: "Single", width: 420, height: 160 },
    { design: 3, slug: "badge", label: "Badge", width: 300, height: 300 },
  ],
  insights: [
    { design: 1, slug: "stats-and-top-play", label: "Stats and top play", width: 880, height: 230 },
    { design: 2, slug: "stats", label: "Stats", width: 880, height: 110 },
    { design: 3, slug: "card", label: "Card", width: 420, height: 300 },
    /* The profile's cumulative pp view: how many top plays sit at or above
       each threshold. Taller than the others because it is a ladder whose
       length is the player's own pp spread. */
    { design: 4, slug: "pp-distribution", label: "PP distribution", width: 560, height: 300 },
  ],
};

export const SIGNATURE_TYPE_LABELS: Record<SignatureType, string> = {
  maniacard: "ManiaCard",
  goals: "Goals",
  skills: "Skill radar",
  dan: "Dan rating",
  insights: "Profile stats",
};

/* The render version cannot live in the URL the way OG_IMAGE_VERSION does -
   the whole point is a URL a player pastes once and never edits. It lives in
   the cache key instead, so bumping it supersedes every stored render and
   propagates within one edge TTL. Bump it when a layout changes. */
export const SIGNATURE_RENDER_VERSION = "15";

export function isSignatureType(value: string): value is SignatureType {
  return (SIGNATURE_TYPES as readonly string[]).includes(value);
}

export function signatureDesigns(type: SignatureType): SignatureDesign[] {
  return SIGNATURE_DESIGNS[type];
}

export function signatureDesign(type: SignatureType, design: number): SignatureDesign | null {
  return SIGNATURE_DESIGNS[type].find((entry) => entry.design === design) ?? null;
}

export interface SignatureVariant {
  type: SignatureType;
  design: number;
}

/* Parses the `<type>-<slug>.png` path segment, and the `<type>-<n>.png` form
   minted before layouts were named - those urls are pasted into osu! profiles
   and never edited, so the old shape has to keep resolving to the same layout
   forever.

   Everything outside the allowlist is refused here, before a resolve call and
   before any render. Both forms are exact lookups against the declared list,
   so neither can widen how many distinct renders a caller can make us store. */
export function parseSignatureVariant(raw: string): SignatureVariant | null {
  const match = /^([a-z]+)-([a-z0-9-]{1,40})\.png$/.exec(raw);
  if (!match) return null;
  const type = match[1]!;
  if (!isSignatureType(type)) return null;

  const tail = match[2]!;
  if (/^[1-9]$/.test(tail)) {
    const design = Number(tail);
    return signatureDesign(type, design) ? { type, design } : null;
  }
  const found = SIGNATURE_DESIGNS[type].find((entry) => entry.slug === tail);
  return found ? { type, design: found.design } : null;
}

/** The addressable name of a layout. Falls back to the id for a design that is
    not declared, so a caller passing junk lands on a slug that parses back to
    nothing rather than on one that happens to be another layout's. */
export function signatureVariantSlug(type: SignatureType, design: number): string {
  return `${type}-${signatureDesign(type, design)?.slug ?? design}.png`;
}

/** The url shape this used to mint. Only the purge path needs it: an edge
    cache is keyed by url, so a render someone pasted before layouts were
    named still has a copy sitting under the old address. */
export function legacySignatureVariantSlug(type: SignatureType, design: number): string {
  return `${type}-${design}.png`;
}

export function signatureImagePath(token: string, type: SignatureType, design: number): string {
  return `/api/signature/${token}/${signatureVariantSlug(type, design)}`;
}

export function signatureBBCode(url: string): string {
  return `[img]${url}[/img]`;
}

export const SIGNATURE_MAX_WIDTH = OSU_PROFILE_COLUMN_WIDTH;
