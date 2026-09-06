import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLivePlayerSkillHistoryDirect } from "./live-backend";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(Response.json({ items: [], nextBefore: null }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VITE_LIVE_BACKEND_URL", "http://backend.test");
  vi.stubEnv("LIVE_ADMIN_TOKEN", "");
  vi.stubEnv("LIVE_BRIDGE_TOKEN", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("public skill history fetcher", () => {
  it("loads paginated history without credentials and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    expect(await fetchLivePlayerSkillHistoryDirect(99, 7, { before: 123, signal })).toEqual({ items: [], nextBefore: null });
    expect(fetchMock).toHaveBeenCalledWith("http://backend.test/api/profiles/99/skill-history?keys=7&before=123", {
      credentials: "omit", cache: "no-store", signal,
    });
  });

  it("validates user, keymode and cursor before forwarding requests", async () => {
    for (const data of [{ userId: -1, keyCount: 7 }, { userId: 99, keyCount: 99 }, { userId: 99, keyCount: 7, before: -1 }]) {
      await expect(fetchLivePlayerSkillHistoryDirect(data.userId, data.keyCount, data)).rejects.toThrow("Invalid");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
