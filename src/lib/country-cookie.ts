import { DEFAULT_COUNTRY_CODE, isSupportedCountryCode, normalizeCountryCode } from "./country";

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
    return normalizeCountryCode(decodeURIComponent(raw));
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
  const normalized = normalizeCountryCode(country);
  document.cookie = `${COUNTRY_COOKIE_NAME}=${encodeURIComponent(normalized)}; Path=/; Max-Age=${COUNTRY_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  if (options?.auto) {
    document.cookie = `${COUNTRY_AUTO_COOKIE_NAME}=1; Path=/; Max-Age=${COUNTRY_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } else {
    document.cookie = `${COUNTRY_AUTO_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

export function resolveDetectedCountry(country: string | null | undefined): string | null {
  const normalized = country?.trim().toUpperCase();
  return isSupportedCountryCode(normalized) ? normalized : null;
}

export function resolveInitialCountry(cookieValue: string | null, detectedCountry?: string | null): string {
  return cookieValue ?? resolveDetectedCountry(detectedCountry) ?? DEFAULT_COUNTRY_CODE;
}
