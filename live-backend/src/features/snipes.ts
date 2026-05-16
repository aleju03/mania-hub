import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { LiveEventLog } from "../live/event-log.js";
import { getBoardLaneKey, getDisplayedAccuracy, getDisplayedRank, getDisplayedTotalScore, getModAcronyms, isLazerScore, nowIso, scoreHasPublicLeaderboard, scoreHasReplay } from "../shared/score.js";
import type { OscScore, SnipeEvent } from "../shared/types.js";

export async function updateSnipeProjection(db: Db, events: LiveEventLog, country: string, score: OscScore): Promise<SnipeEvent | null> {
  if (!score.beatmap || !score.beatmapset || !score.user) return null;
  if (!scoreHasPublicLeaderboard(score)) return null;
  const totalScore = getDisplayedTotalScore(score);
  if (totalScore == null) return null;
  const isLazer = isLazerScore(score);
  const mods = getModAcronyms(score.mods);
  const rank = getDisplayedRank(score);
  const laneKey = getBoardLaneKey(mods, isLazer);
  const endedAt = score.ended_at ?? score.created_at ?? nowIso();
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
    [country, score.beatmap.id, laneKey, score.user_id, score.id, totalScore, score.pp, getDisplayedAccuracy(score), rank, json(mods), isLazer ? 1 : 0, scoreHasReplay(score) ? 1 : 0, endedAt, nowIso()],
  );
  if (victimIndex < 0) return null;
  const victim = beforeRows[victimIndex];
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
