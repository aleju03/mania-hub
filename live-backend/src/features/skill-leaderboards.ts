import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { resolveCountryScope } from "../countries.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import {
  PLAYER_SKILLS_VERSION,
  PLAYER_SKILL_PATTERN_AXES,
  SKILL_RATING_SKILLSETS,
  type PlayerSkillModeBreakdown,
} from "./player-skills.js";
import {
  BASELINE_MIN_PLAYS,
  BASELINE_PATTERN_MIN_PLAYS,
  curveMedian,
  exactCurvesUsable,
  percentileFromCurve,
  readExactSkillCurves,
  shrinkRating,
  type AxisCurveMap,
  type ExactSkillCurves,
} from "./skill-baseline.js";

// Population leaderboards over the stored per-player skill vectors and dan
// estimates ("who are the best 7K chordjack players"). Everything here is a
// read-time view: the numbers already exist in player_skill_ratings.modes_json,
// computed by the player-skills pipeline and kept at full roster coverage by
// the drip scheduler, so this module adds no ingest, no job and no table.
//
// The board is built once and cached per Db, exactly like the pp board in
// global-rankings.ts, and scope/keymode/axis are slices of it. What it must NOT
// do is materialize one entry object per (player, keymode, axis) - that is
// ~660k objects on the real roster. Instead each keymode holds one shared
// player record set plus, per axis, three typed arrays: the value, the evidence
// count, and a descending order of player slots. The whole thing is a few MB.
//
// Ratings are the DISPLAY-SHRUNK ones, the same number the profile Skills tab
// prints (shrinkRating against the population median from the exact curves).
// That is not cosmetic: aggregateSsrs is an absolute erfc fold, so a 22-play
// pool converges near its own peak plays while a 215-play pool has to sustain
// it, and ranking raw would put the thin pool on top. The board and the profile
// must agree, so the shrink is imported rather than reimplemented.

export type DanSide = "rc" | "ln";

export const SKILL_LEADERBOARD_KEY_COUNTS = [4, 6, 7] as const;
export type SkillLeaderboardKeyCount = (typeof SKILL_LEADERBOARD_KEY_COUNTS)[number];

export const SKILL_LEADERBOARD_MAX_PAGE_SIZE = 50;

export function isSkillLeaderboardKeyCount(value: number): value is SkillLeaderboardKeyCount {
  return (SKILL_LEADERBOARD_KEY_COUNTS as readonly number[]).includes(value);
}

/**
 * Axes a keymode publishes, mirroring skillModeEntries on the frontend and
 * percentileAxes in skill-baseline: 4K speaks MinaCalc's native skillsets plus
 * the grafted LN pattern axis; 6K/7K speak the in-house pattern vocabulary only,
 * because the calc's skillset names are 4K-born and unreliable elsewhere.
 *
 * Overall leads every keymode and is the board's default: it is the "no
 * particular skill" ranking, the aggregate the profile card headlines, and the
 * one axis every keymode rates (percentileAxes publishes it for non-4K too).
 * Without it the reader is forced to pick a specialty before seeing anybody.
 *
 * The served payload carries the axes that actually have a population, so the
 * frontend renders that list instead of keeping its own copy.
 */
export const LEADERBOARD_DEFAULT_AXIS = "Overall";

export function leaderboardAxesFor(keyCount: number): string[] {
  if (keyCount === 4) {
    return [...SKILL_RATING_SKILLSETS, "pattern:ln"];
  }
  return [LEADERBOARD_DEFAULT_AXIS, ...PLAYER_SKILL_PATTERN_AXES.map((axis) => `pattern:${axis}`)];
}

export function isLeaderboardAxis(keyCount: number, axis: string): boolean {
  return leaderboardAxesFor(keyCount).includes(axis);
}

export interface SkillLeaderboardUser {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
  global_rank: number | null;
}

export interface SkillLeaderboardEntry {
  rank: number;
  user: SkillLeaderboardUser;
  value: number;
  // Evidence behind the value: plays on the tagged charts for a pattern axis,
  // the keymode's analyzed plays for an MSD skillset.
  plays: number;
  analyzedPlays: number;
  // Thinner evidence than the population baseline demands of its own members;
  // the value is shrunk hard toward the median and reads as an estimate.
  provisional?: boolean;
  percentile?: number;
}

export interface DanLeaderboardEntry {
  rank: number;
  user: SkillLeaderboardUser;
  rawDan: number;
  label: string;
  /* Deliberately not the stored `clears`: danFromClears counts clears tied
     with the quorum-th credited clear, which is the dan itself, so it reads 4
     for ~98% of players and carries no signal. The player's real qualifying
     total is only on the dan-evidence endpoint, which re-derives it from
     plays_json per request. What separates a dan off a deep pool from one off
     a handful of maps is play depth, so that is what a row carries. */
  analyzedPlays: number;
  // The estimate sits at or above the top of this keymode's ladder, so the
  // label is a floor rather than a measurement.
  beyondTable?: boolean;
}

export interface SkillLeaderboardAxisInfo {
  axis: string;
  players: number;
}

interface LeaderboardSnapshotBase {
  total: number;
  page: number;
  pageSize: number;
  keyCount: number;
  fetchedAt: number;
  // False when the exact curves are missing or unusable and the board is
  // serving raw ratings, which would then disagree with the profile page.
  shrunk: boolean;
  // Rows at the current analysis version out of all ready rows. A version bump
  // recomputes players one at a time, so a half-migrated board is visible here
  // instead of quietly wrong.
  coverage: { current: number; total: number };
}

export interface SkillLeaderboardSnapshot extends LeaderboardSnapshotBase {
  axis: string;
  ranking: SkillLeaderboardEntry[];
  axes: SkillLeaderboardAxisInfo[];
}

export interface DanLeaderboardSnapshot extends LeaderboardSnapshotBase {
  side: DanSide;
  ranking: DanLeaderboardEntry[];
  sides: Array<{ side: DanSide; players: number }>;
}

// --- Board memory ---

interface AxisColumn {
  values: Float32Array;
  plays: Int32Array;
  // Player slots with a value, sorted by value descending.
  order: Int32Array;
}

interface DanColumn {
  raw: Float32Array;
  labels: string[];
  beyond: Uint8Array;
  order: Int32Array;
}

interface KeymodeBoard {
  keyCount: number;
  users: SkillLeaderboardUser[];
  countries: string[];
  analyzedPlays: Int32Array;
  axes: Map<string, AxisColumn>;
  dan: Map<DanSide, DanColumn>;
}

interface SkillBoardCache {
  keymodes: Map<number, KeymodeBoard>;
  shrunk: boolean;
  curves: ExactSkillCurves | null;
  coverage: { current: number; total: number };
  builtAt: number;
}

// Skill rows carry a 12h recompute TTL and the drip only adds 16 players every
// 5 minutes, so a 5-minute board is as fresh as the data underneath it. (The pp
// board rebuilds every 60s because pp moves constantly; this does not.)
const SKILL_BOARD_CACHE_TTL_MS = 5 * 60 * 1000;
const SCOPE_VIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const BOARD_BUILD_CHUNK = 500;

interface SkillBoardMemory {
  board: SkillBoardCache;
  checkedAt: number;
}

const boardCacheByDb = new WeakMap<Db, SkillBoardMemory>();
const boardBuildByDb = new WeakMap<Db, Promise<SkillBoardCache>>();

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface DraftAxis {
  values: number[];
  plays: number[];
}

interface DraftDan {
  raw: number[];
  labels: string[];
  beyond: number[];
}

interface DraftKeymode {
  keyCount: number;
  users: SkillLeaderboardUser[];
  countries: string[];
  analyzedPlays: number[];
  axes: Map<string, DraftAxis>;
  dan: Map<DanSide, DraftDan>;
}

function draftFor(drafts: Map<number, DraftKeymode>, keyCount: number): DraftKeymode {
  let draft = drafts.get(keyCount);
  if (!draft) {
    draft = {
      keyCount,
      users: [],
      countries: [],
      analyzedPlays: [],
      axes: new Map(),
      dan: new Map(),
    };
    drafts.set(keyCount, draft);
  }
  return draft;
}

/* Every column is dense over the keymode's player slots, so an axis first seen
   at slot N is back-filled with zeros and every column grows to the same
   length once the slot is written. Zero means "no value", which is also what
   the order build filters on. */
function padTo(list: number[], length: number, filler: number): void {
  while (list.length < length) list.push(filler);
}

function padLabels(list: string[], length: number): void {
  while (list.length < length) list.push("");
}

function sortedOrder(values: number[]): Int32Array {
  const slots: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] > 0) slots.push(index);
  }
  slots.sort((a, b) => values[b] - values[a]);
  return Int32Array.from(slots);
}

async function buildSkillBoard(db: Db): Promise<SkillBoardCache> {
  const startedAt = Date.now();
  const curvesRaw = await readExactSkillCurves(db);
  const curves = exactCurvesUsable(curvesRaw) ? curvesRaw : null;

  /* Roster membership is read once instead of as an `in (select ...)` subquery
     on every batch: the same 12k-row scan repeated 28 times was most of the
     build. The set is the same one buildExactSkillCurves narrows to, so the
     board and the percentile population stay the same players. */
  const rosterIds = new Set<number>();
  for (const row of (await exec(db, "select distinct user_id from country_rosters")).rows) {
    rosterIds.add(Number(row.user_id));
  }

  const drafts = new Map<number, DraftKeymode>();
  let cursor = 0;
  let scanned = 0;
  for (;;) {
    const rows = (await exec(
      db,
      `select r.user_id, r.modes_json, u.username, u.avatar_url, u.country_code, u.global_rank
         from player_skill_ratings r
         join users u on u.user_id = r.user_id
        where r.analysis_version = ? and r.status = 'ready' and r.modes_json is not null
          and r.user_id > ?
        order by r.user_id
        limit ?`,
      [PLAYER_SKILLS_VERSION, cursor, BOARD_BUILD_CHUNK],
    )).rows;

    for (const row of rows) {
      const userId = Number(row.user_id);
      cursor = Math.max(cursor, userId);
      if (!rosterIds.has(userId)) continue;
      scanned += 1;
      const modes = parseJson<{ modes?: PlayerSkillModeBreakdown[] }>(String(row.modes_json ?? ""), {}).modes;
      if (!Array.isArray(modes)) continue;
      const user: SkillLeaderboardUser = {
        id: userId,
        username: String(row.username ?? ""),
        avatar_url: String(row.avatar_url ?? ""),
        country_code: String(row.country_code ?? "").trim().toUpperCase(),
        global_rank: row.global_rank == null ? null : Number(row.global_rank),
      };

      for (const mode of modes) {
        const keyCount = Number(mode?.keyCount);
        if (!isSkillLeaderboardKeyCount(keyCount)) continue;
        const analyzedPlays = Math.max(0, Math.floor(Number(mode?.analyzedPlays) || 0));
        const draft = draftFor(drafts, keyCount);
        const slot = draft.users.length;
        draft.users.push(user);
        draft.countries.push(user.country_code);
        draft.analyzedPlays.push(analyzedPlays);

        const axisCurves: AxisCurveMap | undefined = curves?.curves[String(keyCount)];
        const eligible = new Set(leaderboardAxesFor(keyCount));
        const patternRatings = new Map<string, { rating: number; plays: number }>();
        for (const entry of mode?.patterns ?? []) {
          const id = String(entry?.id ?? "");
          if (!id) continue;
          patternRatings.set(id, { rating: Number(entry?.rating) || 0, plays: Math.max(0, Math.floor(Number(entry?.plays) || 0)) });
        }

        for (const axis of eligible) {
          let value = 0;
          let plays = 0;
          if (axis.startsWith("pattern:")) {
            const entry = patternRatings.get(axis.slice("pattern:".length));
            // The pipeline already drops pattern ratings under the min-play
            // floor, but a stored row from an older version may not have.
            if (entry && entry.plays >= BASELINE_PATTERN_MIN_PLAYS) {
              value = entry.rating;
              plays = entry.plays;
            }
          } else {
            value = Number(mode?.ratings?.[axis]) || 0;
            plays = analyzedPlays;
          }
          // A 6K/7K calc returns ~0.15 slivers for skillsets it does not rate;
          // the same floor the profile card uses keeps those off the board.
          if (!(value >= 1)) continue;
          const shrunkValue = curves ? shrinkRating(value, plays, curveMedian(axisCurves, axis)) : value;
          let column = draft.axes.get(axis);
          if (!column) draft.axes.set(axis, (column = { values: [], plays: [] }));
          padTo(column.values, slot, 0);
          padTo(column.plays, slot, 0);
          column.values.push(shrunkValue);
          column.plays.push(plays);
        }

        for (const side of ["rc", "ln"] as const) {
          const dan = mode?.dan?.[side];
          const rawDan = Number(dan?.rawDan);
          if (!dan || !(rawDan > 0)) continue;
          let column = draft.dan.get(side);
          if (!column) draft.dan.set(side, (column = { raw: [], labels: [], beyond: [] }));
          padTo(column.raw, slot, 0);
          padLabels(column.labels, slot);
          padTo(column.beyond, slot, 0);
          column.raw.push(rawDan);
          column.labels.push(String(dan.label ?? ""));
          column.beyond.push(dan.beyondTable === true ? 1 : 0);
        }
      }
    }

    await yieldEventLoop();
    if (rows.length < BOARD_BUILD_CHUNK) break;
  }

  const keymodes = new Map<number, KeymodeBoard>();
  for (const [keyCount, draft] of drafts) {
    const size = draft.users.length;
    const axes = new Map<string, AxisColumn>();
    for (const [axis, column] of draft.axes) {
      padTo(column.values, size, 0);
      padTo(column.plays, size, 0);
      axes.set(axis, {
        values: Float32Array.from(column.values),
        plays: Int32Array.from(column.plays),
        order: sortedOrder(column.values),
      });
    }
    const dan = new Map<DanSide, DanColumn>();
    for (const [side, column] of draft.dan) {
      padTo(column.raw, size, 0);
      padLabels(column.labels, size);
      padTo(column.beyond, size, 0);
      dan.set(side, {
        raw: Float32Array.from(column.raw),
        labels: column.labels,
        beyond: Uint8Array.from(column.beyond),
        order: sortedOrder(column.raw),
      });
    }
    keymodes.set(keyCount, {
      keyCount,
      users: draft.users,
      countries: draft.countries,
      analyzedPlays: Int32Array.from(draft.analyzedPlays),
      axes,
      dan,
    });
  }

  const counts = (await exec(
    db,
    "select sum(case when analysis_version = ? then 1 else 0 end) as current, count(*) as total from player_skill_ratings where status = 'ready'",
    [PLAYER_SKILLS_VERSION],
  )).rows[0];

  const board: SkillBoardCache = {
    keymodes,
    shrunk: curves != null,
    curves,
    coverage: {
      current: Number(counts?.current ?? 0),
      total: Number(counts?.total ?? 0),
    },
    builtAt: Date.now(),
  };
  logInfo("skill_leaderboard_built", {
    ms: Date.now() - startedAt,
    players: scanned,
    keymodes: keymodes.size,
    shrunk: board.shrunk,
  });
  return board;
}

async function refreshSkillBoard(db: Db): Promise<SkillBoardCache> {
  try {
    const built = await buildSkillBoard(db);
    boardCacheByDb.set(db, { board: built, checkedAt: Date.now() });
    scopeViewCacheByDb.delete(db);
    return built;
  } catch (error) {
    // Keep serving the previous board through a failed rebuild; only the very
    // first load has nothing to fall back to.
    logWarn("skill_leaderboard_rebuild_failed", errorContext(error));
    const stale = boardCacheByDb.get(db);
    if (stale) return stale.board;
    throw error;
  }
}

async function getSkillBoard(db: Db): Promise<SkillBoardCache> {
  const memory = boardCacheByDb.get(db);
  if (memory && Date.now() - memory.checkedAt < SKILL_BOARD_CACHE_TTL_MS) return memory.board;

  let refresh = boardBuildByDb.get(db);
  if (!refresh) {
    refresh = refreshSkillBoard(db).finally(() => {
      boardBuildByDb.delete(db);
    });
    boardBuildByDb.set(db, refresh);
  }
  if (memory) {
    // The rebuild must never sit in the request path: the stale board answers
    // instantly while it runs. Failures log inside.
    refresh.catch(() => {});
    return memory.board;
  }
  return refresh;
}

/** Test seam: drop the cached board so a seeded DB rebuilds on the next read. */
export function resetSkillLeaderboardCache(db: Db): void {
  boardCacheByDb.delete(db);
  boardBuildByDb.delete(db);
  scopeViewCacheByDb.delete(db);
}

// --- Scope views ---

// A scope board is the global order filtered to the scope's member countries,
// which is a linear pass over at most ~13k slots. Cached per (scope, keymode,
// axis) and keyed on the parent board's builtAt, like getRegionBoard.
interface ScopeView {
  order: Int32Array;
  boardBuiltAt: number;
  checkedAt: number;
}

const scopeViewCacheByDb = new WeakMap<Db, Map<string, ScopeView>>();

function scopedOrder(
  db: Db,
  board: SkillBoardCache,
  keymode: KeymodeBoard,
  cacheKey: string,
  order: Int32Array,
  codes: string[] | null,
): Int32Array {
  if (!codes) return order;
  let views = scopeViewCacheByDb.get(db);
  if (!views) scopeViewCacheByDb.set(db, (views = new Map()));
  const cached = views.get(cacheKey);
  if (cached && cached.boardBuiltAt === board.builtAt && Date.now() - cached.checkedAt < SCOPE_VIEW_CACHE_TTL_MS) {
    return cached.order;
  }
  const members = new Set(codes.map((code) => code.trim().toUpperCase()));
  const slots: number[] = [];
  for (let index = 0; index < order.length; index += 1) {
    const slot = order[index];
    if (members.has(keymode.countries[slot])) slots.push(slot);
  }
  const filtered = Int32Array.from(slots);
  views.set(cacheKey, { order: filtered, boardBuiltAt: board.builtAt, checkedAt: Date.now() });
  return filtered;
}

function clampPage(page: number | undefined): number {
  const value = Math.floor(Number(page ?? 1));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 2000) : 1;
}

function clampPageSize(pageSize: number | undefined): number {
  const value = Math.floor(Number(pageSize ?? SKILL_LEADERBOARD_MAX_PAGE_SIZE));
  if (!Number.isFinite(value) || value <= 0) return SKILL_LEADERBOARD_MAX_PAGE_SIZE;
  return Math.min(value, SKILL_LEADERBOARD_MAX_PAGE_SIZE);
}

export interface SkillLeaderboardQuery {
  country: string;
  keyCount: number;
  axis: string;
  page?: number;
  pageSize?: number;
}

export interface DanLeaderboardQuery {
  country: string;
  keyCount: number;
  side: DanSide;
  page?: number;
  pageSize?: number;
}

function axisPopulations(
  db: Db,
  board: SkillBoardCache,
  keymode: KeymodeBoard | undefined,
  scopeCode: string,
  codes: string[] | null,
): SkillLeaderboardAxisInfo[] {
  if (!keymode) return [];
  const infos: SkillLeaderboardAxisInfo[] = [];
  for (const axis of leaderboardAxesFor(keymode.keyCount)) {
    const column = keymode.axes.get(axis);
    if (!column) continue;
    const order = scopedOrder(db, board, keymode, `${scopeCode}:${keymode.keyCount}:${axis}`, column.order, codes);
    if (order.length === 0) continue;
    infos.push({ axis, players: order.length });
  }
  return infos;
}

export async function getSkillLeaderboard(db: Db, query: SkillLeaderboardQuery): Promise<SkillLeaderboardSnapshot> {
  const board = await getSkillBoard(db);
  const scope = resolveCountryScope(query.country);
  const codes = scope.codes;
  const keymode = board.keymodes.get(query.keyCount);
  const page = clampPage(query.page);
  const pageSize = clampPageSize(query.pageSize);
  const axes = axisPopulations(db, board, keymode, scope.code, codes);

  const base: SkillLeaderboardSnapshot = {
    axis: query.axis,
    ranking: [],
    axes,
    total: 0,
    page,
    pageSize,
    keyCount: query.keyCount,
    fetchedAt: board.builtAt,
    shrunk: board.shrunk,
    coverage: board.coverage,
  };
  const column = keymode?.axes.get(query.axis);
  if (!keymode || !column) return base;

  const order = scopedOrder(db, board, keymode, `${scope.code}:${keymode.keyCount}:${query.axis}`, column.order, codes);
  const axisCurves: AxisCurveMap | undefined = board.curves?.curves[String(keymode.keyCount)];
  const curve = axisCurves?.[query.axis]?.curve;
  const start = (page - 1) * pageSize;
  const ranking: SkillLeaderboardEntry[] = [];
  for (let index = start; index < Math.min(order.length, start + pageSize); index += 1) {
    const slot = order[index];
    const analyzedPlays = keymode.analyzedPlays[slot];
    const value = Math.round(column.values[slot] * 100) / 100;
    const entry: SkillLeaderboardEntry = {
      rank: index + 1,
      // A fresh object every time: accent enrichment mutates the response in
      // place and must never write into the shared board.
      user: { ...keymode.users[slot] },
      value,
      plays: column.plays[slot],
      analyzedPlays,
    };
    if (analyzedPlays < BASELINE_MIN_PLAYS) entry.provisional = true;
    if (curve && curve.length > 0) entry.percentile = percentileFromCurve(curve, value);
    ranking.push(entry);
  }

  return { ...base, ranking, total: order.length };
}

export async function getDanLeaderboard(db: Db, query: DanLeaderboardQuery): Promise<DanLeaderboardSnapshot> {
  const board = await getSkillBoard(db);
  const scope = resolveCountryScope(query.country);
  const codes = scope.codes;
  const keymode = board.keymodes.get(query.keyCount);
  const page = clampPage(query.page);
  const pageSize = clampPageSize(query.pageSize);

  const sides: Array<{ side: DanSide; players: number }> = [];
  if (keymode) {
    for (const side of ["rc", "ln"] as const) {
      const column = keymode.dan.get(side);
      if (!column) continue;
      const order = scopedOrder(db, board, keymode, `${scope.code}:${keymode.keyCount}:dan:${side}`, column.order, codes);
      if (order.length === 0) continue;
      sides.push({ side, players: order.length });
    }
  }

  const base: DanLeaderboardSnapshot = {
    side: query.side,
    ranking: [],
    sides,
    total: 0,
    page,
    pageSize,
    keyCount: query.keyCount,
    fetchedAt: board.builtAt,
    shrunk: board.shrunk,
    coverage: board.coverage,
  };
  const column = keymode?.dan.get(query.side);
  if (!keymode || !column) return base;

  const order = scopedOrder(db, board, keymode, `${scope.code}:${keymode.keyCount}:dan:${query.side}`, column.order, codes);
  const start = (page - 1) * pageSize;
  const ranking: DanLeaderboardEntry[] = [];
  for (let index = start; index < Math.min(order.length, start + pageSize); index += 1) {
    const slot = order[index];
    const entry: DanLeaderboardEntry = {
      rank: index + 1,
      user: { ...keymode.users[slot] },
      rawDan: Math.round(column.raw[slot] * 100) / 100,
      label: column.labels[slot],
      analyzedPlays: keymode.analyzedPlays[slot],
    };
    if (column.beyond[slot] === 1) entry.beyondTable = true;
    ranking.push(entry);
  }

  return { ...base, ranking, total: order.length };
}
