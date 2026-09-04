import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPlayerSkillHistory } from "./player-skill-history";

const authorize = vi.hoisted(() => vi.fn());
const setHeader = vi.hoisted(() => vi.fn());
vi.mock("./auth", () => ({ requireAdminAccess: authorize }));
vi.mock("./live-backend", () => ({ getServerLiveBackendUrl: () => "http://backend.test" }));
vi.mock("@tanstack/react-start/server", () => ({ setResponseHeader: setHeader }));
// Execute the server function's validator and handler in process; the actual
// session guard and backend request remain the boundaries under test.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator: (validate: (data: unknown) => unknown) => ({
      handler: (handle: (context: { data: unknown }) => Promise<unknown>) =>
        async ({ data }: { data: unknown }) => handle({ data: validate(data) }),
    }),
  }),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  authorize.mockReset().mockResolvedValue(undefined);
  setHeader.mockReset();
  fetchMock.mockReset().mockResolvedValue(Response.json({ items: [], nextBefore: null }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("LIVE_ADMIN_TOKEN", "test-admin-token");
  vi.stubEnv("LIVE_BRIDGE_TOKEN", "test-bridge-token");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("admin skill history proxy", () => {
  it("rejects non-admin sessions before calling the backend", async () => {
    authorize.mockRejectedValue(new Error("Skill history is only available to admins."));
    await expect(fetchPlayerSkillHistory({ data: { userId: 99, keyCount: 7 } })).rejects.toThrow("only available to admins");
    expect(authorize).toHaveBeenCalledWith("Skill history");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("uses the server admin credential for authorized history pages", async () => {
    expect(await fetchPlayerSkillHistory({ data: { userId: 99, keyCount: 7, before: 123 } })).toEqual({ items: [], nextBefore: null });
    expect(fetchMock).toHaveBeenCalledWith("http://backend.test/api/profiles/99/skill-history?keys=7&before=123", expect.objectContaining({
      headers: { authorization: "Bearer test-admin-token" }, cache: "no-store",
    }));
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("fails closed when only the bridge credential is configured", async () => {
    vi.stubEnv("LIVE_ADMIN_TOKEN", "");
    await expect(fetchPlayerSkillHistory({ data: { userId: 99, keyCount: 7 } })).rejects.toThrow("LIVE_ADMIN_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates user, keymode and cursor before forwarding requests", async () => {
    for (const data of [{ userId: -1, keyCount: 7 }, { userId: 99, keyCount: 99 }, { userId: 99, keyCount: 7, before: -1 }]) {
      await expect(fetchPlayerSkillHistory({ data })).rejects.toThrow("Invalid");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
