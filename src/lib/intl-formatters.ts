// Formatting repeats across hundreds of calendar cells and ranking rows. Bound
// these caches because requested timezones can also come from backend data.
const MAX_FORMATTERS = 128;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

export function getDateTimeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (dateFormatters.size >= MAX_FORMATTERS) dateFormatters.delete(dateFormatters.keys().next().value!);
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

export function getNumberFormatter(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify([locale, options]);
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    if (numberFormatters.size >= MAX_FORMATTERS) numberFormatters.delete(numberFormatters.keys().next().value!);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

/** Match Date.toLocale*String's invalid-date result (Intl.format would throw). */
export function formatDateTime(date: Date, locale: string, options: Intl.DateTimeFormatOptions): string {
  if (!Number.isFinite(date.getTime())) return "Invalid Date";
  return getDateTimeFormatter(locale, options).format(date);
}
