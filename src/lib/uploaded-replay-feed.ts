import type { CommunityUploadEntry } from "./uploaded-replay-payload";

export const COMMUNITY_UPLOADS_PAGE_SIZE = 24;
export type CommunityUploadSort = "newest" | "oldest";
export type CommunityUploadKeys = "all" | "4" | "7" | "other";
export type CommunityUploadGrade = "all" | "SS" | "S" | "A" | "B";
/** Top of the star filter's rail; 0 on either end means that end is unset. */
export const COMMUNITY_STAR_MAX = 15;
export interface CommunityUploadsQuery {
  q: string;
  keys: CommunityUploadKeys;
  grade: CommunityUploadGrade;
  starMin: number;
  starMax: number;
  sort: CommunityUploadSort;
  cursor?: string;
  /** Refresh the already visible prefix while a cold catalog is filling. */
  limit?: number;
}
export interface CommunityUploadsPage {
  uploads: CommunityUploadEntry[];
  total: number;
  nextCursor: string | null;
  indexing: boolean;
}

function starBound(value: unknown): number {
  const stars = Number(value);
  if (!Number.isFinite(stars) || stars <= 0) return 0;
  return Math.min(COMMUNITY_STAR_MAX, Math.round(stars * 10) / 10);
}

export function normalizeCommunityUploadsQuery(data: Record<string, unknown> = {}): CommunityUploadsQuery {
  return {
    q: typeof data.q === "string" ? data.q.trim().slice(0, 160) : "",
    keys: data.keys === "4" || data.keys === "7" || data.keys === "other" ? data.keys : "all",
    grade: data.grade === "SS" || data.grade === "S" || data.grade === "A" || data.grade === "B" ? data.grade : "all",
    starMin: starBound(data.starMin),
    starMax: starBound(data.starMax),
    sort: data.sort === "oldest" ? data.sort : "newest",
    ...(typeof data.cursor === "string" && data.cursor.length <= 250 ? { cursor: data.cursor } : {}),
    ...(typeof data.limit === "number" && Number.isFinite(data.limit)
      ? { limit: Math.max(COMMUNITY_UPLOADS_PAGE_SIZE, Math.min(10_000, Math.floor(data.limit))) } : {}),
  };
}

// Silver ranks are the same grade with a mod on; the filter reads the letter,
// the way the tracker's grade filter does.
function gradeGroup(grade: string): CommunityUploadGrade | null {
  if (grade === "X" || grade === "XH" || grade === "SS" || grade === "SSH") return "SS";
  if (grade === "S" || grade === "SH") return "S";
  return grade === "A" || grade === "B" ? grade : null;
}

/** What the card shows and the difficulty filter reads: the rating the play
 *  actually ran at once it is known, and the map's own until then. */
export function uploadStarRating(upload: Pick<CommunityUploadEntry, "starRatingAtRate" | "beatmap">): number | null {
  return upload.starRatingAtRate ?? upload.beatmap?.starRating ?? null;
}

function searchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

// A value/time/id boundary remains stable when new uploads arrive or another
// upload is deleted. An offset (or looking up the previous id) does not.
function position(upload: CommunityUploadEntry, sort: CommunityUploadSort): [number, number, string] {
  return [sort === "oldest" ? upload.uploadedAt : -upload.uploadedAt, -upload.uploadedAt, upload.id];
}
function compare(a: [number, number, string], b: [number, number, string]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2], "en-US");
}
function parseCursor(cursor?: string): [number, number, string] | null {
  try {
    const value: unknown = JSON.parse(cursor ?? "null");
    return Array.isArray(value) && value.length === 3 && Number.isFinite(value[0]) && Number.isFinite(value[1])
      && typeof value[2] === "string" ? value as [number, number, string] : null;
  } catch {
    return null;
  }
}

export function queryCommunityUploads(
  entries: CommunityUploadEntry[], query: CommunityUploadsQuery, indexing = false, limit = query.limit ?? COMMUNITY_UPLOADS_PAGE_SIZE,
): CommunityUploadsPage {
  const words = searchText(query.q).split(/\s+/).filter(Boolean);
  const matching = entries.filter((entry) => {
    if (query.keys === "other" && (entry.keyCount === 4 || entry.keyCount === 7)) return false;
    if ((query.keys === "4" || query.keys === "7") && entry.keyCount !== Number(query.keys)) return false;
    if (query.grade !== "all" && gradeGroup(entry.grade) !== query.grade) return false;
    if (query.starMin > 0 || query.starMax > 0) {
      // An upload whose map osu! doesn't know has no star rating to compare, so
      // a narrowed range drops it rather than guessing it belongs.
      const stars = uploadStarRating(entry);
      if (stars == null) return false;
      if (query.starMin > 0 && stars < query.starMin) return false;
      if (query.starMax > 0 && stars > query.starMax) return false;
    }
    if (!words.length) return true;
    const text = searchText([entry.playerName, entry.originalFilename, entry.uploadedBy?.username,
      entry.beatmap?.title, entry.beatmap?.artist, entry.beatmap?.version, entry.beatmap?.creator,
      `${entry.keyCount}K`, ...entry.mods].filter(Boolean).join(" "));
    return words.every((word) => text.includes(word));
  }).sort((a, b) => compare(position(a, query.sort), position(b, query.sort)));
  const boundary = parseCursor(query.cursor);
  const remaining = boundary ? matching.filter((entry) => compare(position(entry, query.sort), boundary) > 0) : matching;
  const uploads = remaining.slice(0, limit);
  return {
    uploads,
    total: matching.length,
    nextCursor: remaining.length > limit ? JSON.stringify(position(uploads[uploads.length - 1], query.sort)) : null,
    indexing,
  };
}
