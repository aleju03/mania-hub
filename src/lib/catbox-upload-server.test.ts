import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthCookieHeader } from "./auth-server";
import { handleCatboxProxyGet, handleCatboxUploadPost, type UploadTestSeams } from "./catbox-upload-server";
import type { PinnedTransportResponse } from "./safe-image-fetch";

const ORIGIN = "https://mania-tracker.com";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);

// Rate-limit windows are module state keyed by viewer id, so every test uses
// its own viewer to stay independent.
let nextViewerId = 9000;

async function authCookie(id: number): Promise<string> {
  const header = await createAuthCookieHeader(
    { id, username: `tester${id}`, avatarUrl: "", countryCode: "CR" },
    new Request(`${ORIGIN}/`),
  );
  return header.split(";")[0];
}

interface RequestOptions {
  cookie?: string;
  fetchSite?: string | null;
}

function postRequest(body: Buffer, contentType: string, { cookie, fetchSite = "same-origin" }: RequestOptions = {}): Request {
  return new Request(`${ORIGIN}/api/catbox-upload`, {
    method: "POST",
    body: body as unknown as BodyInit,
    headers: {
      "content-type": contentType,
      ...(fetchSite ? { "sec-fetch-site": fetchSite } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
}

function getRequest(target: string, { cookie, fetchSite = "same-origin" }: RequestOptions = {}): Request {
  return new Request(`${ORIGIN}/api/catbox-upload?url=${encodeURIComponent(target)}`, {
    headers: {
      ...(fetchSite ? { "sec-fetch-site": fetchSite } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
}

type StoreSeam = NonNullable<UploadTestSeams["store"]>;

/** Stands in for the R2 write, recording what the handler decided to store. */
function stubStore(): ReturnType<typeof vi.fn<StoreSeam>> {
  return vi.fn<StoreSeam>(async (_buffer, mime) => ({
    url: `https://cdn.mania-tracker.com/bbcode/deadbeef.${mime.split("/")[1]}`,
    key: `bbcode/deadbeef.${mime.split("/")[1]}`,
  }));
}

function imageResponse(status: number, headers: Record<string, string>, body: Buffer = PNG_BYTES): PinnedTransportResponse {
  return { status, headers, stream: Readable.from([body]) };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

beforeAll(() => {
  process.env.AUTH_SESSION_SECRET = "vitest-catbox-secret-vitest-catbox-secret";
  delete process.env.ENABLE_LOCAL_DEV_ADMIN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleCatboxUploadPost", () => {
  it("requires a signed session", async () => {
    const store = stubStore();
    const response = await handleCatboxUploadPost(postRequest(PNG_BYTES, "image/png"), { store });
    expect(response.status).toBe(401);
    expect(store).not.toHaveBeenCalled();
  });

  it("rejects an unsigned tampered cookie", async () => {
    const cookie = await authCookie(nextViewerId++);
    const tampered = `${cookie.slice(0, -4)}AAAA`;
    const response = await handleCatboxUploadPost(postRequest(PNG_BYTES, "image/png", { cookie: tampered }));
    expect(response.status).toBe(401);
  });

  it("rejects cross-site and same-site requests even with a valid session", async () => {
    const cookie = await authCookie(nextViewerId++);
    for (const fetchSite of ["cross-site", "same-site", "none"]) {
      const response = await handleCatboxUploadPost(postRequest(PNG_BYTES, "image/png", { cookie, fetchSite }));
      expect(response.status, fetchSite).toBe(403);
    }
  });

  it("falls back to a full-origin match when Sec-Fetch-Site is absent", async () => {
    function requestWithOrigin(origin?: string): Request {
      return new Request(`${ORIGIN}/api/catbox-upload`, {
        method: "POST",
        body: PNG_BYTES as unknown as BodyInit,
        headers: { "content-type": "image/png", ...(origin ? { origin } : {}) },
      });
    }
    // A matching full origin clears the same-origin gate (401 = auth is next).
    expect((await handleCatboxUploadPost(requestWithOrigin(ORIGIN))).status).toBe(401);
    // Host alone is not enough: the scheme must match too.
    expect((await handleCatboxUploadPost(requestWithOrigin("http://mania-tracker.com"))).status).toBe(403);
    expect((await handleCatboxUploadPost(requestWithOrigin("https://evil.example"))).status).toBe(403);
    expect((await handleCatboxUploadPost(requestWithOrigin())).status).toBe(403);
  });

  it("stores a valid image, typed from its sniffed bytes, and returns its URL", async () => {
    const store = stubStore();
    const viewerId = nextViewerId++;
    const cookie = await authCookie(viewerId);
    // Claimed webp, actually png: the sniffed type wins.
    const response = await handleCatboxUploadPost(postRequest(PNG_BYTES, "image/webp", { cookie }), { store });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://cdn.mania-tracker.com/bbcode/deadbeef.png" });
    const [buffer, mime, uploadedBy] = store.mock.calls[0] ?? [];
    expect(buffer).toEqual(PNG_BYTES);
    expect(mime).toBe("image/png");
    // Stored alongside the object so a takedown can be traced to an account.
    expect(uploadedBy).toBe(`user:${viewerId}`);
  });

  it("rejects bodies that are not really images without storing anything", async () => {
    const store = stubStore();
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxUploadPost(
      postRequest(Buffer.from("<html>not an image</html>"), "image/png", { cookie }),
      { store },
    );
    expect(response.status).toBe(415);
    expect(store).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies", async () => {
    const store = stubStore();
    const cookie = await authCookie(nextViewerId++);
    // Sized to sit just past the cap, so this fails if the limit is raised
    // without a deliberate decision rather than only on absurd inputs.
    const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    const response = await handleCatboxUploadPost(postRequest(oversized, "image/png", { cookie }), { store });
    expect(response.status).toBe(413);
    expect(store).not.toHaveBeenCalled();
  });

  // Cloudflare replaces 502 and 504 origin responses with its own error page,
  // body included, so reporting a storage failure with either code costs the
  // user the only sentence that explains it. This is not hypothetical: catbox
  // paused uploads on 2026-08-03 and the editor showed a bare "Bad gateway".
  it("reports a storage failure with a status the edge forwards, quoting the reason", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxUploadPost(postRequest(PNG_BYTES, "image/png", { cookie }), {
      store: async () => {
        throw new Error("NoSuchBucket: the specified bucket does not exist");
      },
    });
    expect(response.status).not.toBe(502);
    expect(response.status).not.toBe(504);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("NoSuchBucket");
  });

  it("keeps a sprawling storage error out of the message it shows", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxUploadPost(postRequest(PNG_BYTES, "image/png", { cookie }), {
      store: async () => {
        throw new Error(`<html><body>${"upstream connect error ".repeat(40)}</body></html>`);
      },
    });
    const { error } = await response.json();
    expect(error).not.toContain("<");
    expect(error.length).toBeLessThan(220);
  });

  it("rate limits repeated uploads per viewer", async () => {
    const store = stubStore();
    const cookie = await authCookie(nextViewerId++);
    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      const response = await handleCatboxUploadPost(postRequest(PNG_BYTES, "image/png", { cookie }), { store });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 12)).toEqual(Array(12).fill(200));
    expect(statuses[12]).toBe(429);
  });
});

describe("handleCatboxProxyGet", () => {
  it("requires a signed session", async () => {
    const response = await handleCatboxProxyGet(getRequest("https://img.example.test/a.png"));
    expect(response.status).toBe(401);
  });

  it("rejects cross-site requests", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxProxyGet(getRequest("https://img.example.test/a.png", { cookie, fetchSite: "cross-site" }));
    expect(response.status).toBe(403);
  });

  it("requires a url parameter", async () => {
    const cookie = await authCookie(nextViewerId++);
    const request = new Request(`${ORIGIN}/api/catbox-upload`, {
      headers: { "sec-fetch-site": "same-origin", cookie },
    });
    expect((await handleCatboxProxyGet(request)).status).toBe(400);
  });

  it("blocks private targets outright", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxProxyGet(getRequest("http://127.0.0.1/a.png", { cookie }));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Blocked host");
  });

  it("blocks public hostnames resolving to private addresses", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxProxyGet(getRequest("https://img.example.test/a.png", { cookie }), {
      lookupFn: async () => [{ address: "192.168.1.7", family: 4 }],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Blocked host");
  });

  it("serves a validated image relabelled from its sniffed bytes", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxProxyGet(getRequest("https://img.example.test/a.png", { cookie }), {
      lookupFn: publicLookup,
      // Upstream lies and says jpeg; the bytes are png.
      transport: async () => imageResponse(200, { "content-type": "image/jpeg" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("rejects upstream responses that are not images by header or by bytes", async () => {
    const cookie = await authCookie(nextViewerId++);
    const byHeader = await handleCatboxProxyGet(getRequest("https://img.example.test/a.png", { cookie }), {
      lookupFn: publicLookup,
      transport: async () => imageResponse(200, { "content-type": "text/html" }, Buffer.from("<html></html>")),
    });
    expect(byHeader.status).toBe(415);
    const byBytes = await handleCatboxProxyGet(getRequest("https://img.example.test/b.png", { cookie }), {
      lookupFn: publicLookup,
      transport: async () => imageResponse(200, { "content-type": "image/png" }, Buffer.from("<html></html>")),
    });
    expect(byBytes.status).toBe(415);
  });

  it("rate limits repeated proxy loads per viewer", async () => {
    const cookie = await authCookie(nextViewerId++);
    // The rate check runs before target parsing, so url-less requests (400)
    // exercise the window without any transport round-trips.
    const request = new Request(`${ORIGIN}/api/catbox-upload`, {
      headers: { "sec-fetch-site": "same-origin", cookie },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push((await handleCatboxProxyGet(request)).status);
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(400));
    expect(statuses[30]).toBe(429);
  });

  it("reports a failed upstream fetch with an edge-visible status", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxProxyGet(getRequest("https://img.example.test/a.png", { cookie }), {
      lookupFn: publicLookup,
      transport: async () => imageResponse(404, { "content-type": "text/html" }),
    });
    expect(response.status).toBe(503);
  });

  it("rejects oversized upstream bodies", async () => {
    const cookie = await authCookie(nextViewerId++);
    const response = await handleCatboxProxyGet(getRequest("https://img.example.test/a.png", { cookie }), {
      lookupFn: publicLookup,
      transport: async () => imageResponse(200, { "content-type": "image/png", "content-length": String(64 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});
