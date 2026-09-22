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

  it("refuses an upload without credentials before reading a byte of it", async () => {
    mockBackend(new Response("{}", { status: 200 }));
    const request = new Request("https://mania-tracker.com/x", { method: "PUT", body: "replay bytes" });
    const response = await forwardNativeRequest(request, "submissionReplay", { id: "abcdefgh1234" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("DPoP");
    expect(request.bodyUsed).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("refuses a token request without a proof in the OAuth error shape", async () => {
    mockBackend(new Response("{}", { status: 200 }));
    const request = new Request("https://mania-tracker.com/x", { method: "POST", body: "{}" });
    const response = await forwardNativeRequest(request, "token");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_dpop_proof" });
    expect(request.bodyUsed).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("caps a JSON route far below the upload ceiling", async () => {
    mockBackend(new Response("{}", { status: 200 }));
    const request = new Request("https://mania-tracker.com/x", {
      method: "POST",
      headers: { authorization: "DPoP cmp_at_abc", dpop: "proof", "content-length": String(1024 * 1024) },
      body: "x",
    });
    const response = await forwardNativeRequest(request, "submissions");
    expect(response.status).toBe(413);
    expect(calls.length).toBe(0);
  });

  it("streams an upload to the backend rather than buffering it first", async () => {
    const bytes = new Uint8Array(50_000).map((_, index) => index % 251);
    let received: Uint8Array | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit & { duplex?: string } = {}) => {
      calls.push({ url: String(input), init });
      // Handed over as a stream: the backend authenticates on arrival and
      // only then reads the file, however long the upload takes.
      expect(init.body).toBeInstanceOf(ReadableStream);
      expect(init.duplex).toBe("half");
      received = new Uint8Array(await new Response(init.body).arrayBuffer());
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    calls = [];
    const request = new Request("https://mania-tracker.com/x", {
      method: "PUT",
      headers: { authorization: "DPoP cmp_at_abc", dpop: "proof", "content-type": "application/octet-stream" },
      body: bytes,
    });
    const response = await forwardNativeRequest(request, "submissionReplay", { id: "abcdefgh1234" });
    expect(response.status).toBe(200);
    expect(received).toEqual(bytes);
  });

  it("stops a body that outgrows its route's ceiling without a declared length", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
      await new Response(init.body).arrayBuffer();
      return new Response("{}", { status: 200 });
    }));
    const chunk = new Uint8Array(16 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("https://mania-tracker.com/x", {
      method: "POST",
      headers: { authorization: "DPoP cmp_at_abc", dpop: "proof" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await forwardNativeRequest(request, "submissions");
    expect(response.status).toBe(413);
  });

  it("forwards no body on a route that takes none", async () => {
    mockBackend(new Response("{}", { status: 202 }));
    const request = new Request("https://mania-tracker.com/x", {
      method: "POST",
      headers: { authorization: "DPoP cmp_at_abc", dpop: "proof", "content-type": "application/json" },
      body: "{\"unexpected\":true}",
    });
    await forwardNativeRequest(request, "submissionComplete", { id: "abcdefgh1234" });
    expect(calls[0].init.body).toBeUndefined();
    expect(headersOf()["content-type"]).toBeUndefined();
  });

  it("replaces a backend failure that is not an error envelope", async () => {
    mockBackend(new Response(JSON.stringify({ error: "SQLITE_ERROR: no such column: companella_secret" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    const response = await forwardNativeRequest(new Request("https://mania-tracker.com/x"), "me");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("SQLITE");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "internal_error", retryable: true } });
  });

  it("passes a deliberate 5xx envelope through, and answers OAuth failures in their own shape", async () => {
    const envelope = { error: { code: "storage_unavailable", message: "Try again later.", retryable: true }, request_id: "r", submission_id: null };
    mockBackend(new Response(JSON.stringify(envelope), { status: 503, headers: { "content-type": "application/json", "retry-after": "30" } }));
    const passed = await forwardNativeRequest(new Request("https://mania-tracker.com/x"), "me");
    expect(passed.status).toBe(503);
    expect(await passed.json()).toEqual(envelope);
    expect(passed.headers.get("retry-after")).toBe("30");

    mockBackend(new Response("upstream exploded", { status: 500 }));
    const oauth = await forwardNativeRequest(new Request("https://mania-tracker.com/x", {
      method: "POST", headers: { dpop: "proof", "content-type": "application/json" }, body: "{}",
    }), "token");
    expect(oauth.status).toBe(500);
    expect(await oauth.json()).toEqual({ error: "server_error" });
  });

  it("keeps the OAuth shape on the token endpoint when the backend is not configured", async () => {
    delete process.env.LIVE_BACKEND_URL;
    delete process.env.VITE_LIVE_BACKEND_URL;
    mockBackend(new Response("{}", { status: 200 }));
    const response = await forwardNativeRequest(new Request("https://mania-tracker.com/x", {
      method: "POST", headers: { dpop: "proof", "content-type": "application/json" }, body: "{}",
    }), "token");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "integration_unavailable" });
    expect(calls.length).toBe(0);
  });
});
