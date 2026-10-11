import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* Plays entered by hand (/admin/players?tab=add, backend
   integrations/companella/manual-scores.ts): old or offline plays with no
   replay, added under the player's account and listed and rated like any
   import. */

export interface ManualScoreAccount {
  userId: number;
  username: string;
  avatarUrl: string | null;
}

export interface ManualScoreJudgements {
  countGeki: number;
  count300: number;
  countKatu: number;
  count100: number;
  count50: number;
  countMiss: number;
}

export interface ManualScoreEntry {
  submissionId: string;
  scoreId: string | null;
  /** queued / validating / analyzing while it is rated, then accepted or rejected. */
  state: string;
  errorCode: string | null;
  entry: {
    beatmapId: number;
    playedAt: string;
    accuracy: number;
    mods: string[];
    judgements: ManualScoreJudgements | null;
    maxCombo: number | null;
    totalScore: number | null;
    videoUrl: string | null;
  };
  beatmap: { title: string | null; artist: string | null; version: string | null; keyCount: number | null };
  createdAt: string;
}

export interface ManualScoreInput {
  userId: number;
  beatmapId: number;
  /** YYYY-MM-DD. */
  playedAt: string;
  /** Percent, 0-100. */
  accuracy: number;
  mods: string[];
  judgements: Partial<Record<"count_geki" | "count_300" | "count_katu" | "count_100" | "count_50" | "count_miss", number>> | null;
  maxCombo: number | null;
  totalScore: number | null;
  videoUrl: string;
}

const ERRORS: Record<string, string> = {
  invalid_beatmap: "That is not a beatmap id or link.",
  invalid_date: "The date has to be a real day between 2007 and today.",
  invalid_accuracy: "Accuracy has to be above 0 and at most 100.",
  invalid_mods: "Those mods cannot be played together.",
  invalid_judgements: "The judgements have to be whole numbers, and not all zero.",
  invalid_combo: "Combo has to be a whole number.",
  invalid_score: "Score has to be a whole number up to 1,000,000.",
  invalid_video_url: "The video link has to be an http or https link.",
  unknown_user: "The site does not know this player.",
  beatmap_not_found: "osu! has no beatmap with that id.",
  not_mania: "That beatmap is not an osu!mania map.",
  chart_unavailable: "The map's .osu file could not be loaded.",
};

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: string; result?: string } | null;
  const code = body?.error ?? body?.result ?? "";
  if (code === "processing") return new Error("That play is still being rated. Try again in a moment.");
  return new Error(ERRORS[code] ?? `Server ${response.status} for /api/admin/companella/manual-scores`);
}

/** The account by username or id with its entries; null when the site does not know it. */
export const lookupManualScores = createServerFn({ method: "GET" })
  .validator((data: { user?: unknown }) => ({ user: String(data?.user ?? "").trim().replace(/^#/, "").slice(0, 40) }))
  .handler(async ({ data }): Promise<{ account: ManualScoreAccount; entries: ManualScoreEntry[] } | null> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Look up entered plays");
    const response = await adminFetch(`/api/admin/companella/manual-scores?user=${encodeURIComponent(data.user)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await failure(response);
    return await response.json() as { account: ManualScoreAccount; entries: ManualScoreEntry[] };
  });

export const addManualScore = createServerFn({ method: "POST" })
  .validator((data: ManualScoreInput) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
    return data;
  })
  .handler(async ({ data }): Promise<void> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Add a play by hand");
    const response = await adminFetch(`/api/admin/companella/manual-scores/${data.userId}`, {
      method: "POST",
      body: JSON.stringify({
        beatmap_id: data.beatmapId,
        played_at: data.playedAt,
        accuracy: data.accuracy,
        mods: data.mods,
        judgements: data.judgements,
        max_combo: data.maxCombo,
        total_score: data.totalScore,
        video_url: data.videoUrl,
      }),
    });
    if (!response.ok) throw await failure(response);
  });

/** Replaces the video link on an entry; an empty link clears it. */
export const setManualScoreVideo = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; submissionId?: unknown; videoUrl?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
    return { userId, submissionId: String(data?.submissionId ?? "").slice(0, 64), videoUrl: String(data?.videoUrl ?? "").trim().slice(0, 300) };
  })
  .handler(async ({ data }): Promise<void> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Change an entered play's video");
    const response = await adminFetch(`/api/admin/companella/manual-scores/${data.userId}/video`, {
      method: "POST",
      body: JSON.stringify({ submission_id: data.submissionId, video_url: data.videoUrl }),
    });
    if (!response.ok) throw await failure(response);
  });

export const deleteManualScore = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown; submissionId?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
    return { userId, submissionId: String(data?.submissionId ?? "").slice(0, 64) };
  })
  .handler(async ({ data }): Promise<void> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Delete an entered play");
    const response = await adminFetch(`/api/admin/companella/manual-scores/${data.userId}/delete`, {
      method: "POST",
      body: JSON.stringify({ submission_id: data.submissionId }),
    });
    if (!response.ok) throw await failure(response);
  });
