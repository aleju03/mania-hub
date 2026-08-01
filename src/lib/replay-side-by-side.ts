// Which pairs of scores can be watched side by side. Both playfields run off
// one shared map-time clock, which only stays honest when the two runs are the
// same chart at the same rate: otherwise a side would play its frames faster
// than its player heard them, and the single audio track would match neither.

import { getReplayScoreAvailability } from "./replay-score-availability";
import { getScoreRate } from "./score";
import type { OsuScore } from "./types";

export type SideBySideIssueCode = "unplayable" | "same-score" | "different-map" | "different-rate";

export interface SideBySideIssue {
  code: SideBySideIssueCode;
  message: string;
}

/** One side on its own: a mania score with a replay we can download. */
export function getSideBySideScoreIssue(score: OsuScore): SideBySideIssue | null {
  const availability = getReplayScoreAvailability(score);
  if (availability.available) return null;
  return {
    code: "unplayable",
    message: `${score.user?.username ?? "This player"}: ${availability.message}`,
  };
}

/** Both sides together; null when the pair is playable. */
export function getSideBySideIssue(left: OsuScore, right: OsuScore): SideBySideIssue | null {
  const sideIssue = getSideBySideScoreIssue(left) ?? getSideBySideScoreIssue(right);
  if (sideIssue) return sideIssue;

  if (left.id === right.id) {
    return {
      code: "same-score",
      message: "That's the same score on both sides. Pick a different run for the other side.",
    };
  }

  const beatmapId = left.beatmap?.id;
  if (!beatmapId || right.beatmap?.id !== beatmapId) {
    return {
      code: "different-map",
      message: "These scores are on different maps. Side by side plays two runs of the same beatmap.",
    };
  }

  const leftRate = getScoreRate(left.mods);
  const rightRate = getScoreRate(right.mods);
  if (leftRate !== rightRate) {
    return {
      code: "different-rate",
      message: `These runs used different rates (${leftRate}x vs ${rightRate}x). Side by side needs both at the same rate.`,
    };
  }

  return null;
}

/** Why a leaderboard row can't join the run already picked, for its tooltip. */
export function getSideBySideCandidateIssue(candidate: OsuScore, picked: OsuScore | null): SideBySideIssue | null {
  return picked ? getSideBySideIssue(picked, candidate) : getSideBySideScoreIssue(candidate);
}
