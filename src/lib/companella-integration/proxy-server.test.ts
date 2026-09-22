import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forwardNativeRequest, trustedEdgeCountry } from "./proxy-server";

/*
 * The proxy's whole job is to be untrustworthy-input-proof at the header
 * level, so these tests are mostly about what does NOT get forwarded.
 */

const BACKEND = "http://127.0.0.1:7227";
let calls: Array<{ url: string; init: RequestInit }> = [];

function mockBackend(response: Response) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return response;
  }));
}

let previousViteUrl: string | undefined;

beforeEach(() => {
  previousViteUrl = process.env.VITE_LIVE_BACKEND_URL;
  process.env.LIVE_BACKEND_URL = BACKEND;
  process.env.LIVE_BRIDGE_TOKEN = "bridge-token-value";
  delete process.env.TRUST_PROXY_HEADERS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LIVE_BACKEND_URL;
  delete process.env.LIVE_BRIDGE_TOKEN;
  delete process.env.TRUST_PROXY_HEADERS;
  if (previousViteUrl == null) delete process.env.VITE_LIVE_BACKEND_URL;
  else process.env.VITE_LIVE_BACKEND_URL = previousViteUrl;
});

function headersOf(index = 0): Record<string, string> {
  return (calls[index].init.headers ?? {}) as Record<string, string>;
}

describe("native proxy", () => {
  it("moves the client's credentials aside and puts the bridge token in Authorization", async () => {
    mockBackend(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const request = new Request("https://mania-tracker.com/api/integrations/companella/v1/me", {
      headers: { authorization: "DPoP cmp_at_abc", dpop: "proof.value.here" },
    });
    await forwardNativeRequest(request, "me");
    expect(calls[0].url).toBe(`${BACKEND}/api/integrations/companella/native/me`);
    const headers = headersOf();
    expect(headers.authorization).toBe("Bearer bridge-token-value");
    expect(headers["x-companella-authorization"]).toBe("DPoP cmp_at_abc");
    expect(headers["x-companella-dpop"]).toBe("proof.value.here");
  });

  it("never forwards an internal header the caller supplied", async () => {
    mockBackend(new Response("{}", { status: 200 }));
    const request = new Request("https://mania-tracker.com/api/integrations/companella/v1/me", {
      headers: {
        authorization: "DPoP cmp_at_abc",
        // Every one of these would be a privilege escalation if it survived.
        "x-companella-actor": "7095193",
        "x-companella-actor-name": "owner",
        "x-companella-actor-auth-at": String(Date.now()),
        "x-companella-country": "KR",
        "cf-ipcountry": "KR",
        "x-forwarded-host": "evil.example",
      },
    });
    await forwardNativeRequest(request, "me");
    const headers = headersOf();
    expect(headers["x-companella-actor"]).toBeUndefined();
    expect(headers["x-companella-actor-name"]).toBeUndefined();
    expect(headers["x-companella-actor-auth-at"]).toBeUndefined();
    // The country header is not trusted without the deployment switch, so it
    // is absent even though the request carried one.
    expect(headers["x-companella-country"]).toBeUndefined();
    expect(calls[0].url.startsWith(BACKEND)).toBe(true);
  });

  it("passes the edge country only when the deployment says it sits behind one", async () => {
    const request = new Request("https://mania-tracker.com/x", { headers: { "cf-ipcountry": "CR" } });
    expect(trustedEdgeCountry(request, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(trustedEdgeCountry(request, { TRUST_PROXY_HEADERS: "1" } as NodeJS.ProcessEnv)).toBe("CR");
    // Cloudflare's own unknown markers are not countries.
    expect(trustedEdgeCountry(
      new Request("https://mania-tracker.com/x", { headers: { "cf-ipcountry": "XX" } }),
      { TRUST_PROXY_HEADERS: "1" } as NodeJS.ProcessEnv,
    )).toBeNull();
    expect(trustedEdgeCountry(
      new Request("https://mania-tracker.com/x", { headers: { "cf-ipcountry": "T1" } }),
      { TRUST_PROXY_HEADERS: "1" } as NodeJS.ProcessEnv,
    )).toBeNull();
  });

  it("refuses a submission id outside the id alphabet instead of putting it in a path", async () => {
    mockBackend(new Response("{}", { status: 200 }));
    const request = new Request("https://mania-tracker.com/x", { method: "GET" });
    const response = await forwardNativeRequest(request, "submissionRead", { id: "../../admin" });
    expect(response.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("builds the destination from the route table, never from the incoming path", async () => {
    mockBackend(new Response("{}", { status: 200 }));
    const request = new Request("https://mania-tracker.com/api/integrations/companella/v1/anything/at/all");
    await forwardNativeRequest(request, "capabilities");
    expect(calls[0].url).toBe(`${BACKEND}/api/integrations/companella/native/capabilities`);
  });

  it("does not follow a redirect with credentials attached", async () => {
    mockBackend(new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    const request = new Request("https://mania-tracker.com/x");
    const response = await forwardNativeRequest(request, "me");
    expect(response.status).toBe(502);
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("marks every answer no-store and passes the auth challenge headers back", async () => {
    mockBackend(new Response("{}", {
      status: 401,
      headers: { "www-authenticate": "DPoP", "dpop-nonce": "nonce-value", "content-type": "application/json" },
    }));
    const response = await forwardNativeRequest(new Request("https://mania-tracker.com/x"), "me");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toBe("DPoP");
    expect(response.headers.get("dpop-nonce")).toBe("nonce-value");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses an oversized body before it reaches the backend", async () => {
    mockBackend(new Response("{}", { status: 200 }));
    const request = new Request("https://mania-tracker.com/x", {
      method: "PUT",
      headers: { "content-length": String(64 * 1024 * 1024) },
      body: "x",
    });
    const response = await forwardNativeRequest(request, "submissionReplay", { id: "abcdefgh1234" });
    expect(response.status).toBe(413);
    expect(calls.length).toBe(0);
  });

  it("answers a real error rather than pretending when the backend is not configured", async () => {
    delete process.env.LIVE_BACKEND_URL;
    delete process.env.VITE_LIVE_BACKEND_URL;
    mockBackend(new Response("{}", { status: 200 }));
    const response = await forwardNativeRequest(new Request("https://mania-tracker.com/x"), "me");
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("integration_unavailable");
    expect(body.error.retryable).toBe(true);
    expect(calls.length).toBe(0);
  });
});
