import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { secureRandom, secureRandomId } from "../shared/secure-random.js";
import { getGlobalRankingsSnapshot, type GlobalRankingEntry } from "./global-rankings.js";
import {
  getStreakPlayerMetrics,
  grantPackGameShards,
  streakShardReward,
  type PackGameRewardResult,
  type StreakPlayerMetrics,
} from "./pack-games.js";

// Blitz higher-or-lower. The casual game next to it deals in the browser and
// scores itself there, which is the right shape for something whose only stake
// is a capped shard allowance: every number it asks about is public, so no
// amount of server-side bookkeeping would stop a scripted client, and the cap
// makes faking it pointless.
//
// A leaderboard is a different stake. A board fed by a client-reported streak
// is a board of whoever was willing to send the largest number, so a blitz run
// is dealt here instead: this module picks both players and the question, keeps
// the face-down card's answer in the run row, and increments the streak only
// for a guess that came back before the deadline. The number on the board is
// therefore something the account did.
//
// What this does not do is make the game unscriptable. The rankings and the
// per-player numbers are public API on this same backend, so a script can
// answer correctly in 200ms forever. The clock kills the version of cheating
// that actually happens (open the two profiles in another tab, come back and
// answer), and the per-guess timings are kept so an inhuman run can be told
// apart from a fast one after the fact.

/* Twelve seconds is the read: long enough to compare two dates on cards you
   have never seen, short enough that looking either player up is not on the
   table. The grace is for the wire, not the player - a guess sent at 11.9s
   should not die because it landed at 12.2s. */
export const STREAK_ROUND_MS = 12_000;
export const STREAK_ROUND_GRACE_MS = 1_500;

/* A round dealt in answer to a guess is not on screen yet: the board is still
   showing what the last card had, which is the only chance anyone gets to read
   it. That hold is added on top of the thinking time so every round is worth
   the same twelve seconds, rather than the second one quietly being worth
   ten. The opening deal gets the same hold for a different wait: both cards
   land face down while the browser mints their art, and the client keeps the
   countdown hidden until they turn over (or this runs out, whichever is
   first). Mirrors REVEAL_HOLD_MS in the game component. */
export const STREAK_REVEAL_HOLD_MS = 1_250;

/* Blitz draws from the same three pools the casual game offers, and keeps a
   board for each: a run against the top 500 and a run against the whole
   tracked snapshot are different games. Mirrors streakPoolDepth on the
   frontend; "top" is the 1000 pool for the same reason it is there. */
export const STREAK_POOL_PLAYERS = 1000;
export const STREAK_POOL_PLAYERS_TIGHT = 500;
export const STREAK_PAGE_SIZE = 50;
export const STREAK_BOARD_SIZE = 10;

/* A run that has drawn this many players has emptied a good part of a top-1000
   pool; past it the run starts letting players come round again rather than
   ending a streak that was going well. */
const STREAK_MAX_SEEN = 600;
const STREAK_MAX_TIMINGS = 250;

/* How far past its deadline a live run has to be before the sweep calls it
   abandoned. Generous, because the only thing being raced is a browser that
   might still be mid-request; nothing is lost by closing it late. */
const ABANDONED_RUN_SWEEP_MS = 10 * 60 * 1000;

export type StreakPool = "top500" | "top" | "anyone";
export type StreakGuess = "more" | "less";
export type StreakEndReason = "wrong" | "timeout" | "cashout" | "abandoned" | "exhausted";

/* Mirrors the frontend's metric list. The copy that turns one of these into a
   question stays on the client; the server only ever names the metric and the
   two numbers behind it. */
export type StreakMetric =
  | "plays"
  | "score"
  | "oldestTop"
  | "dtTop"
  | "k7Top"
  | "playTime"
  | "joined"
  | "followers"
  | "replayViews";

export const STREAK_METRICS: readonly StreakMetric[] = [
  "plays",
  "score",
  "oldestTop",
  "dtTop",
  "k7Top",
  "playTime",
  "joined",
  "followers",
  "replayViews",
];

export interface StreakRoundPlayer {
  userId: number;
  username: string;
  countryCode: string;
  avatarUrl: string;
  globalRank: number;
  pp: number;
}

type StreakValues = Partial<Record<StreakMetric, number>>;

interface DealtCard {
  player: StreakRoundPlayer;
  values: StreakValues;
}

interface RoundState {
  index: number;
  metric: StreakMetric;
  left: DealtCard;
  right: DealtCard;
}

/* The round as the client is allowed to see it: the face-up card with its
   number, and the face-down card with a name and nothing else. */
export interface StreakRoundView {
  index: number;
  metric: StreakMetric;
  left: { player: StreakRoundPlayer; value: number };
  right: { player: StreakRoundPlayer };
  deadlineAt: number;
  /* The server's clock, so a browser running a few seconds off still draws an
     honest countdown. */
  serverNow: number;
}

export interface StreakRunView {
  runId: string;
  pool: StreakPool;
  streak: number;
  status: "live" | "ended";
  endedBy: StreakEndReason | null;
  round: StreakRoundView | null;
}

export interface StreakGuessView extends StreakRunView {
  correct: boolean;
  /* The guess arrived after the deadline, so the run ended on the clock rather
     than on the answer. */
  expired: boolean;
  /* What the face-down card actually had, once it has been answered for. */
  revealed: { userId: number; value: number } | null;
  reward: PackGameRewardResult | null;
}

export interface StreakBoardEntry {
  rank: number;
  userId: number;
  username: string;
  /* Read off the site account rather than stored with the best: a player who
     moves country should read as where they are now. Null when the account is
     not in `users` yet. */
  countryCode: string | null;
  streak: number;
  achievedAt: number;
}

export interface StreakBoard {
  pool: StreakPool;
  entries: StreakBoardEntry[];
  /* The viewer's own best, whether or not it made the top ten. Null when they
     have never finished a blitz run in this pool. */
  viewer: StreakBoardEntry | null;
}

export function normalizeStreakPool(value: unknown): StreakPool {
  if (value === "anyone") return "anyone";
  return value === "top500" ? "top500" : "top";
}

export function normalizeStreakGuess(value: unknown): StreakGuess | null {
  return value === "more" || value === "less" ? value : null;
}

const RUN_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RUN_ID_LENGTH = 12;

export function generateStreakRunId(rng?: () => number): string {
  if (!rng) return secureRandomId(RUN_ID_ALPHABET, RUN_ID_LENGTH);
  let id = "";
  for (let index = 0; index < RUN_ID_LENGTH; index += 1) {
    id += RUN_ID_ALPHABET[Math.min(RUN_ID_ALPHABET.length - 1, Math.floor(rng() * RUN_ID_ALPHABET.length))];
  }
  return id;
}

export function normalizeStreakRunId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9]{8,24}$/.test(id) ? id : null;
}

/* A tie is scored as a right answer: nobody should lose a streak to two
   players happening to share a number. Mirrors the casual game. */
export function isStreakGuessCorrect(guess: StreakGuess, leftValue: number, rightValue: number): boolean {
  if (rightValue === leftValue) return true;
  return guess === "more" ? rightValue > leftValue : rightValue < leftValue;
}

/* What this player can be asked about. Zero is a real answer for the counting
   questions (plenty of players have no DT plays in their tops); the "when" and
   "how much" questions need a positive number to mean anything. Same rules as
   the client's toStreakPlayer, because the two have to agree on which
   questions exist. */
function cardValues(entry: GlobalRankingEntry, metrics: StreakPlayerMetrics | undefined): StreakValues {
  const values: StreakValues = {};
  const positive = (metric: StreakMetric, value: number | null | undefined): void => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) values[metric] = value;
  };
  const count = (metric: StreakMetric, value: number | null | undefined): void => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) values[metric] = value;
  };
  positive("plays", entry.play_count);
  positive("score", entry.ranked_score);
  positive("oldestTop", metrics?.oldestTopAt);
  count("dtTop", metrics?.dtTop);
  count("k7Top", metrics?.k7Top);
  positive("playTime", metrics?.playTimeHours);
  positive("joined", metrics?.joinedAt);
  count("followers", metrics?.followers);
  count("replayViews", metrics?.replayViews);
  return values;
}

function toRoundPlayer(entry: GlobalRankingEntry): StreakRoundPlayer {
  return {
    userId: entry.user.id,
    username: entry.user.username,
    countryCode: entry.user.country_code,
    avatarUrl: entry.user.avatar_url,
    // Tracked players carry their osu! global rank; the board position stands
    // in for anyone missing one, the same way the pack draw handles it.
    globalRank: entry.global_rank ?? entry.rank,
    pp: entry.pp,
  };
}

/* The question for a round, drawn from what both cards can answer, preferring
   one they actually differ on: a pair who both have zero 7K top plays is a
   free point, which is a boring round to be given. */
export function pickStreakMetric(left: StreakValues, right: StreakValues, rng: () => number): StreakMetric | null {
  const shared = STREAK_METRICS.filter((metric) => left[metric] !== undefined && right[metric] !== undefined);
  if (shared.length === 0) return null;
  const differing = shared.filter((metric) => left[metric] !== right[metric]);
  const pool = differing.length > 0 ? differing : shared;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))] ?? null;
}

/* How deep the run draws. Read once per deal rather than per card: the board
   is built and cached in memory, so this is a slice rather than a query, but
   there is no reason to take it twice. */
async function poolDepth(db: Db, pool: StreakPool): Promise<number> {
  const snapshot = await getGlobalRankingsSnapshot(db, { page: 1, pageSize: 1, sort: "rank", dir: "desc" });
  const total = Math.max(0, Math.floor(snapshot.total));
  if (pool === "anyone") return total;
  return Math.min(pool === "top500" ? STREAK_POOL_PLAYERS_TIGHT : STREAK_POOL_PLAYERS, total);
}

/* One card, aimed rather than sifted: a uniformly random position in the pool,
   then the page holding it. Drawing from whatever page happens to be loaded
   would quietly favour the top. Priming the whole page's metrics keeps the
   per-card read a cache hit for the rest of the run. */
async function drawCard(
  db: Db,
  depth: number,
  seen: Set<number>,
  rng: () => number,
): Promise<DealtCard | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rank = 1 + Math.floor(rng() * Math.max(1, depth));
    const page = Math.max(1, Math.ceil(rank / STREAK_PAGE_SIZE));
    const snapshot = await getGlobalRankingsSnapshot(db, {
      page,
      pageSize: STREAK_PAGE_SIZE,
      sort: "rank",
      dir: "desc",
    });
    const candidates = snapshot.ranking.filter((entry) => entry.rank <= depth && !seen.has(entry.user.id));
    if (candidates.length === 0) continue;
    const metrics = await getStreakPlayerMetrics(db, snapshot.ranking.map((entry) => entry.user.id));
    const entry = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
    if (!entry) continue;
    const values = cardValues(entry, metrics[entry.user.id]);
    if (Object.keys(values).length === 0) {
      // Nothing to ask about this player. Not a round the run can use, and not
      // worth drawing again.
      seen.add(entry.user.id);
      continue;
    }
    return { player: toRoundPlayer(entry), values };
  }
  return null;
}

/* The next round. The face-up card carries over from the round just answered,
   so a run reads as one line of players rather than a series of pairs; only
   the opponent is drawn. A pair with no question in common is re-drawn rather
   than asked. */
async function dealRound(
  db: Db,
  depth: number,
  seen: Set<number>,
  carried: DealtCard | null,
  index: number,
  rng: () => number,
): Promise<RoundState | null> {
  let left = carried;
  if (!left) {
    left = await drawCard(db, depth, seen, rng);
    if (!left) return null;
    seen.add(left.player.userId);
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const right = await drawCard(db, depth, seen, rng);
    if (!right) return null;
    seen.add(right.player.userId);
    const metric = pickStreakMetric(left.values, right.values, rng);
    if (metric) return { index, metric, left, right };
  }
  return null;
}

interface RunRow {
  id: string;
  userId: number;
  username: string;
  pool: StreakPool;
  streak: number;
  status: "live" | "ended";
  endedBy: StreakEndReason | null;
  round: RoundState | null;
  seen: Set<number>;
  dealtAt: number;
  deadlineAt: number;
  guessMs: number[];
}

function readRunRow(row: Record<string, unknown>): RunRow {
  const round = parseJson<RoundState | null>(typeof row.round_json === "string" ? row.round_json : "", null);
  const seen = parseJson<number[]>(typeof row.seen_json === "string" ? row.seen_json : "", []);
  const guessMs = parseJson<number[]>(typeof row.guess_ms_json === "string" ? row.guess_ms_json : "", []);
  return {
    id: String(row.id),
    userId: Number(row.user_id) || 0,
    username: String(row.username ?? ""),
    pool: normalizeStreakPool(row.pool),
    streak: Math.max(0, Number(row.streak) || 0),
    status: row.status === "live" ? "live" : "ended",
    endedBy: (row.ended_by as StreakEndReason | null) ?? null,
    round: round && round.left && round.right ? round : null,
    seen: new Set(Array.isArray(seen) ? seen.filter((id) => Number.isInteger(id)) : []),
    dealtAt: Number(row.dealt_at) || 0,
    deadlineAt: Number(row.deadline_at) || 0,
    guessMs: Array.isArray(guessMs) ? guessMs : [],
  };
}

async function readRun(db: Db, runId: string): Promise<RunRow | null> {
  const row = (await exec(db, "select * from pack_streak_runs where id = ?", [runId])).rows[0];
  return row ? readRunRow(row as Record<string, unknown>) : null;
}

function roundView(round: RoundState, deadlineAt: number, now: number): StreakRoundView {
  return {
    index: round.index,
    metric: round.metric,
    left: { player: round.left.player, value: round.left.values[round.metric] ?? 0 },
    right: { player: round.right.player },
    deadlineAt,
    serverNow: now,
  };
}

function endedView(run: RunRow, extra: Partial<StreakGuessView> = {}): StreakGuessView {
  return {
    runId: run.id,
    pool: run.pool,
    streak: run.streak,
    status: "ended",
    endedBy: run.endedBy,
    round: null,
    correct: false,
    expired: false,
    revealed: null,
    reward: null,
    ...extra,
  };
}

/* Ends a live run and pays what it earned. The status guard is what keeps a
   double-tap (or a guess racing a cash-out) from paying the same run twice:
   only the update that actually flipped the row hands out shards. */
async function endRun(
  db: Db,
  run: RunRow,
  reason: StreakEndReason,
  now: number,
): Promise<PackGameRewardResult | null> {
  /* seen_json goes with the round: it is bookkeeping for the draw, useless the
     moment there is nothing left to draw, and a few hundred bytes per run adds
     up on a row nobody deletes today. guess_ms_json stays until the row itself
     is pruned, since telling a fast run from an inhuman one is exactly an
     after-the-fact question. */
  const ended = await exec(
    db,
    `update pack_streak_runs
        set status = 'ended', ended_by = ?, round_json = null, seen_json = null, updated_at = ?
      where id = ? and status = 'live'`,
    [reason, now, run.id],
  );
  if (ended.rowsAffected === 0 || run.streak <= 0) return null;
  /* The board's row. Only a run that beat this account's own best in this pool
     writes, so the achieved_at that breaks ties stays the moment the record was
     actually set rather than the last time they played. */
  await exec(
    db,
    `insert into pack_streak_bests (user_id, pool, username, streak, achieved_at, run_id, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(user_id, pool) do update set
       username = excluded.username,
       streak = excluded.streak,
       achieved_at = excluded.achieved_at,
       run_id = excluded.run_id,
       updated_at = excluded.updated_at
     where excluded.streak > pack_streak_bests.streak`,
    [run.userId, run.pool, run.username, run.streak, now, run.id, now],
  );
  return grantPackGameShards(db, run.userId, "streak", streakShardReward(run.streak), now);
}

/* Closes runs somebody walked away from. A run only reaches the board when it
   ends, and an abandoned one otherwise sits open until that account plays
   again - so a streak earned by someone who then shut the tab would hang there
   unpaid and unlisted. Swept hourly by retention rather than by a job, since
   there is nothing to schedule: it is a query for rows whose clock ran out
   long ago. */
export async function sweepAbandonedStreakRuns(db: Db, now = Date.now()): Promise<number> {
  const stale = (await exec(
    db,
    "select * from pack_streak_runs where status = 'live' and deadline_at < ?",
    [now - ABANDONED_RUN_SWEEP_MS],
  )).rows;
  let closed = 0;
  for (const row of stale) {
    await endRun(db, readRunRow(row as Record<string, unknown>), "abandoned", now);
    closed += 1;
  }
  return closed;
}

export interface StartStreakRunInput {
  userId: number;
  username: string;
  pool: StreakPool;
  now?: number;
  rng?: () => number;
}

/* Opens a blitz run and deals its first round. Any run this account left
   hanging is closed first (and paid, since those rounds were played), so an
   account only ever has one live run and abandoning is never worth more than
   stopping. */
export async function startStreakRun(db: Db, input: StartStreakRunInput): Promise<StreakRunView | null> {
  const now = input.now ?? Date.now();
  // The deal decides a public leaderboard, so it draws from the CSPRNG unless a
  // caller (tests) hands in its own: the face-down card's number is the whole
  // game, and Math.random's stream is observable from every other draw the
  // process makes.
  const rng = input.rng ?? secureRandom;
  if (!Number.isInteger(input.userId) || input.userId <= 0) return null;

  const openRows = (await exec(
    db,
    "select * from pack_streak_runs where user_id = ? and status = 'live'",
    [input.userId],
  )).rows;
  for (const row of openRows) {
    await endRun(db, readRunRow(row as Record<string, unknown>), "abandoned", now);
  }

  const depth = await poolDepth(db, input.pool);
  if (depth < 2) return null;
  const seen = new Set<number>();
  const round = await dealRound(db, depth, seen, null, 1, rng);
  if (!round) return null;

  const id = generateStreakRunId(rng);
  /* The opening pair is dealt face down while the browser mints both cards'
     art, so the first round is paid the hold every later round gets for its
     reveal: the countdown the player sees never runs against card backs. */
  const deadlineAt = now + STREAK_ROUND_MS + STREAK_REVEAL_HOLD_MS;
  await exec(
    db,
    `insert into pack_streak_runs
       (id, user_id, username, pool, streak, status, ended_by, round_json, seen_json,
        dealt_at, deadline_at, guess_ms_json, created_at, updated_at)
     values (?, ?, ?, ?, 0, 'live', null, ?, ?, ?, ?, '[]', ?, ?)`,
    [
      id,
      input.userId,
      input.username.slice(0, 64),
      input.pool,
      JSON.stringify(round),
      JSON.stringify([...seen]),
      now,
      deadlineAt,
      now,
      now,
    ],
  );
  return {
    runId: id,
    pool: input.pool,
    streak: 0,
    status: "live",
    endedBy: null,
    round: roundView(round, deadlineAt, now),
  };
}

export interface StreakGuessInput {
  userId: number;
  runId: string;
  guess: StreakGuess;
  now?: number;
  rng?: () => number;
}

/* One guess. Everything that decides the run happens here: whether it arrived
   in time, whether it was right, and what the next pair is. */
export async function guessStreakRound(db: Db, input: StreakGuessInput): Promise<StreakGuessView | null> {
  const now = input.now ?? Date.now();
  // Same reason as the opening deal: this picks the next face-down card.
  const rng = input.rng ?? secureRandom;
  const run = await readRun(db, input.runId);
  if (!run || run.userId !== input.userId) return null;
  if (run.status !== "live" || !run.round) return endedView(run);

  const round = run.round;
  const leftValue = round.left.values[round.metric];
  const rightValue = round.right.values[round.metric];
  if (leftValue === undefined || rightValue === undefined) {
    // A round whose question lost its numbers cannot be scored either way, so
    // the run keeps what it had rather than losing it to a bad deal.
    const reward = await endRun(db, run, "exhausted", now);
    return endedView({ ...run, endedBy: "exhausted" }, { reward });
  }
  const revealed = { userId: round.right.player.userId, value: rightValue };

  if (now > run.deadlineAt + STREAK_ROUND_GRACE_MS) {
    const reward = await endRun(db, run, "timeout", now);
    return endedView({ ...run, endedBy: "timeout" }, { expired: true, revealed, reward });
  }

  if (!isStreakGuessCorrect(input.guess, leftValue, rightValue)) {
    const reward = await endRun(db, run, "wrong", now);
    return endedView({ ...run, endedBy: "wrong" }, { revealed, reward });
  }

  const streak = run.streak + 1;
  const guessMs = [...run.guessMs, Math.max(0, now - run.dealtAt)].slice(-STREAK_MAX_TIMINGS);
  /* Once the run has drawn most of a pool, players are allowed round again:
     ending a good streak because the pool ran dry reads as the game giving up
     rather than as a challenge. The card still on the board is kept out. */
  const seen = run.seen.size >= STREAK_MAX_SEEN
    ? new Set<number>([round.right.player.userId])
    : run.seen;
  const depth = await poolDepth(db, run.pool);
  const next = await dealRound(db, depth, seen, round.right, round.index + 1, rng);
  if (!next) {
    await exec(
      db,
      "update pack_streak_runs set streak = ?, guess_ms_json = ?, updated_at = ? where id = ?",
      [streak, JSON.stringify(guessMs), now, run.id],
    );
    const reward = await endRun(db, { ...run, streak }, "exhausted", now);
    return endedView({ ...run, streak, endedBy: "exhausted" }, { correct: true, revealed, reward });
  }

  const deadlineAt = now + STREAK_ROUND_MS + STREAK_REVEAL_HOLD_MS;
  await exec(
    db,
    `update pack_streak_runs
        set streak = ?, round_json = ?, seen_json = ?, dealt_at = ?, deadline_at = ?,
            guess_ms_json = ?, updated_at = ?
      where id = ? and status = 'live'`,
    [
      streak,
      JSON.stringify(next),
      JSON.stringify([...seen]),
      now,
      deadlineAt,
      JSON.stringify(guessMs),
      now,
      run.id,
    ],
  );
  return {
    runId: run.id,
    pool: run.pool,
    streak,
    status: "live",
    endedBy: null,
    round: roundView(next, deadlineAt, now),
    correct: true,
    expired: false,
    revealed,
    reward: null,
  };
}

/* Stopping on purpose, which banks the streak and pays it. A run whose clock
   already ran out ends as the timeout it was; the streak is the same number
   either way, so there is nothing to win by stalling. */
export async function cashOutStreakRun(
  db: Db,
  input: { userId: number; runId: string; now?: number },
): Promise<StreakGuessView | null> {
  const now = input.now ?? Date.now();
  const run = await readRun(db, input.runId);
  if (!run || run.userId !== input.userId) return null;
  if (run.status !== "live") return endedView(run);
  const expired = now > run.deadlineAt + STREAK_ROUND_GRACE_MS;
  const reason: StreakEndReason = expired ? "timeout" : "cashout";
  const reward = await endRun(db, run, reason, now);
  return endedView({ ...run, endedBy: reason }, { expired, reward });
}

/* The board. One indexed read of pack_streak_bests, which already holds one
   row per account per pool: no grouping, no scan of the run log, and nothing
   that grows with how much the game gets played rather than how many people
   play it. A best only lands here when a run ends, so a run still in progress
   is not on the board - which is the honest reading of "longest streaks
   recorded" anyway, and abandoned runs are swept in so nothing earned goes
   missing. */
function streakCountryCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return code ? code : null;
}

export async function getStreakBoard(
  db: Db,
  pool: StreakPool,
  viewerId: number | null = null,
): Promise<StreakBoard> {
  const rows = (await exec(
    db,
    `select b.user_id, b.username, b.streak, b.achieved_at,
            (select u.country_code from users u where u.user_id = b.user_id) as country_code
       from pack_streak_bests b
      where b.pool = ?
      order by b.streak desc, b.achieved_at asc
      limit ?`,
    [pool, STREAK_BOARD_SIZE],
  )).rows;
  const entries: StreakBoardEntry[] = rows.map((row, index) => ({
    rank: index + 1,
    userId: Number(row.user_id) || 0,
    username: String(row.username ?? ""),
    countryCode: streakCountryCode(row.country_code),
    streak: Math.max(0, Number(row.streak) || 0),
    achievedAt: Number(row.achieved_at) || 0,
  }));

  let viewer: StreakBoardEntry | null = null;
  if (Number.isInteger(viewerId) && (viewerId ?? 0) > 0) {
    const inBoard = entries.find((entry) => entry.userId === viewerId);
    if (inBoard) viewer = inBoard;
    else {
      const own = (await exec(
        db,
        `select b.username, b.streak, b.achieved_at,
                (select u.country_code from users u where u.user_id = b.user_id) as country_code
           from pack_streak_bests b
          where b.pool = ? and b.user_id = ?`,
        [pool, viewerId],
      )).rows[0];
      const best = Math.max(0, Number(own?.streak) || 0);
      if (best > 0) {
        const achievedAt = Number(own?.achieved_at) || 0;
        /* Where that best sits: everyone whose own best beats it, plus anyone
           tied who got there first. Counted rather than ranked so a player
           deep down the board still gets a real number, and counted over the
           same index the board is ordered by. */
        const ahead = (await exec(
          db,
          `select count(*) as ahead
             from pack_streak_bests
            where pool = ? and (streak > ? or (streak = ? and achieved_at < ?))`,
          [pool, best, best, achievedAt],
        )).rows[0];
        viewer = {
          rank: Math.max(1, (Number(ahead?.ahead) || 0) + 1),
          userId: viewerId ?? 0,
          username: String(own?.username ?? ""),
          countryCode: streakCountryCode(own?.country_code),
          streak: best,
          achievedAt,
        };
      }
    }
  }
  return { pool, entries, viewer };
}

/* Take a streak off the board. Deliberately not a ban: it deletes the record
   and nothing else, so the account can play the next minute and set another
   one. That account's ended runs in the pool go with it, since their per-guess
   timings were the evidence for a decision now made, and clearing them leaves
   nothing behind for a backfill to rebuild the entry from. A run still live is
   left alone: it is a game somebody is in the middle of. */
export async function removeStreakBest(
  db: Db,
  input: { userId: number; pool: StreakPool },
): Promise<{ removed: boolean; entry: StreakBoardEntry | null; runsDeleted: number }> {
  const row = (await exec(
    db,
    "select username, streak, achieved_at from pack_streak_bests where pool = ? and user_id = ?",
    [input.pool, input.userId],
  )).rows[0];
  if (!row) return { removed: false, entry: null, runsDeleted: 0 };
  const entry: StreakBoardEntry = {
    rank: 0,
    userId: input.userId,
    username: String(row.username ?? ""),
    countryCode: null,
    streak: Math.max(0, Number(row.streak) || 0),
    achievedAt: Number(row.achieved_at) || 0,
  };
  await exec(db, "delete from pack_streak_bests where pool = ? and user_id = ?", [input.pool, input.userId]);
  const runs = await exec(
    db,
    "delete from pack_streak_runs where user_id = ? and pool = ? and status = 'ended'",
    [input.userId, input.pool],
  );
  return { removed: true, entry, runsDeleted: Number(runs.rowsAffected ?? 0) };
}
