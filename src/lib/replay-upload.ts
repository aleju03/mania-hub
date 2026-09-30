import type { OsuMod } from "./types";
import type { ServerReplay } from "./replay-types";
import { lazerReplayMods } from "./replay-lazer-score";
import { readOsr } from "./replay-osr";

const MANIA_RULESET_ID = 3;

const STABLE_MOD_BITS: Array<{ bit: number; acronym: string }> = [
  { bit: 1 << 0, acronym: "NF" },
  { bit: 1 << 1, acronym: "EZ" },
  { bit: 1 << 3, acronym: "HD" },
  { bit: 1 << 4, acronym: "HR" },
  { bit: 1 << 5, acronym: "SD" },
  { bit: 1 << 6, acronym: "DT" },
  { bit: 1 << 8, acronym: "HT" },
  { bit: 1 << 9, acronym: "NC" },
  { bit: 1 << 10, acronym: "FL" },
  { bit: 1 << 14, acronym: "PF" },
  { bit: 1 << 15, acronym: "4K" },
  { bit: 1 << 16, acronym: "5K" },
  { bit: 1 << 17, acronym: "6K" },
  { bit: 1 << 18, acronym: "7K" },
  { bit: 1 << 19, acronym: "8K" },
  { bit: 1 << 20, acronym: "FI" },
  // Stable stores no shuffle seed, so the judgement engine treats a seedless RD
  // as a no-op and leaves the columns alone; carrying it is still worth it so
  // the viewer shows what was actually played.
  { bit: 1 << 21, acronym: "RD" },
  { bit: 1 << 24, acronym: "9K" },
  { bit: 1 << 26, acronym: "1K" },
  { bit: 1 << 27, acronym: "3K" },
  { bit: 1 << 28, acronym: "2K" },
  { bit: 1 << 29, acronym: "SV2" },
  // Mirror flips the chart's columns. Dropping it left the notes unmirrored
  // while the replay's presses stayed mirrored, so nothing lined up.
  { bit: 1 << 30, acronym: "MR" },
];
// Deliberately unmapped: 1 << 25 is stable's KeyCoop (2P co-op), which shares no
// meaning with lazer's "CO" (Cover) - mapping it would trigger the cover overlay.

export interface UploadedReplayParseResult {
  replay: ServerReplay;
  mods: OsuMod[];
  scoreId: number | null;
}

// A lazer replay records its mods twice: the legacy bitfield in the header, and
// the real list (with settings) in the trailing score info block. Prefer the
// list - the bitfield flattens a custom rate into plain DT and drops anything
// stable had no bit for. Stable replays have no block and keep the bitfield.
export function readUploadedReplayMods(scoreInfoBlock: Uint8Array | null, modsUsed: number): OsuMod[] {
  return lazerReplayMods(scoreInfoBlock) ?? stableModBitmaskToMods(modsUsed);
}

export function stableModBitmaskToMods(modsUsed: number): OsuMod[] {
  const mods = STABLE_MOD_BITS
    .filter((mod) => (modsUsed & mod.bit) !== 0)
    .map((mod) => ({ acronym: mod.acronym }));

  if (mods.some((mod) => mod.acronym === "NC")) {
    return mods.filter((mod) => mod.acronym !== "DT");
  }
  if (mods.some((mod) => mod.acronym === "PF")) {
    return mods.filter((mod) => mod.acronym !== "SD");
  }
  return mods;
}

// The trailing "online score id" stable writes into an .osr lives in the
// per-mode legacy namespace, which overlaps the unified /scores/{id} one — so
// looking it up can return a completely unrelated play (another user, another
// map, even another ruleset) that then poisons everything the viewer derives
// from the score: accuracy, the stable/lazer client badge and judging mode,
// mods, key count, and the beatmapset the audio streams from (which is what
// made seeking snap to the end). Only trust a fetched score that is
// verifiably this replay's map: the exact revision the .osr names, or the
// beatmap id that revision's checksum lookup resolved to.
export function scoreMatchesUploadedReplay(
  score: { beatmap?: { id?: number; checksum?: string | null } | null } | null | undefined,
  replayBeatmapHash: string | null | undefined,
  lookedUpBeatmapId: number | null | undefined,
): boolean {
  const beatmap = score?.beatmap;
  if (!beatmap) return false;
  if (replayBeatmapHash && beatmap.checksum === replayBeatmapHash) return true;
  return lookedUpBeatmapId != null && beatmap.id === lookedUpBeatmapId;
}

export function extractReplayScoreIdFromFilename(filename: string | null | undefined): number | null {
  const matches = (filename ?? "").match(/\d{6,}/g);
  if (!matches?.length) return null;
  const scoreId = Number(matches[matches.length - 1]);
  return Number.isSafeInteger(scoreId) && scoreId > 0 ? scoreId : null;
}

export async function parseUploadedReplayBuffer(buffer: ArrayBuffer): Promise<UploadedReplayParseResult> {
  const { replay, rawFrameCount, scoreId, scoreInfoBlock } = readOsr(buffer);

  if (replay.header.gameMode !== MANIA_RULESET_ID) {
    throw new Error("This is not an osu!mania replay.");
  }
  if (rawFrameCount === 0) {
    throw new Error("This replay has no playable input frames.");
  }
  if (replay.frames.length === 0) {
    throw new Error("This replay has no readable input frames.");
  }

  return {
    replay,
    mods: readUploadedReplayMods(scoreInfoBlock, replay.header.modsUsed ?? 0),
    scoreId: Number.isSafeInteger(scoreId) && scoreId > 0 ? scoreId : null,
  };
}

export async function parseUploadedReplayFile(file: File): Promise<UploadedReplayParseResult> {
  return parseUploadedReplayBuffer(await file.arrayBuffer());
}
