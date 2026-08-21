import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";

import { getI18n } from "./i18n";
import { DEFAULT_LOCALE } from "./locale";
import type { GoalKind, GoalSpeedBucket, UserGoal } from "./goals";

// Goal display formatting shared by the goals page (GoalsPanel) and the root-mounted goal toasts.
//
// Every phrase here is a whole sentence with the numbers, the map and the
// speed as placeholders, so a translation can reorder them - a goal reads
// "96% Normal on <map>" in English and needs the pieces in another order
// elsewhere. That means these functions take the caller's I18n instance
// (`useLingui()` in a component, `getI18n(locale)` in a route head) rather
// than returning fragments to be glued together at the render site.
//
// The dynamic-render images (src/routes/api/signature/-renderers.ts) draw
// outside any React tree and stay English, so they call describeGoalEnglish.

export const GOAL_SPEED_LABELS: Record<GoalSpeedBucket, MessageDescriptor> = {
  normal: msg`Normal`,
  ht: msg`HT/DC`,
  dt: msg`DT/NC`,
};

export function goalSpeedBucket(goal: Pick<UserGoal, "speedBucket">): GoalSpeedBucket {
  return goal.speedBucket === "ht" || goal.speedBucket === "dt" ? goal.speedBucket : "normal";
}

export function goalSpeedLabel(goal: Pick<UserGoal, "speedBucket">, i18n: I18n): string {
  return i18n._(GOAL_SPEED_LABELS[goalSpeedBucket(goal)]);
}

export function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, "");
}

// Pinned to en-US like the rest of the site's formatting (src/lib/format.ts):
// a bare toLocaleString() takes Node's locale on the server and the browser's
// on the client, so a visitor whose locale groups with dots hydrated "12.345"
// over the SSR "12,345" -- the recoverable #418s on /goals' current-pp tile.
export function nf(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Compact span between two timestamps ("45m", "6h", "12d", "3mo", "1y"). */
export function goalSpanLabel(fromMs: number, toMs: number, i18n: I18n): string {
  const mins = Math.max(0, Math.floor((toMs - fromMs) / 60000));
  if (mins < 60) return i18n._(msg`${mins}m`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return i18n._(msg`${hours}h`);
  const days = Math.floor(hours / 24);
  if (days < 30) return i18n._(msg`${days}d`);
  if (days < 365) {
    const months = Math.floor(days / 30);
    return i18n._(msg`${months}mo`);
  }
  const years = Math.floor(days / 365);
  return i18n._(msg`${years}y`);
}

/** How long an open goal has been standing, for the card's header line. */
export function goalAgeLabel(createdAt: number, nowMs: number, i18n: I18n): string {
  if (nowMs - createdAt < 60000) return i18n._(msg`set just now`);
  const span = goalSpanLabel(createdAt, nowMs, i18n);
  return i18n._(msg`set ${span} ago`);
}

/** How long a cleared goal took. Null when it was created and cleared inside a minute. */
export function goalDurationLabel(goal: Pick<UserGoal, "createdAt" | "completedAt">, i18n: I18n): string | null {
  if (goal.completedAt == null || goal.completedAt - goal.createdAt < 60000) return null;
  const span = goalSpanLabel(goal.createdAt, goal.completedAt, i18n);
  return i18n._(msg`took ${span}`);
}

export function describeGoal(goal: UserGoal, i18n: I18n): string {
  const map = goal.beatmapLabel ?? (goal.beatmapId ? i18n._(msg`map #${goal.beatmapId}`) : i18n._(msg`a map`));
  const speed = goalSpeedLabel(goal, i18n);
  switch (goal.kind) {
    case "reach_pp": {
      const pp = nf(goal.targetValue ?? 0);
      return i18n._(msg`Reach ${pp} total pp`);
    }
    case "reach_rank": {
      const rank = nf(goal.targetValue ?? 0);
      // Two whole sentences rather than one with a "country"/"global" word
      // slotted in: which of the two it is changes more than that word in
      // plenty of languages.
      return goal.targetGrade === "country"
        ? i18n._(msg`Reach country rank #${rank}`)
        : i18n._(msg`Reach global rank #${rank}`);
    }
    case "play_pp": {
      const pp = Math.round(goal.targetValue ?? 0);
      return i18n._(msg`Land a ${pp}pp play`);
    }
    case "play_pp_count": {
      const pp = Math.round(goal.targetValue ?? 0);
      const count = goal.targetCount ?? 0;
      return i18n._(msg`Have ${plural(count, { one: `# ${pp}pp+ play`, other: `# ${pp}pp+ plays` })}`);
    }
    case "accuracy": {
      const acc = trimZeros(((goal.targetValue ?? 0) * 100).toFixed(2));
      return i18n._(msg`${acc}% ${speed} on ${map}`);
    }
    case "pass":
      return i18n._(msg`Pass ${map} (${speed})`);
    case "fc":
      return i18n._(msg`FC ${map} (${speed})`);
    case "grade": {
      const grade = goal.targetGrade ?? "S";
      return i18n._(msg`Get ${grade} ${speed} on ${map}`);
    }
    default:
      return i18n._(msg`Goal`);
  }
}

/* The English rendering, for callers that draw outside any React tree and
   outside any request's locale: the dynamic-render images. Resolving through
   the shared "en" instance rather than a second copy of the sentences is what
   keeps the picture and the page saying the same thing. */
export function describeGoalEnglish(goal: UserGoal): string {
  return describeGoal(goal, getI18n(DEFAULT_LOCALE));
}

/** Shape of the goal_completed SSE payload the live backend emits. */
export interface GoalCompletedPayload {
  userId?: number;
  kind?: GoalKind;
  targetValue?: number | null;
  targetCount?: number | null;
  targetGrade?: string | null;
  speedBucket?: GoalSpeedBucket | null;
  beatmapLabel?: string | null;
}

export function celebrationLabel(data: GoalCompletedPayload, i18n: I18n): string {
  const synthetic = {
    kind: data.kind ?? "reach_pp",
    beatmapLabel: data.beatmapLabel ?? null,
    beatmapId: null,
    targetValue: data.targetValue ?? null,
    targetCount: data.targetCount ?? null,
    targetGrade: data.targetGrade ?? null,
    speedBucket: data.speedBucket ?? null,
  } as UserGoal;
  return describeGoal(synthetic, i18n);
}
