import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./live-backend", () => ({ getServerLiveBackendUrl: () => "http://backend.test" }));
vi.mock("./live-backend-tokens", () => ({ adminAuthHeaders: () => ({ authorization: "Bearer admin" }) }));

async function handleCompanellaUsageApi(request: Request): Promise<Response> {
  // A fresh module per call site keeps the cache and the rate window per test.
  return (await import("./companella-usage")).handleCompanellaUsageApi(request);
}

function request(auth?: string, query = ""): Request {
  return new Request(`https://mania-tracker.com/api/companella/usage${query}`, auth ? { headers: { authorization: auth } } : undefined);
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the Companella usage API", () => {
  it("is off while no key is set", async () => {
    vi.stubEnv("COMPANELLA_USAGE_API_KEY", "");
    expect((await handleCompanellaUsageApi(request("Bearer anything"))).status).toBe(404);
  });

  it("refuses a missing or wrong key without asking the backend", async () => {
    vi.stubEnv("COMPANELLA_USAGE_API_KEY", "right-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await handleCompanellaUsageApi(request())).status).toBe(401);
    expect((await handleCompanellaUsageApi(request("Bearer wrong-key"))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the backend's usage for the right key, uncached", async () => {
    vi.stubEnv("COMPANELLA_USAGE_API_KEY", "right-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ days: 7 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleCompanellaUsageApi(request("Bearer right-key", "?days=7"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ days: 7 });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://backend.test/api/admin/companella/usage?days=7");
  });

  it("serves a copy for a minute and refuses past 30 requests a minute", async () => {
    vi.stubEnv("COMPANELLA_USAGE_API_KEY", "right-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ days: 30 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await handleCompanellaUsageApi(request("Bearer right-key"))).status);
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    const limited = await handleCompanellaUsageApi(request("Bearer right-key"));
    expect(statuses[30]).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
