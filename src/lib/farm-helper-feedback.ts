import { createServerFn } from "@tanstack/react-start";

// Bridge to the live-backend farm helper feedback API. Every call resolves the osu! viewer from
// the signed login cookie server-side and forwards that id with the admin token (the goals
// pattern), so a logged-in user can only ever read or mutate their own marks. The browser never
// sends a user id and never sees the admin token.

export type FarmHelperFeedbackVerdict = "too_hard" | "too_easy";

// Why a mutation (or list read) did not go through. "not_logged_in" means the
// cookie resolved no viewer; "too_many_marks" is the backend's active-marks
// cap; "failed" is any other backend or transport failure.
export type FarmHelperFeedbackFailReason = "not_logged_in" | "too_many_marks" | "failed";

export interface FarmHelperFeedbackMark {
  beatmapId: number;
  speedBucket: string;
  verdict: FarmHelperFeedbackVerdict;
  createdAt: number;
  resolvedAt: number | null;
  resolvedPp: number | null;
}

export interface FarmHelperFeedbackListResult {
  // False when the marks could not actually be read (backend down or
  // unconfigured); callers must not treat that as "no marks".
  ok: boolean;
  marks: FarmHelperFeedbackMark[];
}

interface FeedbackBackend {
  base: string;
  headers: HeadersInit;
  userId: number;
}

type FeedbackBackendResult =
  | { ok: true; backend: FeedbackBackend }
  | { ok: false; reason: "not_logged_in" | "failed" };

async function resolveFeedbackBackend(): Promise<FeedbackBackendResult> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return { ok: false, reason: "not_logged_in" };
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return { ok: false, reason: "failed" };
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  return { ok: true, backend: { base, headers, userId: auth.viewer.id } };
}

export const getMyFarmHelperFeedback = createServerFn({ method: "GET" }).handler(
  async (): Promise<FarmHelperFeedbackListResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveFeedbackBackend();
    // A logged-out viewer genuinely has no marks; a missing backend is a failure.
    if (!cfg.ok) return { ok: cfg.reason === "not_logged_in", marks: [] };
    try {
      const response = await fetch(`${cfg.backend.base}/api/farm-helper/feedback?userId=${cfg.backend.userId}`, {
        headers: cfg.backend.headers,
      });
      if (!response.ok) return { ok: false, marks: [] };
      const body = (await response.json()) as { marks?: FarmHelperFeedbackMark[] };
      return { ok: true, marks: Array.isArray(body.marks) ? body.marks : [] };
    } catch {
      return { ok: false, marks: [] };
    }
  },
);

export const setMyFarmHelperFeedback = createServerFn({ method: "POST" })
  .validator((data: { beatmapId: number; speedBucket: string; verdict: FarmHelperFeedbackVerdict }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ ok: boolean; mark: FarmHelperFeedbackMark | null; reason?: FarmHelperFeedbackFailReason }> => {
      const { setResponseHeader } = await import("@tanstack/react-start/server");
      setResponseHeader("Cache-Control", "private, no-store");
      const cfg = await resolveFeedbackBackend();
      if (!cfg.ok) return { ok: false, mark: null, reason: cfg.reason };
      try {
        const response = await fetch(`${cfg.backend.base}/api/farm-helper/feedback/set`, {
          method: "POST",
          headers: cfg.backend.headers,
          body: JSON.stringify({
            userId: cfg.backend.userId,
            beatmapId: data.beatmapId,
            speedBucket: data.speedBucket,
            verdict: data.verdict,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          mark?: FarmHelperFeedbackMark;
          code?: string;
          error?: string;
        };
        if (response.ok && body.ok === true) return { ok: true, mark: body.mark ?? null };
        const overCap = body.code === "too_many_marks" || body.error === "too_many_marks";
        return { ok: false, mark: null, reason: overCap ? "too_many_marks" : "failed" };
      } catch {
        return { ok: false, mark: null, reason: "failed" };
      }
    },
  );

export const clearMyFarmHelperFeedback = createServerFn({ method: "POST" })
  .validator((data: { beatmapId: number; speedBucket: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; reason?: FarmHelperFeedbackFailReason }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveFeedbackBackend();
    if (!cfg.ok) return { ok: false, reason: cfg.reason };
    try {
      const response = await fetch(`${cfg.backend.base}/api/farm-helper/feedback/clear`, {
        method: "POST",
        headers: cfg.backend.headers,
        body: JSON.stringify({ userId: cfg.backend.userId, beatmapId: data.beatmapId, speedBucket: data.speedBucket }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean };
      return response.ok && body.ok === true ? { ok: true } : { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "failed" };
    }
  });
