import { GLOBAL_SCOPE_CODE, isGlobalScope, isSupportedCountryCode, normalizeCountryScope } from "./country";

export const COUNTRY_COOKIE_NAME = "mania-hub-country";
export const COUNTRY_AUTO_COOKIE_NAME = "mania-hub-country-auto";

export const COUNTRY_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function parseCookieHeaderValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return match?.[1] ?? null;
}

// Parse the value of our country cookie out of a raw `Cookie:` header string.
// Returns null when the cookie isn't set so callers can distinguish "no cookie"
// from "default value".
export function parseCountryCookieHeader(cookieHeader: string | null | undefined): string | null {
  return parseCountryCookieValue(parseCookieHeaderValue(cookieHeader, COUNTRY_COOKIE_NAME));
}

export function hasCountryCookieHeader(cookieHeader: string | null | undefined): boolean {
  return parseCookieHeaderValue(cookieHeader, COUNTRY_COOKIE_NAME) != null;
}

export function hasAutoCountryCookieHeader(cookieHeader: string | null | undefined): boolean {
  return parseCookieHeaderValue(cookieHeader, COUNTRY_AUTO_COOKIE_NAME) != null;
}

// Parse a raw cookie value (already extracted by the server's cookie parser).
export function parseCountryCookieValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return normalizeCountryScope(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function readCountryCookieClient(): string | null {
  if (typeof document === "undefined") return null;
  return parseCountryCookieHeader(document.cookie);
}

export function readAutoCountryCookieClient(): boolean {
  if (typeof document === "undefined") return false;
  return hasAutoCountryCookieHeader(document.cookie);
}

export function writeCountryCookieClient(country: string, options?: { auto?: boolean }): void {
  if (typeof document === "undefined") return;
  const normalized = normalizeCountryScope(country);
  document.cookie = `${COUNTRY_COOKIE_NAME}=${encodeURIComponent(normalized)}; Path=/; Max-Age=${COUNTRY_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  if (options?.auto) {
    document.cookie = `${COUNTRY_AUTO_COOKIE_NAME}=1; Path=/; Max-Age=${COUNTRY_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } else {
    document.cookie = `${COUNTRY_AUTO_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

export function resolveDetectedCountry(country: string | null | undefined): string | null {
  const normalized = country?.trim().toUpperCase();
  return normalized && isSupportedCountryCode(normalized) ? normalized : null;
}

// A country is only worth routing to automatically when the server
// actually tracks it. `available` is the set of tracked country codes; when it
// is null we couldn't reach the backend and treat availability as unknown.
function isAvailableCountry(code: string | null | undefined, available: ReadonlySet<string> | null): boolean {
  if (!code) return false;
  if (isGlobalScope(code)) return true;
  // Unknown availability (backend offline) deliberately routes to Global
  // instead of trusting an ISO code we have no data for.
  if (!available) return false;
  return available.has(code.trim().toUpperCase());
}

// Resolve the scope a visitor should land on. A manual pick (cookie without the
// `-auto` flag) is always honoured. An auto-detected cookie or a fresh geo-IP
// hit is only used when that country is currently available, otherwise we fall
// back to Global so nobody is stranded on an empty single-country view.
export function resolveInitialCountry(
  cookieValue: string | null,
  detectedCountry?: string | null,
  options?: { available?: ReadonlySet<string> | null; cookieIsAuto?: boolean },
): string {
  const available = options?.available ?? null;

  if (cookieValue) {
    const manualPick = !options?.cookieIsAuto;
    if (manualPick) return cookieValue;
    // An auto cookie caches the previous auto decision. A real country that is
    // still available sticks, but auto-Global only meant "no trackable country
    // last time" - fall through so a geo hit that is available now (e.g. the
    // visitor's country got registered since) wins over it.
    if (!isGlobalScope(cookieValue) && isAvailableCountry(cookieValue, available)) {
      return cookieValue;
    }
  }

  const detected = resolveDetectedCountry(detectedCountry);
  if (detected && isAvailableCountry(detected, available)) {
    return detected;
  }

  return GLOBAL_SCOPE_CODE;
}
