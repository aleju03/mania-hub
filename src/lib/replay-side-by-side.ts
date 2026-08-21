// Which pairs of scores can be watched side by side. Both playfields run off
// one shared map-time clock, which only stays honest when the two runs are the
// same chart at the same rate: otherwise a side would play its frames faster
// than its player heard them, and the single audio track would match neither.

import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";

import { getReplayScoreAvailability } from "./replay-score-availability";
import { getScoreRate } from "./score";
import type { OsuScore } from "./types";

export type SideBySideIssueCode = "unplayable" | "same-score" | "different-map" | "different-rate";

export interface SideBySideIssue {
  code: SideBySideIssueCode;
  message: MessageDescriptor;
  /** Set on "unplayable": whose side can't be watched, prefixed on render. */
  player?: string;
}

/** The issue as one line of viewer-facing copy. */
export function formatSideBySideIssue(issue: SideBySideIssue, i18n: I18n): string {
  const message = i18n._(issue.message);
  return issue.player ? `${issue.player}: ${message}` : message;
}

/** One side on its own: a mania score with a replay we can download. */
export function getSideBySideScoreIssue(score: OsuScore): SideBySideIssue | null {
  const availability = getReplayScoreAvailability(score);
  if (availability.available) return null;
  return {
    code: "unplayable",
    message: availability.message,
    player: score.user?.username,
  };
}

/** Both sides together; null when the pair is playable. */
export function getSideBySideIssue(left: OsuScore, right: OsuScore): SideBySideIssue | null {
  const sideIssue = getSideBySideScoreIssue(left) ?? getSideBySideScoreIssue(right);
  if (sideIssue) return sideIssue;

  if (left.id === right.id) {
    return {
      code: "same-score",
      message: msg`That's the same score on both sides. Pick a different run for the other side.`,
    };
  }

  const beatmapId = left.beatmap?.id;
  if (!beatmapId || right.beatmap?.id !== beatmapId) {
    return {
      code: "different-map",
      message: msg`These scores are on different maps. Side by side plays two runs of the same beatmap.`,
    };
  }

  const leftRate = getScoreRate(left.mods);
  const rightRate = getScoreRate(right.mods);
  if (leftRate !== rightRate) {
    return {
      code: "different-rate",
      message: msg`These runs used different rates (${leftRate}x vs ${rightRate}x). Side by side needs both at the same rate.`,
    };
  }

  return null;
}

/** Why a leaderboard row can't join the run already picked, for its tooltip. */
export function getSideBySideCandidateIssue(candidate: OsuScore, picked: OsuScore | null): SideBySideIssue | null {
  return picked ? getSideBySideIssue(picked, candidate) : getSideBySideScoreIssue(candidate);
}

/* How the stage lays itself out for the viewport it landed in. Pure, and kept
   next to the pair rules, because the phone behaviour is the fiddly part: the
   view must never unmount across a rotation (that would drop both replays and
   refetch them), so every orientation is a class swap on the same tree. */

export const SIDE_BY_SIDE_PORTRAIT_PHONE_QUERY = "(orientation: portrait) and (max-width: 639px)";
/** Landscape phones sit around 320-450px tall; laptops start near 700px. */
export const SIDE_BY_SIDE_SHORT_VIEWPORT_QUERY = "(max-height: 600px)";
export const SIDE_BY_SIDE_TOUCH_QUERY = "(pointer: coarse)";

export interface SideBySideViewport {
  portraitPhone: boolean;
  shortViewport: boolean;
  touch: boolean;
}

export interface SideBySideLayout {
  /** Cover the whole viewport, navbar included, instead of sitting under it. */
  overlay: boolean;
  /** Squeeze the chrome so the two playfields keep the height they need. */
  compact: boolean;
  /** Playfields stay mounted and paused behind a rotate prompt. */
  rotatePrompt: boolean;
}

export function resolveSideBySideLayout(viewport: SideBySideViewport, fullscreen: boolean): SideBySideLayout {
  return {
    // A portrait phone keeps the navbar: the rotate prompt is a dead end
    // otherwise, with no way back to the rest of the site.
    overlay: fullscreen || (viewport.touch && !viewport.portraitPhone),
    compact: viewport.shortViewport,
    rotatePrompt: viewport.portraitPhone,
  };
}
