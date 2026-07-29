export type TriStateMode = "include" | "exclude";
export type TriStateSelection<T extends string> = { includes: Set<T>; excludes: Set<T> };

// URL encoding: `value` = include, `-value` = exclude. Backwards compatible
// with the previous toggle scheme (no prefix == include).
export function parseTriStateCsv<T extends string>(raw: string, allowed: readonly T[]): TriStateSelection<T> {
  const includes = new Set<T>();
  const excludes = new Set<T>();
  if (!raw) return { includes, excludes };
  const allowedSet = new Set<string>(allowed);
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const isExclude = trimmed.startsWith("-");
    const value = isExclude ? trimmed.slice(1) : trimmed;
    if (!allowedSet.has(value)) continue;
    if (isExclude) excludes.add(value as T);
    else includes.add(value as T);
  }
  return { includes, excludes };
}

// Cycle: none -> include -> exclude -> none
export function cycleTriStateCsv(raw: string, value: string): string {
  const parts = raw ? raw.split(",").filter(Boolean) : [];
  const includeIdx = parts.indexOf(value);
  const excludeIdx = parts.indexOf(`-${value}`);
  if (includeIdx >= 0) {
    parts[includeIdx] = `-${value}`;
  } else if (excludeIdx >= 0) {
    parts.splice(excludeIdx, 1);
  } else {
    parts.push(value);
  }
  return parts.join(",");
}

// Reverse cycle: none -> exclude -> include -> none
export function reverseCycleTriStateCsv(raw: string, value: string): string {
  const parts = raw ? raw.split(",").filter(Boolean) : [];
  const includeIdx = parts.indexOf(value);
  const excludeIdx = parts.indexOf(`-${value}`);
  if (includeIdx >= 0) {
    parts.splice(includeIdx, 1);
  } else if (excludeIdx >= 0) {
    parts[excludeIdx] = value;
  } else {
    parts.push(`-${value}`);
  }
  return parts.join(",");
}

export function getTriStateMode<T extends string>(sel: TriStateSelection<T>, value: T): TriStateMode | undefined {
  if (sel.includes.has(value)) return "include";
  if (sel.excludes.has(value)) return "exclude";
  return undefined;
}

export function triStateActive<T extends string>(sel: TriStateSelection<T>): number {
  return sel.includes.size + sel.excludes.size;
}

export function serializeTriStateCsv(
  includes: Iterable<string>,
  excludes: Iterable<string>,
): string {
  return [...includes, ...[...excludes].map((value) => `-${value}`)].join(",");
}
