import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec, execBatch, json, parseJson, type DbStatement } from "../db.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "./activity.js";
import { CHART_ANALYSIS_VERSION } from "./chart-analysis.js";
import type { JobQueue } from "../jobs/queue.js";
import { nowIso } from "../shared/score.js";

// Global, denormalized search projection over every chart-analyzed mania map.
// Built from beatmap_skill_vectors (the 0-1 pattern mix in skills_json) joined to
// beatmaps/beatmapsets, so the /maps Search section can filter and sort by pattern
// plus stars/bpm/length/key/status without scanning JSON on every request.

export const MAP_SEARCH_BUILD_JOB = "build_map_search_index";
// Bump BUILD_REVISION to force a full re-upsert of the index after a fix to how
// indexed fields are derived (r2: length was stored as the source row's column
// count for every map; r4: MSD-based 4K primaries, lnRatio LN routing, vibro;
// r5: msd_overall column for MSD-bucketed collections).
// The rebuild is pure DB work, no osu! API.
const BUILD_REVISION = 5;
const BUILD_META_KEY = `map_search_index_built:v${ACTIVITY_SKILL_ANALYSIS_VERSION}:r${BUILD_REVISION}`;
const BUILD_CURSOR_KEY = `map_search_index_build_cursor:v${ACTIVITY_SKILL_ANALYSIS_VERSION}:r${BUILD_REVISION}`;
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

// Subfamily ids from the in-house pattern analyzer, matched against the
// space-delimited pattern_tags column (detected patterns from chart analysis)
// rather than a dominance column: a subfamily is an attribute of the chart,
// not its primary identity.
export const MAP_SEARCH_SUB_PATTERNS = [
  "speedjack", "handjack",
  "dumpstream", "quadstream", "chordstream", "delay", "bracket",
  "lngeneral", "lnrelease", "lninverse", "lntech",
];
const SUB_PATTERN_SET = new Set(MAP_SEARCH_SUB_PATTERNS);

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
  danMin: number | null;
  danMax: number | null;
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
  /** Unified-classifier dan verdict, null until the chart analysis lands. */
  dan: { label: string; family: string; rawDan: number } | null;
  /** MinaCalc MSD skillset values at 1.0x, null until the chart analysis lands. */
  msd: Record<string, number> | null;
  /** Vibro-like chart per the classifier; ratings are unreliable, dan filters skip these. */
  vibro: boolean;
}

// A search result row: one per beatmapset. The top-level fields describe the
// representative diff (the one that ranks best under the current sort) and
// `diffs` carries every filter-matching diff of the set, easiest first, so the
// UI can show the spread and switch diffs without another request.
export interface MapSearchSetEntry extends MapSearchEntry {
  diffCount: number;
  diffs: MapSearchEntry[];
}

export interface MapSearchPage {
  items: MapSearchSetEntry[];
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

// MinaCalc skillset -> family. LN has no MSD axis; it keeps the in-house score.
const MSD_FAMILY_KEYS: Array<[msdKey: string, family: string]> = [
  ["Stream", "stream"],
  ["Jumpstream", "jumpstream"],
  ["Handstream", "handstream"],
  ["Stamina", "stamina"],
  ["JackSpeed", "jack"],
  ["Chordjack", "chordjack"],
  ["Technical", "tech"],
];

function readMsdValues(msdJson: unknown): Record<string, number> | null {
  const parsed = parseJson<{ values?: Record<string, unknown> } | null>(msdJson, null);
  if (!parsed?.values || typeof parsed.values !== "object") return null;
  return parsed.values as Record<string, number>;
}

// The chart's family identity, from the strongest available signal per row.
//
// The in-house activity scorer force-caps its chosen family to 1.0 and reads
// dense chord charts as jump/handstream (Planet Shaper indexed as handstream
// with MinaCalc saying Stamina 23.2 / Handstream 18.5), and it promotes any
// holds-heavy hybrid to LN off a soft composite even when the classifier
// routed the chart RC (lnRatio < 0.5). So:
// - 4K with MSD: primary = top MinaCalc skillset (Etterna's own labeling),
//   pat_* mix normalized against it so card tags agree with the modal.
// - Every keymode with a chart analysis: LN primary iff lnRatio >= 0.5, the
//   same threshold the classifier uses to route the dan verdict.
// - No analysis yet: the skills_json profile as before.
function derivePatternProfile(row: Record<string, unknown>): { primary: string; scores: Record<string, number> } {
  const { primary, scores } = readPatternProfile(row.skills_json);
  let result = primary;

  if (intOr(row.cs) === 4) {
    const msd = readMsdValues(row.ca_msd_json);
    if (msd) {
      const values = MSD_FAMILY_KEYS.map(([msdKey, family]) => {
        const value = Number(msd[msdKey]);
        return { family, value: Number.isFinite(value) && value > 0 ? value : 0 };
      });
      const top = values.reduce((best, entry) => (entry.value > best.value ? entry : best), values[0]);
      if (top.value > 0) {
        for (const entry of values) scores[entry.family] = clamp01(entry.value / top.value);
        result = top.family;
      }
    }
  }

  const classification = parseJson<{ lnRatio?: unknown } | null>(row.ca_classification_json, null);
  const lnRatio = classification != null && Number.isFinite(Number(classification.lnRatio)) ? Number(classification.lnRatio) : null;
  if (lnRatio != null && lnRatio >= 0.5) {
    result = "ln";
    scores.ln = 1;
  } else if (lnRatio != null && result === "ln") {
    let best = "unknown";
    let bestValue = 0;
    for (const family of MAP_SEARCH_PATTERNS) {
      if (family === "ln") continue;
      if (scores[family] > bestValue) {
        best = family;
        bestValue = scores[family];
      }
    }
    result = bestValue > 0 ? best : result;
  }

  return { primary: result, scores };
}

// The detected-pattern ids from the chart analysis, space-delimited with outer
// spaces so subfamily filters can match with like '% id %'.
function readPatternTags(classificationJson: unknown): string {
  const parsed = parseJson<{ patterns?: Array<{ id?: unknown }> } | null>(classificationJson, null);
  if (!parsed || !Array.isArray(parsed.patterns)) return "";
  const ids = [...new Set(parsed.patterns.map((hit) => String(hit?.id ?? "")).filter(Boolean))];
  return ids.length > 0 ? ` ${ids.join(" ")} ` : "";
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
    json_extract(b.metadata_json, '$.total_length') as total_length,
    json_extract(b.metadata_json, '$.status') as meta_status,
    s.title as title,
    s.artist as artist,
    s.creator as creator,
    s.covers_json as covers_json,
    json_extract(s.metadata_json, '$.ranked_date') as ranked_date,
    ca.primary_label as ca_dan_label,
    ca.primary_family as ca_dan_family,
    ca.raw_dan as ca_raw_dan,
    ca.msd_json as ca_msd_json,
    ca.msd_overall as ca_msd_overall,
    ca.classification_json as ca_classification_json,
    json_extract(ca.classification_json, '$.vibro') as ca_vibro
  from beatmap_skill_vectors sv
  join beatmaps b on b.beatmap_id = sv.beatmap_id
  join beatmapsets s on s.beatmapset_id = b.beatmapset_id
  left join beatmap_chart_analysis ca
    on ca.beatmap_id = sv.beatmap_id and ca.analysis_version = ${CHART_ANALYSIS_VERSION} and ca.status = 'ready'
  where sv.analysis_version = ? and sv.status = 'ready'
    and json_extract(b.metadata_json, '$.mode') = 'mania'
    and coalesce(json_extract(b.metadata_json, '$.convert'), 0) != 1`;

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
  const { primary, scores } = derivePatternProfile(row);
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
    // Read via the total_length alias: libsql rows are array-like, so a column
    // selected as `length` is shadowed by the row's own length property (the
    // column count), which silently wrote 19 for every map.
    intOr(row.total_length),
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
    row.ca_dan_label == null ? null : String(row.ca_dan_label),
    row.ca_dan_family == null ? null : String(row.ca_dan_family),
    row.ca_raw_dan == null ? null : realOr(row.ca_raw_dan),
    row.ca_msd_json == null ? null : String(row.ca_msd_json),
    row.ca_msd_overall == null ? null : realOr(row.ca_msd_overall),
    readPatternTags(row.ca_classification_json),
    intOr(row.ca_vibro) === 1 ? 1 : 0,
    nowIso(),
  ];
  return {
    sql: `insert into map_search_index (
        beatmap_id, beatmapset_id, analysis_version, title, artist, creator, version,
        search_text, key_count, stars, bpm, length, status, play_count, pass_count, ln_count,
        primary_pattern, pat_jack, pat_stream, pat_jumpstream, pat_handstream, pat_stamina,
        pat_chordjack, pat_tech, pat_ln, covers_json, ranked_date,
        dan_label, dan_family, raw_dan, msd_json, msd_overall, pattern_tags, vibro, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        dan_label = excluded.dan_label, dan_family = excluded.dan_family, raw_dan = excluded.raw_dan,
        msd_json = excluded.msd_json, msd_overall = excluded.msd_overall,
        pattern_tags = excluded.pattern_tags, vibro = excluded.vibro,
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
  if (!row) {
    // The map no longer qualifies (e.g. a metadata refresh reclassified it as a
    // convert): drop any stale index row. Reads trust the index outright, so
    // write paths own keeping it clean.
    await exec(db, "delete from map_search_index where beatmap_id = ?", [id]);
    return;
  }
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

// Build progress is tracked explicitly (not inferred from max(beatmap_id)) so a
// BUILD_REVISION bump re-upserts existing rows from the start instead of
// "resuming" past them. The key carries the revision, so a bump resets to 0.
async function readBuildCursor(db: Db): Promise<number> {
  const row = (await exec(db, "select value_json from live_meta where key = ? limit 1", [BUILD_CURSOR_KEY])).rows[0];
  const parsed = row ? parseJson<{ cursor?: number } | null>(row.value_json, null) : null;
  const cursor = Math.floor(Number(parsed?.cursor ?? 0));
  return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
}

async function writeBuildCursor(db: Db, cursor: number): Promise<void> {
  const now = nowIso();
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [BUILD_CURSOR_KEY, json({ cursor }), now]);
}

async function enqueueBuild(queue: JobQueue, cursor: number): Promise<void> {
  // replaceDone matters: a revision-bumped rebuild reuses the same per-cursor
  // dedupe keys as the previous completed build, and without it the enqueue
  // silently no-ops against those done rows until retention prunes them (which
  // is exactly how the r2 rebuild failed to start on prod).
  await queue.enqueue(MAP_SEARCH_BUILD_JOB, `${MAP_SEARCH_BUILD_JOB}:${cursor}`, { cursor }, { priority: BUILD_JOB_PRIORITY, replaceDone: true });
}

/**
 * Drop the build bookkeeping and start a full index rebuild from row zero.
 * For out-of-band changes the incremental paths never see, e.g. bulk-importing
 * beatmap_chart_analysis rows (chart-analysis transfer) whose per-beatmap
 * index upserts never ran.
 */
export async function forceMapSearchIndexRebuild(db: Db, queue: JobQueue): Promise<void> {
  await exec(db, "delete from live_meta where key in (?, ?)", [BUILD_META_KEY, BUILD_CURSOR_KEY]);
  await enqueueBuild(queue, 0);
}

const STALE_PRUNE_KEY = "map_search_index_stale_pruned:v1";
const STALE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Daily cleanup of rows whose beatmap turned out to be a convert or non-mania
// (osu!std maps played as mania converts show up either with a non-mania native
// mode or as mania rows with `convert: true`, like Kimi no Sei). Search queries
// trust the index outright - probing beatmaps.metadata_json per row at read
// time cost ~40% of every request - so staleness is handled here instead.
async function pruneStaleRows(db: Db, queue: JobQueue): Promise<void> {
  const row = (await exec(db, "select updated_at from live_meta where key = ? limit 1", [STALE_PRUNE_KEY])).rows[0];
  if (row) {
    const last = Date.parse(String(row.updated_at));
    if (Number.isFinite(last) && Date.now() - last < STALE_PRUNE_INTERVAL_MS) return;
  }
  const result = await exec(
    db,
    `delete from map_search_index
     where beatmap_id in (
       select i.beatmap_id
       from map_search_index i
       join beatmaps b on b.beatmap_id = i.beatmap_id
       where coalesce(json_extract(b.metadata_json, '$.convert'), 0) = 1
          or coalesce(json_extract(b.metadata_json, '$.mode'), b.mode, '') != 'mania'
     )`,
  );
  const now = nowIso();
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [STALE_PRUNE_KEY, json({ at: now }), now]);
  if (result.rowsAffected > 0) {
    await queue.enqueue("rebuild_map_collections", "rebuild_map_collections", {}, { priority: -12, replaceDone: true });
  }
}

// Boot/periodic watchdog: kick off the build when missing, and resume a chain
// that died mid-way (crash between batches) from the last indexed id.
export async function ensureMapSearchIndexSeeded(db: Db, queue: JobQueue): Promise<void> {
  await pruneStaleRows(db, queue);
  if (await isMapSearchIndexBuilt(db)) return;
  if (await hasPendingBuildJob(db)) return;
  await enqueueBuild(queue, await readBuildCursor(db));
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
  await writeBuildCursor(db, cursor);
  await enqueueBuild(queue, cursor);
}

export async function getMapSearchIndexStamp(db: Db): Promise<string> {
  const row = (await exec(db, "select updated_at from live_meta where key = ?", [BUILD_META_KEY])).rows[0];
  return row ? String(row.updated_at) : "building";
}

// ── Query ────────────────────────────────────────────────────────────────────

// `length` is aliased on the way out: libsql rows are array-like, so reading
// row.length would return the column count instead of the column.
const SELECT_COLUMNS = `
  beatmap_id, beatmapset_id, title, artist, creator, version, status, key_count,
  stars, bpm, length as length_seconds, play_count, ln_count, primary_pattern,
  pat_jack, pat_stream, pat_jumpstream, pat_handstream, pat_stamina, pat_chordjack, pat_tech, pat_ln,
  covers_json, dan_label, dan_family, raw_dan, msd_json, vibro`;

const KEY_CLAUSES: Record<string, (p: string) => string> = {
  "4k": (p) => `${p}key_count = 4`,
  "7k": (p) => `${p}key_count = 7`,
  other: (p) => `${p}key_count not in (4, 7)`,
};

const STATUS_CLAUSES: Record<string, (p: string) => string> = {
  ranked: (p) => `${p}status in ('ranked', 'approved')`,
  loved: (p) => `${p}status = 'loved'`,
  graveyard: (p) => `${p}status = 'graveyard'`,
  other: (p) => `${p}status not in ('ranked', 'approved', 'loved', 'graveyard')`,
};

// OR the selected options within a facet (so "4K or 7K" widens), then the facets
// AND together. Empty selection = no clause = all.
function orClause(values: string[], lookup: Record<string, (p: string) => string>, p: string): string | null {
  const clauses = [...new Set(values)].map((value) => lookup[value]?.(p)).filter(Boolean);
  return clauses.length > 0 ? `(${clauses.join(" or ")})` : null;
}

// ── osu!-style search tokens ─────────────────────────────────────────────────
//
// The free-text box accepts osu! web filter syntax alongside plain keywords:
//   keys=7 stars>5 bpm>=200 length<90s status=ranked creator=nanahira
//   artist=camellia title=ghost difficulty=insane ranked>2019 dan>=10
// Ops: = (also : and ==) plus >, >=, <, <= (>: and <: accepted) on numeric and
// date fields, and != to negate. Quoted values keep spaces (creator="foo bar").
// A recognized key with an unparsable value drops the token (so a half-typed
// "status=" doesn't blank the results); unknown keys stay plain search terms.

type TokenOp = "=" | "!=" | ">" | ">=" | "<" | "<=";

type SearchTokenFilter =
  // Equality on numerics matches the literal's precision as a half-open bucket:
  // stars=5 is [5, 6), stars=5.3 is [5.3, 5.4), keys=6 is exactly 6.
  | { kind: "numeric"; column: "key_count" | "stars" | "bpm" | "length"; op: TokenOp; value: number; step: number }
  | { kind: "text"; column: "title" | "artist" | "creator" | "version"; negate: boolean; value: string }
  | { kind: "status"; negate: boolean; statuses: string[] }
  // Dates compare lexicographically against the ISO ranked_date; [start, end)
  // spans the literal's precision (2019, 2019-06, or 2019-06-15).
  | { kind: "date"; op: TokenOp; start: string; end: string }
  // Dan levels widen ±0.5 on raw_dan like the facet, and exclude vibro charts.
  | { kind: "dan"; op: TokenOp; value: number };

export interface ParsedMapSearchText {
  terms: string[];
  filters: SearchTokenFilter[];
}

const TOKEN_RE = /^([a-zA-Z_]+)(>=|<=|>:|<:|==|!=|[:=><])(.*)$/;

const NUMERIC_TOKEN_COLUMNS: Record<string, "key_count" | "stars" | "bpm"> = {
  key: "key_count",
  keys: "key_count",
  cs: "key_count",
  star: "stars",
  stars: "stars",
  sr: "stars",
  bpm: "bpm",
};

const TEXT_TOKEN_COLUMNS: Record<string, "title" | "artist" | "creator" | "version"> = {
  title: "title",
  artist: "artist",
  creator: "creator",
  mapper: "creator",
  difficulty: "version",
  diff: "version",
  version: "version",
};

// Token values -> index status column values ("ranked" folds in approved, same
// as the facet; the rest map straight through to the osu! API statuses).
const STATUS_TOKEN_VALUES: Record<string, string[]> = {
  ranked: ["ranked", "approved"],
  approved: ["approved"],
  qualified: ["qualified"],
  loved: ["loved"],
  pending: ["pending"],
  wip: ["wip"],
  graveyard: ["graveyard"],
};

function normalizeTokenOp(raw: string): TokenOp {
  if (raw === ":" || raw === "=" || raw === "==") return "=";
  if (raw === ">:") return ">=";
  if (raw === "<:") return "<=";
  return raw as TokenOp;
}

// Seconds, with osu!'s s/m/h suffixes plus the natural m:ss form.
function parseLengthSeconds(raw: string): number | null {
  const colon = /^(\d+):(\d{1,2})$/.exec(raw);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(raw);
  if (!match) return null;
  const unit = match[2] === "m" ? 60 : match[2] === "h" ? 3600 : 1;
  return Math.round(Number(match[1]) * unit);
}

function parseDateRange(raw: string): { start: string; end: string } | null {
  const match = /^(\d{4})(?:[-./](\d{1,2})(?:[-./](\d{1,2}))?)?$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1990 || year > 2100) return null;
  const month = match[2] == null ? null : Number(match[2]);
  const day = match[3] == null ? null : Number(match[3]);
  if (month != null && (month < 1 || month > 12)) return null;
  if (day != null && (day < 1 || day > 31)) return null;
  const iso = (utc: number) => new Date(utc).toISOString().slice(0, 10);
  const start = Date.UTC(year, (month ?? 1) - 1, day ?? 1);
  const end = day != null
    ? Date.UTC(year, (month as number) - 1, day + 1)
    : month != null
      ? Date.UTC(year, month, 1)
      : Date.UTC(year + 1, 0, 1);
  return { start: iso(start), end: iso(end) };
}

// null = not a filter token, keep as a plain search term; "drop" = recognized
// key but unusable value/op, discard the token entirely.
function parseSearchToken(token: string): SearchTokenFilter | "drop" | null {
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const key = match[1].toLowerCase();
  const op = normalizeTokenOp(match[2]);
  const value = match[3].replace(/"/g, "").trim();

  const numericColumn = NUMERIC_TOKEN_COLUMNS[key];
  if (numericColumn) {
    // Tolerate the natural "keys=7k" spelling.
    const raw = numericColumn === "key_count" ? value.replace(/k$/i, "") : value;
    const parsed = /^(\d+)(?:\.(\d+))?$/.exec(raw);
    if (!parsed) return "drop";
    return { kind: "numeric", column: numericColumn, op, value: Number(raw), step: parsed[2] ? 10 ** -parsed[2].length : 1 };
  }
  if (key === "length" || key === "len") {
    const seconds = parseLengthSeconds(value);
    if (seconds == null) return "drop";
    return { kind: "numeric", column: "length", op, value: seconds, step: 1 };
  }
  const textColumn = TEXT_TOKEN_COLUMNS[key];
  if (textColumn) {
    if ((op !== "=" && op !== "!=") || !value) return "drop";
    return { kind: "text", column: textColumn, negate: op === "!=", value };
  }
  if (key === "status") {
    if (op !== "=" && op !== "!=") return "drop";
    const statuses = STATUS_TOKEN_VALUES[value.toLowerCase()];
    if (!statuses) return "drop";
    return { kind: "status", negate: op === "!=", statuses };
  }
  if (key === "ranked") {
    const range = parseDateRange(value);
    if (!range) return "drop";
    return { kind: "date", op, start: range.start, end: range.end };
  }
  if (key === "dan") {
    const level = Number(value);
    if (!Number.isFinite(level)) return "drop";
    return { kind: "dan", op, value: level };
  }
  return null;
}

// Split the raw query into plain search terms and structured token filters.
// Quotes group spaces into one unit, both for filter values and free text
// (searching "big black" as a single phrase).
export function parseMapSearchText(q: string): ParsedMapSearchText {
  const terms: string[] = [];
  const filters: SearchTokenFilter[] = [];
  for (const token of q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const filter = parseSearchToken(token);
    if (filter === "drop") continue;
    if (filter) {
      if (filters.length < 12) filters.push(filter);
      continue;
    }
    const term = token.replace(/"/g, "").toLowerCase();
    if (term && terms.length < 6) terms.push(term);
  }
  return { terms, filters };
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

// Columns hold original casing; LIKE is ASCII-case-insensitive in SQLite, which
// covers creator/title tokens the same way the lowercased search_text blob does.
function applyTokenFilter(filter: SearchTokenFilter, p: string, conditions: string[], args: InValue[]): void {
  switch (filter.kind) {
    case "numeric": {
      const col = `${p}${filter.column}`;
      if (filter.op === "=" || filter.op === "!=") {
        const clause = `(${col} >= ? and ${col} < ?)`;
        conditions.push(filter.op === "=" ? clause : `not ${clause}`);
        args.push(filter.value, filter.value + filter.step);
      } else {
        conditions.push(`${col} ${filter.op} ?`);
        args.push(filter.value);
      }
      return;
    }
    case "text": {
      conditions.push(`${p}${filter.column} ${filter.negate ? "not like" : "like"} ? escape '\\'`);
      args.push(`%${escapeLike(filter.value)}%`);
      return;
    }
    case "status": {
      const placeholders = filter.statuses.map(() => "?").join(", ");
      conditions.push(`${p}status ${filter.negate ? "not in" : "in"} (${placeholders})`);
      args.push(...filter.statuses);
      return;
    }
    case "date": {
      const col = `${p}ranked_date`;
      if (filter.op === "=" || filter.op === "!=") {
        const clause = `(${col} >= ? and ${col} < ?)`;
        conditions.push(filter.op === "=" ? clause : `not ${clause}`);
        args.push(filter.start, filter.end);
      } else if (filter.op === ">") {
        conditions.push(`${col} >= ?`);
        args.push(filter.end);
      } else if (filter.op === ">=") {
        conditions.push(`${col} >= ?`);
        args.push(filter.start);
      } else if (filter.op === "<") {
        conditions.push(`${col} < ?`);
        args.push(filter.start);
      } else {
        conditions.push(`${col} < ?`);
        args.push(filter.end);
      }
      return;
    }
    case "dan": {
      const col = `${p}raw_dan`;
      const lo = filter.value - 0.5;
      const hi = filter.value + 0.5;
      if (filter.op === "=" || filter.op === "!=") {
        const clause = `(${col} >= ? and ${col} <= ?)`;
        if (filter.op === "!=") {
          conditions.push(`not ${clause}`);
          args.push(lo, hi);
          return;
        }
        conditions.push(clause);
        args.push(lo, hi);
      } else if (filter.op === ">") {
        conditions.push(`${col} > ?`);
        args.push(hi);
      } else if (filter.op === ">=") {
        conditions.push(`${col} >= ?`);
        args.push(lo);
      } else if (filter.op === "<") {
        conditions.push(`${col} < ?`);
        args.push(lo);
      } else {
        conditions.push(`${col} <= ?`);
        args.push(hi);
      }
      // Same rationale as the dan facet: vibro dans are inflated noise.
      conditions.push(`${p}vibro = 0`);
      return;
    }
  }
}

// Filter conditions with an optional column prefix ("i." / "j.") so the page
// query can apply the same filter set to both sides of its dedup anti-join.
// No metadata probes here: the index is kept convert/non-mania-free at write
// time (build filter, upsert delete, daily prune), so reads trust it as-is.
function buildWhereParts(query: MapSearchQuery, p = ""): { conditions: string[]; args: InValue[] } {
  const conditions: string[] = [];
  const args: InValue[] = [];

  const keyClause = orClause(query.keys, KEY_CLAUSES, p);
  if (keyClause) conditions.push(keyClause);

  const statusClause = orClause(query.statuses, STATUS_CLAUSES, p);
  if (statusClause) conditions.push(statusClause);

  const parsedText = parseMapSearchText(query.q);
  for (const term of parsedText.terms) {
    conditions.push(`${p}search_text like ? escape '\\'`);
    args.push(`%${escapeLike(term)}%`);
  }
  for (const filter of parsedText.filters) {
    applyTokenFilter(filter, p, conditions, args);
  }

  if (query.starMin != null) {
    conditions.push(`${p}stars >= ?`);
    args.push(query.starMin);
  }
  if (query.starMax != null) {
    conditions.push(`${p}stars <= ?`);
    args.push(query.starMax);
  }
  if (query.bpmMin != null) {
    conditions.push(`${p}bpm >= ?`);
    args.push(query.bpmMin);
  }
  if (query.bpmMax != null) {
    conditions.push(`${p}bpm <= ?`);
    args.push(query.bpmMax);
  }
  if (query.lenMin != null) {
    conditions.push(`${p}length >= ?`);
    args.push(query.lenMin);
  }
  if (query.lenMax != null) {
    conditions.push(`${p}length <= ?`);
    args.push(query.lenMax);
  }

  // Family picks match the map's dominant pattern (select chordjack -> chordjack
  // maps); subfamily picks match detected-pattern tags. Within the facet the
  // selections OR together, like every other facet.
  const requested = [...new Set(query.patterns)];
  const families = requested.filter((pattern) => PATTERN_COLUMNS[pattern]);
  const subs = requested.filter((pattern) => SUB_PATTERN_SET.has(pattern));
  const patternClauses: string[] = [];
  if (families.length > 0) {
    patternClauses.push(`${p}primary_pattern in (${families.map(() => "?").join(", ")})`);
    args.push(...families);
  }
  for (const sub of subs) {
    patternClauses.push(`${p}pattern_tags like ?`);
    args.push(`% ${sub} %`);
  }
  if (patternClauses.length > 0) {
    conditions.push(`(${patternClauses.join(" or ")})`);
  }

  // danMin/danMax are integer dan levels, inclusive of the whole dan: verdict
  // "N" spans N±0.5 on raw_dan (tier offsets ±0.4, boundary halves ±0.5), so
  // the bounds widen half a step. min == max matches exactly one dan.
  // Vibro charts are excluded outright: their estimated dans are inflated
  // (mash-heavy charts overrate on every engine), so a dan-scoped search
  // returning them is noise. They stay reachable without the dan filter.
  if (query.danMin != null) {
    conditions.push(`${p}raw_dan >= ?`);
    args.push(query.danMin - 0.5);
  }
  if (query.danMax != null) {
    conditions.push(`${p}raw_dan <= ?`);
    args.push(query.danMax + 0.5);
  }
  if (query.danMin != null || query.danMax != null) {
    conditions.push(`${p}vibro = 0`);
  }

  if (query.country) {
    conditions.push(
      `${p}beatmap_id in (
        select beatmap_id from country_maps_farmed_scores where country = ?
        union
        select beatmap_id from country_maps_most_played where country = ?
      )`,
    );
    args.push(query.country, query.country);
  }

  return { conditions, args };
}

export async function getMapSearchPage(db: Db, query: MapSearchQuery): Promise<MapSearchPage> {
  const flat = buildWhereParts(query);
  const flatWhere = flat.conditions.length > 0 ? `where ${flat.conditions.join(" and ")}` : "";

  const totalRow = (await exec(
    db,
    `select count(distinct beatmapset_id) as total from map_search_index ${flatWhere}`,
    flat.args,
  )).rows[0];
  const total = intOr(totalRow?.total, 0);

  const orderColumn = SORT_COLUMNS[query.sort] ?? "play_count";
  const orderDir = query.dir === "asc" ? "asc" : "desc";

  const pageSize = Math.max(1, Math.floor(query.pageSize));
  const page = Math.max(0, Math.floor(query.page));
  const offset = page * pageSize;

  // One row per beatmapset: a diff represents its set unless a sibling diff that
  // also matches the filters sorts strictly better. This anti-join shape (rather
  // than ranking with a window function) lets SQLite walk the (sort column,
  // beatmap_id) index already in order and stop at the page boundary, where the
  // window variant had to rank and sort the whole filtered corpus per request.
  // The tiebreak follows the sort direction so one index serves both scans.
  // ranked_date is nullable: null-vs-null compares as unknown and would leak
  // every diff of an undated set past the anti-join, so it compares through
  // coalesce; the raw column still drives ORDER BY (same order: '' and null
  // both sort before every real date) to keep the index usable. It is also
  // selected explicitly because SELECT_COLUMNS doesn't carry it.
  const cmp = orderDir === "asc" ? "<" : ">";
  const orderRef = (alias: string) =>
    orderColumn === "ranked_date" ? `coalesce(${alias}.ranked_date, '')` : `${alias}.${orderColumn}`;
  const outer = buildWhereParts(query, "i.");
  const sibling = buildWhereParts(query, "j.");
  const pageConditions = [
    ...outer.conditions,
    `not exists (
       select 1 from map_search_index j
       where j.beatmapset_id = i.beatmapset_id
         ${sibling.conditions.map((condition) => `and ${condition}`).join(" ")}
         and (${orderRef("j")} ${cmp} ${orderRef("i")}
           or (${orderRef("j")} = ${orderRef("i")} and j.beatmap_id ${cmp} i.beatmap_id))
     )`,
  ];
  const rows = (await exec(
    db,
    `select ${SELECT_COLUMNS}, ranked_date
     from map_search_index i
     where ${pageConditions.join(" and ")}
     order by i.${orderColumn} ${orderDir}, i.beatmap_id ${orderDir}
     limit ? offset ?`,
    [...outer.args, ...sibling.args, pageSize, offset],
  )).rows;

  // Second pass: every matching diff of the page's sets, easiest first. Covers
  // are dropped from the nested diffs since they duplicate the set's own.
  const setIds = [...new Set(rows.map((row) => intOr(row.beatmapset_id)))].filter((id) => id > 0);
  const diffsBySet = new Map<number, MapSearchEntry[]>();
  if (setIds.length > 0) {
    const placeholders = setIds.map(() => "?").join(", ");
    const diffConditions = [...flat.conditions, `beatmapset_id in (${placeholders})`];
    const diffRows = (await exec(
      db,
      `select ${SELECT_COLUMNS} from map_search_index where ${diffConditions.join(" and ")}
       order by key_count asc, stars asc, beatmap_id asc`,
      [...flat.args, ...setIds],
    )).rows;
    for (const row of diffRows) {
      const entry = { ...rowToEntry(row), covers: null };
      const list = diffsBySet.get(entry.beatmapsetId);
      if (list) list.push(entry);
      else diffsBySet.set(entry.beatmapsetId, [entry]);
    }
  }

  const items = rows.map((row) => {
    const entry = rowToEntry(row);
    const diffs = diffsBySet.get(entry.beatmapsetId) ?? [{ ...entry, covers: null }];
    return { ...entry, diffCount: diffs.length, diffs };
  });

  return { items, total, page, pageSize };
}

// One set entry keyed off a single diff: the requested beatmap becomes the
// representative and `diffs` carries every diff of its set, easiest first,
// unfiltered. Backs the /maps?map=<beatmapId> share links.
export async function getMapSearchSetEntry(db: Db, beatmapId: number): Promise<MapSearchSetEntry | null> {
  const rows = (await exec(
    db,
    `select ${SELECT_COLUMNS} from map_search_index where beatmap_id = ?`,
    [beatmapId],
  )).rows;
  if (rows.length === 0) return null;
  const entry = rowToEntry(rows[0]);
  const diffRows = (await exec(
    db,
    `select ${SELECT_COLUMNS} from map_search_index where beatmapset_id = ?
     order by key_count asc, stars asc, beatmap_id asc`,
    [entry.beatmapsetId],
  )).rows;
  const diffs = diffRows.map((row) => ({ ...rowToEntry(row), covers: null }));
  return { ...entry, diffCount: diffs.length, diffs };
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
      `select ${SELECT_COLUMNS}
       from map_search_index
       where beatmap_id in (${placeholders})`,
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
  const rawDan = row.raw_dan == null ? null : Number(row.raw_dan);
  const dan = row.dan_label != null && rawDan != null && Number.isFinite(rawDan)
    ? { label: String(row.dan_label), family: String(row.dan_family ?? "dan"), rawDan }
    : null;
  const msdParsed = row.msd_json == null
    ? null
    : parseJson<{ values?: Record<string, number> } | null>(row.msd_json, null);
  const msd = msdParsed && msdParsed.values && typeof msdParsed.values === "object" ? msdParsed.values : null;
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
    length: intOr(row.length_seconds),
    playCount: intOr(row.play_count),
    lnCount: intOr(row.ln_count),
    primaryPattern: String(row.primary_pattern ?? "unknown"),
    patterns,
    covers: covers && typeof covers === "object" ? covers : null,
    dan,
    msd,
    vibro: intOr(row.vibro) === 1,
  };
}
