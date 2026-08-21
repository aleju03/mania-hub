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
