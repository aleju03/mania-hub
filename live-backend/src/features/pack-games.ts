import type { Db } from "../db.js";
import { exec } from "../db.js";
import { unpackJson } from "../shared/compressed-json.js";
import { selectRowsByIntegerSet } from "../shared/score-storage.js";
import { addWalletShards } from "./pack-wallets.js";

// What the arcade pays. Both games hand out shards, and both are capped by the
// same daily allowance rather than by trusting the client.
//
// The cap is the whole security model, deliberately. A streak run is scored in
// the browser off data that is public either way (a script could read the
// rankings and answer every round correctly), and a duel is two accounts who
// could simply agree to trade wins, so no amount of server-side game state
// would make either unfarmable. What does work is making farming pointless: a
// day's play is worth the same allowance whether it was earned or scripted.
//
// Where the allowance sits is set by what the rest of the economy already
// pays, not by how nervous the client-reported scoring makes anyone. A pack
// charge regenerates every 30 seconds and every open pays 2 shards, so idling
// on /packs is worth roughly 240 shards an hour before a single duplicate is
// recycled, and nothing caps that: an account left open all day earns several
// thousand for doing nothing. The arcade is capped, so the cap has to be worth
// sitting down for. A day's allowance is about five hours of idling, which a
// player reaches in one long streak run (eighty-five correct caps it) or a
// couple of dozen duels, and is still a fraction of what the idle loop next
// to it pays over the same day. Farming it is possible and pointless.

export const GAME_SHARD_DAILY_CAP = 1200;

/* Five shards per correct guess, plus a bonus at every fifth in a row that
   grows each time it is hit: 5 at the first milestone, 10 at the second, 15
   at the third. Growing is the point. A flat bonus would pay two runs of five
   exactly what it pays one run of ten, which makes restarting the optimal
   play in a game whose whole appeal is not wanting to stop. Per-guess is
   where the buff lives: one right answer paying a single shard read as an
   insult next to a pack open paying 2 for a click. */
export const STREAK_SHARDS_PER_CORRECT = 5;
export const STREAK_MILESTONE = 5;
export const STREAK_MILESTONE_BONUS = 5;

/* A duel is worth a good streak run: it costs a hand of mints to answer, four
   rounds of decisions to play, and a second human to exist. The loser is paid
   too, because a game that pays nothing for losing is one nobody answers
   twice. */
export const DUEL_WIN_SHARDS = 25;
export const DUEL_TIE_SHARDS = 15;
export const DUEL_LOSS_SHARDS = 8;

export type PackGameSource = "streak" | "duel";

export interface PackGameRewardResult {
  /* What actually landed in the wallet, which is the ask trimmed to whatever
     is left of today's allowance. */
  granted: number;
  /* Shards this account can still earn from games today. */
  remainingToday: number;
  cap: number;
}

export function streakShardReward(streak: number): number {
  if (!Number.isFinite(streak) || streak <= 0) return 0;
  const correct = Math.floor(Math.min(streak, 1000));
  const milestones = Math.floor(correct / STREAK_MILESTONE);
  // 5 + 10 + 15 + ... for every milestone passed.
  const bonus = (STREAK_MILESTONE_BONUS * milestones * (milestones + 1)) / 2;
  return correct * STREAK_SHARDS_PER_CORRECT + bonus;
}

/* What the next milestone is worth, so the board can tell you what you are
   playing for instead of making you work it out from the payout. */
export function nextStreakMilestone(streak: number): { at: number; bonus: number } {
  const passed = Math.floor(Math.max(0, streak) / STREAK_MILESTONE);
  return {
    at: (passed + 1) * STREAK_MILESTONE,
    bonus: STREAK_MILESTONE_BONUS * (passed + 1),
  };
}

/* The allowance day, in UTC. A local-midnight cap would need a timezone per
   account for a feature where the only thing at stake is when the next day's
   shards unlock. */
export function rewardDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function shardsEarnedToday(db: Db, userId: number, day: string): Promise<number> {
  const row = (await exec(
    db,
    "select coalesce(sum(shards), 0) as earned from pack_game_rewards where user_id = ? and day = ?",
    [userId, day],
  )).rows[0];
  return Math.max(0, Number(row?.earned) || 0);
}

export async function getPackGameAllowance(db: Db, userId: number, now = Date.now()): Promise<PackGameRewardResult> {
  const earned = await shardsEarnedToday(db, userId, rewardDay(now));
  return { granted: 0, remainingToday: Math.max(0, GAME_SHARD_DAILY_CAP - earned), cap: GAME_SHARD_DAILY_CAP };
}

/* Pays out what is left of the allowance and writes it to the ledger the cap
   is read from. Nothing is granted for a zero or negative ask, so a losing run
   costs a row rather than earning one. */
export async function grantPackGameShards(
  db: Db,
  userId: number,
  source: PackGameSource,
  amount: number,
  now = Date.now(),
): Promise<PackGameRewardResult> {
  if (!Number.isInteger(userId) || userId <= 0) {
    return { granted: 0, remainingToday: 0, cap: GAME_SHARD_DAILY_CAP };
  }
  const day = rewardDay(now);
  const earned = await shardsEarnedToday(db, userId, day);
  const remaining = Math.max(0, GAME_SHARD_DAILY_CAP - earned);
  const granted = Math.max(0, Math.min(Math.floor(amount), remaining));
  if (granted === 0) return { granted: 0, remainingToday: remaining, cap: GAME_SHARD_DAILY_CAP };

  await exec(
    db,
    `insert into pack_game_rewards (user_id, day, source, shards, updated_at)
     values (?, ?, ?, ?, ?)
     on conflict(user_id, day, source) do update set
       shards = pack_game_rewards.shards + excluded.shards,
       updated_at = excluded.updated_at`,
    [userId, day, source, granted, now],
  );
  await addWalletShards(db, userId, granted, now);
  return { granted, remainingToday: remaining - granted, cap: GAME_SHARD_DAILY_CAP };
}

/* Per-player numbers for the streak game's rotating questions, read entirely
   from projections the backend already keeps (user_top_scores, beatmaps,
   profile_snapshots). Deliberately never an osu! API call and never a queued
   job: the game is free to run, so a round about a player the projections do
   not cover simply is not asked, the same way a metric the snapshot lacks is
   not asked today. Null means "no question", not "go fetch". */

export const STREAK_METRICS_MAX_IDS = 50;

export interface StreakPlayerMetrics {
  userId: number;
  /* Epoch ms of the oldest stored top play. */
  oldestTopAt: number | null;
  /* DT/NC plays among the stored top plays. Zero is an answer, not a gap. */
  dtTop: number | null;
  /* 7K plays among the stored top plays (mania cs = key count). */
  k7Top: number | null;
  /* Whole hours, from the profile's play_time seconds. */
  playTimeHours: number | null;
  /* Epoch ms of the osu! join date. */
  joinedAt: number | null;
  followers: number | null;
  replayViews: number | null;
}

/* These numbers move slowly (a top play entering, a profile refresh), and one
   run re-reads the same fifty players many times over, so a stale-by-hours
   answer is indistinguishable from a fresh one at the board. Six hours keeps
   the pool to a handful of grouped reads a day per serving process. */
const STREAK_METRICS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STREAK_METRICS_CACHE_MAX = 4096;
const streakMetricsCache = new Map<number, { at: number; row: StreakPlayerMetrics }>();

export function clearStreakMetricsCache(): void {
  streakMetricsCache.clear();
}

function emptyStreakMetrics(userId: number): StreakPlayerMetrics {
  return {
    userId,
    oldestTopAt: null,
    dtTop: null,
    k7Top: null,
    playTimeHours: null,
    joinedAt: null,
    followers: null,
    replayViews: null,
  };
}

function readPositiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readCount(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function parseEpochMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function getStreakPlayerMetrics(
  db: Db,
  userIds: number[],
  now = Date.now(),
): Promise<Record<number, StreakPlayerMetrics>> {
  const ids = [...new Set(userIds
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isSafeInteger(id) && id > 0))]
    .slice(0, STREAK_METRICS_MAX_IDS);
  const result: Record<number, StreakPlayerMetrics> = {};
  const missing: number[] = [];
  for (const id of ids) {
    const cached = streakMetricsCache.get(id);
    if (cached && now - cached.at < STREAK_METRICS_CACHE_TTL_MS) result[id] = cached.row;
    else missing.push(id);
  }
  if (missing.length === 0) return result;

  const rows = new Map(missing.map((id) => [id, emptyStreakMetrics(id)]));

  /* One grouped pass over the stored top plays. score_json is plain TEXT here
     (unlike the packed profile snapshot), so the beatmap id comes out in SQL
     and the mods check is a substring match against the exact shape
     JSON.stringify writes ("acronym":"DT"), which never appears outside a mod
     list. NC counts as DT because it is DT with a different sound. A top play
     whose beatmap row is missing counts as not-7K rather than unknown. */
  const topRows = await selectRowsByIntegerSet(
    db,
    `select uts.user_id,
            min(uts.ended_at) as oldest_top,
            sum(case when uts.score_json like '%"acronym":"DT"%' or uts.score_json like '%"acronym":"NC"%' then 1 else 0 end) as dt_top,
            sum(case when b.cs = 7 then 1 else 0 end) as k7_top
     from user_top_scores uts
     left join beatmaps b on b.beatmap_id = cast(json_extract(uts.score_json, '$.beatmap_id') as integer)
     where uts.user_id in`,
    missing,
    "group by uts.user_id",
  );
  for (const row of topRows) {
    const entry = rows.get(Number(row.user_id));
    if (!entry) continue;
    entry.oldestTopAt = parseEpochMs(typeof row.oldest_top === "string" ? row.oldest_top : null);
    entry.dtTop = readCount(row.dt_top);
    entry.k7Top = readCount(row.k7_top);
  }

  /* One row per player, unpacked in JS because user_json may be gzipped. Only
     players missing from the in-memory cache ever reach this. */
  const profileRows = await selectRowsByIntegerSet(
    db,
    "select user_id, user_json from profile_snapshots where user_id in",
    missing,
  );
  for (const row of profileRows) {
    const entry = rows.get(Number(row.user_id));
    if (!entry) continue;
    const profile = unpackJson<Record<string, unknown>>(row.user_json, {});
    const statistics = profile.statistics && typeof profile.statistics === "object"
      ? profile.statistics as Record<string, unknown>
      : {};
    entry.joinedAt = parseEpochMs(profile.join_date);
    entry.followers = readCount(profile.follower_count);
    entry.replayViews = readCount(statistics.replays_watched_by_others);
    const playTimeSeconds = readPositiveNumber(statistics.play_time);
    entry.playTimeHours = playTimeSeconds === null ? null : Math.round(playTimeSeconds / 3600);
  }

  for (const [id, row] of rows) {
    streakMetricsCache.set(id, { at: now, row });
    result[id] = row;
  }
  if (streakMetricsCache.size > STREAK_METRICS_CACHE_MAX) {
    for (const key of streakMetricsCache.keys()) {
      if (streakMetricsCache.size <= STREAK_METRICS_CACHE_MAX) break;
      streakMetricsCache.delete(key);
    }
  }
  return result;
}
