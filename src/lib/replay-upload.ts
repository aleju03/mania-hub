import type { OsuMod } from "./types";
import type { ServerReplay } from "./replay-types";
import { decodeStableManiaReplayFrames } from "./replay-frames";

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
  { bit: 1 << 24, acronym: "9K" },
  { bit: 1 << 26, acronym: "1K" },
  { bit: 1 << 27, acronym: "3K" },
  { bit: 1 << 28, acronym: "2K" },
];

export interface UploadedReplayParseResult {
  replay: ServerReplay;
  mods: OsuMod[];
  scoreId: number | null;
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

export function extractReplayScoreIdFromFilename(filename: string | null | undefined): number | null {
  const matches = (filename ?? "").match(/\d{6,}/g);
  if (!matches?.length) return null;
  const scoreId = Number(matches[matches.length - 1]);
  return Number.isSafeInteger(scoreId) && scoreId > 0 ? scoreId : null;
}

export async function parseUploadedReplayBuffer(buffer: ArrayBuffer): Promise<UploadedReplayParseResult> {
  const { ScoreDecoder } = await import("osu-parsers");
  const score = await new ScoreDecoder().decodeFromBuffer(buffer);
  const info = score.info;
  const rawFrames = (score.replay?.frames ?? []) as any[];
  const rulesetId = Number(info?.rulesetId ?? 0);

  if (rulesetId !== MANIA_RULESET_ID) {
    throw new Error("This is not an osu!mania replay.");
  }
  if (rawFrames.length === 0) {
    throw new Error("This replay has no playable input frames.");
  }

  const frames = decodeStableManiaReplayFrames(rawFrames);

  if (frames.length === 0) {
    throw new Error("This replay has no readable input frames.");
  }

  const lifeBarFrames = (score.replay?.lifeBar ?? [])
    .map((frame: any) => ({
      time: Math.round(Number(frame.startTime ?? frame.time ?? 0)),
      health: Math.max(0, Math.min(1, Number(frame.health ?? 0))),
    }))
    .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.health))
    .sort((a, b) => a.time - b.time);

  const modsUsed = Number(info?.rawMods ?? info?.mods?.bitwise ?? 0) || 0;
  let keyCount = 0;
  for (const frame of frames) {
    let state = frame.keyState;
    let bit = 0;
    while (state > 0) {
      bit++;
      state >>= 1;
    }
    keyCount = Math.max(keyCount, bit);
  }

  const replay: ServerReplay = {
    header: {
      playerName: String(info?.username ?? "Unknown"),
      gameMode: rulesetId,
      gameVersion: Number(score.replay?.gameVersion ?? 0) || undefined,
      beatmapHash: String(info?.beatmapHashMD5 ?? ""),
      modsUsed,
      totalScore: Number(info?.totalScore ?? 0),
      maxCombo: Number(info?.maxCombo ?? 0),
      count300: Number(info?.count300 ?? 0),
      count100: Number(info?.count100 ?? 0),
      count50: Number(info?.count50 ?? 0),
      countGeki: Number(info?.countGeki ?? 0),
      countKatu: Number(info?.countKatu ?? 0),
      countMiss: Number(info?.countMiss ?? 0),
      isPerfect: Boolean(info?.perfect),
    },
    frames,
    lifeBarFrames,
    keyCount: Math.max(keyCount, 4),
  };

  const scoreId = Number(info?.id ?? 0);
  return {
    replay,
    mods: stableModBitmaskToMods(modsUsed),
    scoreId: Number.isSafeInteger(scoreId) && scoreId > 0 ? scoreId : null,
  };
}

export async function parseUploadedReplayFile(file: File): Promise<UploadedReplayParseResult> {
  return parseUploadedReplayBuffer(await file.arrayBuffer());
}
