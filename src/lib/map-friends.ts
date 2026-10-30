import { createServerFn } from "@tanstack/react-start";

import type { LiveMapScoresSnapshot } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";

/* The Friends map boards. A friends list is private on osu!, so both the list
   and the boards built from it go through here, for the viewer from the login
   cookie, never through the browser's own backend requests. */

export interface FriendSync {
  syncedAt: number;
  count: number;
  nextSyncAt: number;
}

function backendBase(): string | null {
  return (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "") || null;
}

async function viewerId(): Promise<number | null> {
  const { readCurrentAuth } = await import("./auth-server");
  return (await readCurrentAuth()).viewer?.id ?? null;
}

export const getMyFriendSync = createServerFn({ method: "GET" }).handler(async (): Promise<FriendSync | null> => {
  const userId = await viewerId();
  const base = backendBase();
  if (!userId || !base) return null;
  const response = await fetch(`${base}/api/session/friends?user=${userId}`, { headers: bridgeAuthHeaders() });
  if (!response.ok) return null;
  return ((await response.json()) as { sync?: FriendSync | null }).sync ?? null;
});

export const forgetMyFriends = createServerFn({ method: "POST" }).handler(async (): Promise<boolean> => {
  const userId = await viewerId();
  const base = backendBase();
  if (!userId || !base) return false;
  const response = await fetch(`${base}/api/session/friends/forget`, {
    method: "POST",
    headers: bridgeAuthHeaders(true),
    body: JSON.stringify({ userId }),
  });
  return response.ok;
});

export const getMyFriendsMapScores = createServerFn({ method: "GET" })
  .validator((data: { beatmapId?: unknown; offset?: unknown; name?: unknown }) => ({
    beatmapId: Math.max(0, Math.floor(Number(data?.beatmapId) || 0)),
    offset: Math.max(0, Math.floor(Number(data?.offset) || 0)),
    name: typeof data?.name === "string" ? data.name.slice(0, 32) : "",
  }))
  .handler(async ({ data }): Promise<LiveMapScoresSnapshot> => {
    const userId = await viewerId();
    const base = backendBase();
    if (!userId || !base || data.beatmapId <= 0) throw new Error("unavailable");
    const query = new URLSearchParams({ beatmap: String(data.beatmapId), user: String(userId), friends: "1" });
    if (data.offset) query.set("offset", String(data.offset));
    if (data.name) query.set("q", data.name);
    const response = await fetch(`${base}/api/snapshots/map-scores?${query.toString()}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) throw new Error(`map scores answered ${response.status}`);
    return (await response.json()) as LiveMapScoresSnapshot;
  });
