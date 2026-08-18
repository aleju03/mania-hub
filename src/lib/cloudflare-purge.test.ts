// @vitest-environment node
/* The purge is what makes a block mean "gone now" rather than "gone in five
   minutes". Two properties matter: it must never throw into the moderation
   action that already succeeded, and it must not silently claim success when
   it is not configured. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCloudflarePurgeConfigured, purgeCloudflareUrls } from "./cloudflare-purge";

const ORIGINAL = { token: process.env.CLOUDFLARE_API_TOKEN, zone: process.env.CLOUDFLARE_ZONE_ID };

let fetchMock: ReturnType<typeof vi.fn>;

function configure(on: boolean): void {
  if (on) {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ZONE_ID = "test-zone";
  } else {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ZONE_ID;
  }
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  configure(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = ORIGINAL.token;
  if (ORIGINAL.zone === undefined) delete process.env.CLOUDFLARE_ZONE_ID;
  else process.env.CLOUDFLARE_ZONE_ID = ORIGINAL.zone;
});

const url = (n: number) => `https://mania-tracker.com/api/signature/tok/maniacard-${n}.png`;

describe("purgeCloudflareUrls", () => {
  it("posts the urls to the zone's purge endpoint", async () => {
    const result = await purgeCloudflareUrls([url(1), url(2)]);
    expect(result).toEqual({ configured: true, purged: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://api.cloudflare.com/client/v4/zones/test-zone/purge_cache");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ files: [url(1), url(2)] });
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test-token" });
  });

  it("deduplicates, so twelve variants are not asked for twice", async () => {
    await purgeCloudflareUrls([url(1), url(1), url(2)]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).files).toEqual([url(1), url(2)]);
  });

  /* Cloudflare rejects more than 30 files per call on the plans this site is
     on, so a long list has to arrive as several calls rather than one refusal. */
  it("splits past the per-call limit", async () => {
    const many = Array.from({ length: 65 }, (_, index) => url(index));
    const result = await purgeCloudflareUrls(many);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.purged).toBe(65);
  });

  it("reports unconfigured rather than pretending to have purged", async () => {
    configure(false);
    expect(isCloudflarePurgeConfigured()).toBe(false);
    const result = await purgeCloudflareUrls([url(1)]);
    expect(result).toEqual({ configured: false, purged: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts a rejection as failed instead of throwing", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(purgeCloudflareUrls([url(1)])).resolves.toMatchObject({ failed: 1, purged: 0 });
  });

  /* The block already succeeded by the time this runs. A network error here
     must not propagate and turn a successful moderation into an error toast. */
  it("swallows a network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(purgeCloudflareUrls([url(1)])).resolves.toMatchObject({ failed: 1 });
  });

  it("does nothing for an empty list", async () => {
    await purgeCloudflareUrls([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores anything that is not an https url", async () => {
    await purgeCloudflareUrls(["http://mania-tracker.com/a.png", "not a url", url(1)]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).files).toEqual([url(1)]);
  });
});
