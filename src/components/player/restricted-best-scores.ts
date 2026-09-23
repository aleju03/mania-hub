import type { RestrictedPpPlay, RestrictedPpPlayer } from "../../lib/live-backend";
import { getScoreSpeedBucket } from "../../lib/score";
import type { TrackedPlayViewer } from "../../lib/tracked-play-score";
import type { OsuGradeCounts, OsuScore, OsuUserStatistics } from "../../lib/types";

/**
 * The best list of an account osu! turned away, rebuilt from the plays it
 * imported (live-backend restricted-pp.ts) as the score objects the profile
 * already draws, so the list reads like anyone else's.
 *
 * Every play is priced as a stable score, so each one carries a stable total.
 * There is no osu! score behind it: the id stays 0, which keeps the details
 * card on the map rather than on a score page osu! never had. Stars arrive at
 * the played rate while the card reads a map's 1.0x stars, so a rate-modded
 * play drops them, as tracked plays do.
 *
 * Best first, as the profile's rows, filters and insights read a window. Each
 * score carries the Companella mark with its import, which is what the row's
 * replay link opens: every play here counts, so every one has a public replay.
 */
export function buildRestrictedBestList(plays: RestrictedPpPlay[], owner: TrackedPlayViewer): OsuScore[] {
  return plays.map((play, index) => {
    const playedAt = play.playedAt ?? play.receivedAt;
    const cover = play.beatmapsetId ? `/api/background?beatmapsetId=${play.beatmapsetId}` : null;
    return {
      id: 0,
      legacy_score_id: null,
      legacy_total_score: play.totalScore,
      total_score: play.totalScore,
      score: play.totalScore,
      user_id: owner.id,
      user: owner,
      accuracy: play.accuracy,
      mode: "mania",
      ruleset_id: 3,
      beatmap_id: play.beatmapId,
      mods: play.mods.map((acronym) => ({ acronym })),
      max_combo: play.maxCombo,
      passed: true,
      rank: play.grade,
      statistics: {
        count_geki: play.counts.countGeki,
        count_300: play.counts.count300,
        count_katu: play.counts.countKatu,
        count_100: play.counts.count100,
        count_50: play.counts.count50,
        count_miss: play.counts.countMiss,
      },
      pp: play.pp,
      weight: play.weightedPp != null ? { percentage: 100 * 0.95 ** index, pp: play.weightedPp } : undefined,
      has_replay: false,
      created_at: playedAt,
      ended_at: playedAt,
      beatmap: {
        id: play.beatmapId,
        beatmapset_id: play.beatmapsetId || undefined,
        mode: "mania",
        convert: false,
        cs: play.keyCount ?? undefined,
        version: play.version,
        difficulty_rating: getScoreSpeedBucket(play.mods) === "normal" ? play.starRating : undefined,
        bpm: play.bpm ?? undefined,
      },
      beatmapset: {
        id: play.beatmapsetId || undefined,
        title: play.title,
        artist: play.artist,
        creator: play.creator ?? undefined,
        covers: cover ? { cover, "cover@2x": cover } : {},
      },
      companella: { importId: play.scoreId, replay: true },
      // Absent fields stay absent, which no full OsuScore shape can express.
    } as unknown as OsuScore;
  });
}

/**
 * The play totals the profile rail shows. A standing stands in for osu!'s
 * numbers as it does for pp and accuracy: its imports' play count, play time
 * and grades. Null where there is nothing honest to print ("-"): osu!'s own
 * totals on a profile built from projections only, or a play time a backend
 * older than the field never sent.
 */
export function profileRailTotals(
  stats: Pick<OsuUserStatistics, "play_count" | "play_time" | "grade_counts">,
  standing: Pick<RestrictedPpPlayer, "playCount" | "playTime" | "gradeCounts"> | null,
  projectedOnly: boolean,
): { playCount: number | null; playTime: number | null; gradeCounts: OsuGradeCounts | null } {
  if (standing) return { playCount: standing.playCount, playTime: standing.playTime ?? null, gradeCounts: standing.gradeCounts };
  if (projectedOnly) return { playCount: null, playTime: null, gradeCounts: null };
  return { playCount: stats.play_count, playTime: stats.play_time ?? null, gradeCounts: stats.grade_counts };
}
