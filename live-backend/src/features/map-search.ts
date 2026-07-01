import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec, execBatch, json, parseJson, type DbStatement } from "../db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "./activity.js";
import type { JobQueue } from "../jobs/queue.js";
import { nowIso } from "../shared/score.js";

// Global, denormalized search projection over every chart-analyzed mania map.
// Built from beatmap_skill_vectors (the 0-1 pattern mix in skills_json) joined to
// beatmaps/beatmapsets, so the /maps Search section can filter and sort by pattern
// plus stars/bpm/length/key/status without scanning JSON on every request.

export const MAP_SEARCH_BUILD_JOB = "build_map_search_index";
const BUILD_META_KEY = `map_search_index_built:v${ACTIVITY_SKILL_ANALYSIS_VERSION}`;
const BUILD_BATCH_SIZE = 400;
const BUILD_BATCHES_PER_RUN = 3;
const BUILD_JOB_PRIORITY = -10;

// The eight families the UI exposes: the seven dan estimator primaries plus the
// orthogonal LN axis. LN subtypes (lnGeneral/lnRelease/...) collapse to "ln".
const PATTERN_COLUMNS: Record<string, string> = {
  jack: "pat_jack",
  stream: "pat_stream",
  jumpstream: "pat_jumpstream",
  handstream: "pat_handstream",
  stamina: "pat_stamina",
  chordjack: "pat_chordjack",
  tech: "pat_tech",
  ln: "pat_ln",
};
export const MAP_SEARCH_PATTERNS = Object.keys(PATTERN_COLUMNS);

// Whitelisted column lookup for the pattern families. Returns null for anything
// not in the canonical eight, so callers can safely interpolate the result.
export function patternScoreColumn(pattern: string): string | null {
  return PATTERN_COLUMNS[pattern] ?? null;
}

const SORT_COLUMNS: Record<string, string> = {
  stars: "stars",
  bpm: "bpm",
  length: "length",
  playcount: "play_count",
  date: "ranked_date",
};

export type MapSearchSort = "stars" | "bpm" | "length" | "playcount" | "date" | "relevance";
export type SortDirection = "asc" | "desc";

// Multi-select facets: an empty array means "no filter" (all). Patterns match the
// map's dominant pattern, so picking "chordjack" returns chordjack maps directly.
export interface MapSearchQuery {
  q: string;
  keys: string[];
  statuses: string[];
  patterns: string[];
  starMin: number | null;
  starMax: number | null;
  bpmMin: number | null;
  bpmMax: number | null;
  lenMin: number | null;
  lenMax: number | null;
  country: string | null;
  sort: MapSearchSort;
  dir: SortDirection;
  page: number;
  pageSize: number;
}

export interface MapSearchEntry {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  version: string;
  status: string;
  keyCount: number;
  stars: number;
  bpm: number;
  length: number;
  playCount: number;
  lnCount: number;
  primaryPattern: string;
  patterns: Record<string, number>;
  covers: Record<string, string> | null;
}

export interface MapSearchPage {
  items: MapSearchEntry[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Pattern parsing ──────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

function normalizePrimary(raw: string, scores: Record<string, number>): string {
  const p = raw.toLowerCase();
  if (p.startsWith("ln")) return "ln";
  if (PATTERN_COLUMNS[p]) return p;
  // "unknown" or an unexpected family: fall back to the strongest score so the
  // primary column stays one of the eight families (or "unknown" when empty).
  let best = "unknown";
  let bestValue = 0;
  for (const key of MAP_SEARCH_PATTERNS) {
    if (scores[key] > bestValue) {
      best = key;
      bestValue = scores[key];
    }
  }
  return bestValue > 0 ? best : "unknown";
}

function readPatternProfile(skillsJson: unknown): { primary: string; scores: Record<string, number> } {
  const parsed = parseJson<{ primary?: unknown; patterns?: unknown } | null>(skillsJson, null);
  const rawPatterns =
    parsed && typeof parsed === "object" && parsed.patterns && typeof parsed.patterns === "object"
      ? (parsed.patterns as Record<string, unknown>)
      : {};
  const scores: Record<string, number> = {};
  for (const key of MAP_SEARCH_PATTERNS) {
    scores[key] = clamp01(Number(rawPatterns[key]));
  }
  const rawPrimary = parsed && typeof parsed.primary === "string" ? parsed.primary : "unknown";
  return { primary: normalizePrimary(rawPrimary, scores), scores };
}

// ── Source rows -> index rows ────────────────────────────────────────────────

const SOURCE_SELECT = `
  select
    sv.beatmap_id as beatmap_id,
    sv.analysis_version as analysis_version,
    sv.skills_json as skills_json,
    b.beatmapset_id as beatmapset_id,
    b.cs as cs,
    b.difficulty_rating as difficulty_rating,
    b.bpm as bpm,
    b.version as version,
    b.status as beatmap_status,
    json_extract(b.metadata_json, '$.playcount') as play_count,
    json_extract(b.metadata_json, '$.passcount') as pass_count,
    json_extract(b.metadata_json, '$.count_sliders') as ln_count,
    json_extract(b.metadata_json, '$.total_length') as length,
    json_extract(b.metadata_json, '$.status') as meta_status,
    s.title as title,
    s.artist as artist,
    s.creator as creator,
    s.covers_json as covers_json,
    json_extract(s.metadata_json, '$.ranked_date') as ranked_date
  from beatmap_skill_vectors sv
  join beatmaps b on b.beatmap_id = sv.beatmap_id
  join beatmapsets s on s.beatmapset_id = b.beatmapset_id
  where sv.analysis_version = ? and sv.status = 'ready'
    and coalesce(json_extract(b.metadata_json, '$.convert'), 0) = 0`;

function intOr(value: unknown, fallback = 0): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function realOr(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildIndexUpsert(row: Record<string, unknown>): DbStatement | null {
  const beatmapId = intOr(row.beatmap_id);
  const beatmapsetId = intOr(row.beatmapset_id);
  if (beatmapId <= 0 || beatmapsetId <= 0) return null;
  const { primary, scores } = readPatternProfile(row.skills_json);
  const title = String(row.title ?? "");
  const artist = String(row.artist ?? "");
  const creator = row.creator == null ? "" : String(row.creator);
  const version = String(row.version ?? "");
  const searchText = `${title} ${artist} ${creator} ${version}`.toLowerCase();
  const status = String(row.meta_status ?? row.beatmap_status ?? "").toLowerCase() || "graveyard";
  const args: InValue[] = [
    beatmapId,
    beatmapsetId,
    intOr(row.analysis_version, ACTIVITY_SKILL_ANALYSIS_VERSION),
    title,
    artist,
    creator,
    version,
    searchText,
    intOr(row.cs),
    realOr(row.difficulty_rating),
    realOr(row.bpm),
    intOr(row.length),
    status,
    intOr(row.play_count),
    intOr(row.pass_count),
    intOr(row.ln_count),
    primary,
    scores.jack,
    scores.stream,
    scores.jumpstream,
    scores.handstream,
    scores.stamina,
    scores.chordjack,
    scores.tech,
    scores.ln,
    row.covers_json == null ? null : String(row.covers_json),
    row.ranked_date == null ? null : String(row.ranked_date),
    nowIso(),
  ];
  return {
    sql: `insert into map_search_index (
        beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version,
        search_text, key_count, stars, bpm, length, status, play_count, pass_count, ln_count,
        primary_pattern, pat_jack, pat_stream, pat_jumpstream, pat_handstream, pat_stamina,
        pat_chordjack, pat_tech, pat_ln, covers_json, ranked_date, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(beatmap_id) do update set
        beatmapset_id = excluded.beatmapset_id,
        analysis_version = excluded.analysis_version,
        title = excluded.title, artist = excluded.artist, creator = excluded.creator, version = excluded.version,
        search_text = excluded.search_text, key_count = excluded.key_count, stars = excluded.stars,
        bpm = excluded.bpm, length = excluded.length, status = excluded.status,
        play_count = excluded.play_count, pass_count = excluded.pass_count, ln_count = excluded.ln_count,
        primary_pattern = excluded.primary_pattern,
        pat_jack = excluded.pat_jack, pat_stream = excluded.pat_stream, pat_jumpstream = excluded.pat_jumpstream,
        pat_handstream = excluded.pat_handstream, pat_stamina = excluded.pat_stamina, pat_chordjack = excluded.pat_chordjack,
        pat_tech = excluded.pat_tech, pat_ln = excluded.pat_ln,
        covers_json = excluded.covers_json, ranked_date = excluded.ranked_date,
        updated_at = excluded.updated_at`,
    args,
  };
}

// Single-row upsert: the incremental hook fired from the skill-vector job, so a
// newly analyzed map appears in search without waiting for the next full build.
export async function upsertMapSearchIndexRow(db: Db, beatmapId: number): Promise<void> {
  const id = Math.floor(Number(beatmapId));
  if (!Number.isFinite(id) || id <= 0) return;
  const row = (await exec(db, `${SOURCE_SELECT} and sv.beatmap_id = ? limit 1`, [ACTIVITY_SKILL_ANALYSIS_VERSION, id])).rows[0];
  if (!row) return;
  const statement = buildIndexUpsert(row);
  if (statement) await exec(db, statement.sql, statement.args);
}

// One bulk batch: the next `limit` ready vectors past `cursor`, upserted in a
// single write transaction. Returns the new cursor and whether the corpus is done.
export async function buildMapSearchIndexBatch(
  db: Db,
  cursor: number,
  limit: number,
): Promise<{ nextCursor: number; processed: number; done: boolean }> {
  const rows = (await exec(
    db,
    `${SOURCE_SELECT} and sv.beatmap_id > ? order by sv.beatmap_id asc limit ?`,
    [ACTIVITY_SKILL_ANALYSIS_VERSION, Math.max(0, Math.floor(cursor)), Math.max(1, Math.floor(limit))],
  )).rows;
  if (rows.length === 0) return { nextCursor: cursor, processed: 0, done: true };
  const statements: DbStatement[] = [];
  let nextCursor = cursor;
  for (const row of rows) {
    nextCursor = Math.max(nextCursor, intOr(row.beatmap_id));
    const statement = buildIndexUpsert(row);
    if (statement) statements.push(statement);
  }
  if (statements.length > 0) await execBatch(db, statements);
  return { nextCursor, processed: rows.length, done: rows.length < limit };
}

async function markMapSearchIndexBuilt(db: Db): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [BUILD_META_KEY, json({ builtAt: now }), now],
  );
}

async function isMapSearchIndexBuilt(db: Db): Promise<boolean> {
  const row = (await exec(db, "select 1 from live_meta where key = ? limit 1", [BUILD_META_KEY])).rows[0];
  return !!row;
}

async function hasPendingBuildJob(db: Db): Promise<boolean> {
  const row = (await exec(
    db,
    "select 1 from jobs where type = ? and status in ('queued', 'running', 'failed', 'deferred_pressure') limit 1",
    [MAP_SEARCH_BUILD_JOB],
  )).rows[0];
  return !!row;
}

async function maxIndexedBeatmapId(db: Db): Promise<number> {
  const row = (await exec(db, "select max(beatmap_id) as max_id from map_search_index")).rows[0];
  return intOr(row?.max_id, 0);
}

async function enqueueBuild(queue: JobQueue, cursor: number): Promise<void> {
  await queue.enqueue(MAP_SEARCH_BUILD_JOB, `${MAP_SEARCH_BUILD_JOB}:${cursor}`, { cursor }, { priority: BUILD_JOB_PRIORITY });
}

const CONVERTS_PRUNED_KEY = "map_search_index_converts_pruned:v1";

// One-time cleanup: earlier builds indexed auto-generated converts (osu!std maps
// auto-converted to mania). Only maps made for mania belong in the pool, so drop
// them once and rebuild collections so the packs lose them too.
async function pruneConvertsOnce(db: Db, queue: JobQueue): Promise<void> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [CONVERTS_PRUNED_KEY])).rows[0];
  if (done) return;
  await exec(
    db,
    `delete from map_search_index
     where beatmap_id in (
       select beatmap_id from beatmaps where coalesce(json_extract(metadata_json, '$.convert'), 0) = 1
     )`,
  );
  const now = nowIso();
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [CONVERTS_PRUNED_KEY, json({ at: now }), now]);
  await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
}

// Boot/periodic watchdog: kick off the build when missing, and resume a chain
// that died mid-way (crash between batches) from the last indexed id.
export async function ensureMapSearchIndexSeeded(db: Db, queue: JobQueue): Promise<void> {
  await pruneConvertsOnce(db, queue);
  if (await isMapSearchIndexBuilt(db)) return;
  if (await hasPendingBuildJob(db)) return;
  await enqueueBuild(queue, await maxIndexedBeatmapId(db));
}

// The build job handler: a few short batches per invocation, then either chains
// the next cursor (fresh dedupe key, so it never collides with the running row)
// or finalizes and triggers the first collections rebuild.
export async function runMapSearchIndexBuildJob(
  db: Db,
  queue: JobQueue,
  payload: { cursor?: number } | undefined,
  onComplete: () => Promise<void>,
): Promise<void> {
  let cursor = Math.max(0, Math.floor(Number(payload?.cursor ?? 0)));
  for (let batch = 0; batch < BUILD_BATCHES_PER_RUN; batch++) {
    const result = await buildMapSearchIndexBatch(db, cursor, BUILD_BATCH_SIZE);
    cursor = result.nextCursor;
    if (result.done) {
      await markMapSearchIndexBuilt(db);
      await onComplete();
      return;
    }
    // Yield between batches so ingest/SSE get the event loop back.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await enqueueBuild(queue, cursor);
}

export async function getMapSearchIndexStamp(db: Db): Promise<string> {
  const row = (await exec(db, "select updated_at from live_meta where key = ?", [BUILD_META_KEY])).rows[0];
  return row ? String(row.updated_at) : "building";
}

// ── Query ────────────────────────────────────────────────────────────────────

const SELECT_COLUMNS = `
  beatmap_id, beatmapset_id, title, artist, creator, version, status, key_count,
  stars, bpm, length, play_count, ln_count, primary_pattern,
  pat_jack, pat_stream, pat_jumpstream, pat_handstream, pat_stamina, pat_chordjack, pat_tech, pat_ln,
  covers_json`;

const KEY_CLAUSES: Record<string, string> = {
  "4k": "key_count = 4",
  "7k": "key_count = 7",
  other: "key_count not in (4, 7)",
};

const STATUS_CLAUSES: Record<string, string> = {
  ranked: "status in ('ranked', 'approved')",
  loved: "status = 'loved'",
  graveyard: "status = 'graveyard'",
  other: "status not in ('ranked', 'approved', 'loved', 'graveyard')",
};

// OR the selected options within a facet (so "4K or 7K" widens), then the facets
// AND together. Empty selection = no clause = all.
function orClause(values: string[], lookup: Record<string, string>): string | null {
  const clauses = [...new Set(values)].map((value) => lookup[value]).filter(Boolean);
  return clauses.length > 0 ? `(${clauses.join(" or ")})` : null;
}

function buildWhere(query: MapSearchQuery): { sql: string; args: InValue[] } {
  const conditions: string[] = [];
  const args: InValue[] = [];

  const keyClause = orClause(query.keys, KEY_CLAUSES);
  if (keyClause) conditions.push(keyClause);

  const statusClause = orClause(query.statuses, STATUS_CLAUSES);
  if (statusClause) conditions.push(statusClause);

  for (const term of query.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
    conditions.push("search_text like ? escape '\\'");
    args.push(`%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }

  if (query.starMin != null) {
    conditions.push("stars >= ?");
    args.push(query.starMin);
  }
  if (query.starMax != null) {
    conditions.push("stars <= ?");
    args.push(query.starMax);
  }
  if (query.bpmMin != null) {
    conditions.push("bpm >= ?");
    args.push(query.bpmMin);
  }
  if (query.bpmMax != null) {
    conditions.push("bpm <= ?");
    args.push(query.bpmMax);
  }
  if (query.lenMin != null) {
    conditions.push("length >= ?");
    args.push(query.lenMin);
  }
  if (query.lenMax != null) {
    conditions.push("length <= ?");
    args.push(query.lenMax);
  }

  // Pattern picks match the map's dominant pattern: select chordjack -> chordjack maps.
  const patterns = [...new Set(query.patterns)].filter((pattern) => PATTERN_COLUMNS[pattern]);
  if (patterns.length > 0) {
    conditions.push(`primary_pattern in (${patterns.map(() => "?").join(", ")})`);
    args.push(...patterns);
  }

  if (query.country) {
    conditions.push(
      `beatmap_id in (
        select beatmap_id from country_maps_farmed_scores where country = ?
        union
        select beatmap_id from country_maps_most_played where country = ?
      )`,
    );
    args.push(query.country, query.country);
  }

  const sql = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
  return { sql, args };
}

export async function getMapSearchPage(db: Db, query: MapSearchQuery): Promise<MapSearchPage> {
  const where = buildWhere(query);

  const totalRow = (await exec(db, `select count(*) as total from map_search_index ${where.sql}`, where.args)).rows[0];
  const total = intOr(totalRow?.total, 0);

  const orderColumn = SORT_COLUMNS[query.sort] ?? "play_count";
  const orderDir = query.dir === "asc" ? "asc" : "desc";

  const pageSize = Math.max(1, Math.floor(query.pageSize));
  const page = Math.max(0, Math.floor(query.page));
  const offset = page * pageSize;

  const rows = (await exec(
    db,
    `select ${SELECT_COLUMNS} from map_search_index ${where.sql}
     order by ${orderColumn} ${orderDir}, beatmap_id asc
     limit ? offset ?`,
    [...where.args, pageSize, offset],
  )).rows;

  return { items: rows.map(rowToEntry), total, page, pageSize };
}

// Fetch index entries for a set of beatmap ids (used by collection detail).
// Returns a map keyed by beatmapId so callers can preserve their own ordering.
export async function getMapSearchEntriesByIds(db: Db, ids: number[]): Promise<Map<number, MapSearchEntry>> {
  const result = new Map<number, MapSearchEntry>();
  const unique = [...new Set(ids.map((id) => Math.floor(Number(id))).filter((id) => Number.isFinite(id) && id > 0))];
  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = (await exec(
      db,
      `select ${SELECT_COLUMNS} from map_search_index where beatmap_id in (${placeholders})`,
      chunk,
    )).rows;
    for (const row of rows) {
      const entry = rowToEntry(row);
      result.set(entry.beatmapId, entry);
    }
  }
  return result;
}

function rowToEntry(row: Record<string, unknown>): MapSearchEntry {
  const patterns: Record<string, number> = {};
  for (const key of MAP_SEARCH_PATTERNS) {
    const value = realOr(row[PATTERN_COLUMNS[key]]);
    if (value > 0) patterns[key] = value;
  }
  const covers = row.covers_json == null ? null : parseJson<Record<string, string> | null>(row.covers_json, null);
  return {
    beatmapId: intOr(row.beatmap_id),
    beatmapsetId: intOr(row.beatmapset_id),
    title: String(row.title ?? ""),
    artist: String(row.artist ?? ""),
    creator: row.creator == null ? "" : String(row.creator),
    version: String(row.version ?? ""),
    status: String(row.status ?? ""),
    keyCount: intOr(row.key_count),
    stars: realOr(row.stars),
    bpm: realOr(row.bpm),
    length: intOr(row.length),
    playCount: intOr(row.play_count),
    lnCount: intOr(row.ln_count),
    primaryPattern: String(row.primary_pattern ?? "unknown"),
    patterns,
    covers: covers && typeof covers === "object" ? covers : null,
  };
}
