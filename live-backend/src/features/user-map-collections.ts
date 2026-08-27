import crypto from "node:crypto";
import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec, execBatch, json, parseJson, type DbStatement } from "../db.js";
import { nowIso } from "../shared/score.js";
import { getMapSearchEntriesByIds, type MapSearchEntry } from "./map-search.js";

/*
 * Map collections built by players, as opposed to the auto-generated packs in
 * map-collections.ts. A collection is a title, a few words about it, some tags,
 * and an ordered list of charts; anyone signed in can post one and it is public
 * the moment they do.
 *
 * There is no review state here on purpose. What a collection contains is
 * beatmap ids, and every one of them has already been through osu!'s own
 * submission and moderation before it could reach the catalog this reads from;
 * a second queue in front of "these are my favourite jack files" would be
 * ceremony. The only removal path is the owner's own delete, plus an admin's
 * (which is the same call with asAdmin).
 *
 * Membership is validated against map_search_index rather than taken from the
 * client: an id the catalog does not know is dropped on the way in, so a
 * collection can never hold a chart the page could not render. That index is
 * also where the derived fields come from - the keymode chip and the cover
 * collage are read off the members, never typed by the author, so they cannot
 * disagree with what is in the list.
 */

export const USER_COLLECTION_MAX_PER_USER = 25;
export const USER_COLLECTION_MAX_ITEMS = 100;
/* A list of one or two charts is a recommendation, not a collection, and the
   directory reads as noise when it fills with them. Checked against the members
   the catalog actually recognized, so padding a short list with dead ids does
   not get past it. */
export const USER_COLLECTION_MIN_ITEMS = 3;
export const USER_COLLECTION_TITLE_MAX_LENGTH = 80;
export const USER_COLLECTION_DESCRIPTION_MAX_LENGTH = 600;
export const USER_COLLECTION_MAX_TAGS = 5;
export const USER_COLLECTION_TAG_MAX_LENGTH = 24;
export const USER_COLLECTIONS_PAGE_SIZE = 24;
const USER_COLLECTIONS_MAX_PAGE_SIZE = 50;
// Enough tags to fill the filter row; the tail is one-offs.
const USER_COLLECTION_TAG_FACET_LIMIT = 24;

export type UserCollectionSort = "recent" | "favourites" | "maps" | "title";

/*
 * The shareable half of a collection's URL: "LN Coordination" becomes
 * "ln-coordination". A title with nothing a slug can keep (all CJK, all
 * punctuation) falls back to the word, and the id is what makes it unique -
 * `uniqueCollectionSlug` appends -2, -3 rather than letting two collections
 * fight over one link.
 */
export function slugifyCollectionTitle(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return base || "collection";
}

async function uniqueCollectionSlug(db: Db, title: string, id: string): Promise<string> {
  const base = slugifyCollectionTitle(title);
  for (let attempt = 1; attempt <= 50; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    const clash = (await exec(db, "select id from user_map_collections where slug = ? and id != ? limit 1", [slug, id])).rows[0];
    if (!clash) return slug;
  }
  // Fifty collections already named this; the id is always free.
  return `${base}-${id}`;
}

const ORDER_SQL: Record<UserCollectionSort, string> = {
  recent: "created_at desc",
  favourites: "favourite_count desc, created_at desc",
  maps: "member_count desc, created_at desc",
  title: "title collate nocase asc",
};

export function normalizeUserCollectionSort(value: unknown): UserCollectionSort {
  const sort = String(value ?? "");
  return sort === "favourites" || sort === "maps" || sort === "title" ? sort : "recent";
}

export interface UserCollectionOwner {
  userId: number;
  username: string;
  avatarUrl: string | null;
  countryCode: string | null;
}

export interface UserMapCollectionSummary {
  id: string;
  /** The pretty half of its URL, `/collections/<slug>`. Fixed at creation: a
      rename must not 404 every link already shared. */
  slug: string | null;
  title: string;
  description: string | null;
  tags: string[];
  /** The keymode every member shares, or null when the list mixes them. */
  keyCount: number | null;
  memberCount: number;
  favouriteCount: number;
  coverSetIds: number[];
  owner: UserCollectionOwner;
  createdAt: string;
  updatedAt: string;
  /** Whether whoever asked has this one favourited; false for a stranger. */
  favourited: boolean;
}

export interface UserMapCollectionDetail extends UserMapCollectionSummary {
  items: MapSearchEntry[];
}

export interface UserCollectionsListResult {
  collections: UserMapCollectionSummary[];
  total: number;
  page: number;
  pageSize: number;
  facets: { tags: Array<{ value: string; count: number }> };
}

export interface UserCollectionInput {
  title: string;
  description?: string | null;
  tags?: unknown;
  beatmapIds?: unknown;
}

export type UserCollectionWriteResult =
  | { ok: true; collection: UserMapCollectionSummary; droppedBeatmapIds: number[] }
  | { ok: false; error: string };

// ------------------------------------------------------------- normalizing

function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Description keeps its line breaks; only trailing whitespace per line goes. */
function cleanDescription(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, USER_COLLECTION_DESCRIPTION_MAX_LENGTH);
}

/*
 * Tags are owner-typed free text, normalized to a charset with no quotes or
 * commas, the same shape /communities uses: the list filter matches with LIKE
 * over the json blob, and a tag that could contain the delimiter would let a
 * longer tag half-match a shorter one.
 */
export function normalizeUserCollectionTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = entry
      .toLowerCase()
      .replace(/[^a-z0-9 +#-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, USER_COLLECTION_TAG_MAX_LENGTH);
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= USER_COLLECTION_MAX_TAGS) break;
  }
  return tags;
}

function normalizeBeatmapIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const entry of value) {
    const id = Math.floor(Number(entry));
    if (!Number.isFinite(id) || id <= 0 || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= USER_COLLECTION_MAX_ITEMS) break;
  }
  return ids;
}

function searchText(title: string, description: string, tags: string[], username: string): string {
  return `${title} ${description} ${tags.join(" ")} ${username}`.toLowerCase().slice(0, 2000);
}

// A set has usable cover art when osu! returned a cover with a real upload
// version; a "?0" version marks a background that was never uploaded and would
// render as a blank tile in the collage. Same test the auto packs apply.
function hasCoverArt(coversJson: unknown): boolean {
  const covers = parseJson<Record<string, string> | null>(coversJson, null);
  if (!covers || typeof covers !== "object") return false;
  return Object.values(covers).some((url) => typeof url === "string" && url.length > 0 && !url.endsWith("?0"));
}

interface MemberFacts {
  /** The requested ids that the catalog knows, in the order they were asked for. */
  beatmapIds: number[];
  droppedBeatmapIds: number[];
  keyCount: number | null;
  coverSetIds: number[];
}

/*
 * What the catalog says about a proposed member list: which ids are real, the
 * keymode they share (null when mixed or empty), and the first few sets with
 * artwork for the card collage.
 */
async function readMemberFacts(db: Db, beatmapIds: number[]): Promise<MemberFacts> {
  if (beatmapIds.length === 0) return { beatmapIds: [], droppedBeatmapIds: [], keyCount: null, coverSetIds: [] };
  const placeholders = beatmapIds.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select beatmap_id, beatmapset_id, key_count, covers_json
     from map_search_index where beatmap_id in (${placeholders})`,
    beatmapIds as InValue[],
  )).rows;
  const known = new Map<number, { beatmapsetId: number; keyCount: number; hasCover: boolean }>();
  for (const row of rows) {
    known.set(Math.floor(Number(row.beatmap_id)), {
      beatmapsetId: Math.floor(Number(row.beatmapset_id)) || 0,
      keyCount: Math.floor(Number(row.key_count)) || 0,
      hasCover: hasCoverArt(row.covers_json),
    });
  }
  const kept = beatmapIds.filter((id) => known.has(id));
  const dropped = beatmapIds.filter((id) => !known.has(id));
  const keyCounts = new Set(kept.map((id) => known.get(id)?.keyCount ?? 0).filter((keys) => keys > 0));
  const coverSetIds: number[] = [];
  for (const id of kept) {
    const facts = known.get(id);
    if (!facts || !facts.hasCover || facts.beatmapsetId <= 0) continue;
    if (coverSetIds.includes(facts.beatmapsetId)) continue;
    coverSetIds.push(facts.beatmapsetId);
    if (coverSetIds.length >= 3) break;
  }
  return {
    beatmapIds: kept,
    droppedBeatmapIds: dropped,
    keyCount: keyCounts.size === 1 ? [...keyCounts][0] : null,
    coverSetIds,
  };
}

// ------------------------------------------------------------------- reads

function rowToSummary(row: Record<string, unknown>, favourited: boolean): UserMapCollectionSummary {
  const description = row.description == null ? "" : String(row.description);
  return {
    id: String(row.id ?? ""),
    slug: row.slug == null ? null : String(row.slug),
    title: String(row.title ?? ""),
    description: description || null,
    tags: parseJson<string[]>(row.tags_json, []).filter((tag): tag is string => typeof tag === "string"),
    keyCount: row.key_count == null ? null : Math.floor(Number(row.key_count)) || null,
    memberCount: Math.floor(Number(row.member_count)) || 0,
    favouriteCount: Math.floor(Number(row.favourite_count)) || 0,
    coverSetIds: parseJson<number[]>(row.cover_sets_json, [])
      .map((id) => Math.floor(Number(id)))
      .filter((id) => id > 0),
    owner: {
      userId: Math.floor(Number(row.owner_user_id)) || 0,
      username: String(row.owner_username ?? ""),
      avatarUrl: row.owner_avatar_url == null ? null : String(row.owner_avatar_url),
      countryCode: row.owner_country == null ? null : String(row.owner_country),
    },
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    favourited,
  };
}

/* The owner's avatar comes off the `users` projection rather than being copied
   onto the collection: a player who changes their avatar changes it everywhere
   at once, and a collection posted by someone the site has never tracked simply
   has no avatar to show. */
const SUMMARY_SELECT = `select c.id, c.slug, c.title, c.description, c.tags_json, c.key_count, c.member_count,
  c.favourite_count, c.cover_sets_json, c.owner_user_id, c.owner_username, c.owner_country,
  u.avatar_url as owner_avatar_url, c.created_at, c.updated_at
  from user_map_collections c left join users u on u.user_id = c.owner_user_id`;

async function favouritedIds(db: Db, viewerUserId: number | null, ids: string[]): Promise<Set<string>> {
  if (!viewerUserId || ids.length === 0) return new Set();
  const rows = (await exec(
    db,
    `select collection_id from user_map_collection_favourites
     where user_id = ? and collection_id in (${ids.map(() => "?").join(", ")})`,
    [viewerUserId, ...ids],
  )).rows;
  return new Set(rows.map((row) => String(row.collection_id)));
}

export interface UserCollectionsQuery {
  q?: string;
  sort?: UserCollectionSort;
  keys?: string;
  tag?: string;
  ownerUserId?: number | null;
  /** Only the collections this viewer favourited. */
  favouritedBy?: number | null;
  page?: number;
  pageSize?: number;
  viewerUserId?: number | null;
}

export async function listUserMapCollections(db: Db, query: UserCollectionsQuery): Promise<UserCollectionsListResult> {
  const page = Math.max(0, Math.floor(Number(query.page ?? 0)) || 0);
  const pageSize = Math.min(USER_COLLECTIONS_MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.pageSize ?? USER_COLLECTIONS_PAGE_SIZE)) || USER_COLLECTIONS_PAGE_SIZE));
  const sort = normalizeUserCollectionSort(query.sort);

  const clauses: string[] = [];
  const args: InValue[] = [];
  const q = cleanText(query.q, 80).toLowerCase();
  if (q) {
    clauses.push("c.search_text like ?");
    args.push(`%${q}%`);
  }
  // "4k" / "7k" / "other" over the derived keymode; a mixed collection is not
  // any one keymode and stays out of all three.
  const keys = String(query.keys ?? "").toLowerCase();
  if (keys === "4k" || keys === "7k") {
    clauses.push("c.key_count = ?");
    args.push(keys === "4k" ? 4 : 7);
  } else if (keys === "other") {
    clauses.push("c.key_count is not null and c.key_count not in (4, 7)");
  }
  const tag = normalizeUserCollectionTags([query.tag])[0];
  if (tag) {
    clauses.push("c.tags_json like ?");
    args.push(`%"${tag}"%`);
  }
  const ownerUserId = Math.floor(Number(query.ownerUserId ?? 0)) || 0;
  if (ownerUserId > 0) {
    clauses.push("c.owner_user_id = ?");
    args.push(ownerUserId);
  }
  const favouritedBy = Math.floor(Number(query.favouritedBy ?? 0)) || 0;
  if (favouritedBy > 0) {
    clauses.push("exists (select 1 from user_map_collection_favourites f where f.collection_id = c.id and f.user_id = ?)");
    args.push(favouritedBy);
  }
  const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";

  const totalRow = (await exec(
    db,
    `select count(*) as total from user_map_collections c${where}`,
    args,
  )).rows[0];
  const rows = (await exec(
    db,
    `${SUMMARY_SELECT}${where} order by ${ORDER_SQL[sort]} limit ? offset ?`,
    [...args, pageSize, page * pageSize],
  )).rows;

  const favourites = await favouritedIds(db, query.viewerUserId ?? null, rows.map((row) => String(row.id)));
  // Facets come off the whole directory rather than the filtered page, so the
  // tag row does not empty itself out as soon as one tag is picked.
  const tagRows = (await exec(
    db,
    `select value as tag, count(*) as total from user_map_collections, json_each(tags_json)
     group by value order by total desc, value asc limit ?`,
    [USER_COLLECTION_TAG_FACET_LIMIT],
  )).rows;

  return {
    collections: rows.map((row) => rowToSummary(row, favourites.has(String(row.id)))),
    total: Math.floor(Number(totalRow?.total ?? 0)) || 0,
    page,
    pageSize,
    facets: {
      tags: tagRows.map((row) => ({ value: String(row.tag), count: Math.floor(Number(row.total)) || 0 })),
    },
  };
}

export async function getUserMapCollectionSummary(
  db: Db,
  id: string,
  viewerUserId: number | null = null,
): Promise<UserMapCollectionSummary | null> {
  // Either half of the link resolves: the slug is what gets shared, the id is
  // what a pre-slug link (or a collection whose title slugged to nothing) uses.
  const row = (await exec(db, `${SUMMARY_SELECT} where c.id = ? or c.slug = ? limit 1`, [id, id])).rows[0];
  if (!row) return null;
  const favourites = await favouritedIds(db, viewerUserId, [String(row.id)]);
  return rowToSummary(row, favourites.has(String(row.id)));
}

export async function getUserMapCollection(
  db: Db,
  id: string,
  viewerUserId: number | null = null,
): Promise<UserMapCollectionDetail | null> {
  const summary = await getUserMapCollectionSummary(db, id, viewerUserId);
  if (!summary) return null;
  // `id` may be the slug half of the link; the items table only knows the id.
  const memberRows = (await exec(
    db,
    "select beatmap_id from user_map_collection_items where collection_id = ? order by position asc",
    [summary.id],
  )).rows;
  const orderedIds = memberRows.map((row) => Math.floor(Number(row.beatmap_id))).filter((value) => value > 0);
  const entryById = await getMapSearchEntriesByIds(db, orderedIds);
  // A chart that left the index between the write and this read is skipped
  // rather than rendered as a hole; member_count is what the author put in.
  const items = orderedIds.map((beatmapId) => entryById.get(beatmapId)).filter((entry): entry is MapSearchEntry => !!entry);
  return { ...summary, items };
}

export async function listUserMapCollectionsForOwner(db: Db, ownerUserId: number): Promise<UserMapCollectionSummary[]> {
  const rows = (await exec(
    db,
    `${SUMMARY_SELECT} where c.owner_user_id = ? order by c.created_at desc`,
    [ownerUserId],
  )).rows;
  const favourites = await favouritedIds(db, ownerUserId, rows.map((row) => String(row.id)));
  return rows.map((row) => rowToSummary(row, favourites.has(String(row.id))));
}

// ------------------------------------------------------------------ writes

/** The statements that replace a collection's member list and its derived fields. */
function memberStatements(id: string, facts: MemberFacts, now: string): DbStatement[] {
  const statements: DbStatement[] = [
    { sql: "delete from user_map_collection_items where collection_id = ?", args: [id] },
  ];
  facts.beatmapIds.forEach((beatmapId, index) => {
    statements.push({
      sql: "insert into user_map_collection_items (collection_id, beatmap_id, position, added_at) values (?, ?, ?, ?)",
      args: [id, beatmapId, index, now],
    });
  });
  return statements;
}

export async function createUserMapCollection(
  db: Db,
  input: UserCollectionInput & { ownerUserId: number; ownerUsername: string; ownerCountry?: string | null },
): Promise<UserCollectionWriteResult> {
  const title = cleanText(input.title, USER_COLLECTION_TITLE_MAX_LENGTH);
  if (!title) return { ok: false, error: "empty_title" };

  const mine = (await exec(
    db,
    "select count(*) as total from user_map_collections where owner_user_id = ?",
    [input.ownerUserId],
  )).rows[0];
  if (Number(mine?.total ?? 0) >= USER_COLLECTION_MAX_PER_USER) return { ok: false, error: "limit_reached" };

  const description = cleanDescription(input.description);
  const tags = normalizeUserCollectionTags(input.tags);
  const facts = await readMemberFacts(db, normalizeBeatmapIds(input.beatmapIds));
  if (facts.beatmapIds.length < USER_COLLECTION_MIN_ITEMS) return { ok: false, error: "too_few_maps" };
  const now = nowIso();
  // Short and URL-shaped rather than a uuid: this id rides in every shared
  // link beside the slug, and 36 characters of hyphenated hex there is what a
  // long ugly URL is made of. 10 hex characters is ~1.1e12 values, against a
  // table that will hold thousands.
  const id = crypto.randomBytes(5).toString("hex");
  const country = String(input.ownerCountry ?? "").trim().toUpperCase();

  const slug = await uniqueCollectionSlug(db, title, id);

  await execBatch(db, [
    {
      sql: `insert into user_map_collections (
          id, slug, owner_user_id, owner_username, owner_country, title, description, tags_json, search_text,
          key_count, member_count, favourite_count, cover_sets_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      args: [
        id,
        slug,
        input.ownerUserId,
        input.ownerUsername,
        /^[A-Z]{2}$/.test(country) ? country : null,
        title,
        description || null,
        json(tags),
        searchText(title, description, tags, input.ownerUsername),
        facts.keyCount,
        facts.beatmapIds.length,
        json(facts.coverSetIds),
        now,
        now,
      ],
    },
    ...memberStatements(id, facts, now),
  ]);

  const collection = await getUserMapCollectionSummary(db, id, input.ownerUserId);
  if (!collection) return { ok: false, error: "write_failed" };
  return { ok: true, collection, droppedBeatmapIds: facts.droppedBeatmapIds };
}

export interface UserCollectionPatch {
  title?: unknown;
  description?: unknown;
  tags?: unknown;
  beatmapIds?: unknown;
}

/**
 * Edits one collection in place. Every field is optional: the editor sends the
 * whole form, but a rename that never opened the map picker must not empty the
 * list, so an absent `beatmapIds` leaves the members (and the fields derived
 * from them) exactly as they were.
 */
export async function updateUserMapCollection(
  db: Db,
  ownerUserId: number,
  id: string,
  patch: UserCollectionPatch,
  options: { asAdmin?: boolean } = {},
): Promise<UserCollectionWriteResult> {
  const row = (await exec(db, "select owner_user_id, title, description, tags_json, owner_username from user_map_collections where id = ? limit 1", [id])).rows[0];
  if (!row) return { ok: false, error: "not_found" };
  if (Math.floor(Number(row.owner_user_id)) !== ownerUserId && options.asAdmin !== true) return { ok: false, error: "forbidden" };

  const title = patch.title === undefined
    ? String(row.title ?? "")
    : cleanText(patch.title, USER_COLLECTION_TITLE_MAX_LENGTH);
  if (!title) return { ok: false, error: "empty_title" };
  const description = patch.description === undefined
    ? (row.description == null ? "" : String(row.description))
    : cleanDescription(patch.description);
  const tags = patch.tags === undefined
    ? parseJson<string[]>(row.tags_json, [])
    : normalizeUserCollectionTags(patch.tags);
  const now = nowIso();

  const statements: DbStatement[] = [];
  let dropped: number[] = [];
  if (patch.beatmapIds === undefined) {
    statements.push({
      sql: `update user_map_collections set title = ?, description = ?, tags_json = ?, search_text = ?, updated_at = ? where id = ?`,
      args: [title, description || null, json(tags), searchText(title, description, tags, String(row.owner_username ?? "")), now, id],
    });
  } else {
    const facts = await readMemberFacts(db, normalizeBeatmapIds(patch.beatmapIds));
    if (facts.beatmapIds.length < USER_COLLECTION_MIN_ITEMS) return { ok: false, error: "too_few_maps" };
    dropped = facts.droppedBeatmapIds;
    statements.push({
      sql: `update user_map_collections set title = ?, description = ?, tags_json = ?, search_text = ?,
              key_count = ?, member_count = ?, cover_sets_json = ?, updated_at = ? where id = ?`,
      args: [
        title,
        description || null,
        json(tags),
        searchText(title, description, tags, String(row.owner_username ?? "")),
        facts.keyCount,
        facts.beatmapIds.length,
        json(facts.coverSetIds),
        now,
        id,
      ],
    });
    statements.push(...memberStatements(id, facts, now));
  }
  await execBatch(db, statements);

  const collection = await getUserMapCollectionSummary(db, id, ownerUserId);
  if (!collection) return { ok: false, error: "write_failed" };
  return { ok: true, collection, droppedBeatmapIds: dropped };
}

/** Owner delete, or an admin's takedown with `asAdmin`. */
export async function deleteUserMapCollection(
  db: Db,
  ownerUserId: number,
  id: string,
  options: { asAdmin?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const row = (await exec(db, "select owner_user_id from user_map_collections where id = ? limit 1", [id])).rows[0];
  if (!row) return { ok: false, error: "not_found" };
  if (Math.floor(Number(row.owner_user_id)) !== ownerUserId && options.asAdmin !== true) return { ok: false, error: "forbidden" };
  await execBatch(db, [
    { sql: "delete from user_map_collection_items where collection_id = ?", args: [id] },
    { sql: "delete from user_map_collection_favourites where collection_id = ?", args: [id] },
    { sql: "delete from user_map_collections where id = ?", args: [id] },
  ]);
  return { ok: true };
}

/**
 * Favourite or unfavourite, and hand back the count the button should now show.
 * The count lives on the collection row rather than being counted per read, and
 * it is recomputed from the favourites table inside the same batch, so a double
 * click cannot drift it away from the rows underneath.
 */
export async function setUserMapCollectionFavourite(
  db: Db,
  id: string,
  userId: number,
  favourited: boolean,
): Promise<{ ok: boolean; favourited: boolean; favouriteCount: number; error?: string }> {
  const row = (await exec(db, "select id from user_map_collections where id = ? limit 1", [id])).rows[0];
  if (!row) return { ok: false, favourited: false, favouriteCount: 0, error: "not_found" };
  await execBatch(db, [
    favourited
      ? {
          sql: "insert or ignore into user_map_collection_favourites (collection_id, user_id, created_at) values (?, ?, ?)",
          args: [id, userId, nowIso()],
        }
      : { sql: "delete from user_map_collection_favourites where collection_id = ? and user_id = ?", args: [id, userId] },
    {
      sql: `update user_map_collections set favourite_count =
              (select count(*) from user_map_collection_favourites where collection_id = ?) where id = ?`,
      args: [id, id],
    },
  ]);
  const counted = (await exec(db, "select favourite_count from user_map_collections where id = ?", [id])).rows[0];
  return { ok: true, favourited, favouriteCount: Math.floor(Number(counted?.favourite_count ?? 0)) || 0 };
}
