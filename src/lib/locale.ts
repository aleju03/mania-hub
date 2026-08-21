// The locales the site ships UI translations for. Adding a locale means
// extending this array, adding src/locales/<locale>/, and giving the settings
// picker a label; everything else (cookie, context, catalogs) keys off it.
export const SUPPORTED_LOCALES = ["en", "zh-CN", "es"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

// Map a BCP-47-ish tag (cookie value, Accept-Language entry, html lang) onto a
// supported locale. Any Chinese tag resolves to zh-CN: the site has one
// Chinese catalog, and serving Simplified to a zh-TW visitor beats serving
// English. Returns null for unrecognized tags so callers can keep scanning an
// Accept-Language list instead of defaulting early.
export function normalizeLocale(raw: string | null | undefined): AppLocale | null {
  if (!raw) return null;
  const tag = raw.trim().toLowerCase();
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
  // One neutral, Latin America-friendly Spanish catalog serves every Spanish
  // browser tag. Formatting uses es-419 separately in format.ts.
  if (tag === "es" || tag.startsWith("es-")) return "es";
  return null;
}

export function isSupportedLocale(raw: string | null | undefined): raw is AppLocale {
  return SUPPORTED_LOCALES.includes(raw as AppLocale);
}
