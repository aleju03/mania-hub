import { type AppLocale, DEFAULT_LOCALE, normalizeLocale } from "./locale";

// Modeled on country-cookie.ts: the cookie is the single source of truth for
// the UI language (no store copy - the server has to read it too, and the
// cookie already crosses that boundary). Unlike country there is no `-auto`
// marker cookie: once set, the cookie wins and the settings picker is the
// escape hatch. If auto-redetection is ever wanted, mirror
// COUNTRY_AUTO_COOKIE_NAME - but note every extra cookie multiplies the
// `Vary: Cookie` CDN variants in start.ts.
export const LOCALE_COOKIE_NAME = "mania-hub-locale";

export const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function parseCookieHeaderValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return match?.[1] ?? null;
}

// Parse our locale cookie out of a raw `Cookie:` header. Returns null when the
// cookie is missing or holds an unsupported tag so callers can distinguish "no
// cookie" (detect from Accept-Language) from "explicit choice".
export function parseLocaleCookieHeader(cookieHeader: string | null | undefined): AppLocale | null {
  const raw = parseCookieHeaderValue(cookieHeader, LOCALE_COOKIE_NAME);
  if (!raw) return null;
  try {
    return normalizeLocale(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function hasLocaleCookieHeader(cookieHeader: string | null | undefined): boolean {
  return parseCookieHeaderValue(cookieHeader, LOCALE_COOKIE_NAME) != null;
}

export function readLocaleCookieClient(): AppLocale | null {
  if (typeof document === "undefined") return null;
  return parseLocaleCookieHeader(document.cookie);
}

export function writeLocaleCookieClient(locale: AppLocale): void {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

// First-visit detection. The list is scanned in order and the first tag that
// maps to a supported locale wins; q-weights are ignored on purpose - browsers
// emit the list already ordered by preference, and the only case a weight
// would change the outcome is a UA that ranks zh below en explicitly, which
// ordering alone already honours.
export function resolveLocaleFromAcceptLanguage(header: string | null | undefined): AppLocale {
  if (!header) return DEFAULT_LOCALE;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim();
    if (!tag || tag === "*") continue;
    const normalized = normalizeLocale(tag);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}
