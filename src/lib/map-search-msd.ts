// Per-skillset MSD ranges for the /maps search filter. One format serves the
// route's `sMsd` param and the backend's `msd` param: `key:min-max` pairs,
// comma-joined in key order, with an empty side for an open bound
// (`jackspeed:24-,overall:20-30`). In UI state an open bound is 0, the same
// convention RangeSlider uses.

import { usesPrism } from "#dan/prism/switch";

export const MSD_FILTER_KEYS = [
  "overall",
  "stream",
  "jumpstream",
  "handstream",
  "stamina",
  "jackspeed",
  "chordjack",
  "technical",
  "ln",
  "speed",
  "chordstream",
  "bracket",
  "jack",
] as const;

// The MinaCalc skillset each key reads, as named in MSD_SKILLSET_META.
export const MSD_FILTER_SKILLSET: Record<string, string> = {
  overall: "Overall",
  stream: "Stream",
  jumpstream: "Jumpstream",
  handstream: "Handstream",
  stamina: "Stamina",
  jackspeed: "JackSpeed",
  chordjack: "Chordjack",
  technical: "Technical",
  ln: "LN",
  speed: "Speed",
  // Prism's names for the slots it shares with MinaCalc: the backend reads
  // the same column on 6K-8K charts only (MAP_SEARCH_PRISM_MSD_KEYS).
  chordstream: "Jumpstream",
  bracket: "Handstream",
  jack: "Chordjack",
};

/** The Prism-named filter key for a MinaCalc-named one, where Prism renames the slot. */
const PRISM_KEY_FOR: Record<string, string> = { jumpstream: "chordstream", handstream: "bracket", chordjack: "jack" };
const PRISM_ONLY_KEYS = new Set(["chordstream", "bracket", "jack", "speed"]);

export function isPrismOnlyMsdKey(key: string): boolean {
  return PRISM_ONLY_KEYS.has(key);
}

// The keys the panel offers: Prism's skillsets when the key facet is exactly
// 7K, MinaCalc's and then Prism's when no keymode is picked (each matching
// only its own keymodes), MinaCalc's otherwise.
const PRISM_FILTER_KEYS = ["overall", "chordstream", "bracket", "jack", "technical", "speed", "ln"];
const MINACALC_FILTER_KEYS = MSD_FILTER_KEYS.filter((key) => !PRISM_ONLY_KEYS.has(key));
const ALL_FILTER_KEYS = [...MINACALC_FILTER_KEYS, "chordstream", "bracket", "jack", "speed"];

export function isPrismKeyFacet(keys: readonly string[]): boolean {
  return keys.length === 1 && keys[0] === "7k";
}

export function msdFilterKeysFor(keys: readonly string[]): readonly string[] {
  if (isPrismKeyFacet(keys)) return PRISM_FILTER_KEYS;
  return keys.length === 0 && usesPrism(7) ? ALL_FILTER_KEYS : MINACALC_FILTER_KEYS;
}

/** The ranges a key facet filters by. A 7K link from before the Prism names
 *  (handstream on 7K) reads as the Prism key that slot now goes by. */
export function msdRangesForFacet(ranges: MsdRanges, keys: readonly string[]): MsdRanges {
  const offered = msdFilterKeysFor(keys);
  const out: MsdRanges = {};
  for (const [key, range] of Object.entries(ranges)) {
    const facetKey = isPrismKeyFacet(keys) ? PRISM_KEY_FOR[key] ?? key : key;
    if (offered.includes(facetKey) && !out[facetKey]) out[facetKey] = range;
  }
  return out;
}

export const MSD_FILTER_MAX = 40;

export type MsdRanges = Record<string, { min: number; max: number }>;

const KEY_SET = new Set<string>(MSD_FILTER_KEYS);

function bound(raw: string): number {
  if (raw === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MSD_FILTER_MAX, Math.round(value * 2) / 2);
}

export function parseMsdRanges(raw: unknown): MsdRanges {
  const ranges: MsdRanges = {};
  if (typeof raw !== "string" || !raw) return ranges;
  for (const part of raw.toLowerCase().split(",")) {
    const match = /^([a-z]+):([\d.]*)-([\d.]*)$/.exec(part.trim());
    if (!match || !KEY_SET.has(match[1])) continue;
    let min = bound(match[2]);
    let max = bound(match[3]);
    if (min > 0 && max > 0 && min > max) [min, max] = [max, min];
    if (min === 0 && max === 0) continue;
    ranges[match[1]] = { min, max };
  }
  return ranges;
}

export function serializeMsdRanges(ranges: MsdRanges): string {
  return MSD_FILTER_KEYS
    .filter((key) => ranges[key] && (ranges[key].min > 0 || ranges[key].max > 0))
    .map((key) => `${key}:${ranges[key].min > 0 ? ranges[key].min : ""}-${ranges[key].max > 0 ? ranges[key].max : ""}`)
    .join(",");
}

export function activeMsdKeys(ranges: MsdRanges): string[] {
  return MSD_FILTER_KEYS.filter((key) => ranges[key] && (ranges[key].min > 0 || ranges[key].max > 0));
}
