import { createServerFn } from "@tanstack/react-start";
import { requireAdminAccess } from "./auth";
import { getServerLiveBackendUrl, type LivePlayerSkillHistoryPage } from "./live-backend";
import { adminAuthHeaders } from "./live-backend-tokens";

// Temporary admin preview: verify the session on every page of history and
// keep the backend credential on the server, like the other admin tools.
export const fetchPlayerSkillHistory = createServerFn({ method: "GET" })
  .validator((data: { userId: number; keyCount: number; before?: number }) => {
    if (!Number.isSafeInteger(data?.userId) || data.userId <= 0) throw new Error("Invalid user ID.");
    if (!Number.isInteger(data.keyCount) || data.keyCount < 4 || data.keyCount > 18) throw new Error("Invalid key count.");
    if (data.before != null && (!Number.isSafeInteger(data.before) || data.before <= 0)) throw new Error("Invalid history cursor.");
    return { userId: data.userId, keyCount: data.keyCount, before: data.before };
  })
  .handler(async ({ data }): Promise<LivePlayerSkillHistoryPage> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    await requireAdminAccess("Skill history");
    const base = getServerLiveBackendUrl();
    if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
    const headers = adminAuthHeaders();
    if (!headers.authorization) throw new Error("LIVE_ADMIN_TOKEN is not configured.");
    const query = new URLSearchParams({ keys: String(data.keyCount) });
    if (data.before != null) query.set("before", String(data.before));
    const response = await fetch(`${base}/api/profiles/${data.userId}/skill-history?${query}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Could not load skill history (${response.status}).`);
    return response.json() as Promise<LivePlayerSkillHistoryPage>;
  });
