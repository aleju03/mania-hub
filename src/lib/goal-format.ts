import type { GoalKind, GoalSpeedBucket, UserGoal } from "./goals";

// Goal display formatting shared by the goals page (GoalsPanel) and the root-mounted goal toasts.

export const GOAL_SPEED_LABELS: Record<GoalSpeedBucket, string> = {
  normal: "Normal",
  ht: "HT/DC",
  dt: "DT/NC",
};

export function goalSpeedBucket(goal: Pick<UserGoal, "speedBucket">): GoalSpeedBucket {
  return goal.speedBucket === "ht" || goal.speedBucket === "dt" ? goal.speedBucket : "normal";
}

export function goalSpeedLabel(goal: Pick<UserGoal, "speedBucket">): string {
  return GOAL_SPEED_LABELS[goalSpeedBucket(goal)];
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
export function goalSpanLabel(fromMs: number, toMs: number): string {
  const mins = Math.max(0, Math.floor((toMs - fromMs) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** How long an open goal has been standing, for the card's header line. */
export function goalAgeLabel(createdAt: number, nowMs: number): string {
  if (nowMs - createdAt < 60000) return "set just now";
  return `set ${goalSpanLabel(createdAt, nowMs)} ago`;
}

/** How long a cleared goal took. Null when it was created and cleared inside a minute. */
export function goalDurationLabel(goal: Pick<UserGoal, "createdAt" | "completedAt">): string | null {
  if (goal.completedAt == null || goal.completedAt - goal.createdAt < 60000) return null;
  return `took ${goalSpanLabel(goal.createdAt, goal.completedAt)}`;
}

export function describeGoal(goal: UserGoal): string {
  const map = goal.beatmapLabel ?? (goal.beatmapId ? `map #${goal.beatmapId}` : "a map");
  switch (goal.kind) {
    case "reach_pp":
      return `Reach ${nf(goal.targetValue ?? 0)} total pp`;
    case "reach_rank":
      return `Reach ${goal.targetGrade === "country" ? "country" : "global"} rank #${nf(goal.targetValue ?? 0)}`;
    case "play_pp":
      return `Land a ${Math.round(goal.targetValue ?? 0)}pp play`;
    case "play_pp_count":
      return `Have ${nf(goal.targetCount ?? 0)} ${Math.round(goal.targetValue ?? 0)}pp+ plays`;
    case "accuracy":
      return `${trimZeros(((goal.targetValue ?? 0) * 100).toFixed(2))}% ${goalSpeedLabel(goal)} on ${map}`;
    case "pass":
      return `Pass ${map} (${goalSpeedLabel(goal)})`;
    case "fc":
      return `FC ${map} (${goalSpeedLabel(goal)})`;
    case "grade":
      return `Get ${goal.targetGrade ?? "S"} ${goalSpeedLabel(goal)} on ${map}`;
    default:
      return "Goal";
  }
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

export function celebrationLabel(data: GoalCompletedPayload): string {
  const synthetic = {
    kind: data.kind ?? "reach_pp",
    beatmapLabel: data.beatmapLabel ?? null,
    beatmapId: null,
    targetValue: data.targetValue ?? null,
    targetCount: data.targetCount ?? null,
    targetGrade: data.targetGrade ?? null,
    speedBucket: data.speedBucket ?? null,
  } as UserGoal;
  return describeGoal(synthetic);
}
