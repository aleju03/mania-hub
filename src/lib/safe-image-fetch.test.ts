import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  fetchValidatedImage,
  isBlockedIp,
  performPinnedRequest,
  readCappedStream,
  resolvePinnedAddress,
  type PinnedTransport,
  type PinnedTransportResponse,
} from "./safe-image-fetch";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);

function fakeResponse(status: number, headers: Record<string, string>, body: Buffer = PNG_BYTES): PinnedTransportResponse {
  return { status, headers, stream: Readable.from([body]) };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("isBlockedIp", () => {
  it("blocks private, loopback, link-local, CGNAT, and reserved IPv4 ranges", () => {
    for (const ip of [
      "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3",
      "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "192.168.255.255",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", "100.127.255.255", // CGNAT
      "192.0.0.1", "192.0.2.1", // IETF assignments, TEST-NET-1
      "192.88.99.2", // deprecated 6to4 relay anycast
      "198.18.0.1", "198.19.255.255", // benchmarking
      "198.51.100.7", "203.0.113.9", // TEST-NET-2/3
      "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4 addresses, including denylist neighbours", () => {
    for (const ip of [
      "8.8.8.8", "1.1.1.1", "93.184.216.34",
      "172.15.0.1", "172.32.0.1", // outside 172.16/12
      "100.63.0.1", "100.128.0.1", // outside CGNAT
      "198.17.0.1", "198.20.0.1", // outside benchmarking
      "192.0.1.1", "192.0.3.1", // between the 192.0.x carve-outs
      "192.88.98.1", "192.88.100.1", // around the 6to4 relay block
      "9.255.255.255", "11.0.0.1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks non-global IPv6 including IPv4-mapped forms in dotted and hex notation", () => {
    for (const ip of [
      "::1", "::",
      "fe80::1", "fe80::abcd", // link-local
      "fc00::1", "fd12:3456::1", // unique-local
      "ff02::1", // multicast
      "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.1.1", // mapped, dotted
      "::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:101", // mapped, hex
      "0:0:0:0:0:ffff:7f00:1", // mapped, unabbreviated
      "::7f00:1", // deprecated IPv4-compatible
      "64:ff9b::7f00:1", // NAT64
      "100::1", // discard-only
      "2001::1", // Teredo
      "2001:2::5", // benchmarking
      "2001:1::1", "2001:100::1", "2001:1ff::1", // rest of IETF 2001::/23
      "2001:db8::1", "3fff::1", // documentation
      "2002:7f00:1::1", // 6to4
      "2003:4000::1", // just outside the allocated 2003::/18
      "2004::1", // unallocated gap inside 2000::/3
      "2d00::1", "3000::1", "3ffe::1", // IANA-reserved global-unicast space
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public global-unicast IPv6, including public IPv4-mapped answers", () => {
    for (const ip of [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2a00:1450:4001:80b::200e",
      "2001:200::1", // first hextet-pair outside 2001::/23
      "2003:3fff::1", // last address block inside 2003::/18
      "2400::1", "2410::1", "2610::1", "2620::1", "2630::1",
      "2800::1", "2a10::1", "2c00::1",
      "::ffff:8.8.8.8", "::ffff:808:808", // mapped public v4
    ]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks anything that is not a plain IP literal", () => {
    for (const ip of ["", "not-an-ip", "1.2.3", "1.2.3.4.5", "fe80::1%eth0", "999.1.1.1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });
});

describe("resolvePinnedAddress", () => {
  it("passes allowed literals through without DNS, stripping IPv6 brackets", async () => {
    const lookupFn = vi.fn();
    expect(await resolvePinnedAddress("93.184.216.34", lookupFn)).toEqual({ address: "93.184.216.34", family: 4 });
    expect(await resolvePinnedAddress("[2606:4700::1111]", lookupFn)).toEqual({ address: "2606:4700::1111", family: 6 });
    expect(await resolvePinnedAddress("127.0.0.1", lookupFn)).toBeNull();
    expect(await resolvePinnedAddress("[::1]", lookupFn)).toBeNull();
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("pins the first answer only when every answer is public", async () => {
    const pinned = await resolvePinnedAddress("img.example.test", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("rejects hostnames whose answers include any private address", async () => {
    // A public hostname resolving (partly) to a private address is a
    // rebinding/split-horizon attempt; one bad answer poisons the set.
    expect(await resolvePinnedAddress("rebind.example.test", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ])).toBeNull();
    expect(await resolvePinnedAddress("internal.example.test", async () => [
      { address: "192.168.1.10", family: 4 },
    ])).toBeNull();
    expect(await resolvePinnedAddress("empty.example.test", async () => [])).toBeNull();
    expect(await resolvePinnedAddress("nxdomain.example.test", async () => {
      throw new Error("ENOTFOUND");
    })).toBeNull();
  });
});

describe("fetchValidatedImage", () => {
  it("blocks direct private and metadata URLs before any connection", async () => {
    const transport = vi.fn<PinnedTransport>();
    for (const url of [
      "http://127.0.0.1/x.png",
      "http://[::1]/x.png",
      "http://169.254.169.254/latest/meta-data",
      "http://[::ffff:7f00:1]/x.png",
      "http://0x7f000001/x.png", // WHATWG URL canonicalizes hex IPv4 to 127.0.0.1
      "http://2130706433/x.png", // ...and decimal
    ]) {
      await expect(fetchValidatedImage(url, { signal: signal(), transport }), url)
        .rejects.toMatchObject({ status: 400, message: "Blocked host" });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects non-http protocols, credentials, and non-default ports", async () => {
    const transport = vi.fn<PinnedTransport>();
    await expect(fetchValidatedImage("ftp://img.example.test/x.png", { signal: signal(), transport }))
      .rejects.toMatchObject({ status: 400, message: "Invalid image url" });
    await expect(fetchValidatedImage("http://user:pass@img.example.test/x.png", { signal: signal(), transport }))
      .rejects.toMatchObject({ status: 400, message: "Invalid image url" });
    await expect(fetchValidatedImage("http://img.example.test:8080/x.png", { signal: signal(), transport }))
      .rejects.toMatchObject({ status: 400, message: "Blocked port" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("blocks public hostnames that resolve to private addresses", async () => {
    const transport = vi.fn<PinnedTransport>();
    await expect(fetchValidatedImage("http://img.example.test/x.png", {
      signal: signal(),
      lookupFn: async () => [{ address: "10.0.0.5", family: 4 }],
      transport,
    })).rejects.toMatchObject({ status: 400, message: "Blocked host" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("connects to the first validated DNS answer even if DNS changes afterwards", async () => {
    let lookups = 0;
    const answers = [
      [{ address: "93.184.216.34", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }], // the rebound answer must never be used
    ];
    const connected: string[] = [];
    const transport: PinnedTransport = async (_url, pinned) => {
      connected.push(pinned.address);
      return fakeResponse(200, { "content-type": "image/png" });
    };
    const result = await fetchValidatedImage("http://img.example.test/a.png", {
      signal: signal(),
      lookupFn: async () => answers[Math.min(lookups++, answers.length - 1)],
      transport,
    });
    expect(result.status).toBe(200);
    expect(lookups).toBe(1);
    expect(connected).toEqual(["93.184.216.34"]);
  });

  it("re-validates redirect hops and blocks a public-to-private redirect", async () => {
    const hosts: Record<string, string> = {
      "img.example.test": "93.184.216.34",
      "internal.example.test": "10.0.0.5",
    };
    const transport = vi.fn<PinnedTransport>(async () =>
      fakeResponse(302, { location: "http://internal.example.test/secret" }));
    await expect(fetchValidatedImage("http://img.example.test/a.png", {
      signal: signal(),
      lookupFn: async (hostname) => [{ address: hosts[hostname], family: 4 }],
      transport,
    })).rejects.toMatchObject({ status: 400, message: "Blocked host" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("follows validated public redirects and pins each hop", async () => {
    const hosts: Record<string, string> = {
      "img.example.test": "93.184.216.34",
      "cdn.example.test": "203.0.112.9",
    };
    const connected: string[] = [];
    const transport: PinnedTransport = async (url, pinned) => {
      connected.push(`${url.hostname}@${pinned.address}`);
      if (url.hostname === "img.example.test") return fakeResponse(301, { location: "https://cdn.example.test/b.png" });
      return fakeResponse(200, { "content-type": "image/png", "content-length": String(PNG_BYTES.length) });
    };
    const result = await fetchValidatedImage("http://img.example.test/a.png", {
      signal: signal(),
      lookupFn: async (hostname) => [{ address: hosts[hostname], family: 4 }],
      transport,
    });
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/png");
    expect(connected).toEqual(["img.example.test@93.184.216.34", "cdn.example.test@203.0.112.9"]);
    expect(await readCappedStream(result.stream, 1024)).toEqual(PNG_BYTES);
  });

  it("gives up after the redirect limit", async () => {
    const transport = vi.fn<PinnedTransport>(async () =>
      fakeResponse(302, { location: "http://img.example.test/loop.png" }));
    await expect(fetchValidatedImage("http://img.example.test/a.png", {
      signal: signal(),
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
    })).rejects.toMatchObject({ status: 502, message: "Too many redirects" });
    expect(transport).toHaveBeenCalledTimes(4); // initial request + 3 redirects
  });
});

describe("performPinnedRequest", () => {
  it("dials the pinned address for the socket instead of resolving DNS", async () => {
    // The hostname is under .invalid and can never resolve; the request only
    // succeeds if the socket truly goes to the pinned address.
    const server = createServer((req, res) => {
      res.setHeader("content-type", "image/png");
      res.end(`host=${req.headers.host}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await performPinnedRequest(
        new URL(`http://mania-hub-pin-test.invalid:${port}/img.png`),
        { address: "127.0.0.1", family: 4 },
        signal(),
      );
      expect(response.status).toBe(200);
      const body = await readCappedStream(response.stream, 1024);
      expect(String(body)).toBe(`host=mania-hub-pin-test.invalid:${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("identifies itself, because hosts drop a request that does not", async () => {
    // catbox resets the socket outright on a missing User-Agent, and Node sends
    // none by default - which silently broke resizing every catbox-hosted
    // profile image until the header was added.
    const server = createServer((req, res) => {
      res.setHeader("content-type", "image/png");
      res.end(`ua=${req.headers["user-agent"] ?? ""}|accept=${req.headers.accept ?? ""}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await performPinnedRequest(
        new URL(`http://mania-hub-ua-test.invalid:${port}/img.png`),
        { address: "127.0.0.1", family: 4 },
        signal(),
      );
      const body = String(await readCappedStream(response.stream, 1024));
      expect(body).toMatch(/^ua=.*mania-tracker\.com.*\|accept=image\/\*$/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("never reuses a pooled socket from a previous pin for the same host and port", async () => {
    // Two servers on the same port, different loopback addresses. With the
    // default global agent a keep-alive socket from request one would be
    // reused for request two (skipping its lookup pin entirely); agent: false
    // must dial the newly pinned address instead.
    const serverA = createServer((_req, res) => res.end("A"));
    await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve));
    const port = (serverA.address() as AddressInfo).port;
    const serverB = createServer((_req, res) => res.end("B"));
    await new Promise<void>((resolve, reject) => {
      serverB.once("error", reject);
      serverB.listen(port, "127.0.0.2", () => resolve());
    });
    try {
      const url = new URL(`http://mania-hub-pin-test.invalid:${port}/img.png`);
      const first = await performPinnedRequest(url, { address: "127.0.0.1", family: 4 }, signal());
      expect(String(await readCappedStream(first.stream, 64))).toBe("A");
      const second = await performPinnedRequest(url, { address: "127.0.0.2", family: 4 }, signal());
      expect(String(await readCappedStream(second.stream, 64))).toBe("B");
    } finally {
      await new Promise((resolve) => serverA.close(resolve));
      await new Promise((resolve) => serverB.close(resolve));
    }
  });
});

describe("readCappedStream", () => {
  it("returns the buffered body when under the cap", async () => {
    expect(await readCappedStream(Readable.from([PNG_BYTES]), 1024)).toEqual(PNG_BYTES);
  });

  it("bails out early on an oversized declared length", async () => {
    const stream = Readable.from([PNG_BYTES]);
    expect(await readCappedStream(stream, 1024, "4096")).toBeNull();
    expect(stream.destroyed).toBe(true);
  });

  it("stops reading once the streamed body exceeds the cap", async () => {
    const chunks = [Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)];
    expect(await readCappedStream(Readable.from(chunks), 1024)).toBeNull();
  });
});
