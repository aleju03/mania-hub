import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import { computeMsd, isMsdSupportedKeyCount } from "../dan/msd.js";
import type { JobQueue } from "../jobs/queue.js";
import { readConfig } from "../config.js";
import { CHART_ANALYSIS_VERSION, enqueueMissingChartAnalyses } from "./chart-analysis.js";
import { getCachedBeatmapFile, readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";
import type { OsuApiClient } from "../osu/client.js";
import { fetchAndStoreProfileSnapshotShared, getCachedPlayerProfileSnapshot } from "./player-profiles.js";
import { getScoreIdentity, nowIso } from "../shared/score.js";
import type { OscScore, OsuMod, OsuScoreStatistics } from "../shared/types.js";

// Etterna-style player skill ratings from the player's osu! top plays: each
// play gets MinaCalc SSRs (the MSD skillsets computed at the play's music rate
// with the play's accuracy as the score goal), aggregated per keymode with
// Etterna's erfc rating aggregation. Replaces the old activity-vector
// "playstyle fingerprint" as the my-stats skill surface.
//
// MinaCalc's skillset taxonomy is 4K-born, so each keymode additionally gets
// per-pattern ratings in our own vocabulary: the play's Overall SSRs
// aggregated over the chart-analysis pattern tags of the charts they were set
// on ("your rating on chordstream charts"). The 4K card shows the native MSD
// skillsets; 6K/7K show these pattern ratings instead.
//
// Rates come from ranked rate mods only: DT/NC is 1.5x, HT/DC is 0.75x. Custom
// speed_change values are unranked (no pp), so a top play can never carry one;
// if one shows up anyway it is skipped rather than mis-rated.
//
// The score goal is an estimated Wife3 percent from the play's judgement
// counts, not raw osu! accuracy: osu! accuracy weighs MAX and 300 identically,
// so nearly every top play sits at 97%+ and would saturate MinaCalc's 0.965
// goal cap. The Wife estimate spreads that band back out (MAX:300 ratio is
// the signal), and goals that still land above the cap get their SSRs
// log-linearly extrapolated from the calc's own 0.93 -> 0.965 slope.

export const PLAYER_SKILLS_VERSION = 3;
export const PLAYER_SKILLS_JOB = "compute_player_skills";

export const SKILL_RATING_SKILLSETS = [
  "Overall",
  "Stream",
  "Jumpstream",
  "Handstream",
  "Stamina",
  "JackSpeed",
  "Chordjack",
  "Technical",
] as const;

const READY_RECOMPUTE_TTL_MS = 12 * 60 * 60_000;
const PENDING_RETRY_TTL_MS = 30 * 60_000;
const RUNNING_REQUEUE_MS = 10 * 60_000;
const FAILED_RETRY_MS = 10 * 60_000;
// A pattern rating from one or two plays is an anecdote, not a rating.
const PATTERN_RATING_MIN_PLAYS = 3;
// Chart analysis stores every detected pattern down to trace hits, so common
// tags (ln, tech) land on nearly every chart and would aggregate to a copy of
// Overall. A chart only counts toward a pattern it is meaningfully made of.
const PATTERN_TAG_MIN_SCORE = 0.5;
const SSR_GOAL_MIN = 0.8;
// The calc clamps goals above 0.965 internally (Etterna's SSR cap); goals
// above it are served by extrapolating from the calc's slope between the MSD
// baseline goal and the cap.
const SSR_CALC_GOAL_CAP = 0.965;
const SSR_EXTRAPOLATION_BASE_GOAL = 0.93;
// Ceiling for Wife-estimated goals: an all-MAX play estimates ~0.998, and the
// log-linear extrapolation should not be trusted much further past the cap
// than the width of the slope window it was measured on.
const SSR_GOAL_CAP = 0.9975;
// Safety bound on the per-chart 0.93->0.965 slope used for extrapolation
// (measured ~1.07-1.11 on real charts).
const SSR_EXTRAPOLATION_MAX_SLOPE = 1.2;
// Expected normalized Wife3 points per osu!mania judgement: Etterna's wife3
// curve (J4: full points inside 5ms, erf falloff with dev 22.7 crossing zero
// at 65ms, linear to the -2.75 miss weight at 180ms, all normalized to
// marvelous = 1) averaged uniformly over each stable OD8 hit window (MAX
// +-16.5ms, 300 +-40, 200 +-73, 100 +-103, 50 +-127). The MAX vs 300 split is
// the load-bearing part: osu! accuracy scores both as 100%, Wife3 does not,
// which is what lets two 99%+ plays with different MAX:300 ratios rate
// differently.
const EXPECTED_WIFE3_POINTS = {
  perfect: 0.9994,
  great: 0.9654,
  good: 0.3713,
  ok: -0.55,
  meh: -1.1957,
  miss: -2.75,
} as const;
// Etterna's rating_scaler from ScoreManager::CalcPlayerRating.
const AGGREGATE_RATING_SCALER = 1.04;

export interface PlayerSkillPatternRating {
  id: string;
  rating: number;
  plays: number;
}

export interface PlayerSkillModeBreakdown {
  keyCount: number;
  analyzedPlays: number;
  ratings: Record<string, number>;
  patterns: PlayerSkillPatternRating[];
}

export interface PlayerSkillBreakdown {
  status: "pending" | "ready" | "failed";
  version: number;
  computedAt: string | null;
  totalPlays: number;
  analyzedPlays: number;
  pendingPlays: number;
  unsupportedPlays: number;
  modes: PlayerSkillModeBreakdown[];
}

interface StoredPlaySsr {
  identity: string;
  beatmapId: number;
  keyCount: number;
  rate: number;
  goal: number;
  pp: number;
  values: Record<string, number>;
  // Chart-analysis pattern tags for the play's chart. Refreshed from the DB on
  // every compute (analysis rows land after plays do), never part of the SSR
  // reuse key.
  patterns: string[];
}

interface StoredModesSummary {
  totalPlays: number;
  analyzedPlays: number;
  pendingPlays: number;
  unsupportedPlays: number;
  modes: PlayerSkillModeBreakdown[];
}

/**
 * The music rate a ranked play was set at, or null when the play cannot be
 * rated honestly (custom speed_change, wind up/down style variable rates).
 */
export function getRankedPlayRate(mods: OsuMod[] | string[] | undefined): number | null {
  let rate = 1;
  for (const mod of mods ?? []) {
    const acronym = typeof mod === "string" ? mod : String(mod?.acronym ?? "");
    if (acronym === "DT" || acronym === "NC") {
      if (hasCustomSpeed(mod, 1.5)) return null;
      rate *= 1.5;
    } else if (acronym === "HT" || acronym === "DC") {
      if (hasCustomSpeed(mod, 0.75)) return null;
      rate *= 0.75;
    } else if (acronym === "WU" || acronym === "WD" || acronym === "AS") {
      return null;
    }
  }
  return Math.round(rate * 100) / 100;
}

function hasCustomSpeed(mod: OsuMod | string, defaultSpeed: number): boolean {
  if (typeof mod === "string") return false;
  const speed = Number(mod.settings?.speed_change ?? defaultSpeed);
  return Number.isFinite(speed) && Math.abs(speed - defaultSpeed) > 1e-3;
}

export function ssrGoalForAccuracy(accuracy: number): number {
  const acc = Number.isFinite(accuracy) ? accuracy : 0.93;
  return Math.round(Math.max(SSR_GOAL_MIN, Math.min(SSR_CALC_GOAL_CAP, acc)) * 10_000) / 10_000;
}

/**
 * Estimated Wife3 percent from a play's judgement counts (lazer or stable
 * naming), or null when the score carries no counts.
 */
export function estimateWifeAccuracy(statistics: OsuScoreStatistics | undefined): number | null {
  if (!statistics) return null;
  const counts: Record<keyof typeof EXPECTED_WIFE3_POINTS, number> = {
    perfect: readCount(statistics.perfect ?? statistics.count_geki),
    great: readCount(statistics.great ?? statistics.count_300),
    good: readCount(statistics.good ?? statistics.count_katu),
    ok: readCount(statistics.ok ?? statistics.count_100),
    meh: readCount(statistics.meh ?? statistics.count_50),
    miss: readCount(statistics.miss ?? statistics.count_miss),
  };
  let total = 0;
  let points = 0;
  for (const [name, count] of Object.entries(counts) as Array<[keyof typeof EXPECTED_WIFE3_POINTS, number]>) {
    total += count;
    points += count * EXPECTED_WIFE3_POINTS[name];
  }
  return total > 0 ? points / total : null;
}

function readCount(value: number | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * The SSR goal for a play: the Wife3 estimate when judgement counts exist,
 * raw accuracy otherwise. Only the judgement path may exceed the calc's
 * 0.965 cap; without a MAX:300 breakdown there is no evidence to
 * differentiate high-accuracy plays on.
 */
export function ssrGoalForScore(score: Pick<OscScore, "accuracy" | "statistics">): number {
  const wife = estimateWifeAccuracy(score.statistics);
  if (wife == null) return ssrGoalForAccuracy(score.accuracy);
  return Math.round(Math.max(SSR_GOAL_MIN, Math.min(SSR_GOAL_CAP, wife)) * 10_000) / 10_000;
}

// Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7, plenty for the aggregation)
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/**
 * Etterna's ScoreManager::AggregateSSRs: binary-search the rating whose
 * erfc-weighted sum of SSR overages matches the exponential target, so one
 * outlier score cannot set the rating but a deep stack of similar SSRs pushes
 * it toward them.
 */
export function aggregateSsrs(values: number[]): number {
  const ssrs = values.filter((value) => Number.isFinite(value) && value > 0);
  if (ssrs.length === 0) return 0;
  let rating = 0;
  let res = 10.24;
  for (let iter = 1; iter <= 11; iter += 1) {
    let sum: number;
    do {
      rating += res;
      sum = 0;
      for (const ssr of ssrs) sum += Math.max(0, 2 / (1 - erf(0.1 * (ssr - rating))) - 2);
    } while (Math.pow(2, rating * 0.1) < sum);
    if (iter === 11) break;
    rating -= res;
    res /= 2;
  }
  return Math.round(rating * AGGREGATE_RATING_SCALER * 100) / 100;
}

/**
 * SSRs for a play at `goal`, running the calc once for goals it can serve
 * directly and extending past its 0.965 cap by extrapolating each skillset
 * along the chart's own 0.93 -> 0.965 log-slope. Returns the values plus how
 * many calc runs it took (for event-loop breathing).
 */
async function computePlaySsrValues(
  osuText: string,
  options: { rate: number; keyCount: number; goal: number },
): Promise<{ values: Record<string, number>; calcRuns: number } | null> {
  const { rate, keyCount, goal } = options;
  const capped = await computeMsd(osuText, { rate, keyCount, scoreGoal: Math.min(goal, SSR_CALC_GOAL_CAP) }).catch(() => null);
  if (!capped) return null;
  if (goal <= SSR_CALC_GOAL_CAP) return { values: capped.values, calcRuns: 1 };
  const base = await computeMsd(osuText, { rate, keyCount, scoreGoal: SSR_EXTRAPOLATION_BASE_GOAL }).catch(() => null);
  if (!base) return { values: capped.values, calcRuns: 1 };
  const exponent = (goal - SSR_CALC_GOAL_CAP) / (SSR_CALC_GOAL_CAP - SSR_EXTRAPOLATION_BASE_GOAL);
  const values: Record<string, number> = {};
  for (const [name, atCap] of Object.entries(capped.values)) {
    const atBase = Number(base.values[name] ?? 0);
    if (!(atCap > 0) || !(atBase > 0) || atCap <= atBase) {
      values[name] = atCap;
      continue;
    }
    const slope = Math.min(atCap / atBase, SSR_EXTRAPOLATION_MAX_SLOPE);
    values[name] = atCap * Math.pow(slope, exponent);
  }
  return { values, calcRuns: 2 };
}

function aggregateModeRatings(plays: StoredPlaySsr[]): Record<string, number> {
  const ratings: Record<string, number> = {};
  for (const name of SKILL_RATING_SKILLSETS) {
    ratings[name] = aggregateSsrs(plays.map((play) => Number(play.values[name] ?? 0)));
  }
  return ratings;
}

// "Your rating on chordstream charts": the Overall SSRs of the plays whose
// charts carry a pattern tag, aggregated per tag. This is the keymode-honest
// axis set for 6K/7K, where MinaCalc's 4K-born skillset names mislead.
function aggregateModePatternRatings(plays: StoredPlaySsr[]): PlayerSkillPatternRating[] {
  const playsByPattern = new Map<string, StoredPlaySsr[]>();
  for (const play of plays) {
    for (const pattern of play.patterns) {
      const list = playsByPattern.get(pattern);
      if (list) list.push(play);
      else playsByPattern.set(pattern, [play]);
    }
  }
  return [...playsByPattern.entries()]
    .filter(([, list]) => list.length >= PATTERN_RATING_MIN_PLAYS)
    .map(([id, list]) => ({
      id,
      rating: aggregateSsrs(list.map((play) => Number(play.values.Overall ?? 0))),
      plays: list.length,
    }))
    .filter((entry) => entry.rating > 0)
    .sort((a, b) => b.rating - a.rating);
}

async function loadChartPatternTags(db: Db, beatmapIds: number[]): Promise<Map<number, string[]>> {
  const ids = [...new Set(beatmapIds)].filter((id) => Number.isInteger(id) && id > 0);
  const tags = new Map<number, string[]>();
  if (ids.length === 0) return tags;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select beatmap_id, classification_json from beatmap_chart_analysis
     where analysis_version = ? and status = 'ready' and beatmap_id in (${placeholders})`,
    [CHART_ANALYSIS_VERSION, ...ids],
  )).rows;
  for (const row of rows) {
    const parsed = parseJson<{ patterns?: Array<{ id?: unknown; score?: unknown }> } | null>(String(row.classification_json ?? ""), null);
    const patternIds = Array.isArray(parsed?.patterns)
      ? [...new Set(parsed.patterns
          .filter((hit) => Number(hit?.score ?? 0) >= PATTERN_TAG_MIN_SCORE)
          .map((hit) => String(hit?.id ?? ""))
          .filter(Boolean))]
      : [];
    tags.set(Number(row.beatmap_id), patternIds);
  }
  return tags;
}

function parseOsuKeyCount(osuText: string): number | null {
  const match = osuText.match(/^CircleSize\s*:\s*(\d+(?:\.\d+)?)/m);
  if (!match) return null;
  const keyCount = Math.round(Number(match[1]));
  return Number.isInteger(keyCount) && keyCount > 0 ? keyCount : null;
}

/**
 * Analyze one player's ranked top plays into per-keymode skillset ratings.
 * `previousPlays` is the last run's per-play SSR cache; unchanged plays reuse
 * their SSRs so steady-state recomputes only run the calc for new plays.
 */
export async function computePlayerSkillRatings(
  db: Db,
  osu: Pick<OsuApiClient, "getBeatmapFile">,
  scores: OscScore[],
  previousPlays: StoredPlaySsr[],
): Promise<{ summary: StoredModesSummary; plays: StoredPlaySsr[]; untaggedBeatmapIds: number[] }> {
  const plays = scores.filter((score) => typeof score.pp === "number" && score.pp > 0);
  const previousByIdentity = new Map(previousPlays.map((play) => [play.identity, play]));
  const analyzed: StoredPlaySsr[] = [];
  let pendingPlays = 0;
  let unsupportedPlays = 0;
  let calcRuns = 0;

  for (const score of plays) {
    const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id ?? 0);
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
      unsupportedPlays += 1;
      continue;
    }
    const rate = getRankedPlayRate(score.mods);
    if (rate == null) {
      unsupportedPlays += 1;
      continue;
    }
    const goal = ssrGoalForScore(score);
    const identity = getScoreIdentity(score);
    const previous = previousByIdentity.get(identity);
    if (previous && previous.beatmapId === beatmapId && previous.rate === rate && previous.goal === goal) {
      analyzed.push({ ...previous, pp: score.pp ?? previous.pp });
      continue;
    }

    const osuText = await loadOsuText(db, osu, beatmapId);
    if (osuText == null) {
      pendingPlays += 1;
      continue;
    }
    // Converts serve the std .osu under the mania beatmap id; the calc would
    // misread x positions as columns, so anything that is not Mode 3 is out.
    if (!/^Mode\s*:\s*3\s*$/m.test(osuText)) {
      unsupportedPlays += 1;
      continue;
    }
    const keyCount = parseOsuKeyCount(osuText);
    if (keyCount == null || !isMsdSupportedKeyCount(keyCount)) {
      unsupportedPlays += 1;
      continue;
    }
    const ssr = await computePlaySsrValues(osuText, { rate, keyCount, goal });
    if (!ssr) {
      unsupportedPlays += 1;
      continue;
    }
    analyzed.push({ identity, beatmapId, keyCount, rate, goal, pp: score.pp ?? 0, values: ssr.values, patterns: [] });
    // Each calc run is a short synchronous wasm burst; breathe between bursts
    // so a 200-play first run does not starve the event loop.
    calcRuns += ssr.calcRuns;
    if (calcRuns >= 5) {
      calcRuns = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Tag lookup runs fresh every compute (never from the SSR cache): analysis
  // rows keep landing after the plays that referenced them.
  const tagsByBeatmap = await loadChartPatternTags(db, analyzed.map((play) => play.beatmapId));
  const untaggedBeatmapIds: number[] = [];
  for (const play of analyzed) {
    const tags = tagsByBeatmap.get(play.beatmapId);
    play.patterns = tags ?? [];
    if (!tags) untaggedBeatmapIds.push(play.beatmapId);
  }

  const byKeyCount = new Map<number, StoredPlaySsr[]>();
  for (const play of analyzed) {
    const list = byKeyCount.get(play.keyCount);
    if (list) list.push(play);
    else byKeyCount.set(play.keyCount, [play]);
  }
  const modes: PlayerSkillModeBreakdown[] = [...byKeyCount.entries()]
    .map(([keyCount, list]) => ({
      keyCount,
      analyzedPlays: list.length,
      ratings: aggregateModeRatings(list),
      patterns: aggregateModePatternRatings(list),
    }))
    .sort((a, b) => b.analyzedPlays - a.analyzedPlays);

  return {
    summary: {
      totalPlays: plays.length,
      analyzedPlays: analyzed.length,
      pendingPlays,
      unsupportedPlays,
      modes,
    },
    plays: analyzed,
    untaggedBeatmapIds: [...new Set(untaggedBeatmapIds)],
  };
}

async function loadOsuText(db: Db, osu: Pick<OsuApiClient, "getBeatmapFile">, beatmapId: number): Promise<string | null> {
  try {
    // Cache-first with a network fallback that honors the API-jobs switch,
    // same policy as chart analysis (dev boxes analyze cached charts only).
    return readConfig().enableOsuApiJobs
      ? await getCachedBeatmapFile(db, osu, beatmapId, `job:${PLAYER_SKILLS_JOB}`)
      : await readCachedBeatmapFile(db, beatmapId);
  } catch {
    return null;
  }
}

type ProfileOsuClient = Pick<OsuApiClient, "getBeatmapFile" | "getUserByKey" | "getUserBestScoresWindow">;

export async function computePlayerSkillsJob(db: Db, osu: ProfileOsuClient, queue: JobQueue, payload: { userId: number }): Promise<void> {
  const userId = Math.floor(Number(payload?.userId));
  if (!Number.isInteger(userId) || userId <= 0) return;

  await exec(
    db,
    `insert into player_skill_ratings (user_id, analysis_version, status, updated_at)
     values (?, ?, 'running', ?)
     on conflict(user_id, analysis_version) do update set
       status = 'running',
       error = null,
       updated_at = excluded.updated_at`,
    [userId, PLAYER_SKILLS_VERSION, nowIso()],
  );

  try {
    const snapshot = await loadTopPlaysSnapshot(db, osu, userId);
    if (!snapshot) throw new Error("No stored top plays and osu API jobs are disabled");

    const previousRow = (await exec(
      db,
      "select plays_json from player_skill_ratings where user_id = ? and analysis_version = ?",
      [userId, PLAYER_SKILLS_VERSION],
    )).rows[0];
    const previousPlays = parseJson<{ plays?: StoredPlaySsr[] }>(String(previousRow?.plays_json ?? ""), {}).plays ?? [];

    const result = await computePlayerSkillRatings(db, osu, snapshot.bestScores, previousPlays);
    const computedAt = nowIso();
    await exec(
      db,
      `update player_skill_ratings
       set status = 'ready', modes_json = ?, plays_json = ?, source_fetched_at = ?, error = null, computed_at = ?, updated_at = ?
       where user_id = ? and analysis_version = ?`,
      [
        json(result.summary),
        json({ version: PLAYER_SKILLS_VERSION, plays: result.plays }),
        snapshot.fetchedAt,
        computedAt,
        computedAt,
        userId,
        PLAYER_SKILLS_VERSION,
      ],
    );
    // Superseded-version rows are dead weight once the new one is ready.
    await exec(db, "delete from player_skill_ratings where user_id = ? and analysis_version != ?", [userId, PLAYER_SKILLS_VERSION]);
    // Charts with no analysis row yet contribute no pattern tags; queue them so
    // the next recompute (12h TTL) picks their tags up.
    await enqueueMissingChartAnalyses(db, queue, result.untaggedBeatmapIds).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await exec(
      db,
      `update player_skill_ratings
       set status = 'failed', error = ?, updated_at = ?
       where user_id = ? and analysis_version = ?`,
      [message.slice(0, 500), nowIso(), userId, PLAYER_SKILLS_VERSION],
    );
    throw error;
  }
}

async function loadTopPlaysSnapshot(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  userId: number,
): Promise<{ bestScores: OscScore[]; fetchedAt: string } | null> {
  const key = String(userId);
  let snapshot = await getCachedPlayerProfileSnapshot(db, key);
  if ((!snapshot || snapshot.bestScores.length === 0) && readConfig().enableOsuApiJobs) {
    await fetchAndStoreProfileSnapshotShared(db, osu, key, "userId");
    snapshot = await getCachedPlayerProfileSnapshot(db, key);
  }
  if (!snapshot) return null;
  return { bestScores: snapshot.bestScores, fetchedAt: snapshot.fetchedAt };
}

export async function enqueuePlayerSkills(queue: JobQueue, userId: number): Promise<void> {
  await queue.enqueue(
    PLAYER_SKILLS_JOB,
    `player-skills:${PLAYER_SKILLS_VERSION}:${userId}`,
    { userId },
    { priority: 50, replaceDone: true },
  );
}

/**
 * Read a player's stored skill breakdown, enqueueing a (re)compute when the
 * row is missing, stale, or superseded by newer top-play events. Ready rows
 * keep serving their data while a refresh runs.
 */
export async function getPlayerSkillBreakdown(db: Db, queue: JobQueue, userId: number): Promise<PlayerSkillBreakdown> {
  const row = (await exec(
    db,
    `select status, modes_json, computed_at, updated_at from player_skill_ratings
     where user_id = ? and analysis_version = ?`,
    [userId, PLAYER_SKILLS_VERSION],
  )).rows[0];

  const now = Date.now();
  const status = row ? String(row.status) : null;
  const updatedAtMs = Date.parse(String(row?.updated_at ?? ""));
  const computedAtMs = Date.parse(String(row?.computed_at ?? ""));
  const summary = parseJson<Partial<StoredModesSummary> | null>(String(row?.modes_json ?? ""), null);

  let shouldEnqueue = false;
  if (!row) {
    shouldEnqueue = true;
  } else if (status === "running") {
    shouldEnqueue = !Number.isFinite(updatedAtMs) || now - updatedAtMs > RUNNING_REQUEUE_MS;
  } else if (status === "failed") {
    shouldEnqueue = !Number.isFinite(updatedAtMs) || now - updatedAtMs > FAILED_RETRY_MS;
  } else if (status === "ready") {
    if (!Number.isFinite(computedAtMs) || now - computedAtMs > READY_RECOMPUTE_TTL_MS) {
      shouldEnqueue = true;
    } else if ((summary?.pendingPlays ?? 0) > 0 && now - computedAtMs > PENDING_RETRY_TTL_MS) {
      shouldEnqueue = true;
    } else if (typeof row.computed_at === "string") {
      const newTopPlays = Number((await exec(
        db,
        "select count(*) as cnt from top_play_events where user_id = ? and detected_at > ?",
        [userId, row.computed_at],
      )).rows[0]?.cnt ?? 0);
      shouldEnqueue = newTopPlays > 0;
    }
  }
  if (shouldEnqueue) await enqueuePlayerSkills(queue, userId);

  if (status === "ready" && summary) {
    return {
      status: "ready",
      version: PLAYER_SKILLS_VERSION,
      computedAt: typeof row?.computed_at === "string" ? row.computed_at : null,
      totalPlays: Math.max(0, Number(summary.totalPlays ?? 0)),
      analyzedPlays: Math.max(0, Number(summary.analyzedPlays ?? 0)),
      pendingPlays: Math.max(0, Number(summary.pendingPlays ?? 0)),
      unsupportedPlays: Math.max(0, Number(summary.unsupportedPlays ?? 0)),
      modes: Array.isArray(summary.modes) ? summary.modes.filter(isValidMode).map(normalizeMode) : [],
    };
  }
  return {
    status: status === "failed" ? "failed" : "pending",
    version: PLAYER_SKILLS_VERSION,
    computedAt: null,
    totalPlays: 0,
    analyzedPlays: 0,
    pendingPlays: 0,
    unsupportedPlays: 0,
    modes: [],
  };
}

function isValidMode(mode: unknown): mode is PlayerSkillModeBreakdown {
  if (mode == null || typeof mode !== "object") return false;
  const candidate = mode as PlayerSkillModeBreakdown;
  return Number.isInteger(candidate.keyCount)
    && Number.isFinite(candidate.analyzedPlays)
    && candidate.ratings != null
    && typeof candidate.ratings === "object";
}

function normalizeMode(mode: PlayerSkillModeBreakdown): PlayerSkillModeBreakdown {
  return { ...mode, patterns: Array.isArray(mode.patterns) ? mode.patterns : [] };
}
