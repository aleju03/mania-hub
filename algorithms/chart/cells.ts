// Chart-analysis cells arrive here as JSON text or already-parsed objects.
export function readChartJson<T>(cell: unknown, fallback: T): T {
  if (cell == null) return fallback;
  if (typeof cell !== "string") return cell as T;
  return parseJson(cell, fallback);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function readSameChartChecksums(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseJson<unknown>(value, null) : value;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}
