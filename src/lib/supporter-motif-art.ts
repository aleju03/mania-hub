/* The doodles a supporter's cards can float, drawn the way the supporter
   welcome's heart is (wobbly ink ribbons over an off-register marker fill) by
   scripts/dev/card-doodles.html, one 320x320 transparent PNG each.

   A leaf module on purpose: card-motif.ts resolves these for the canvas and
   the overlay shader, and maniacard-art.ts for the share image.

   They drift in a layer of their own between the card's background and its
   text, in their own colours (cardTexture.ts, ManiaCardRenderer.ts).

   Retired from the supporter picker (a supporter's card art is now only their
   own upload); kept so a card or share image that still names one draws it. */

export const SUPPORTER_MOTIF_IDS = ["stars", "hearts", "notes", "petals", "headphones", "keys", "stellium"] as const;
export type SupporterMotifId = (typeof SUPPORTER_MOTIF_IDS)[number];
export const DEFAULT_SUPPORTER_MOTIF: SupporterMotifId = "stars";

/* The file's version: a redrawn picture takes a new number, because the
   service worker keeps anything under /images/ until its URL changes. */
const ART_VERSION = 2;

/* Site-relative path of the picture, which the browser loads directly: it is
   same-origin, so drawing it never taints the card canvas. */
export function supporterMotifPath(id: SupporterMotifId): string {
  return `/images/supporter-motifs/${id}-${ART_VERSION}.png`;
}

/* The identity a card carries. The share image reads it back off this
   deployment (siteAssetMotifPath in card-motif.ts), never off the public
   domain, so a local render draws the file in this checkout. */
export function supporterMotifUrl(id: SupporterMotifId): string {
  return `https://mania-tracker.com${supporterMotifPath(id)}`;
}

/* The site path a supporter motif URL names, or null for any other URL. */
export function supporterMotifPathForUrl(url: string): string | null {
  const id = SUPPORTER_MOTIF_IDS.find((candidate) => supporterMotifUrl(candidate) === url);
  return id ? supporterMotifPath(id) : null;
}
