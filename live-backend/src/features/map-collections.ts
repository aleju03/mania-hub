import type { Db } from "../db.js";
import { exec, execBatch, type DbStatement } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { nowIso } from "../shared/score.js";
import {
  getMapSearchEntriesByIds,
  patternScoreColumn,
  MAP_SEARCH_PATTERNS,
  type MapSearchEntry,
} from "./map-search.js";

// Auto-generated map packs materialized from map_search_index by code-defined
// recipes (pattern x key x star bucket). Players browse these from the /maps
// Collections section. Members are deduped by beatmapset so a pack is
// distinct mapsets, not many diffs of one set.

const COLLECTIONS_REFRESHED_META_KEY = "map_collections_refreshed_at";
const MEMBER_LIMIT = 40;
const OVERFETCH = 240;

const PATTERN_LABELS: Record<string, string> = {
  jack: "Jack",
  stream: "Stream",
  jumpstream: "Jumpstream",
  handstream: "Handstream",
  stamina: "Stamina",
  chordjack: "Chordjack",
  tech: "Tech",
  ln: "LN",
};

const STAR_BUCKETS = [
  { id: "2-3", min: 2, max: 3 },
  { id: "3-4", min: 3, max: 4 },
  { id: "4-5", min: 4, max: 5 },
  { id: "5-6", min: 5, max: 6 },
  { id: "6plus", min: 6, max: 99 },
] as const;

const COLLECTION_KEYS = [4, 7] as const;

interface CollectionRecipe {
  id: string;
  recipeId: string;
  kind: "pattern";
  pattern: string;
  keyCount: number;
  starMin: number;
  starMax: number;
  title: string;
  description: string;
  sortOrder: number;
}

function buildRecipes(): CollectionRecipe[] {
  const recipes: CollectionRecipe[] = [];
  let order = 0;
  for (const pattern of MAP_SEARCH_PATTERNS) {
    const label = PATTERN_LABELS[pattern] ?? pattern;
    for (const keyCount of COLLECTION_KEYS) {
      for (const bucket of STAR_BUCKETS) {
        const starLabel = bucket.max >= 99 ? `${bucket.min}★+` : `${bucket.min}-${bucket.max}★`;
        const starText = bucket.max >= 99 ? `${bucket.min}★ and up` : `${bucket.min} to ${bucket.max}★`;
        recipes.push({
          id: `pattern:${pattern}:${keyCount}k:${bucket.id}`,
          recipeId: `pattern:${pattern}:${keyCount}k`,
          kind: "pattern",
          pattern,
          keyCount,
          starMin: bucket.min,
          starMax: bucket.max,
          title: `${label} · ${keyCount}K · ${starLabel}`,
          description: `${label}-heavy ${keyCount}K maps, ${starText}.`,
          sortOrder: order++,
        });
      }
    }
  }
  return recipes;
}

export const COLLECTION_RECIPES: CollectionRecipe[] = buildRecipes();

export interface MapCollectionSummary {
  id: string;
  recipeId: string;
  kind: string;
  title: string;
  description: string | null;
  keyCount: number | null;
  pattern: string | null;
  sortOrder: number;
  coverSetId: number | null;
  memberCount: number;
  refreshedAt: string;
}

export interface MapCollectionDetail extends MapCollectionSummary {
  items: MapSearchEntry[];
}

function intOr(value: unknown, fallback = 0): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

// Rebuild every recipe's member list from the current search index. Each recipe
// is replaced in its own transaction; the whole pass yields between recipes so
// it never holds the event loop for long.
export async function rebuildMapCollections(db: Db): Promise<void> {
  const now = nowIso();
  for (const recipe of COLLECTION_RECIPES) {
    const column = patternScoreColumn(recipe.pattern);
    if (!column) continue;
    const rows = (await exec(
      db,
      `select beatmap_id, beatmapset_id, ${column} as metric
       from map_search_index
       where key_count = ? and primary_pattern = ? and stars >= ? and stars < ?
       order by ${column} desc, play_count desc
       limit ?`,
      [recipe.keyCount, recipe.pattern, recipe.starMin, recipe.starMax, OVERFETCH],
    )).rows;

    const seenSets = new Set<number>();
    const members: Array<{ beatmapId: number; beatmapsetId: number; score: number }> = [];
    for (const row of rows) {
      const beatmapsetId = intOr(row.beatmapset_id);
      if (beatmapsetId > 0 && seenSets.has(beatmapsetId)) continue;
      if (beatmapsetId > 0) seenSets.add(beatmapsetId);
      members.push({ beatmapId: intOr(row.beatmap_id), beatmapsetId, score: Number(row.metric) || 0 });
      if (members.length >= MEMBER_LIMIT) break;
    }

    const statements: DbStatement[] = [{ sql: "delete from map_collection_members where collection_id = ?", args: [recipe.id] }];
    if (members.length === 0) {
      statements.push({ sql: "delete from map_collections where id = ?", args: [recipe.id] });
    } else {
      members.forEach((member, index) => {
        statements.push({
          sql: "insert into map_collection_members (collection_id, beatmap_id, position, score, added_at) values (?, ?, ?, ?, ?)",
          args: [recipe.id, member.beatmapId, index, member.score, now],
        });
      });
      statements.push({
        sql: `insert into map_collections (
            id, recipe_id, kind, title, description, key_count, sort_order, cover_set_id, member_count, refreshed_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            recipe_id = excluded.recipe_id, kind = excluded.kind, title = excluded.title,
            description = excluded.description, key_count = excluded.key_count, sort_order = excluded.sort_order,
            cover_set_id = excluded.cover_set_id, member_count = excluded.member_count,
            refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at`,
        args: [
          recipe.id,
          recipe.recipeId,
          recipe.kind,
          recipe.title,
          recipe.description,
          recipe.keyCount,
          recipe.sortOrder,
          members[0].beatmapsetId || null,
          members.length,
          now,
          now,
        ],
      });
    }
    await execBatch(db, statements);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [COLLECTIONS_REFRESHED_META_KEY, JSON.stringify({ refreshedAt: now }), now],
  );
}

function rowToSummary(row: Record<string, unknown>): MapCollectionSummary {
  const recipeId = String(row.recipe_id ?? "");
  // recipeId is "pattern:<family>:<key>k"; the family is the middle segment.
  const pattern = recipeId.startsWith("pattern:") ? recipeId.split(":")[1] ?? null : null;
  return {
    id: String(row.id ?? ""),
    recipeId,
    kind: String(row.kind ?? ""),
    title: String(row.title ?? ""),
    description: row.description == null ? null : String(row.description),
    keyCount: row.key_count == null ? null : intOr(row.key_count),
    pattern,
    sortOrder: intOr(row.sort_order),
    coverSetId: row.cover_set_id == null ? null : intOr(row.cover_set_id),
    memberCount: intOr(row.member_count),
    refreshedAt: String(row.refreshed_at ?? ""),
  };
}

export async function getMapCollections(db: Db): Promise<MapCollectionSummary[]> {
  const rows = (await exec(
    db,
    `select id, recipe_id, kind, title, description, key_count, sort_order, cover_set_id, member_count, refreshed_at
     from map_collections
     where member_count > 0
     order by sort_order asc, title asc`,
  )).rows;
  return rows.map(rowToSummary);
}

export async function getMapCollection(db: Db, id: string): Promise<MapCollectionDetail | null> {
  const row = (await exec(
    db,
    `select id, recipe_id, kind, title, description, key_count, sort_order, cover_set_id, member_count, refreshed_at
     from map_collections where id = ? limit 1`,
    [id],
  )).rows[0];
  if (!row) return null;
  const summary = rowToSummary(row);

  const memberRows = (await exec(
    db,
    "select beatmap_id from map_collection_members where collection_id = ? order by position asc",
    [id],
  )).rows;
  const orderedIds = memberRows.map((member) => intOr(member.beatmap_id)).filter((value) => value > 0);
  const entryById = await getMapSearchEntriesByIds(db, orderedIds);
  const items = orderedIds.map((beatmapId) => entryById.get(beatmapId)).filter((entry): entry is MapSearchEntry => !!entry);

  return { ...summary, items };
}

export async function getMapCollectionsStamp(db: Db): Promise<string> {
  const row = (await exec(db, "select updated_at from live_meta where key = ?", [COLLECTIONS_REFRESHED_META_KEY])).rows[0];
  return row ? String(row.updated_at) : "pending";
}

// Periodic staleness check. The first rebuild is triggered by the index build's
// completion; afterwards this re-runs it once the previous pass ages past the
// interval, so packs track newly analyzed maps.
export async function enqueueMapCollectionsRebuildIfDue(db: Db, queue: JobQueue, intervalMs: number): Promise<void> {
  const row = (await exec(db, "select updated_at from live_meta where key = ?", [COLLECTIONS_REFRESHED_META_KEY])).rows[0];
  if (!row) return;
  const last = Date.parse(String(row.updated_at));
  if (Number.isFinite(last) && Date.now() - last < intervalMs) return;
  await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
}
