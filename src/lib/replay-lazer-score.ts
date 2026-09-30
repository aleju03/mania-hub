import { readLazerScoreInfo } from "./replay-osr";
import type { OsuMod } from "./types";

// osu!lazer appends a second, richer copy of the score to the end of a .osr: an
// LZMA-compressed `LegacyReplaySoloScoreInfo` JSON blob sitting after the online
// score id. Everything lazer-only lives there, because the legacy header can
// only carry stable's 32-bit mod bitfield - which has no room for mod settings
// (a custom rate "DT at 1.1x" reads back as plain DT, so the viewer runs the
// chart at 1.5x) and no bit at all for mods stable never had, like DA.
// readOsr hands the block over as `scoreInfoBlock`.

function toOsuMods(raw: unknown): OsuMod[] | null {
  if (!Array.isArray(raw)) return null;
  const mods: OsuMod[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const acronym = (entry as { acronym?: unknown }).acronym;
    if (typeof acronym !== "string" || !acronym.trim()) continue;
    const settings = (entry as { settings?: unknown }).settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      mods.push({ acronym: acronym.trim() });
      continue;
    }
    const kept: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        kept[key] = value;
      }
    }
    mods.push(Object.keys(kept).length > 0 ? { acronym: acronym.trim(), settings: kept } : { acronym: acronym.trim() });
  }
  return mods;
}

/**
 * The mods a lazer replay recorded, with their settings, or null for a stable
 * replay (or any tail we can't read). An empty array is a real answer: a lazer
 * no-mod play, which the legacy bitfield cannot distinguish from a mod it has
 * no bit for.
 */
export function lazerReplayMods(scoreInfoBlock: Uint8Array | null): OsuMod[] | null {
  const info = readLazerScoreInfo(scoreInfoBlock);
  if (!info || typeof info !== "object") return null;
  return toOsuMods((info as { mods?: unknown }).mods);
}
