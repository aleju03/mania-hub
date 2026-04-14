import { DEFAULT_COUNTRY_CODE, normalizeCountryCode } from "./country";

export const COUNTRY_COOKIE_NAME = "mania-hub-country";

const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

// Parse the value of our country cookie out of a raw `Cookie:` header string.
// Returns null when the cookie isn't set so callers can distinguish "no cookie"
// from "default value".
export function parseCountryCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const escaped = COUNTRY_COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return parseCountryCookieValue(match?.[1]);
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

export function writeCountryCookieClient(country: string): void {
  if (typeof document === "undefined") return;
  const normalized = normalizeCountryCode(country);
  document.cookie = `${COUNTRY_COOKIE_NAME}=${encodeURIComponent(normalized)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function resolveInitialCountry(cookieValue: string | null): string {
  return cookieValue ?? DEFAULT_COUNTRY_CODE;
}
