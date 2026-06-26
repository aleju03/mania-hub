import { createFileRoute } from "@tanstack/react-router";

import { GoalsPanel } from "../components/me/GoalsPanel";
import { EMPTY_GOAL_SUGGESTION_METRICS, fetchMyGoalSuggestionMetrics, type GoalSuggestionMetrics } from "../lib/goals";

const GOALS_SUGGESTION_LOADER_TIMEOUT_MS = 900;

function withGoalsLoaderBudget<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([
    promise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

export const Route = createFileRoute("/goals")({
  loader: async (): Promise<GoalSuggestionMetrics> => {
    try {
      return await withGoalsLoaderBudget(fetchMyGoalSuggestionMetrics(), GOALS_SUGGESTION_LOADER_TIMEOUT_MS) ?? EMPTY_GOAL_SUGGESTION_METRICS;
    } catch {
      return EMPTY_GOAL_SUGGESTION_METRICS;
    }
  },
  head: () => ({
    meta: [
      { title: "Goals" },
      { name: "description", content: "" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: GoalsRoute,
});

function GoalsRoute() {
  const initialSuggestionMetrics = Route.useLoaderData();
  return <GoalsPanel initialSuggestionMetrics={initialSuggestionMetrics} />;
}
