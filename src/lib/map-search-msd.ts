// Per-skillset MSD ranges for the /maps search filter. One format serves the
// route's `sMsd` param and the backend's `msd` param: `key:min-max` pairs,
// comma-joined in key order, with an empty side for an open bound
// (`jackspeed:24-,overall:20-30`). In UI state an open bound is 0, the same
// convention RangeSlider uses.

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
};

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
