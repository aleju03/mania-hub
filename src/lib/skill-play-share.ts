import { MSD_SKILLSET_META, skillAxisMeta } from "./skill-axes";

export interface SharedSkillPlaySearch {
  score?: number;
  keys?: number;
  map?: number;
  rating?: string;
}

const DAN_SLUGS: Record<string, string> = { "dan:rc": "dan", "dan:ln": "ln-dan" };
const MSD_SLUGS = new Set(MSD_SKILLSET_META.map((meta) => meta.key.toLowerCase()));

// Overall is the default and leaves no slug. Pattern ratings drop their
// prefix unless the id clashes with a skillset (pattern:stream vs Stream).
function ratingSlug(rating: string): string | null {
  if (rating === "Overall") return null;
  if (DAN_SLUGS[rating]) return DAN_SLUGS[rating];
  if (rating.startsWith("pattern:")) {
    const id = rating.slice("pattern:".length);
    return MSD_SLUGS.has(id) ? `pattern-${id}` : id;
  }
  return rating.toLowerCase();
}

function ratingFromSlug(slug: string | undefined): string | null {
  if (!slug) return "Overall";
  const dan = Object.entries(DAN_SLUGS).find(([, value]) => value === slug)?.[0];
  if (dan) return dan;
  const skillset = MSD_SKILLSET_META.find((meta) => meta.key.toLowerCase() === slug);
  if (skillset) return skillset.key;
  const pattern = `pattern:${slug.replace(/^pattern-/, "")}`;
  return skillAxisMeta(pattern) ? pattern : null;
}

function validRating(rating: string): boolean {
  return rating === "dan:rc" || rating === "dan:ln" || skillAxisMeta(rating) != null;
}

/** Reads `?play=4k-<scoreId>[-<rating>]`, and the older `?score=&keys=&map=&rating=` links. */
export function parseSharedSkillPlaySearch(search: Record<string, unknown>): SharedSkillPlaySearch {
  if (search.play != null) {
    const match = /^(\d{1,2})k-(\d+)(?:-([a-z-]+))?$/.exec(String(search.play).toLowerCase());
    if (!match) return {};
    const keys = Number(match[1]);
    const score = Number(match[2]);
    const rating = ratingFromSlug(match[3]);
    if (!Number.isSafeInteger(score) || score <= 0 || keys < 1 || keys > 18 || !rating) return {};
    return { score, keys, rating };
  }
  const score = Number(search.score);
  const keys = Number(search.keys);
  const map = Number(search.map);
  const rating = String(search.rating ?? "Overall");
  if (!Number.isSafeInteger(score) || score <= 0 || !Number.isInteger(keys) || keys < 1 || keys > 18
    || !Number.isSafeInteger(map) || map <= 0 || !validRating(rating)) return {};
  return { score, keys, map, rating };
}

export function skillPlaySharePath(username: string, scoreId: number | null | undefined, keyCount: number, rating: string): string | null {
  if (!scoreId || !Number.isSafeInteger(scoreId) || scoreId <= 0 || !Number.isInteger(keyCount) || keyCount < 1 || keyCount > 18
    || !validRating(rating)) return null;
  const slug = ratingSlug(rating);
  return `/player/${encodeURIComponent(username)}/skills?play=${keyCount}k-${scoreId}${slug ? `-${slug}` : ""}`;
}
