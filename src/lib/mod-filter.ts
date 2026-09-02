// The mod filter the play lists share: a chip per mod, cycling neutral ->
// include -> exclude. Best Performance filters osu! score objects with it and
// the Skills tab's plays explorer filters the full mod lists its cohort
// carries, so
// the rules (aliases, the synthetic NoMod chip, the cycle order) live here
// rather than in whichever list happened to grow them first.

export type ModFilterMode = "include" | "exclude";
export type ModFilterState = Record<string, ModFilterMode>;

/** Synthetic chip used to filter for plays set without any mods. */
export const NO_MOD_KEY = "NM";

// DT and NC apply the same 1.5x rate (NC is DT with an audio swap); HT and DC
// are the same 0.75x rate. Scores carry one or the other, so collapse them into
// a single filter chip that matches either mod in the group.
export const MOD_ALIAS_GROUPS: readonly { readonly key: string; readonly mods: readonly string[] }[] = [
  { key: "DT|NC", mods: ["DT", "NC"] },
  { key: "HT|DC", mods: ["HT", "DC"] },
];

export function getModFilterKey(mod: string): string {
  for (const group of MOD_ALIAS_GROUPS) {
    if (group.mods.includes(mod)) return group.key;
  }
  return mod;
}

export function getModFilterGroup(key: string): readonly string[] | null {
  const group = MOD_ALIAS_GROUPS.find((g) => g.key === key);
  return group?.mods ?? null;
}

export function cycleModFilterMode(current: ModFilterMode | undefined): ModFilterMode | undefined {
  if (current === undefined) return "include";
  if (current === "include") return "exclude";
  return undefined;
}

export function reverseCycleModFilterMode(current: ModFilterMode | undefined): ModFilterMode | undefined {
  if (current === undefined) return "exclude";
  if (current === "exclude") return "include";
  return undefined;
}

/** The filter against a play's mod acronyms. An empty filter keeps everything;
    every set chip has to agree, so include and exclude compose. */
export function matchesModAcronymFilter(acronyms: string[], modFilter: ModFilterState): boolean {
  const entries = Object.entries(modFilter);
  if (entries.length === 0) return true;

  const mods = new Set(acronyms);
  const hasNoMods = mods.size === 0;
  for (const [key, mode] of entries) {
    let present: boolean;
    if (key === NO_MOD_KEY) {
      present = hasNoMods;
    } else {
      const group = getModFilterGroup(key);
      present = group ? group.some((m) => mods.has(m)) : mods.has(key);
    }
    if (mode === "include" && !present) return false;
    if (mode === "exclude" && present) return false;
  }
  return true;
}

/** The chips worth offering for a set of plays, most common first, with NoMod
    leading when anything in the set was played bare. Counts a play once per
    chip so an alias group is not double counted. */
export function relevantModFilterKeys(plays: Iterable<string[]>): string[] {
  const counts = new Map<string, number>();
  let noModCount = 0;
  for (const acronyms of plays) {
    if (acronyms.length === 0) {
      noModCount += 1;
      continue;
    }
    const seenKeys = new Set<string>();
    for (const mod of acronyms) {
      const key = getModFilterKey(mod);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
  if (noModCount > 0) sorted.unshift(NO_MOD_KEY);
  return sorted;
}
