import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { scoreHasReplay } from "./score";
import type { OsuScore } from "./types";

export type ReplayScoreAvailability =
  | { available: true }
  | { available: false; reason: "non-mania" | "no-replay"; message: MessageDescriptor };

function formatRuleset(mode: string): string {
  if (mode === "osu") return "osu!standard";
  if (mode === "fruits") return "catch";
  return mode;
}

/**
 * Thrown by the replay download when osu! flags the score as replayable but
 * every download endpoint 404s: the file is gone on osu!'s side, so the
 * viewer names that instead of echoing the proxy error.
 */
export const REPLAY_FILE_MISSING_ERROR = "replay-file-missing";

export const replayFileMissingMessage = msg`osu! no longer has the replay file for this score.`;

export function isReplayFileMissingError(error: unknown): boolean {
  return error instanceof Error && error.message === REPLAY_FILE_MISSING_ERROR;
}

export function getReplayScoreAvailability(score: OsuScore): ReplayScoreAvailability {
  const mode = score.beatmap?.mode;
  if (mode && mode !== "mania") {
    return {
      available: false,
      reason: "non-mania",
      message: msg`This score is for ${formatRuleset(mode)}, not mania.`,
    };
  }

  if (!scoreHasReplay(score)) {
    return {
      available: false,
      reason: "no-replay",
      message: msg`This score doesn't have a downloadable replay.`,
    };
  }

  return { available: true };
}
