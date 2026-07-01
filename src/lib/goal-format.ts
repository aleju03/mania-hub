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

export function nf(value: number): string {
  return Math.round(value).toLocaleString();
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
