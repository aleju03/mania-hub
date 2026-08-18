const PRIMARY_SITE_ORIGIN = "https://mania-tracker.com";
const PRIMARY_SITE_HOSTS = ["mania-tracker.com", "www.mania-tracker.com"];
/** The dev/admin host. It has to resolve to itself rather than to the
    production alias: dev and admin features key off this exact hostname
    (allowsOsuDevAccess in auth-server.ts) and it registers its own osu!
    redirect uri. */
const DEV_SITE_HOST = "ninja.mania-tracker.com";
const DEV_SITE_ORIGIN = `https://${DEV_SITE_HOST}`;
/** Wildcard host suffixes are a development affordance: a localtunnel (phone
    testing) or a throwaway preview deployment needs its own host treated as
    ours. In production they are a foothold - any `*.loca.lt` host an attacker
    registers would be an allowed host - so they are off unless something asks
    for them. `MANIA_HUB_ALLOWED_HOST_SUFFIXES` overrides the defaults. */
const DEV_ALLOWED_HOST_SUFFIXES = [".vercel.app", ".loca.lt"];

function getAllowedHostSuffixes(): string[] {
  const configured = (readEnv("MANIA_HUB_ALLOWED_HOST_SUFFIXES") ?? "")
    .split(",")
    .map((suffix) => suffix.trim().toLowerCase())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  // Preview deployments are the platform's own hosts, so they stay allowed
  // there without a manual list.
  if (readEnv("VERCEL")) return [".vercel.app"];
  return readEnv("NODE_ENV") === "production" ? [] : DEV_ALLOWED_HOST_SUFFIXES;
}

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function normalizeOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  if (!first || /[\r\n]/.test(first)) return null;
  return first;
}

function normalizeHost(value: string | null): string | null {
  const host = firstHeaderValue(value)?.toLowerCase();
  if (!host || host.length > 255) return null;
  if (!/^\[?[a-z0-9:.:-]+\]?$/.test(host)) return null;
  return host;
}

function isLocalHost(host: string): boolean {
  const withoutPort = host.replace(/:\d+$/, "");
  return withoutPort === "localhost" || withoutPort === "127.0.0.1" || withoutPort === "::1" || withoutPort === "[::1]";
}

function getAllowedHosts(): string[] {
  const configured = readEnv("MANIA_HUB_ALLOWED_HOSTS")
    ?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean) ?? [];
  return [...PRIMARY_SITE_HOSTS, DEV_SITE_HOST, ...configured];
}

function isAllowedHost(host: string): boolean {
  // Loopback is a development host. In production nothing legitimate forwards
  // it, while accepting it lets a caller point the OG renderer's asset fetches
  // at a port on the box.
  if (isLocalHost(host) && readEnv("NODE_ENV") !== "production") return true;
  const withoutPort = host.replace(/:\d+$/, "");
  const allowedHosts = getAllowedHosts();
  if (allowedHosts.includes(host) || allowedHosts.includes(withoutPort)) return true;
  return getAllowedHostSuffixes().some((suffix) => withoutPort.endsWith(suffix));
}

function requestOrigin(request: Request): string {
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

function getExplicitConfiguredOrigin(): string | null {
  return (
    normalizeOrigin(readEnv("SITE_URL")) ??
    normalizeOrigin(readEnv("VITE_SITE_URL"))
  );
}

function getVercelProductionOrigin(): string | null {
  return normalizeOrigin(readEnv("VERCEL_PROJECT_PRODUCTION_URL"));
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isPrimarySiteHost(host: string): boolean {
  return PRIMARY_SITE_HOSTS.includes(host);
}

function getAllowedRequestOrigin(request: Request): string | null {
  const forwardedHost = normalizeHost(request.headers.get("x-forwarded-host"));
  const hostHeader = normalizeHost(request.headers.get("host"));
  const host = forwardedHost ?? hostHeader;
  if (!host || !isAllowedHost(host)) return null;

  const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  const proto = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : isLocalHost(host)
    ? "http"
    : "https";
  return `${proto}://${host}`;
}

/* The site's origin with no request to derive it from. Server functions that
   have to name a public URL rather than answer one - a cache purge, for
   instance - have no incoming Request to read a host off, and guessing from
   the last request they happened to see would be worse than a configured
   value. SITE_URL first, then the known primary. */
export function getPrimarySiteOrigin(): string {
  return getExplicitConfiguredOrigin() ?? PRIMARY_SITE_ORIGIN;
}

export function getCanonicalOrigin(request: Request): string {
  const explicit = getExplicitConfiguredOrigin();
  if (explicit) return explicit;

  const allowedRequestOrigin = getAllowedRequestOrigin(request);
  const allowedRequestHost = allowedRequestOrigin ? originHost(allowedRequestOrigin) : null;
  if (allowedRequestHost && isPrimarySiteHost(allowedRequestHost)) {
    return PRIMARY_SITE_ORIGIN;
  }
  // Ahead of the Vercel production alias, which would otherwise rewrite ninja's
  // own origin to the production one and break its osu! callback. Deliberately
  // not a general "prefer the request host" rule: preview *.vercel.app hosts
  // still fall through to the production alias, since their throwaway URLs are
  // not registered redirect uris.
  if (allowedRequestHost === DEV_SITE_HOST) {
    return DEV_SITE_ORIGIN;
  }

  return getVercelProductionOrigin() ?? allowedRequestOrigin ?? requestOrigin(request);
}

/** True only for a request the browser made from our own origin. `same-site`
    (a sibling subdomain) is rejected too: the callers are same-origin fetches
    and form submits, so nothing legitimate arrives from anywhere else. */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";
  // Older browsers omit Sec-Fetch-*; fall back to a full Origin/Referer
  // origin match (scheme included), not just the host.
  let canonicalOrigin: string;
  try {
    canonicalOrigin = new URL(getCanonicalOrigin(request)).origin;
  } catch {
    return false;
  }
  for (const header of ["origin", "referer"]) {
    const value = request.headers.get(header);
    if (!value) continue;
    try {
      return new URL(value).origin === canonicalOrigin;
    } catch {
      return false;
    }
  }
  return false;
}

/** Where the OG renderer pulls its fonts and sprites from. The configured
    origin comes first, matching getCanonicalOrigin: the request-derived origin
    is built from x-forwarded-host, and every card the renderer produces is
    stored in R2 under a key that does not include the origin, so a caller who
    got their own host accepted here could put their imagery under a
    mania-tracker.com OG url for as long as that cache entry lives. */
export function getAssetOrigin(request: Request): string {
  return (
    getExplicitConfiguredOrigin() ??
    getVercelProductionOrigin() ??
    getAllowedRequestOrigin(request) ??
    requestOrigin(request)
  );
}
