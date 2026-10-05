import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./live-backend", () => ({ getServerLiveBackendUrl: () => "http://backend.test" }));
vi.mock("./live-backend-tokens", () => ({ adminAuthHeaders: () => ({ authorization: "Bearer admin" }) }));

import { handleCompanellaUsageApi } from "./companella-usage";

function request(auth?: string, query = ""): Request {
  return new Request(`https://mania-tracker.com/api/companella/usage${query}`, auth ? { headers: { authorization: auth } } : undefined);
}

afterEach(() => {
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
});
