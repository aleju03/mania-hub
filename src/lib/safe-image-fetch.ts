// Server-only SSRF-hardened image fetching for the catbox proxy route.
//
// Plain fetch() after a dns.lookup() check leaves a rebinding window: the
// fetch re-resolves the hostname, so a DNS answer that changes between the
// check and the connection can steer the request at an internal host. Here
// every hop resolves once, every resolved address must pass the denylist, and
// the socket connection is pinned to the validated address via the http(s)
// `lookup` option — TLS still verifies the certificate against the hostname.

import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";

const MAX_REDIRECTS = 3;

// Only default ports: the proxy exists for public image hosts, and odd ports
// are how a "public" IP ends up pointed at someone's admin panel.
const ALLOWED_URL_PORTS = new Set(["", "80", "443"]);

export class ProxyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function isBlockedIpv4Octets(o: number[]): boolean {
  if (o.length !== 4 || o.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
  if (o[0] === 169 && o[1] === 254) return true; // link-local / cloud metadata
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 0 && (o[2] === 0 || o[2] === 2)) return true; // IETF assignments + TEST-NET-1
  if (o[0] === 192 && o[1] === 88 && o[2] === 99) return true; // deprecated 6to4 relay anycast
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // benchmarking
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true; // TEST-NET-2
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true; // TEST-NET-3
  if (o[0] >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expands a valid IPv6 literal (per net.isIP) into its 8 hextets. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.includes("%")) return null; // zone index
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const octets = dotted.slice(2).map(Number);
    if (octets.some((value) => value > 255)) return null;
    s = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill("0"), ...tail];
  const hextets = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return hextets.some(Number.isNaN) ? null : hextets;
}

function matchesIpv6Prefix(address: number[], prefix: readonly number[], prefixBits: number): boolean {
  let remaining = prefixBits;
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const width = Math.min(16, remaining);
    const mask = width === 16 ? 0xffff : (0xffff << (16 - width)) & 0xffff;
    if ((address[index] & mask) !== ((prefix[index] ?? 0) & mask)) return false;
    remaining -= width;
  }
  return remaining === 0;
}

/**
 * IANA-allocated IPv6 global-unicast prefixes, excluding special-purpose
 * blocks denied below. Space inside 2000::/3 that is absent from this list is
 * reserved for future allocation and must fail closed.
 *
 * Source: IANA IPv6 Global Unicast Address Space registry.
 */
const ALLOCATED_IPV6_GLOBAL_UNICAST: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0x2001, 0x0200], 23],
  [[0x2001, 0x0400], 23],
  [[0x2001, 0x0600], 23],
  [[0x2001, 0x0800], 22],
  [[0x2001, 0x0c00], 23],
  [[0x2001, 0x0e00], 23],
  [[0x2001, 0x1200], 23],
  [[0x2001, 0x1400], 22],
  [[0x2001, 0x1800], 23],
  [[0x2001, 0x1a00], 23],
  [[0x2001, 0x1c00], 22],
  [[0x2001, 0x2000], 19],
  [[0x2001, 0x4000], 23],
  [[0x2001, 0x4200], 23],
  [[0x2001, 0x4400], 23],
  [[0x2001, 0x4600], 23],
  [[0x2001, 0x4800], 23],
  [[0x2001, 0x4a00], 23],
  [[0x2001, 0x4c00], 23],
  [[0x2001, 0x5000], 20],
  [[0x2001, 0x8000], 19],
  [[0x2001, 0xa000], 20],
  [[0x2001, 0xb000], 20],
  [[0x2003], 18],
  [[0x2400], 12],
  [[0x2410], 12],
  [[0x2600], 12],
  [[0x2610], 23],
  [[0x2620], 23],
  [[0x2630], 12],
  [[0x2800], 12],
  [[0x2a00], 12],
  [[0x2a10], 12],
  [[0x2c00], 12],
];

function isBlockedIpv6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return true;
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0) {
    // ::ffff:0:0/96 IPv4-mapped (dotted or hex form): dual-stack sockets route
    // these to the embedded IPv4 address, so judge that address.
    if (h[5] === 0xffff) return isBlockedIpv4Octets([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
    return true; // ::, ::1, deprecated IPv4-compatible ::/96, and the rest of ::/80
  }
  // Everything outside allocated global unicast (link-local, unique-local,
  // multicast, NAT64, discard, and IANA-reserved future space) is not for us.
  if (!ALLOCATED_IPV6_GLOBAL_UNICAST.some(([prefix, bits]) => matchesIpv6Prefix(h, prefix, bits))) return true;
  if (h[0] === 0x2001 && h[1] <= 0x01ff) return true; // IETF 2001::/23 (Teredo, benchmarking, ORCHID, ...)
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
  if (h[0] === 0x2002) return true; // 6to4 (embeds an IPv4)
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return true; // documentation (RFC 9637)
  return false;
}

/** True for loopback / private / link-local / reserved literals, v4 and v6. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4Octets(ip.split(".").map(Number));
  if (version === 6) return isBlockedIpv6(ip);
  return true; // not a literal IP we understand -> err on the safe side
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolves a hostname once and returns the address the connection must use,
 * or null when any resolved address (or the literal itself) is internal — a
 * mixed public/private answer is treated as a rebinding attempt.
 */
export async function resolvePinnedAddress(hostname: string, lookupFn: LookupFn = defaultLookup): Promise<PinnedAddress | null> {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  const literal = isIP(host);
  if (literal === 4 || literal === 6) {
    return isBlockedIp(host) ? null : { address: host, family: literal };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookupFn(host);
  } catch {
    return null;
  }
  if (addresses.length === 0) return null;
  if (addresses.some((entry) => isBlockedIp(entry.address))) return null;
  return { address: addresses[0].address, family: addresses[0].family === 6 ? 6 : 4 };
}

export interface PinnedTransportResponse {
  status: number;
  headers: IncomingHttpHeaders;
  stream: Readable;
}

export type PinnedTransport = (url: URL, pinned: PinnedAddress, signal: AbortSignal) => Promise<PinnedTransportResponse>;

/**
 * Issues the request over a socket dialed at the pinned address, regardless of
 * what DNS would say now. For https the URL's hostname still drives SNI and
 * certificate verification.
 */
export const performPinnedRequest: PinnedTransport = (url, pinned, signal) =>
  new Promise((resolve, reject) => {
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    // agent: false — the default global agent pools keep-alive sockets by
    // host:port, and a reused socket would skip the lookup pin entirely.
    const request = requestFn(url, { signal, lookup, agent: false, headers: { Accept: "image/*" } }, (response) => {
      resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response });
    });
    request.on("error", reject);
    request.end();
  });

export interface ValidatedImageResponse {
  status: number;
  contentType: string | null;
  contentLength: string | null;
  stream: Readable;
}

export interface FetchValidatedImageOptions {
  signal: AbortSignal;
  lookupFn?: LookupFn;
  transport?: PinnedTransport;
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** Fetches an image URL with protocol, port, denylist, and pinning checks applied to the URL and to every redirect hop. */
export async function fetchValidatedImage(rawUrl: string, options: FetchValidatedImageOptions): Promise<ValidatedImageResponse> {
  const { signal, lookupFn = defaultLookup, transport = performPinnedRequest } = options;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new ProxyError("Invalid image url", 400);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ProxyError("Invalid image url", 400);
    if (url.username || url.password) throw new ProxyError("Invalid image url", 400);
    if (!ALLOWED_URL_PORTS.has(url.port)) throw new ProxyError("Blocked port", 400);
    const pinned = await resolvePinnedAddress(url.hostname, lookupFn);
    if (!pinned) throw new ProxyError("Blocked host", 400);
    let response: PinnedTransportResponse;
    try {
      response = await transport(url, pinned, signal);
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      throw new ProxyError(signal.aborted ? "Image fetch timed out" : "Image fetch failed", signal.aborted ? 504 : 502);
    }
    const location = headerValue(response.headers.location);
    if (response.status >= 300 && response.status < 400 && location) {
      response.stream.destroy();
      try {
        current = new URL(location, url).toString();
      } catch {
        throw new ProxyError("Invalid image url", 400);
      }
      continue;
    }
    return {
      status: response.status,
      contentType: headerValue(response.headers["content-type"]),
      contentLength: headerValue(response.headers["content-length"]),
      stream: response.stream,
    };
  }
  throw new ProxyError("Too many redirects", 502);
}

/** Buffers a response stream, returning null as soon as it exceeds `cap`. */
export async function readCappedStream(stream: Readable, cap: number, declaredLength?: string | null): Promise<Buffer | null> {
  const declared = Number(declaredLength);
  if (Number.isFinite(declared) && declared > cap) {
    stream.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > cap) {
      stream.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
