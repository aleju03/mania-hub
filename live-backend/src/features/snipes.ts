import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { LiveEventLog } from "../live/event-log.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getModAcronyms, getScoreIdentity, getScoreTimestamp, isLazerScore, nowIso, scoreHasPublicLeaderboard, scoreHasReplay } from "../shared/score.js";
import type { OscScore, SnipeEvent } from "../shared/types.js";
import { isRankedRosterMember } from "../rosters/country-rosters.js";
import { logWarn } from "../logger.js";

export interface SnipeSelfHistoryProvider {
  getBeatmapUserScoresAll(beatmapId: number, userId: number, caller?: string): Promise<OscScore[]>;
}

interface BoardScoreWrite {
  userId: number;
  scoreIdentity: string;
  scoreId: number;
  totalScore: number;
  pp: number | null;
  accuracy: number;
  rank: string;
  mods: string[];
  isLazer: boolean;
  hasReplay: boolean;
  endedAt: string;
}

export async function updateSnipeProjection(db: Db, events: LiveEventLog, country: string, score: OscScore, selfHistory?: SnipeSelfHistoryProvider): Promise<SnipeEvent | null> {
  if (!score.beatmap || !score.beatmapset || !score.user) return null;
  if (!scoreHasPublicLeaderboard(score)) return null;
  // Country snipe boards are a ranking surface: only ranked roster members (top N) write to them.
  // Manual/opt-in members are tracked for activity but carry a null rank, so they never seed,
  // appear on, or snipe these boards. This mirrors the `rank is not null` seeding filter.
  if (!await isRankedRosterMember(db, country, score.user_id)) return null;
  const totalScore = getDisplayedTotalScore(score);
  if (totalScore == null) return null;
  const isLazer = isLazerScore(score);
  const mods = getModAcronyms(score.mods);
  const rank = getDisplayedRank(score);
  const laneKey = getBoardLaneKey(mods, isLazer);
  const endedAt = score.ended_at ?? score.created_at ?? nowIso();
  const currentBoardScore: BoardScoreWrite = {
    userId: score.user_id,
    scoreIdentity: getScoreIdentity(score),
    scoreId: score.id,
    totalScore,
    pp: score.pp,
    accuracy: getDisplayedAccuracy(score),
    rank,
    mods,
    isLazer,
    hasReplay: scoreHasReplay(score),
    endedAt,
  };
  const beforeRows = (await exec(
    db,
    `select s.*, u.username, u.avatar_url
     from country_beatmap_scores s
     left join users u on u.user_id = s.user_id
     where s.country = ? and s.beatmap_id = ? and s.lane_key = ?
     order by s.total_score desc`,
    [country, score.beatmap.id, laneKey],
  )).rows;
  const previousSelf = beforeRows.find((row) => Number(row.user_id) === score.user_id);
  if (previousSelf && Number(previousSelf.total_score) >= totalScore) return null;
  const previousSelfIndex = previousSelf == null ? beforeRows.length : beforeRows.indexOf(previousSelf);
  const victimIndex = beforeRows.findIndex((row, index) =>
    index < previousSelfIndex
    && Number(row.user_id) !== score.user_id
    && Number(row.total_score) < totalScore
  );
  const victim = victimIndex < 0 ? null : beforeRows[victimIndex];
  const timelineSelfBest = victim == null
    ? { best: null, verified: false }
    : await getPriorSelfBestFromTimeline(db, country, score.beatmap.id, laneKey, score.user_id, currentBoardScore.endedAt);
  const victimTotalScore = victim == null ? null : Number(victim.total_score);
  const historicalSelfBest = victim == null
    ? null
    : (timelineSelfBest.best != null && (victimTotalScore == null || timelineSelfBest.best.totalScore > victimTotalScore || timelineSelfBest.verified)
      ? timelineSelfBest.best
      : !timelineSelfBest.verified && selfHistory
      ? await populateSelfHistoryAndGetPriorBest(db, country, score.beatmap.id, laneKey, score, currentBoardScore, selfHistory)
      : timelineSelfBest.best);
  const historicalSelfAlreadyAhead = victim != null
    && historicalSelfBest != null
    && historicalSelfBest.totalScore > Number(victim.total_score);
  await recordSnipePersonalBestCandidate(db, country, score.beatmap.id, laneKey, currentBoardScore);
  const boardScore = historicalSelfBest != null && historicalSelfBest.totalScore > totalScore
    ? historicalSelfBest
    : currentBoardScore;
  await upsertBoardScore(db, country, score.beatmap.id, laneKey, boardScore);
  if (victim == null || historicalSelfAlreadyAhead) return null;
  const event: SnipeEvent = {
    beatmap_id: score.beatmap.id,
    beatmapset_id: score.beatmapset.id,
    score_id: score.id,
    sniper: { id: score.user.id, username: score.user.username, avatar_url: score.user.avatar_url },
    victim: {
      id: Number(victim.user_id),
      username: String(victim.username ?? `User ${victim.user_id}`),
      avatar_url: String(victim.avatar_url ?? ""),
    },
    beatmap: {
      version: score.beatmap.version,
      difficulty_rating: score.beatmap.difficulty_rating,
      cs: score.beatmap.cs,
      url: score.beatmap.url,
    },
    beatmapset: {
      title: score.beatmapset.title,
      artist: score.beatmapset.artist,
      cover_url: score.beatmapset.covers.cover ?? score.beatmapset.covers.card ?? "",
    },
    totalScore,
    accuracy: getDisplayedAccuracy(score),
    mods,
    pp: score.pp,
    rank,
    isLazer,
    hasReplay: scoreHasReplay(score),
    timestamp: endedAt,
    victimTimestamp: String(victim.ended_at),
    detectedAt: Date.now(),
    boardRank: victimIndex + 1,
    victimTotalScore: Number(victim.total_score),
    victimPp: victim.pp == null ? null : Number(victim.pp),
  };
  const inserted = await exec(
    db,
    `insert or ignore into snipe_events (country, beatmap_id, lane_key, score_id, sniper_id, victim_id, board_rank, payload_json, detected_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [country, score.beatmap.id, laneKey, score.id, score.user_id, Number(victim.user_id), event.boardRank ?? null, json(event), nowIso()],
  );
  if (inserted.rowsAffected === 0) return null;
  await events.append("snipe", country, event, `snipe:${country}:${score.beatmap.id}:${laneKey}:${score.id}`);
  return event;
}

async function upsertBoardScore(db: Db, country: string, beatmapId: number, laneKey: string, boardScore: BoardScoreWrite): Promise<void> {
  await exec(
    db,
    `insert into country_beatmap_scores (country, beatmap_id, lane_key, user_id, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(country, beatmap_id, lane_key, user_id) do update set
       score_id = excluded.score_id,
       total_score = excluded.total_score,
       pp = excluded.pp,
       accuracy = excluded.accuracy,
       rank = excluded.rank,
       mods_json = excluded.mods_json,
       is_lazer = excluded.is_lazer,
       has_replay = excluded.has_replay,
       ended_at = excluded.ended_at,
       updated_at = excluded.updated_at
     where excluded.total_score > country_beatmap_scores.total_score`,
    [
      country,
      beatmapId,
      laneKey,
      boardScore.userId,
      boardScore.scoreId,
      boardScore.totalScore,
      boardScore.pp,
      boardScore.accuracy,
      boardScore.rank,
      json(boardScore.mods),
      boardScore.isLazer ? 1 : 0,
      boardScore.hasReplay ? 1 : 0,
      boardScore.endedAt,
      nowIso(),
    ],
  );
}

export async function recordSnipeScoreHistory(
  db: Db,
  country: string,
  beatmapId: number,
  laneKey: string,
  userId: number,
  scores: OscScore[],
  options: { excludeScore?: OscScore; excludeIdentities?: Set<string> } = {},
): Promise<void> {
  const entries = scores
    .flatMap((score) => {
      const boardScore = boardScoreFromScore(score, userId);
      if (!boardScore) return [];
      if (getBoardLaneKey(boardScore.mods, boardScore.isLazer) !== laneKey) return [];
      if (options.excludeIdentities?.has(boardScore.scoreIdentity)) return [];
      if (options.excludeScore && isSameScore(boardScore, options.excludeScore)) return [];
      return [boardScore];
    })
    .sort((a, b) => {
      const timeDiff = new Date(a.endedAt).getTime() - new Date(b.endedAt).getTime();
      if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
      return a.scoreId - b.scoreId;
    });
  for (const entry of entries) {
    await recordSnipePersonalBestCandidate(db, country, beatmapId, laneKey, entry);
  }
  await markSnipeScoreHistoryVerified(db, country, beatmapId, laneKey, userId);
}

async function recordSnipePersonalBestCandidate(db: Db, country: string, beatmapId: number, laneKey: string, boardScore: BoardScoreWrite): Promise<boolean> {
  const prior = (await exec(
    db,
    `select max(total_score) as total_score
     from country_beatmap_score_pbs
     where country = ? and beatmap_id = ? and lane_key = ? and user_id = ? and ended_at < ?`,
    [country, beatmapId, laneKey, boardScore.userId, boardScore.endedAt],
  )).rows[0];
  const priorTotalScore = prior?.total_score == null ? null : Number(prior.total_score);
  if (priorTotalScore != null && priorTotalScore >= boardScore.totalScore) return false;
  await exec(
    db,
    `insert into country_beatmap_score_pbs (country, beatmap_id, lane_key, user_id, score_identity, score_id, total_score, pp, accuracy, rank, mods_json, is_lazer, has_replay, ended_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(country, beatmap_id, lane_key, user_id, score_identity) do update set
       score_id = excluded.score_id,
       total_score = excluded.total_score,
       pp = excluded.pp,
       accuracy = excluded.accuracy,
       rank = excluded.rank,
       mods_json = excluded.mods_json,
       is_lazer = excluded.is_lazer,
       has_replay = excluded.has_replay,
       ended_at = excluded.ended_at,
       updated_at = excluded.updated_at`,
    [
      country,
      beatmapId,
      laneKey,
      boardScore.userId,
      boardScore.scoreIdentity,
      boardScore.scoreId,
      boardScore.totalScore,
      boardScore.pp,
      boardScore.accuracy,
      boardScore.rank,
      json(boardScore.mods),
      boardScore.isLazer ? 1 : 0,
      boardScore.hasReplay ? 1 : 0,
      boardScore.endedAt,
      nowIso(),
    ],
  );
  await exec(
    db,
    `delete from country_beatmap_score_pbs
     where country = ? and beatmap_id = ? and lane_key = ? and user_id = ?
       and ended_at > ? and total_score <= ?`,
    [country, beatmapId, laneKey, boardScore.userId, boardScore.endedAt, boardScore.totalScore],
  );
  return true;
}

async function getPriorSelfBestFromTimeline(
  db: Db,
  country: string,
  beatmapId: number,
  laneKey: string,
  userId: number,
  currentEndedAt: string,
): Promise<{ best: BoardScoreWrite | null; verified: boolean }> {
  const bestRow = (await exec(
    db,
    `select *
     from country_beatmap_score_pbs
     where country = ? and beatmap_id = ? and lane_key = ? and user_id = ? and ended_at < ?
     order by total_score desc, ended_at desc
     limit 1`,
    [country, beatmapId, laneKey, userId, currentEndedAt],
  )).rows[0];
  const stateRow = (await exec(
    db,
    `select 1 as verified
     from country_beatmap_score_pb_state
     where country = ? and beatmap_id = ? and lane_key = ? and user_id = ?
     limit 1`,
    [country, beatmapId, laneKey, userId],
  )).rows[0];
  return { best: bestRow ? rowToBoardScore(bestRow) : null, verified: !!stateRow };
}

async function markSnipeScoreHistoryVerified(db: Db, country: string, beatmapId: number, laneKey: string, userId: number): Promise<void> {
  await exec(
    db,
    `insert into country_beatmap_score_pb_state (country, beatmap_id, lane_key, user_id, verified_at)
     values (?, ?, ?, ?, ?)
     on conflict(country, beatmap_id, lane_key, user_id) do update set
       verified_at = excluded.verified_at`,
    [country, beatmapId, laneKey, userId, nowIso()],
  );
}

async function populateSelfHistoryAndGetPriorBest(
  db: Db,
  country: string,
  beatmapId: number,
  laneKey: string,
  score: OscScore,
  currentBoardScore: BoardScoreWrite,
  selfHistory: SnipeSelfHistoryProvider,
): Promise<BoardScoreWrite | null> {
  let history: OscScore[];
  try {
    history = await selfHistory.getBeatmapUserScoresAll(beatmapId, score.user_id, "snipe:self-history");
  } catch (error) {
    logWarn("snipe_self_history_lookup_failed", {
      user_id: score.user_id,
      beatmap_id: beatmapId,
      score_id: score.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  await recordSnipeScoreHistory(db, country, beatmapId, laneKey, score.user_id, history, { excludeScore: score });
  return (await getPriorSelfBestFromTimeline(db, country, beatmapId, laneKey, score.user_id, currentBoardScore.endedAt)).best;
}

function rowToBoardScore(row: Record<string, unknown>): BoardScoreWrite {
  return {
    userId: Number(row.user_id),
    scoreIdentity: String(row.score_identity),
    scoreId: Number(row.score_id),
    totalScore: Number(row.total_score),
    pp: row.pp == null ? null : Number(row.pp),
    accuracy: Number(row.accuracy ?? 0),
    rank: String(row.rank ?? ""),
    mods: parseJson<string[]>(row.mods_json, []),
    isLazer: Number(row.is_lazer) === 1,
    hasReplay: Number(row.has_replay) === 1,
    endedAt: String(row.ended_at ?? ""),
  };
}

function boardScoreFromScore(score: OscScore, userId = score.user_id): BoardScoreWrite | null {
  if (!score) return null;
  if (score.passed === false) return null;
  const totalScore = getDisplayedTotalScore(score);
  if (totalScore == null) return null;
  const mods = getModAcronyms(score.mods);
  const isLazer = isLazerScore(score);
  return {
    userId,
    scoreIdentity: getScoreIdentity(score),
    scoreId: getBoardScoreId(score),
    totalScore,
    pp: score.pp,
    accuracy: getDisplayedAccuracy(score),
    rank: getDisplayedRank(score),
    mods,
    isLazer,
    hasReplay: scoreHasReplay(score),
    endedAt: getScoreTimestamp(score) || nowIso(),
  };
}

function isSameScore(boardScore: BoardScoreWrite, score: OscScore): boolean {
  if (boardScore.scoreIdentity === getScoreIdentity(score)) return true;
  const currentTimestamp = new Date(getScoreTimestamp(score)).getTime();
  const boardTimestamp = new Date(boardScore.endedAt).getTime();
  const currentTotalScore = getDisplayedTotalScore(score);
  if (
    currentTotalScore != null
    && boardScore.totalScore === currentTotalScore
    && Number.isFinite(currentTimestamp)
    && Number.isFinite(boardTimestamp)
    && Math.abs(boardTimestamp - currentTimestamp) <= 5_000
  ) {
    return true;
  }
  return false;
}

function getBoardScoreId(score: OscScore): number {
  const legacyScoreId = Number(score.legacy_score_id);
  if (Number.isFinite(legacyScoreId) && legacyScoreId > 0) return legacyScoreId;
  const scoreId = Number(score.id);
  return Number.isFinite(scoreId) && scoreId > 0 ? scoreId : 0;
}

export async function getSnipesSnapshot(db: Db, country: string, limit: number): Promise<{ events: SnipeEvent[]; scannedAt: number }> {
  const rows = (await exec(
    db,
    `select
       s.payload_json,
       s.detected_at,
       sniper.username as sniper_username,
       sniper.avatar_url as sniper_avatar_url,
       victim.username as victim_username,
       victim.avatar_url as victim_avatar_url
     from snipe_events s
     left join users sniper on sniper.user_id = s.sniper_id
     left join users victim on victim.user_id = s.victim_id
     where s.country = ?
     order by s.detected_at desc
     limit ?`,
    [country, limit],
  )).rows;
  const latestDetectedAt = rows[0]?.detected_at == null ? null : new Date(String(rows[0].detected_at)).getTime();
  return {
    events: rows.map(hydrateSnipeEvent),
    scannedAt: latestDetectedAt != null && Number.isFinite(latestDetectedAt) ? latestDetectedAt : Date.now(),
  };
}

function hydrateSnipeEvent(row: Record<string, unknown>): SnipeEvent {
  const event = parseJson<SnipeEvent>(row.payload_json, {} as SnipeEvent);
  if (event.sniper) {
    const username = row.sniper_username == null ? "" : String(row.sniper_username);
    const avatarUrl = row.sniper_avatar_url == null ? "" : String(row.sniper_avatar_url);
    event.sniper = {
      ...event.sniper,
      username: username || event.sniper.username,
      avatar_url: avatarUrl || event.sniper.avatar_url,
    };
  }
  if (event.victim) {
    const username = row.victim_username == null ? "" : String(row.victim_username);
    const avatarUrl = row.victim_avatar_url == null ? "" : String(row.victim_avatar_url);
    event.victim = {
      ...event.victim,
      username: username || event.victim.username,
      avatar_url: avatarUrl || event.victim.avatar_url,
    };
  }
  return event;
}
