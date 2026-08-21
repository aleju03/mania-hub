import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { getI18n } from "./i18n";
import type { AppLocale } from "./locale";

/* The UI locale is a catalog choice ("en"), not a full formatting locale;
   this maps it onto the Intl tag the numbers and dates should follow. en-US
   stays the en tag so every existing default-argument call site keeps
   producing byte-identical output. */
const INTL_LOCALE: Record<AppLocale, string> = {
  en: "en-US",
  "zh-CN": "zh-CN",
  es: "es-419",
};

/** The Intl tag for a UI locale, for callers formatting dates of their own. */
export function intlLocaleTag(locale: AppLocale): string {
  return INTL_LOCALE[locale];
}

/* The labels below embed words ("5m ago", "2d 3h"), so they are catalog
   messages rather than template literals: zh reorders them and re-units them
   (分钟 for a minute, 万 for ten thousand). They resolve through the per-locale
   instance rather than useLingui() because these are plain functions, called
   from modules and from components that render outside I18nProvider. */
function tr(locale: AppLocale, descriptor: MessageDescriptor): string {
  return getI18n(locale)._(descriptor);
}

/* Formatters take an optional trailing locale (the formatDate timeZone
   precedent): a caller that has waited for context - useLocale() - passes it,
   everything else keeps the en default, byte-identical to before. */
export function formatNumber(n: number, locale: AppLocale = "en"): string {
  return n.toLocaleString(INTL_LOCALE[locale]);
}

/* Counts for icon-and-number stat rows, where two of them share the space one
   spelled-out figure used to hold: "1.2k" rather than "1,203". Only for places
   that keep the exact number within reach (a title, a detail page). */
export function formatCompactCount(n: number, locale: AppLocale = "en"): string {
  const value = Math.max(0, Math.floor(n));
  if (locale !== "en") {
    /* Compact notation is locale data, not a translation of English "k":
       Chinese groups by 万 while Spanish supplies its own separators and
       suffixes. CLDR already knows where each locale starts shortening. */
    return new Intl.NumberFormat(INTL_LOCALE[locale], { notation: "compact" }).format(value);
  }
  if (value < 1000) return value.toLocaleString("en-US");
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
}

/* 1st, 2nd, 3rd, 4th, and the 11th-13th exceptions. */
export function formatOrdinal(n: number, locale: AppLocale = "en"): string {
  const value = Math.floor(n);
  const grouped = value.toLocaleString(INTL_LOCALE[locale]);
  if (locale === "en") {
    const lastTwo = Math.abs(value) % 100;
    const last = Math.abs(value) % 10;
    const suffix =
      lastTwo >= 11 && lastTwo <= 13 ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
    return `${grouped}${suffix}`;
  }
  /* The suffix table above is English grammar. Everywhere else the ordinal is
     one message, because the marker may lead rather than follow (zh: 第3). The
     untranslated shape is "#3", which still reads as a position. */
  return tr(locale, msg`#${grouped}`);
}

export function formatPP(pp: number | null, locale: AppLocale = "en"): string {
  if (pp == null) return "-";
  return `${Math.round(pp).toLocaleString(INTL_LOCALE[locale])}pp`;
}

export function formatPpGain(pp: number, locale: AppLocale = "en"): string {
  if (Math.abs(pp) < 0.05) return "0";
  return pp.toLocaleString(INTL_LOCALE[locale], {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  });
}

export function formatAccuracy(acc: number): string {
  return `${(acc * 100).toFixed(2)}%`;
}

export function formatPlayTime(seconds: number | null, locale: AppLocale = "en"): string {
  if (!seconds) return tr(locale, msg`0h`);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return tr(locale, msg`${days}d ${hours}h ${mins}m`);
  if (hours > 0) return tr(locale, msg`${hours}h ${mins}m`);
  return tr(locale, msg`${mins}m`);
}

export function formatTimeAgo(dateStr: string, locale: AppLocale = "en"): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return tr(locale, msg`just now`);
  if (mins < 60) return tr(locale, msg`${mins}m ago`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tr(locale, msg`${hours}h ago`);
  const days = Math.floor(hours / 24);
  if (days < 30) return tr(locale, msg`${days}d ago`);
  if (days < 365) {
    const months = Math.floor(days / 30);
    return tr(locale, msg`${months}mo ago`);
  }
  const years = Math.floor(days / 365);
  return tr(locale, msg`${years}y ago`);
}

/* Hover detail for the year labels above: past a year "5y ago" reads faster
   than "63mo ago", but the month count is still the useful number, so keep it
   one hover away. Undefined below a year, where the label is already exact. */
export function formatTimeAgoTooltip(dateStr: string, locale: AppLocale = "en"): string | undefined {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days < 365) return undefined;
  const months = Math.floor(days / 30);
  return tr(locale, msg`${months} months ago`);
}

/* Seconds granularity for live tickers; nowMs is a parameter so a ticking
   state value can drive re-renders and tests stay deterministic. */
export function formatPreciseTimeAgo(timestampMs: number, nowMs: number, locale: AppLocale = "en"): string {
  const secs = Math.floor((nowMs - timestampMs) / 1000);
  if (secs < 5) return tr(locale, msg`just now`);
  if (secs < 60) return tr(locale, msg`${secs}s ago`);
  const mins = Math.floor(secs / 60);
  if (mins < 60) return tr(locale, msg`${mins}m ago`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tr(locale, msg`${hours}h ago`);
  const days = Math.floor(hours / 24);
  return tr(locale, msg`${days}d ago`);
}

export function formatDetailedTimeAgo(dateStr: string, locale: AppLocale = "en"): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return tr(locale, msg`just now`);
  if (mins < 60) return tr(locale, msg`${mins}m ago`);
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (hours < 24) {
    return remainingMins > 0
      ? tr(locale, msg`${hours}h ${remainingMins}m ago`)
      : tr(locale, msg`${hours}h ago`);
  }
  const days = Math.floor(hours / 24);
  if (days < 30) return tr(locale, msg`${days}d ago`);
  if (days < 365) {
    const months = Math.floor(days / 30);
    return tr(locale, msg`${months}mo ago`);
  }
  const years = Math.floor(days / 365);
  return tr(locale, msg`${years}y ago`);
}

export function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* A value that names a day and nothing else - "2026-08-19", or a bare
   "2026-08-19 02:28" with no zone on it. Date.parse gives the first UTC
   midnight, so putting it through a timezone west of Greenwich would print the
   day before: a date with no instant behind it has no business being shifted.
   Only a string that actually carries a zone (Z, +05:30) is a moment. */
function isZonedInstant(dateStr: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(dateStr.trim());
}

/* Date parses a zone-less date-time in the machine's local zone. Pinning the
   formatter to UTC afterwards is too late: in Tokyo, for example,
   "2026-08-19 02:28" has already become an August 18 UTC instant. For the
   ISO-shaped calendar values this helper accepts, construct UTC midnight from
   the day they name so parsing itself cannot move it. */
function dateForFormatting(dateStr: string, zoned: boolean): Date {
  const trimmed = dateStr.trim();
  if (zoned) return new Date(trimmed);
  const calendarDay = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/u.exec(trimmed)?.[1];
  return new Date(calendarDay ? `${calendarDay}T00:00:00Z` : trimmed);
}

/* The absolute date of something.

   `timeZone` defaults to UTC, and that default is load-bearing: this renders
   inside server-rendered HTML (the profile "Joined" line among others), so
   server and client must produce identical text for any viewer or hydration
   fails (React #418) and recovery re-renders wipe the <html> theme vars.

   A caller that wants the viewer's own day - which is what a play time means
   to the person reading it, and what osu! itself prints - passes one, and has
   to have waited for hydration first. useViewerTimeZone() is that gate. */
export function formatDate(dateStr: string, timeZone = "UTC", locale: AppLocale = "en"): string {
  const zoned = isZonedInstant(dateStr);
  return dateForFormatting(dateStr, zoned).toLocaleDateString(INTL_LOCALE[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: zoned ? timeZone : "UTC",
  });
}
