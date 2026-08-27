import type { LiveMapSearchEntry } from "./live-backend";

/*
 * Shapes and caps for the collections players build themselves, shared by the
 * browse grid, the editor and the server functions. Mirrors
 * live-backend/src/features/user-map-collections.ts, which is the copy that
 * counts: everything here is a convenience for the form, and the backend
 * normalizes and re-checks whatever arrives.
 *
 * Split out of user-map-collections.ts so client components can import the caps
 * without pulling the server-function module into the browser bundle.
 */

export const USER_COLLECTION_MAX_PER_USER = 25;
export const USER_COLLECTION_MAX_ITEMS = 100;
/** A list shorter than this is a recommendation, not a collection. Mirrored in
    the backend, which is what actually refuses the write. */
export const USER_COLLECTION_MIN_ITEMS = 3;
export const USER_COLLECTION_TITLE_MAX_LENGTH = 80;
export const USER_COLLECTION_DESCRIPTION_MAX_LENGTH = 600;
export const USER_COLLECTION_MAX_TAGS = 5;
export const USER_COLLECTION_TAG_MAX_LENGTH = 24;
export const USER_COLLECTIONS_PAGE_SIZE = 24;

export type UserCollectionSort = "recent" | "favourites" | "maps" | "title";

export interface UserCollectionOwner {
  userId: number;
  username: string;
  avatarUrl: string | null;
  countryCode: string | null;
}

export interface UserMapCollectionSummary {
  id: string;
  /** The pretty half of its URL. Fixed at creation, so a rename never 404s a
      link that was already shared; null only for a row written before slugs. */
  slug: string | null;
  title: string;
  description: string | null;
  tags: string[];
  /** The keymode every map in it shares, or null when the list mixes them. */
  keyCount: number | null;
  memberCount: number;
  favouriteCount: number;
  coverSetIds: number[];
  owner: UserCollectionOwner;
  createdAt: string;
  updatedAt: string;
  favourited: boolean;
}

export interface UserMapCollectionDetail extends UserMapCollectionSummary {
  items: LiveMapSearchEntry[];
}

export interface UserCollectionsListResult {
  collections: UserMapCollectionSummary[];
  total: number;
  page: number;
  pageSize: number;
  facets: { tags: Array<{ value: string; count: number }> };
}

export const EMPTY_USER_COLLECTIONS_LIST: UserCollectionsListResult = {
  collections: [],
  total: 0,
  page: 0,
  pageSize: USER_COLLECTIONS_PAGE_SIZE,
  facets: { tags: [] },
};

export type UserCollectionWriteResult =
  | { ok: true; collection: UserMapCollectionSummary; droppedBeatmapIds: number[] }
  | { ok: false; error: string };

/** The tag shape the backend stores, applied while typing so the chip in the
    form is the chip the directory will filter on. */
export function normalizeUserCollectionTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 +#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, USER_COLLECTION_TAG_MAX_LENGTH);
}

/** Where a collection lives: /collections/<slug>, falling back to its id. */
export function collectionPath(collection: Pick<UserMapCollectionSummary, "id" | "slug">): string {
  return `/collections/${collection.slug || collection.id}`;
}

/** "4K", "7K", "9K", or null for a collection that mixes keymodes. */
export function userCollectionKeyLabel(keyCount: number | null): string | null {
  return keyCount == null ? null : `${keyCount}K`;
}

/*
 * Fold a collection's charts into one entry per beatmapset, the same shape the
 * map search answers with: the easiest included difficulty is the face of the
 * card and the rest ride along in `diffs`.
 *
 * Adding a whole mapset is one thought ("this pack"), and left ungrouped it
 * painted fourteen near-identical cards of the same artwork down the page. The
 * author's order is kept by first appearance, so a set lands where its first
 * chart was put rather than being hoisted or sorted away.
 *
 * A chart whose set id is missing (0) groups only with itself: two unrelated
 * charts must not merge just because neither knows its set.
 */
export function groupCollectionItemsBySet(items: readonly LiveMapSearchEntry[]): LiveMapSearchEntry[] {
  const groups = new Map<string, LiveMapSearchEntry[]>();
  for (const item of items) {
    const key = item.beatmapsetId > 0 ? `s${item.beatmapsetId}` : `b${item.beatmapId}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const diffs = [...group].sort((a, b) => a.stars - b.stars || a.beatmapId - b.beatmapId);
    return { ...diffs[0], diffs, diffCount: diffs.length };
  });
}
