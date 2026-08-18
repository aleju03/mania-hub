// Dynamic renders: the one place that says which signature variants exist.
//
// Shared by the /dynamic-renders page, the image route, and the tests, because
// the render route validates against this allowlist *before* it resolves a
// token or touches R2. That check is what bounds cache-key cardinality to
// (opted-in players x types x designs) instead of letting a query string mint
// an unbounded number of stored objects.

import { OSU_PROFILE_COLUMN_WIDTH } from "./bbcode-layout";

export const SIGNATURE_TYPES = ["maniacard", "goals", "skills", "dan"] as const;
export type SignatureType = (typeof SIGNATURE_TYPES)[number];

export interface SignatureDesign {
  design: number;
  label: string;
  width: number;
  height: number;
}

/* Widths never exceed OSU_PROFILE_COLUMN_WIDTH: osu! emits
   style="width:<intrinsic>px" per [img] and caps at the column, so anything
   wider is silently scaled down and stops matching what the preview showed.
   Rendered at exact display pixels for the same reason - a 2x render would
   just appear twice as large on a profile. */
export const SIGNATURE_DESIGNS: Record<SignatureType, SignatureDesign[]> = {
  maniacard: [
    { design: 1, label: "Banner", width: 880, height: 200 },
    { design: 2, label: "Strip", width: 600, height: 140 },
    { design: 3, label: "Card", width: 420, height: 588 },
  ],
  goals: [
    { design: 1, label: "Progress list", width: 880, height: 230 },
    { design: 2, label: "Single focus", width: 560, height: 150 },
    { design: 3, label: "Full list", width: 880, height: 300 },
  ],
  skills: [
    { design: 1, label: "Radar and axes", width: 880, height: 260 },
    { design: 2, label: "Bars", width: 700, height: 220 },
    { design: 3, label: "Radar", width: 320, height: 320 },
  ],
  dan: [
    { design: 1, label: "Rice and LN", width: 880, height: 200 },
    { design: 2, label: "Single", width: 420, height: 160 },
    { design: 3, label: "Badge", width: 300, height: 300 },
  ],
};

export const SIGNATURE_TYPE_LABELS: Record<SignatureType, string> = {
  maniacard: "ManiaCard",
  goals: "Goals",
  skills: "Skill radar",
  dan: "Dan rating",
};

/* The render version cannot live in the URL the way OG_IMAGE_VERSION does -
   the whole point is a URL a player pastes once and never edits. It lives in
   the cache key instead, so bumping it supersedes every stored render and
   propagates within one edge TTL. Bump it when a layout changes. */
export const SIGNATURE_RENDER_VERSION = "12";

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

/* Parses the `<type>-<design>.png` path segment. Everything outside the
   allowlist is refused here, before a resolve call and before any render. */
export function parseSignatureVariant(raw: string): SignatureVariant | null {
  const match = /^([a-z]+)-([1-9])\.png$/.exec(raw);
  if (!match) return null;
  const type = match[1]!;
  if (!isSignatureType(type)) return null;
  const design = Number(match[2]);
  return signatureDesign(type, design) ? { type, design } : null;
}

export function signatureVariantSlug(type: SignatureType, design: number): string {
  return `${type}-${design}.png`;
}

export function signatureImagePath(token: string, type: SignatureType, design: number): string {
  return `/api/signature/${token}/${signatureVariantSlug(type, design)}`;
}

export function signatureBBCode(url: string): string {
  return `[img]${url}[/img]`;
}

export const SIGNATURE_MAX_WIDTH = OSU_PROFILE_COLUMN_WIDTH;
