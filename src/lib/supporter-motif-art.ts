/* The shapes a supporter's cards can float, as code-native vectors.

   A leaf module on purpose: card-finish-art.ts resolves these by URL for the
   canvas, the overlay shader and the share image, and supporter-card-looks.ts
   builds the look on top of them, so neither import has to go through the
   other (card-motif.ts already imports card-finish-art.ts).

   Every sprite is a 128x128 tile in pale tones with a brighter outline, the
   same construction as the legacy finishes: the shader lights a sprite by its
   alpha weighted by brightness, so a pale shape reads on every tier, and the
   card keeps its own colours unless the supporter also picked a palette. */

export const SUPPORTER_MOTIF_IDS = ["stars", "notes", "stellium", "petals", "feathers", "hearts"] as const;
export type SupporterMotifId = (typeof SUPPORTER_MOTIF_IDS)[number];
export const DEFAULT_SUPPORTER_MOTIF: SupporterMotifId = "stars";

/* An identity, never fetched: the SVG below is what every surface draws. */
export function supporterMotifUrl(id: SupporterMotifId): string {
  return `https://mania-tracker.com/images/supporter-motifs/${id}.svg`;
}

const open = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">';

export const SUPPORTER_MOTIF_SVGS: Record<SupporterMotifId, string> = {
  stars:
    open +
    '<path d="M56 26 66 52.2 94 53.6 72.2 71.3 79.5 98.4 56 83 32.5 98.4 39.8 71.3 18 53.6 46 52.2Z" fill="#fde68a" fill-opacity=".6" stroke="#fffbeb" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M102 13 105.2 21.6 114.4 22 107.2 27.7 109.6 36.5 102 31.5 94.4 36.5 96.8 27.7 89.6 22 98.8 21.6Z" fill="#fffbeb" fill-opacity=".9" stroke="#fffbeb" stroke-width="2" stroke-linejoin="round"/>' +
    '<circle cx="104" cy="98" r="3.5" fill="#fef3c7"/>' +
    "</svg>",
  // Four columns of note heads climbing like a stair, the outer two white and
  // the inner two pink, as a default 4K skin colours them.
  notes:
    open +
    '<rect x="10" y="88" width="24" height="13" rx="6.5" fill="#f8fafc" fill-opacity=".85" stroke="#ffffff" stroke-width="2"/>' +
    '<rect x="38" y="66" width="24" height="13" rx="6.5" fill="#f9a8d4" fill-opacity=".75" stroke="#fdf2f8" stroke-width="2"/>' +
    '<rect x="66" y="44" width="24" height="13" rx="6.5" fill="#f9a8d4" fill-opacity=".75" stroke="#fdf2f8" stroke-width="2"/>' +
    '<rect x="94" y="22" width="24" height="13" rx="6.5" fill="#f8fafc" fill-opacity=".85" stroke="#ffffff" stroke-width="2"/>' +
    '<rect x="10" y="108" width="24" height="9" rx="4.5" fill="#f8fafc" fill-opacity=".35"/>' +
    '<rect x="94" y="42" width="24" height="9" rx="4.5" fill="#f8fafc" fill-opacity=".35"/>' +
    "</svg>",
  // The 7K Stellium badge's broken ring around its star.
  stellium:
    open +
    '<circle cx="64" cy="64" r="52" fill="none" stroke="#e2e8f0" stroke-opacity=".75" stroke-width="5" stroke-dasharray="120 43.4" stroke-dashoffset="30" stroke-linecap="round"/>' +
    '<circle cx="64" cy="64" r="42" fill="#e2e8f0" fill-opacity=".14"/>' +
    '<path d="M64 34 71.3 53.9 92.5 54.7 75.9 67.9 81.6 88.3 64 76.5 46.4 88.3 52.1 67.9 35.5 54.7 56.7 53.9Z" fill="#ffffff" fill-opacity=".92" stroke="#ffffff" stroke-width="5" stroke-linejoin="round"/>' +
    "</svg>",
  petals:
    open +
    '<path d="M58 112C34 96 26 60 42 30L56 40 66 26C88 50 84 92 58 112Z" fill="#fbcfe8" fill-opacity=".7" stroke="#fdf2f8" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<path d="M58 106C56 82 56 60 58 42" fill="none" stroke="#f9a8d4" stroke-width="2" stroke-linecap="round"/>' +
    '<g transform="translate(100 40) rotate(38)"><path d="M0 22C-13 14-17-4-8-20L0-14 6-22C17-8 14 12 0 22Z" fill="#f9a8d4" fill-opacity=".7" stroke="#fdf2f8" stroke-width="2" stroke-linejoin="round"/></g>' +
    "</svg>",
  feathers:
    open +
    '<path d="M100 14C66 22 40 52 34 98C58 92 90 64 100 14Z" fill="#e0e7ff" fill-opacity=".7" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<path d="M54 54 63 62M46 70 55 76M73 38 79 47" fill="none" stroke="#a5b4fc" stroke-opacity=".8" stroke-width="2.5" stroke-linecap="round"/>' +
    '<path d="M100 14C80 44 56 74 24 116" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>' +
    "</svg>",
  hearts:
    open +
    '<path d="M54 106C28 88 14 72 14 54 14 40 24 30 37 30 45 30 51 35 54 42 57 35 63 30 71 30 84 30 94 40 94 54 94 72 80 88 54 106Z" fill="#fecdd3" fill-opacity=".85" stroke="#fff1f2" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M101 44C91 37 86 31 86 24 86 19 90 15 95 15 98 15 100 17 101 20 102 17 104 15 107 15 112 15 116 19 116 24 116 31 111 37 101 44Z" fill="#fff1f2" fill-opacity=".95" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>' +
    "</svg>",
};

/* The SVG a supporter motif URL names, or null for any other URL. */
export function supporterMotifSvg(url: string): string | null {
  const id = SUPPORTER_MOTIF_IDS.find((candidate) => supporterMotifUrl(candidate) === url);
  return id ? SUPPORTER_MOTIF_SVGS[id] : null;
}
