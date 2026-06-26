import { createServerFn } from "@tanstack/react-start";

// Bridge to the live-backend goals API. Every call resolves the osu! viewer from the signed login
// cookie server-side and forwards that id with the admin token (the roster-self-track pattern), so
// a logged-in user can only ever read or mutate their own goals. The browser never sends a user id.

export type GoalKind = "reach_pp" | "play_pp" | "accuracy" | "pass" | "grade";
export type GoalStatus = "open" | "completed";

export interface GoalProgress {
  current: number | null;
  target: number | null;
  pct: number | null;
  detail: string | null;
}

export interface UserGoal {
  id: string;
  userId: number;
  country: string | null;
  kind: GoalKind;
  beatmapId: number | null;
  beatmapsetId: number | null;
  beatmapLabel: string | null;
  targetValue: number | null;
  targetGrade: string | null;
  note: string | null;
  status: GoalStatus;
  createdAt: number;
  completedAt: number | null;
  completedValue: number | null;
  completedScoreId: string | null;
  completedBeatmapId: number | null;
  progress?: GoalProgress;
}

export interface CreateGoalInput {
  kind: GoalKind;
  beatmapId?: number | null;
  beatmapsetId?: number | null;
  beatmapLabel?: string | null;
  targetValue?: number | null;
  targetGrade?: string | null;
  note?: string | null;
}

export interface GoalsListResult {
  available: boolean;
  goals: UserGoal[];
}

export interface GoalSuggestionMetrics {
  currentPp: number | null;
  lowestTopPlayPp: number | null;
}

export const EMPTY_GOAL_SUGGESTION_METRICS: GoalSuggestionMetrics = {
  currentPp: null,
  lowestTopPlayPp: null,
};

interface GoalsBackend {
  base: string;
  headers: HeadersInit;
  userId: number;
  country: string | null;
}

async function resolveGoalsBackend(): Promise<GoalsBackend | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  const country = auth.viewer.countryCode?.trim().toUpperCase() ?? "";
  return { base, headers, userId: auth.viewer.id, country: /^[A-Z]{2}$/.test(country) ? country : null };
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function lowestProfileTopPlayPp(scores: Array<{ pp?: number | null }> | null | undefined): number | null {
  const topPps = (scores ?? [])
    .map((score) => positiveNumber(score.pp))
    .filter((pp): pp is number => pp != null)
    .sort((a, b) => b - a)
    .slice(0, 100);
  return topPps.length > 0 ? Math.min(...topPps) : null;
}

export const fetchMyGoals = createServerFn({ method: "GET" }).handler(async (): Promise<GoalsListResult> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const cfg = await resolveGoalsBackend();
  if (!cfg) return { available: false, goals: [] };
  try {
    const response = await fetch(`${cfg.base}/api/goals?userId=${cfg.userId}`, { headers: cfg.headers });
    if (!response.ok) return { available: true, goals: [] };
    const body = (await response.json()) as { goals?: UserGoal[] };
    return { available: true, goals: Array.isArray(body.goals) ? body.goals : [] };
  } catch {
    return { available: true, goals: [] };
  }
});

export const fetchMyGoalSuggestionMetrics = createServerFn({ method: "GET" }).handler(async (): Promise<GoalSuggestionMetrics> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const cfg = await resolveGoalsBackend();
  if (!cfg) return EMPTY_GOAL_SUGGESTION_METRICS;

  const [snapshotResult, summaryResult] = await Promise.allSettled([
    fetch(`${cfg.base}/api/profiles/${encodeURIComponent(String(cfg.userId))}/cached-snapshot`, { headers: cfg.headers }),
    fetch(`${cfg.base}/api/my-data/summary?userId=${cfg.userId}`, { headers: cfg.headers }),
  ]);

  const snapshot = snapshotResult.status === "fulfilled" && snapshotResult.value.ok
    ? await snapshotResult.value.json().catch(() => null) as {
        bestScores?: Array<{ pp?: number | null }>;
        projection?: { projectedPp?: number | null; basePp?: number | null };
        user?: { statistics?: { pp?: number | null } };
      } | null
    : null;
  const summary = summaryResult.status === "fulfilled" && summaryResult.value.ok
    ? await summaryResult.value.json().catch(() => null) as { pp?: number | null } | null
    : null;

  return {
    currentPp:
      positiveNumber(snapshot?.projection?.projectedPp) ??
      positiveNumber(snapshot?.projection?.basePp) ??
      positiveNumber(snapshot?.user?.statistics?.pp) ??
      positiveNumber(summary?.pp),
    lowestTopPlayPp: lowestProfileTopPlayPp(snapshot?.bestScores),
  };
});

export const createGoal = createServerFn({ method: "POST" })
  .inputValidator((data: CreateGoalInput) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; goal: UserGoal | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveGoalsBackend();
    if (!cfg) return { ok: false, goal: null };
    try {
      const response = await fetch(`${cfg.base}/api/goals/create`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          userId: cfg.userId,
          country: cfg.country,
          kind: data.kind,
          beatmapId: data.beatmapId ?? null,
          beatmapsetId: data.beatmapsetId ?? null,
          beatmapLabel: data.beatmapLabel ?? null,
          targetValue: data.targetValue ?? null,
          targetGrade: data.targetGrade ?? null,
          note: data.note ?? null,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; goal?: UserGoal };
      return { ok: response.ok && body.ok === true, goal: body.goal ?? null };
    } catch {
      return { ok: false, goal: null };
    }
  });

export const deleteGoal = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveGoalsBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/goals/delete`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, id: data.id }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean };
      return { ok: response.ok && body.ok === true };
    } catch {
      return { ok: false };
    }
  });
