import { isSupportedCountryScope } from "./country";

export const COUNTRY_SEARCH_PARAM = "country";

export function parseCountrySearchParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return isSupportedCountryScope(normalized) ? normalized : undefined;
}

export function readCountryFromSearchStr(searchStr: string): string | undefined {
  return parseCountrySearchParam(new URLSearchParams(searchStr).get(COUNTRY_SEARCH_PARAM));
}

export function withSearchParams(
  path: string,
  params: Record<string, string | number | null | undefined>,
): string {
  const url = new URL(path, "https://mania-hub.local");
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") {
      url.searchParams.delete(key);
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}
