import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { resolveCountryScope } from "../countries.js";
import { errorContext, logInfo, logWarn } from "../logger.js";
import { BOARD_WARMUP_DELAY_MS, unrefDelay, waitForQuietSchema } from "../warmup.js";
import {
  PLAYER_SKILLS_VERSION,
  PLAYER_SKILL_PATTERN_AXES,
  SKILL_RATING_SKILLSETS,
  danSkillsetBucketIds,
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

/**
 * The dan board's "no particular skill" column: every clear the side credited,
 * which is the estimate a profile chip shows. Skillset columns narrow it to the
 * clears of one dan-evidence bucket (4K rice names jack/tech/speed/stamina, 6K
 * and 7K rice jack/tech/speed/stream, 7K LN its four subtypes), so picking one
 * answers "who is the best jack player at their dan level" rather than
 * re-sorting the same estimate.
 */
export const DAN_LEADERBOARD_DEFAULT_SKILLSET = "overall";

export function danLeaderboardSkillsetsFor(keyCount: number, side: DanSide): string[] {
  return [DAN_LEADERBOARD_DEFAULT_SKILLSET, ...danSkillsetBucketIds(keyCount, side)];
}

export function isDanLeaderboardSkillset(keyCount: number, side: DanSide, skillset: string): boolean {
  return danLeaderboardSkillsetsFor(keyCount, side).includes(skillset);
}

/** The dan column key a (side, skillset) pair reads. */
function danColumnKey(side: DanSide, skillset: string): string {
  return `${side}:${skillset}`;
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
  /* How full the averaging window behind this dan is (player-skills'
     clearWindow): `have` of the `need` clears a complete estimate averages
     over, plus, on a side headline, how many of its skills have their whole
     window. Absent on a row whose stored verdict predates it and on a headline
     a course clear set, where there is no window to fill. */
  clearWindow?: { have: number; need: number; skills?: { full: number; total: number } };
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
  // Rows at the current analysis version out of all ready rows. A version bump
  // recomputes players one at a time, so a half-migrated board is visible here
  // instead of quietly wrong.
  coverage: { current: number; total: number };
}

export interface SkillLeaderboardSnapshot extends LeaderboardSnapshotBase {
  axis: string;
  ranking: SkillLeaderboardEntry[];
  axes: SkillLeaderboardAxisInfo[];
  /* False when THIS axis has no population median and the board is therefore
     ranking raw ratings, which would disagree with the profile page. Per axis
     and not per board on purpose: a board-wide flag answers off whichever
     curves happen to exist, so a sparse axis served raw would still claim to
     be shrunk. Dan boards carry no such flag - a dan is not shrunk at all. */
  shrunk: boolean;
}

export interface DanLeaderboardSnapshot extends LeaderboardSnapshotBase {
  side: DanSide;
  // The served skillset column: DAN_LEADERBOARD_DEFAULT_SKILLSET, or a
  // dan-evidence bucket id. Rows carry that column's dan, not the side's.
  skillset: string;
  ranking: DanLeaderboardEntry[];
  sides: Array<{ side: DanSide; players: number }>;
  /* Columns with a population in this scope, in publication order, so the
     frontend renders the list the keymode/side actually has instead of keeping
     its own copy (same contract as `axes` on the skill board). */
  skillsets: Array<{ skillset: string; players: number }>;
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
  /* The averaging window's fill, dense over the same slots. All four fit a
     byte: a window is 20 clears and a headline sums at most four of them.
     Zero in `need` means the stored verdict carried none, and zero in
     `windowSkills` means it counted one pool rather than skills. */
  windowHave: Uint8Array;
  windowNeed: Uint8Array;
  windowFull: Uint8Array;
  windowSkills: Uint8Array;
  order: Int32Array;
}

interface KeymodeBoard {
  keyCount: number;
  users: SkillLeaderboardUser[];
  countries: string[];
  analyzedPlays: Int32Array;
  axes: Map<string, AxisColumn>;
  // Keyed by danColumnKey: one column per (side, skillset) pair a player has.
  dan: Map<string, DanColumn>;
}

interface SkillBoardCache {
  keymodes: Map<number, KeymodeBoard>;
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
/* A rebuild that threw must not leave the board due again on the very next
   request: without a cooldown every read arriving after the TTL would start
   its own full scan, so a database incident turns into a scan storm on top of
   it. Shorter than the TTL because a failure is worth retrying sooner than a
   healthy board is worth refreshing. */
const SKILL_BOARD_RETRY_MS = 60 * 1000;

interface SkillBoardMemory {
  board: SkillBoardCache;
  // When this board stops answering without a rebuild attempt: builtAt + TTL
  // normally, builtAt + the shorter retry window after a failed rebuild.
  freshUntil: number;
}

const boardCacheByDb = new WeakMap<Db, SkillBoardMemory>();
const boardBuildByDb = new WeakMap<Db, Promise<SkillBoardCache>>();
// A cold-start failure has no stale board to fall back on, so the error itself
// is held for the retry window and re-thrown: otherwise every request during
// an outage kicks off another doomed scan.
const boardFailureByDb = new WeakMap<Db, { error: unknown; until: number }>();
// Builds since process start. Ops signal, and the seam the cooldown test reads
// to prove a second scan did not happen.
let boardBuilds = 0;

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
  windowHave: number[];
  windowNeed: number[];
  windowFull: number[];
  windowSkills: number[];
}

interface DraftKeymode {
  keyCount: number;
  users: SkillLeaderboardUser[];
  countries: string[];
  analyzedPlays: number[];
  axes: Map<string, DraftAxis>;
  dan: Map<string, DraftDan>;
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
  boardBuilds += 1;
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
    /* Each user's newest ready row, not just the current version: after a
       PLAYER_SKILLS_VERSION bump the board would otherwise blank to the
       handful of already-recomputed players while the roster drip walks
       everyone else. The superseded row serves until the compute job's ready
       write replaces-then-deletes it, so the board upgrades player by player.
       The correlated subquery rides the (user_id, analysis_version) primary
       key; it also keeps one row per user, which the cursor paging needs. */
    const rows = (await exec(
      db,
      `select r.user_id, r.modes_json, u.username, u.avatar_url, u.country_code, u.global_rank
         from player_skill_ratings r
        join users u on u.user_id = r.user_id
        where r.status = 'ready' and r.modes_json is not null
          and r.analysis_version = (
            select max(r2.analysis_version) from player_skill_ratings r2
             where r2.user_id = r.user_id and r2.status = 'ready' and r2.modes_json is not null)
          and u.is_active != 0
          and r.user_id > ?
        order by r.user_id
        limit ?`,
      [cursor, BOARD_BUILD_CHUNK],
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

        const pushDan = (
          key: string,
          verdict: {
            rawDan?: unknown;
            label?: unknown;
            beyondTable?: unknown;
            clearWindow?: { have?: unknown; need?: unknown; skills?: { full?: unknown; total?: unknown } | null } | null;
          },
        ) => {
          const rawDan = Number(verdict?.rawDan);
          if (!(rawDan > 0)) return;
          let column = draft.dan.get(key);
          if (!column) {
            draft.dan.set(key, (column = { raw: [], labels: [], beyond: [], windowHave: [], windowNeed: [], windowFull: [], windowSkills: [] }));
          }
          padTo(column.raw, slot, 0);
          padLabels(column.labels, slot);
          padTo(column.beyond, slot, 0);
          padTo(column.windowHave, slot, 0);
          padTo(column.windowNeed, slot, 0);
          padTo(column.windowFull, slot, 0);
          padTo(column.windowSkills, slot, 0);
          column.raw.push(rawDan);
          column.labels.push(String(verdict.label ?? ""));
          column.beyond.push(verdict.beyondTable === true ? 1 : 0);
          const need = Math.max(0, Math.min(255, Math.floor(Number(verdict.clearWindow?.need) || 0)));
          const skills = need > 0 ? Math.max(0, Math.min(255, Math.floor(Number(verdict.clearWindow?.skills?.total) || 0))) : 0;
          column.windowHave.push(need > 0 ? Math.max(0, Math.min(need, Math.floor(Number(verdict.clearWindow?.have) || 0))) : 0);
          column.windowNeed.push(need);
          column.windowFull.push(skills > 0 ? Math.max(0, Math.min(skills, Math.floor(Number(verdict.clearWindow?.skills?.full) || 0))) : 0);
          column.windowSkills.push(skills);
        };
        for (const side of ["rc", "ln"] as const) {
          const dan = mode?.dan?.[side];
          if (!dan || !(Number(dan.rawDan) > 0)) continue;
          pushDan(danColumnKey(side, DAN_LEADERBOARD_DEFAULT_SKILLSET), dan);
          // Absent on rows written before the skillset verdicts shipped; the
          // dan sweep backfills them, and until it does those players are
          // simply not on a skillset column.
          for (const bucket of danSkillsetBucketIds(keyCount, side)) {
            const verdict = dan.skillsets?.[bucket];
            if (verdict) pushDan(danColumnKey(side, bucket), verdict);
          }
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
    const dan = new Map<string, DanColumn>();
    for (const [key, column] of draft.dan) {
      padTo(column.raw, size, 0);
      padLabels(column.labels, size);
      padTo(column.beyond, size, 0);
      padTo(column.windowHave, size, 0);
      padTo(column.windowNeed, size, 0);
      padTo(column.windowFull, size, 0);
      padTo(column.windowSkills, size, 0);
      dan.set(key, {
        raw: Float32Array.from(column.raw),
        labels: column.labels,
        beyond: Uint8Array.from(column.beyond),
        windowHave: Uint8Array.from(column.windowHave),
        windowNeed: Uint8Array.from(column.windowNeed),
        windowFull: Uint8Array.from(column.windowFull),
        windowSkills: Uint8Array.from(column.windowSkills),
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
    shrunk: curves != null,
  });
  return board;
}

async function refreshSkillBoard(db: Db): Promise<SkillBoardCache> {
  try {
    const built = await buildSkillBoard(db);
    boardCacheByDb.set(db, { board: built, freshUntil: Date.now() + SKILL_BOARD_CACHE_TTL_MS });
    boardFailureByDb.delete(db);
    scopeViewCacheByDb.delete(db);
    return built;
  } catch (error) {
    // Keep serving the previous board through a failed rebuild; only the very
    // first load has nothing to fall back to. Either way the next attempt is
    // pushed out by the retry window instead of firing on the next request.
    logWarn("skill_leaderboard_rebuild_failed", errorContext(error));
    const stale = boardCacheByDb.get(db);
    if (stale) {
      stale.freshUntil = Date.now() + SKILL_BOARD_RETRY_MS;
      return stale.board;
    }
    boardFailureByDb.set(db, { error, until: Date.now() + SKILL_BOARD_RETRY_MS });
    throw error;
  }
}

async function getSkillBoard(db: Db): Promise<SkillBoardCache> {
  const memory = boardCacheByDb.get(db);
  if (memory && Date.now() < memory.freshUntil) return memory.board;
  if (!memory) {
    const failure = boardFailureByDb.get(db);
    if (failure && Date.now() < failure.until) throw failure.error;
  }

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

/* The board is a ~15k-player scan that costs seconds, and getSkillBoard has
   nothing to serve until the first one finishes, so without this the first
   visitor after a restart waits it out inside their request (measured at 4.3s
   on prod). Build it shortly after boot instead, on the same terms as the
   global farmed board: settle the boot burst, stay off a deploy's schema
   migration, and never hold the process open. A failure here is the same
   failure the first request would have hit, and leaves the retry cooldown
   exactly where refreshSkillBoard puts it. */
export function warmSkillLeaderboardBoard(db: Db): void {
  void (async () => {
    await unrefDelay(BOARD_WARMUP_DELAY_MS);
    await waitForQuietSchema(db, "skill_leaderboard");
    await getSkillBoard(db);
  })().catch((error) => logWarn("skill_leaderboard_warmup_failed", errorContext(error)));
}

/** Test seam: drop the cached board so a seeded DB rebuilds on the next read. */
export function resetSkillLeaderboardCache(db: Db): void {
  boardCacheByDb.delete(db);
  boardBuildByDb.delete(db);
  boardFailureByDb.delete(db);
  scopeViewCacheByDb.delete(db);
}

/** Test seam: age the cached board out without discarding it. */
export function expireSkillLeaderboardBoard(db: Db): void {
  const memory = boardCacheByDb.get(db);
  if (memory) memory.freshUntil = 0;
}

/** Builds since process start; a test reads it to assert a scan did not run. */
export function skillLeaderboardBuildCount(): number {
  return boardBuilds;
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
  skillset?: string;
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
  const axisCurves: AxisCurveMap | undefined = board.curves?.curves[String(query.keyCount)];

  const base: SkillLeaderboardSnapshot = {
    axis: query.axis,
    ranking: [],
    axes,
    total: 0,
    page,
    pageSize,
    keyCount: query.keyCount,
    fetchedAt: board.builtAt,
    // The same curveMedian call the build made, so the flag and the values it
    // describes cannot part ways.
    shrunk: board.curves != null && curveMedian(axisCurves, query.axis) != null,
    coverage: board.coverage,
  };
  const column = keymode?.axes.get(query.axis);
  if (!keymode || !column) return base;

  const order = scopedOrder(db, board, keymode, `${scope.code}:${keymode.keyCount}:${query.axis}`, column.order, codes);
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
  const skillset = query.skillset && isDanLeaderboardSkillset(query.keyCount, query.side, query.skillset)
    ? query.skillset
    : DAN_LEADERBOARD_DEFAULT_SKILLSET;

  // One helper for both published lists and the served column, so a population
  // count and the board it describes can never come off different orders.
  const danOrder = (side: DanSide, column: string): Int32Array | null => {
    if (!keymode) return null;
    const key = danColumnKey(side, column);
    const stored = keymode.dan.get(key);
    if (!stored) return null;
    return scopedOrder(db, board, keymode, `${scope.code}:${keymode.keyCount}:dan:${key}`, stored.order, codes);
  };

  const sides: Array<{ side: DanSide; players: number }> = [];
  const skillsets: Array<{ skillset: string; players: number }> = [];
  if (keymode) {
    for (const side of ["rc", "ln"] as const) {
      // The side toggle counts the side's own board, not the selected
      // skillset's: it says which sides exist, and flipping to one lands on a
      // column the picker then narrows.
      const order = danOrder(side, DAN_LEADERBOARD_DEFAULT_SKILLSET);
      if (order && order.length > 0) sides.push({ side, players: order.length });
    }
    for (const column of danLeaderboardSkillsetsFor(query.keyCount, query.side)) {
      const order = danOrder(query.side, column);
      if (order && order.length > 0) skillsets.push({ skillset: column, players: order.length });
    }
  }

  const base: DanLeaderboardSnapshot = {
    side: query.side,
    skillset,
    ranking: [],
    sides,
    skillsets,
    total: 0,
    page,
    pageSize,
    keyCount: query.keyCount,
    fetchedAt: board.builtAt,
    coverage: board.coverage,
  };
  const column = keymode?.dan.get(danColumnKey(query.side, skillset));
  const order = danOrder(query.side, skillset);
  if (!keymode || !column || !order) return base;

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
    if (column.windowNeed[slot] > 0) {
      entry.clearWindow = {
        have: column.windowHave[slot],
        need: column.windowNeed[slot],
        ...(column.windowSkills[slot] > 0
          ? { skills: { full: column.windowFull[slot], total: column.windowSkills[slot] } }
          : {}),
      };
    }
    ranking.push(entry);
  }

  return { ...base, ranking, total: order.length };
}
