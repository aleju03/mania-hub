import { getScoreSpeedBucket } from "./score";
import type { LiveKeymodePpPlay } from "./live-backend";
import type { OsuScore } from "./types";

/** Who the profile belongs to, which is who every tracked play on it is by. */
export interface TrackedPlayViewer {
  id: number;
  username: string;
  avatar_url: string;
  country_code: string;
}

/**
 * A tracked play, shaped as the score object the details card reads.
 *
 * Nothing here is fetched: the day-best row is the whole source, so the card
 * opens instantly and costs no osu! call. What the row never stored is left
 * *absent* rather than zeroed, because every cell on that card tests for null
 * to decide between a number and a dash - a filled-in 0 would read as a real
 * measurement of nothing.
 *
 * Stars and BPM are the map's at 1.0x, so a rate-modded play drops them: they
 * would describe a chart nobody played.
 */
export function buildTrackedPlayScore(play: LiveKeymodePpPlay, viewer: TrackedPlayViewer): OsuScore {
  const rateModded = getScoreSpeedBucket(play.mods) !== "normal";
  const playedAt = play.playedAt ?? undefined;
  return {
    // The solo id is the one both /replay and osu!'s own /scores/{id} take, so
    // it stays the id even for a stable play; legacy_score_id is what marks
    // that play as stable rather than lazer.
    id: play.soloScoreId ?? 0,
    legacy_score_id: play.legacyScoreId,
    type: "solo_score",
    user_id: viewer.id,
    user: viewer,
    accuracy: play.accuracy ?? 0,
    mode: "mania",
    ruleset_id: 3,
    beatmap_id: play.beatmapId,
    mods: play.mods.map((acronym) => ({ acronym })),
    max_combo: play.maxCombo ?? 0,
    total_score: play.totalScore ?? undefined,
    passed: true,
    rank: play.rank ?? "D",
    statistics: play.statistics ?? {},
    pp: play.pp,
    has_replay: play.hasReplay === true,
    created_at: playedAt,
    ended_at: playedAt,
    beatmap: {
      id: play.beatmapId,
      beatmapset_id: play.beatmapsetId ?? undefined,
      mode: "mania",
      convert: false,
      cs: play.keyCount,
      version: play.version ?? undefined,
      difficulty_rating: rateModded ? undefined : play.stars ?? undefined,
      bpm: rateModded ? undefined : play.bpm ?? undefined,
    },
    beatmapset: {
      id: play.beatmapsetId ?? undefined,
      title: play.title ?? undefined,
      artist: play.artist ?? undefined,
      creator: play.creator ?? undefined,
      covers: play.beatmapsetId ? { "cover@2x": `/api/background?beatmapsetId=${play.beatmapsetId}` } : {},
    },
    // Absent fields are absent on purpose (see above), which no full OsuScore
    // shape can express.
  } as unknown as OsuScore;
}
