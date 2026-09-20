import type { CommunityUploadEntry } from "./uploaded-replay-payload";

export const COMMUNITY_UPLOADS_PAGE_SIZE = 24;
export type CommunityUploadSort = "newest" | "oldest" | "accuracy" | "difficulty";
export type CommunityUploadKeys = "all" | "4" | "7" | "other";
export interface CommunityUploadsQuery {
  q: string;
  keys: CommunityUploadKeys;
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

export function normalizeCommunityUploadsQuery(data: Record<string, unknown> = {}): CommunityUploadsQuery {
  return {
    q: typeof data.q === "string" ? data.q.trim().slice(0, 160) : "",
    keys: data.keys === "4" || data.keys === "7" || data.keys === "other" ? data.keys : "all",
    sort: data.sort === "oldest" || data.sort === "accuracy" || data.sort === "difficulty" ? data.sort : "newest",
    ...(typeof data.cursor === "string" && data.cursor.length <= 250 ? { cursor: data.cursor } : {}),
    ...(typeof data.limit === "number" && Number.isFinite(data.limit)
      ? { limit: Math.max(COMMUNITY_UPLOADS_PAGE_SIZE, Math.min(10_000, Math.floor(data.limit))) } : {}),
  };
}

function searchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

// A value/time/id boundary remains stable when new uploads arrive or another
// upload is deleted. An offset (or looking up the previous id) does not.
function position(upload: CommunityUploadEntry, sort: CommunityUploadSort): [number, number, string] {
  return [sort === "difficulty" ? -(upload.beatmap?.starRating ?? -1)
    : sort === "accuracy" ? -upload.accuracy : sort === "oldest" ? upload.uploadedAt : -upload.uploadedAt,
    -upload.uploadedAt, upload.id];
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
