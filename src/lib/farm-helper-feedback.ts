import { createServerFn } from "@tanstack/react-start";

import type { LiveFarmHelperSnapshot } from "./live-backend";
import { liveBridgeToken } from "./live-backend-tokens";

// Bridge to the live-backend farm helper feedback API. Every call resolves the osu! viewer from
// the signed login cookie server-side and forwards that id with the bridge token (the goals
// pattern), so a logged-in user can only ever read or mutate their own marks. The browser never
// sends a user id and never sees the bridge token.

export type FarmHelperFeedbackVerdict = "too_hard" | "too_easy" | "maxed";

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
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
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

/* The player's own board, fetched server-side so the request can carry proof of
   who is asking. The marks a player leaves are private - every other route that
   reads them goes through this same bridge - but they also ride the snapshot as
   per-rec tags and the "hidden by your feedback" counter, and the snapshot
   endpoint names its subject in a query string anyone can type. So the backend
   only builds those fields in for a request that forwards an osu!-verified
   viewer id, which is this. Anyone else reads the same board over the public
   endpoint, with no trace of what its subject marked.

   Returns null when nobody is signed in or the backend is unconfigured; the
   caller then takes the ordinary public path. */
export const getOwnFarmHelperSnapshot = createServerFn({ method: "GET" })
  .validator((data: { user: string; keyMode?: string; view?: string; limit?: number }) => data)
  .handler(async ({ data }): Promise<{ ok: true; snapshot: LiveFarmHelperSnapshot } | { ok: false; status: number | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveFeedbackBackend();
    if (!cfg.ok) return { ok: false, status: null };
    // The subject comes from the verified session, not caller-controlled server
    // function input. Besides preserving feedback ownership, this is what lets
    // the backend allow one exception to its known-subject gate: a new player
    // may cold-mint their own profile, never an arbitrary account.
    const query = new URLSearchParams({ user: String(cfg.backend.userId), viewerUserId: String(cfg.backend.userId) });
    if (data.keyMode) query.set("key", data.keyMode);
    if (data.view) query.set("view", data.view);
    if (data.limit != null) query.set("limit", String(data.limit));
    try {
      const response = await fetch(`${cfg.backend.base}/api/snapshots/farm-helper?${query.toString()}`, {
        headers: cfg.backend.headers,
      });
      if (!response.ok) return { ok: false, status: response.status };
      return { ok: true, snapshot: (await response.json()) as LiveFarmHelperSnapshot };
    } catch {
      return { ok: false, status: null };
    }
  });
