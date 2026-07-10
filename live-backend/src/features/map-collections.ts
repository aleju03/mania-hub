import type { Db } from "../db.js";
import { exec, execBatch, json, parseJson, type DbStatement } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { nowIso } from "../shared/score.js";
import {
  getMapSearchEntriesByIds,
  patternScoreColumn,
  MAP_SEARCH_PATTERNS,
  type MapSearchEntry,
} from "./map-search.js";

// Auto-generated map packs materialized from map_search_index by code-defined
// recipes (pattern x key x difficulty bucket, on two difficulty axes: dan
// estimate and MSD overall). Players browse these from the /maps Collections
// section. Members are deduped by beatmapset and by normalized song title so
// a pack is distinct songs, not many uploads of one track. Each rebuild
// samples a fresh rotation from a
// quality pool (seeded per pass), so packs change on every refresh instead of
// pinning the same top-40 forever.

const COLLECTIONS_REFRESHED_META_KEY = "map_collections_refreshed_at";
const MEMBER_LIMIT = 40;
// Rows fetched per recipe before set-dedupe; the pool the rotation samples from.
const POOL_OVERFETCH = 400;
// A pack with almost nothing in its bucket reads as broken; skip publishing it.
const MIN_MEMBERS = 5;
// Joke/meme charts are overwhelmingly sub-minute bursts (11s scream maps,
// sound-effect dumps) and their difficulty estimates are noise; packs are for
// playable charts, so anything under a minute stays out of every pool.
const MIN_LENGTH_SECONDS = 60;

// Curation blocklist, matched against the index's lowercased search_text blob
// (title/artist/creator/version). Collections only - search results and dan
// classification are untouched. FNF rips are near-universally long vibro-jack
// dumps ("funkin", "fnf", "agoti", plus the franchise composer), and a pack
// that says "vibro" on the tin is a mash file even when its timing profile
// dodges the detector (jumptrill-style vibro is indistinguishable from legit
// jumptrills).
const BLOCKED_SEARCH_TEXT: RegExp[] = [
  /vibro/i,
  /funkin/i,
  /\bfnf\b/i,
  /agoti/i,
  /kawai sprite/i,
];

function isBlockedSearchText(searchText: string): boolean {
  return BLOCKED_SEARCH_TEXT.some((pattern) => pattern.test(searchText));
}

// One chart per song: the set dedupe misses re-uploads of the same track under
// different beatmapsets, which kept packs landing e.g. "Maid of Fire" three
// times. Parentheticals/brackets go too so "(TV Size)" / "(Cut Ver.)" variants
// collapse onto the strongest chart.
function songKey(title: unknown): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

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

// Collection shelves. Chordjack folds into the Jack shelf: players want one
// "Jack" section where any flavor of jack belongs, and legit dense jack
// content classifies as chordjack-primary anyway.
interface CollectionGroup {
  id: string;
  patterns: string[];
}

const COLLECTION_GROUPS: CollectionGroup[] = MAP_SEARCH_PATTERNS.filter((pattern) => pattern !== "chordjack").map(
  (pattern) => ({ id: pattern, patterns: pattern === "jack" ? ["jack", "chordjack"] : [pattern] }),
);

export type CollectionAxis = "dan" | "msd";

// Difficulty buckets. Dan buckets are integer levels on the classifier's
// rawDan axis; level N spans N±0.5 (same widening the search dan filter uses).
// A null lo/hi marks an open-ended bucket.
interface DifficultyBucket {
  id: string;
  lo: number | null;
  hi: number | null;
}

const DAN_BUCKETS: DifficultyBucket[] = [
  { id: "d3minus", lo: null, hi: 3 },
  { id: "d4-6", lo: 4, hi: 6 },
  { id: "d7-8", lo: 7, hi: 8 },
  { id: "d9-10", lo: 9, hi: 10 },
  { id: "d11-13", lo: 11, hi: 13 },
  { id: "d14plus", lo: 14, hi: null },
];

const MSD_BUCKETS: DifficultyBucket[] = [
  { id: "m14minus", lo: null, hi: 14 },
  { id: "m14-18", lo: 14, hi: 18 },
  { id: "m18-22", lo: 18, hi: 22 },
  { id: "m22-26", lo: 22, hi: 26 },
  { id: "m26-30", lo: 26, hi: 30 },
  { id: "m30plus", lo: 30, hi: null },
];

const COLLECTION_KEYS = [4, 7] as const;

// Ladder names for dan bucket titles, mirroring the frontend's dan scale:
// 4K reform is 1..10 then greek, 4K LN is numeric 1..16, 7K is 0..10 then the
// JinJin boss courses (same ladder for 7K LN).
const REFORM_GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa"];
const SEVENK_BOSSES = ["Gamma", "Azimuth", "Zenith", "Stellium"];

function danLevelName(level: number, keyCount: number, ln: boolean): string {
  if (keyCount === 7) {
    if (level <= 10) return String(Math.max(0, level));
    return SEVENK_BOSSES[Math.min(level, 14) - 11];
  }
  if (ln) return String(Math.min(Math.max(1, level), 16));
  if (level <= 10) return String(Math.max(1, level));
  return REFORM_GREEK[Math.min(level, 20) - 11];
}

function danBucketText(bucket: DifficultyBucket, keyCount: number, pattern: string): string {
  const ln = pattern === "ln";
  if (bucket.lo == null) return `up to ${danLevelName(bucket.hi ?? 0, keyCount, ln)} dan`;
  if (bucket.hi == null) return `${danLevelName(bucket.lo, keyCount, ln)}+ dan`;
  return `${danLevelName(bucket.lo, keyCount, ln)}–${danLevelName(bucket.hi, keyCount, ln)} dan`;
}

function msdBucketText(bucket: DifficultyBucket): string {
  if (bucket.lo == null) return `under ${bucket.hi} MSD`;
  if (bucket.hi == null) return `${bucket.lo}+ MSD`;
  return `${bucket.lo}–${bucket.hi} MSD`;
}

interface CollectionRecipe {
  id: string;
  recipeId: string;
  kind: "pattern";
  pattern: string;
  patterns: string[];
  keyCount: number;
  axis: CollectionAxis;
  bucketLo: number | null;
  bucketHi: number | null;
  title: string;
  description: string;
  sortOrder: number;
}

// 4K jack at Delta+ has no legit single-column population: dense jack at that
// level is chorded, so the router files every real chart (e.g. Homu's Delta
// training pack) under chordjack, and the jack-primary residue is a ~30-chart
// pool of misestimated troll/vibro files. That bucket ships chordjack-only.
// 7K keeps the full group; its 14+ pool is real boss-tier jack content.
function bucketPatterns(group: CollectionGroup, keyCount: number, axis: CollectionAxis, bucket: DifficultyBucket): string[] {
  if (group.id === "jack" && keyCount === 4 && axis === "dan" && bucket.id === "d14plus") return ["chordjack"];
  return group.patterns;
}

function buildRecipes(): CollectionRecipe[] {
  const recipes: CollectionRecipe[] = [];
  let order = 0;
  for (const group of COLLECTION_GROUPS) {
    const pattern = group.id;
    const label = PATTERN_LABELS[pattern] ?? pattern;
    const flavor = pattern === "jack" ? "Jack- and chordjack-heavy" : `${label}-heavy`;
    for (const keyCount of COLLECTION_KEYS) {
      for (const bucket of DAN_BUCKETS) {
        const rangeText = danBucketText(bucket, keyCount, pattern);
        recipes.push({
          id: `pattern:${pattern}:${keyCount}k:dan:${bucket.id}`,
          recipeId: `pattern:${pattern}:${keyCount}k`,
          kind: "pattern",
          pattern,
          patterns: bucketPatterns(group, keyCount, "dan", bucket),
          keyCount,
          axis: "dan",
          bucketLo: bucket.lo,
          bucketHi: bucket.hi,
          title: `${label} · ${keyCount}K · ${rangeText}`,
          description: `${flavor} ${keyCount}K maps, ${rangeText}. Rotates on every refresh.`,
          sortOrder: order++,
        });
      }
      for (const bucket of MSD_BUCKETS) {
        const rangeText = msdBucketText(bucket);
        recipes.push({
          id: `pattern:${pattern}:${keyCount}k:msd:${bucket.id}`,
          recipeId: `pattern:${pattern}:${keyCount}k`,
          kind: "pattern",
          pattern,
          patterns: bucketPatterns(group, keyCount, "msd", bucket),
          keyCount,
          axis: "msd",
          bucketLo: bucket.lo,
          bucketHi: bucket.hi,
          title: `${label} · ${keyCount}K · ${rangeText}`,
          description: `${flavor} ${keyCount}K maps, ${rangeText}. Rotates on every refresh.`,
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
  axis: CollectionAxis | null;
  bucketLo: number | null;
  bucketHi: number | null;
  sortOrder: number;
  coverSetId: number | null;
  coverSetIds: number[];
  memberCount: number;
  refreshedAt: string;
}

export interface MapCollectionDetail extends MapCollectionSummary {
  items: MapSearchEntry[];
  /** Beatmap ids that entered the pack on its latest rotation. */
  newBeatmapIds: number[];
}

export interface MapCollectionsRotation {
  refreshedAt: string | null;
  nextRefreshAt: string | null;
  intervalMs: number;
}

function intOr(value: unknown, fallback = 0): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

// A set has usable cover art when osu! returned covers with a real upload
// version. The API constructs cover URLs for every set, so a non-empty object
// proves nothing; a "?0" version query marks a set whose background was never
// uploaded (the asset 404s and would render as a blank collage tile).
function hasCoverArt(coversJson: unknown): boolean {
  if (coversJson == null) return false;
  const covers = parseJson<Record<string, string> | null>(String(coversJson), null);
  if (!covers || typeof covers !== "object") return false;
  return Object.values(covers).some((url) => typeof url === "string" && url.length > 0 && !url.endsWith("?0"));
}

// Deterministic PRNG for the rotation sample: same rebuild pass -> same packs,
// next pass (new stamp) -> a fresh shuffle.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffleInPlace<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

// The bucket's SQL bounds. Dan buckets widen half a level on each side so a
// "7-8 dan" pack accepts everything the search filter would call 7th or 8th.
function bucketConditions(recipe: CollectionRecipe): { clauses: string[]; args: number[] } {
  const column = recipe.axis === "dan" ? "raw_dan" : "msd_overall";
  const pad = recipe.axis === "dan" ? 0.5 : 0;
  const clauses = [`${column} is not null`];
  const args: number[] = [];
  if (recipe.bucketLo != null) {
    clauses.push(`${column} >= ?`);
    args.push(recipe.bucketLo - pad);
  }
  if (recipe.bucketHi != null) {
    clauses.push(`${column} < ?`);
    args.push(recipe.bucketHi + pad);
  }
  return { clauses, args };
}

// Rebuild every recipe's member list from the current search index. Each recipe
// is replaced in its own transaction; the whole pass yields between recipes so
// it never holds the event loop for long. Membership rotates: the pool is the
// most pattern-pure charts of the bucket, the pack is a seeded random sample.
export async function rebuildMapCollections(db: Db): Promise<void> {
  const now = nowIso();
  for (const recipe of COLLECTION_RECIPES) {
    const columns = recipe.patterns
      .map((pattern) => patternScoreColumn(pattern))
      .filter((column): column is string => column != null);
    if (columns.length === 0) continue;
    // Multi-pattern groups (jack + chordjack) rank by whichever family score
    // is strongest; pat_* columns are always numeric so scalar max() is safe.
    const metric = columns.length > 1 ? `max(${columns.join(", ")})` : columns[0];
    const bucket = bucketConditions(recipe);
    const axisColumn = recipe.axis === "dan" ? "raw_dan" : "msd_overall";
    // Vibro charts are excluded outright: both difficulty axes are unreliable
    // on them (same policy as the search dan filter).
    const rows = (await exec(
      db,
      `select beatmap_id, beatmapset_id, covers_json, title, search_text, ${metric} as metric, ${axisColumn} as axis_value
       from map_search_index
       where key_count = ? and primary_pattern in (${recipe.patterns.map(() => "?").join(", ")})
         and vibro = 0 and length >= ? and ${bucket.clauses.join(" and ")}
       order by ${metric} desc, play_count desc
       limit ?`,
      [recipe.keyCount, ...recipe.patterns, MIN_LENGTH_SECONDS, ...bucket.args, POOL_OVERFETCH],
    )).rows;

    // Drop blocklisted uploads, then dedupe by set and by song (keeping the
    // highest-metric chart of each), then sample the rotation.
    const seenSets = new Set<number>();
    const seenSongs = new Set<string>();
    const pool: Array<{ beatmapId: number; beatmapsetId: number; score: number; axisValue: number; hasCover: boolean }> = [];
    for (const row of rows) {
      if (isBlockedSearchText(String(row.search_text ?? ""))) continue;
      const beatmapsetId = intOr(row.beatmapset_id);
      if (beatmapsetId > 0 && seenSets.has(beatmapsetId)) continue;
      if (beatmapsetId > 0) seenSets.add(beatmapsetId);
      const song = songKey(row.title);
      if (song.length > 0 && seenSongs.has(song)) continue;
      if (song.length > 0) seenSongs.add(song);
      pool.push({
        beatmapId: intOr(row.beatmap_id),
        beatmapsetId,
        score: Number(row.metric) || 0,
        axisValue: Number(row.axis_value) || 0,
        hasCover: hasCoverArt(row.covers_json),
      });
    }
    shuffleInPlace(pool, mulberry32(hashSeed(`${recipe.id}:${now}`)));
    const members = pool.slice(0, MEMBER_LIMIT);
    // Present easiest-first within the pack.
    members.sort((a, b) => a.axisValue - b.axisValue || a.beatmapId - b.beatmapId);

    // A too-small pack is simply not written; the end-of-pass sweep removes any
    // previous rotation of it (its refreshed_at stays behind).
    if (members.length >= MIN_MEMBERS) {
      // Retained members keep their original added_at so the UI can mark the
      // rotation's newcomers (added_at == refreshed_at).
      const previous = new Map<number, string>();
      const previousRows = (await exec(
        db,
        "select beatmap_id, added_at from map_collection_members where collection_id = ?",
        [recipe.id],
      )).rows;
      for (const row of previousRows) previous.set(intOr(row.beatmap_id), String(row.added_at ?? now));

      const statements: DbStatement[] = [{ sql: "delete from map_collection_members where collection_id = ?", args: [recipe.id] }];
      members.forEach((member, index) => {
        statements.push({
          sql: "insert into map_collection_members (collection_id, beatmap_id, position, score, added_at) values (?, ?, ?, ?, ?)",
          args: [recipe.id, member.beatmapId, index, member.score, previous.get(member.beatmapId) ?? now],
        });
      });
      // Only sets that actually have cover art seed the collage thumbnail; a set
      // with no uploaded cover would render as a blank tile in the frontend grid.
      const coverSets = [
        ...new Set(members.filter((member) => member.beatmapsetId > 0 && member.hasCover).map((member) => member.beatmapsetId)),
      ].slice(0, 3);
      statements.push({
        sql: `insert into map_collections (
            id, recipe_id, kind, title, description, key_count, axis, bucket_lo, bucket_hi,
            sort_order, cover_set_id, cover_sets_json, member_count, refreshed_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            recipe_id = excluded.recipe_id, kind = excluded.kind, title = excluded.title,
            description = excluded.description, key_count = excluded.key_count,
            axis = excluded.axis, bucket_lo = excluded.bucket_lo, bucket_hi = excluded.bucket_hi,
            sort_order = excluded.sort_order, cover_set_id = excluded.cover_set_id,
            cover_sets_json = excluded.cover_sets_json, member_count = excluded.member_count,
            refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at`,
        args: [
          recipe.id,
          recipe.recipeId,
          recipe.kind,
          recipe.title,
          recipe.description,
          recipe.keyCount,
          recipe.axis,
          recipe.bucketLo,
          recipe.bucketHi,
          recipe.sortOrder,
          coverSets[0] ?? null,
          json(coverSets),
          members.length,
          now,
          now,
        ],
      });
      await execBatch(db, statements);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // Recipes that no longer exist (e.g. the old star buckets) were not touched
  // this pass; drop them and any orphaned members.
  await exec(db, "delete from map_collections where refreshed_at != ?", [now]);
  await exec(db, "delete from map_collection_members where collection_id not in (select id from map_collections)");
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
  const axis = row.axis === "dan" || row.axis === "msd" ? row.axis : null;
  const coverSetIds = parseJson<number[]>(row.cover_sets_json, [])
    .map((id) => intOr(id))
    .filter((id) => id > 0);
  return {
    id: String(row.id ?? ""),
    recipeId,
    kind: String(row.kind ?? ""),
    title: String(row.title ?? ""),
    description: row.description == null ? null : String(row.description),
    keyCount: row.key_count == null ? null : intOr(row.key_count),
    pattern,
    axis,
    bucketLo: row.bucket_lo == null ? null : Number(row.bucket_lo),
    bucketHi: row.bucket_hi == null ? null : Number(row.bucket_hi),
    sortOrder: intOr(row.sort_order),
    coverSetId: row.cover_set_id == null ? null : intOr(row.cover_set_id),
    coverSetIds,
    memberCount: intOr(row.member_count),
    refreshedAt: String(row.refreshed_at ?? ""),
  };
}

const SUMMARY_SELECT = `select id, recipe_id, kind, title, description, key_count, axis, bucket_lo, bucket_hi,
  sort_order, cover_set_id, cover_sets_json, member_count, refreshed_at from map_collections`;

export async function getMapCollections(db: Db): Promise<MapCollectionSummary[]> {
  // `axis is not null` hides rows from the retired star-bucket scheme during
  // the window between a deploy and the first new-scheme rebuild.
  const rows = (await exec(db, `${SUMMARY_SELECT} where member_count > 0 and axis is not null order by sort_order asc, title asc`)).rows;
  return rows.map(rowToSummary);
}

export async function getMapCollection(db: Db, id: string): Promise<MapCollectionDetail | null> {
  const row = (await exec(db, `${SUMMARY_SELECT} where id = ? limit 1`, [id])).rows[0];
  if (!row) return null;
  const summary = rowToSummary(row);

  const memberRows = (await exec(
    db,
    "select beatmap_id, added_at from map_collection_members where collection_id = ? order by position asc",
    [id],
  )).rows;
  const orderedIds = memberRows.map((member) => intOr(member.beatmap_id)).filter((value) => value > 0);
  const newBeatmapIds = memberRows
    .filter((member) => String(member.added_at ?? "") >= summary.refreshedAt)
    .map((member) => intOr(member.beatmap_id))
    .filter((value) => value > 0);
  const entryById = await getMapSearchEntriesByIds(db, orderedIds);
  const items = orderedIds.map((beatmapId) => entryById.get(beatmapId)).filter((entry): entry is MapSearchEntry => !!entry);

  return { ...summary, items, newBeatmapIds };
}

export async function getMapCollectionsRotation(db: Db, intervalMs: number): Promise<MapCollectionsRotation> {
  const row = (await exec(db, "select updated_at from live_meta where key = ?", [COLLECTIONS_REFRESHED_META_KEY])).rows[0];
  const refreshedAt = row ? String(row.updated_at) : null;
  const refreshedMs = refreshedAt ? Date.parse(refreshedAt) : NaN;
  const nextRefreshAt = Number.isFinite(refreshedMs) ? new Date(refreshedMs + intervalMs).toISOString() : null;
  return { refreshedAt, nextRefreshAt, intervalMs };
}

export async function getMapCollectionsStamp(db: Db): Promise<string> {
  const row = (await exec(db, "select updated_at from live_meta where key = ?", [COLLECTIONS_REFRESHED_META_KEY])).rows[0];
  return row ? String(row.updated_at) : "pending";
}

// Periodic staleness check. The first rebuild is triggered by the index build's
// completion; afterwards this re-runs it once the previous pass ages past the
// interval, so packs rotate and track newly analyzed maps.
export async function enqueueMapCollectionsRebuildIfDue(db: Db, queue: JobQueue, intervalMs: number): Promise<void> {
  const row = (await exec(db, "select updated_at from live_meta where key = ?", [COLLECTIONS_REFRESHED_META_KEY])).rows[0];
  if (!row) return;
  const last = Date.parse(String(row.updated_at));
  if (Number.isFinite(last) && Date.now() - last < intervalMs) return;
  await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
}
