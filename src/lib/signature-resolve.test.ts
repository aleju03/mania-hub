// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSignatureResolveMemo, forgetSignatureToken, resolveSignatureToken } from "./signature-resolve";

vi.mock("./live-backend", () => ({ getServerLiveBackendUrl: () => "http://backend" }));
vi.mock("./live-backend-tokens", () => ({ bridgeAuthHeaders: () => ({}) }));
const token = "abcdefghijklmnop";
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { clearSignatureResolveMemo(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); fetchMock.mockReset(); });

describe("signature resolution", () => {
  it("collapses concurrent token lookups", async () => {
    fetchMock.mockResolvedValue(Response.json({ username: "tester" }));
    const results = await Promise.all([resolveSignatureToken(token), resolveSignatureToken(token)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
  });

  it("does not let an old lookup overwrite a mutation's new resolve", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const old = resolveSignatureToken(token);
    forgetSignatureToken(token);
    fetchMock.mockResolvedValueOnce(Response.json({ username: "new" }));
    expect((await resolveSignatureToken(token))?.username).toBe("new");
    finish(Response.json({ username: "old" }));
    await old;
    expect((await resolveSignatureToken(token))?.username).toBe("new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("memoizes a real revocation but does not turn an outage into one", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(resolveSignatureToken(token)).rejects.toThrow("offline");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await resolveSignatureToken(token)).toBeNull();
    expect(await resolveSignatureToken(token)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds fallback to the last successful resolve during an outage", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ username: "tester" }));
    await resolveSignatureToken(token);
    vi.advanceTimersByTime(11_000);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await resolveSignatureToken(token))?.username).toBe("tester");
    vi.advanceTimersByTime(15 * 60_000);
    await expect(resolveSignatureToken(token)).rejects.toThrow("offline");
  });
});
