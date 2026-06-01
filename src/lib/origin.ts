const PRIMARY_SITE_ORIGIN = "https://mania-tracker.com";
const PRIMARY_SITE_HOSTS = ["mania-tracker.com", "www.mania-tracker.com"];
const DEFAULT_ALLOWED_HOST_SUFFIXES = [".vercel.app", ".loca.lt"];

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
  return [...PRIMARY_SITE_HOSTS, ...configured];
}

function isAllowedHost(host: string): boolean {
  if (isLocalHost(host)) return true;
  const withoutPort = host.replace(/:\d+$/, "");
  const allowedHosts = getAllowedHosts();
  if (allowedHosts.includes(host) || allowedHosts.includes(withoutPort)) return true;
  return DEFAULT_ALLOWED_HOST_SUFFIXES.some((suffix) => withoutPort.endsWith(suffix));
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

// True on local dev, Vercel preview deploys, tunnels and any non-production
// host; false only on the canonical production domain. Used to gate dev-only
// features so they stay off mania-tracker.com but show on preview domains.
export function isDevPreviewHost(origin: string): boolean {
  const host = originHost(origin);
  if (!host) return false; // unknown origin -> treat as production, hide dev-only features
  return !isPrimarySiteHost(host);
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

export function getCanonicalOrigin(request: Request): string {
  const explicit = getExplicitConfiguredOrigin();
  if (explicit) return explicit;

  const allowedRequestOrigin = getAllowedRequestOrigin(request);
  const allowedRequestHost = allowedRequestOrigin ? originHost(allowedRequestOrigin) : null;
  if (allowedRequestHost && isPrimarySiteHost(allowedRequestHost)) {
    return PRIMARY_SITE_ORIGIN;
  }

  return getVercelProductionOrigin() ?? allowedRequestOrigin ?? requestOrigin(request);
}

export function getAssetOrigin(request: Request): string {
  return (
    getAllowedRequestOrigin(request) ??
    getExplicitConfiguredOrigin() ??
    getVercelProductionOrigin() ??
    requestOrigin(request)
  );
}
