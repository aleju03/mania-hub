import type { ManiaBeatmap } from "./beatmap-parser";
import { DEFAULT_REPLAY_MAP_INFO_OPTIONS, type ReplayMapInfoOptions } from "./replay-overlays";
import type { ReplayAudioWave } from "./replay-audio-wave";
import { getScoreRate } from "./score";
import type { OsuMod, OsuScore } from "./types";

/** What the map info overlay draws. Length and BPM already follow the play's rate. */
export interface ReplayMapInfo {
  title: string;
  artist: string;
  version: string;
  creator: string;
  stars: number | null;
  lengthMs: number | null;
  bpm: number | null;
  keyCount: number;
  od: number | null;
  /** Same-origin (or blob) URL of the map background, for lazer's card. */
  backgroundUrl?: string;
  /** The song's precomputed spectrum, present while the audio wave is on. */
  audioWave?: ReplayAudioWave;
  /** The chart's dan estimate at the play's rate. */
  dan?: ReplayMapDan | null;
  /** "mapped by", translated by the page; the canvas has no catalog of its own. */
  mappedByLabel?: string;
}

export interface ReplayMapDan {
  /** The verdict as the site prints it: "7+", "gamma-". */
  label: string;
  family: string;
  /** The badge art, rasterized to a same-origin data URL the canvas can draw. */
  imageUrl?: string;
}

/** "Dan:7+" or, on an LN chart, "LN:7+": what the card prints until the badge art loads. */
export function formatReplayMapDan(dan: ReplayMapDan): string {
  return `${dan.family === "ln" ? "LN" : "Dan"}:${dan.label}`;
}

/** What the player info overlay draws. */
export interface ReplayPlayerInfo {
  name: string;
  /** Canvas-safe, same-origin avatar URL. */
  avatarUrl?: string;
  /** Canvas-safe, same-origin profile cover URL. */
  coverUrl?: string;
  /** Lazer card without its banner: avatar, name and flag straight on the stage. */
  bare?: boolean;
  countryCode?: string;
}

export interface ReplayInfoData {
  map: ReplayMapInfo | null;
  player: ReplayPlayerInfo | null;
}

export const EMPTY_REPLAY_INFO: ReplayInfoData = { map: null, player: null };

/** The playback state the map card's live readouts follow, rate-applied. */
export interface ReplayMapInfoLive {
  bpm: number | null;
  timeLeftMs: number | null;
  /** How far into the map the replay is, 0 to 1. */
  progress: number;
  /** Spectrum levels at the current time, 0 to 1, low to high. */
  wave: Float32Array | null;
}

export interface ReplayMapCardInput {
  map: ReplayMapInfo;
  options: ReplayMapInfoOptions;
  live: ReplayMapInfoLive;
}

export function mapCardInput(map: ReplayMapInfo, options: Partial<ReplayMapInfoOptions> = {}, live: Partial<ReplayMapInfoLive> = {}): ReplayMapCardInput {
  return {
    map,
    options: { ...DEFAULT_REPLAY_MAP_INFO_OPTIONS, ...options },
    live: { bpm: null, timeLeftMs: null, progress: 0, wave: null, ...live },
  };
}

/** The length readout: the map's length, or what is left of it. */
export function getMapInfoLength({ map, options, live }: ReplayMapCardInput): { ms: number; remaining: boolean } | null {
  if (options.timeLeft && live.timeLeftMs != null) return { ms: live.timeLeftMs, remaining: true };
  return map.lengthMs == null ? null : { ms: map.lengthMs, remaining: false };
}

export function getMapInfoBpm({ map, options, live }: ReplayMapCardInput): number | null {
  return options.liveBpm && live.bpm != null ? live.bpm : map.bpm;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasMod(mods: OsuMod[] | undefined, acronym: string): boolean {
  return (mods ?? []).some((mod) => (typeof mod === "string" ? mod : mod?.acronym) === acronym);
}

// Song select shows HR/EZ difficulty settings already applied, like the rate.
function applyDifficultyMods(value: number | null, mods: OsuMod[] | undefined): number | null {
  if (value == null) return null;
  if (hasMod(mods, "HR")) return Math.min(10, value * 1.4);
  if (hasMod(mods, "EZ")) return value * 0.5;
  return value;
}

export function buildReplayMapInfo(
  score: OsuScore | null,
  beatmap: ManiaBeatmap | null,
  mods: OsuMod[] | undefined,
  stars: number | null,
  keyCount: number,
): ReplayMapInfo | null {
  const title = score?.beatmapset?.title ?? beatmap?.title;
  if (!title) return null;
  const rate = getScoreRate(mods);
  const lengthMs = finite(score?.beatmap?.total_length) != null
    ? score!.beatmap.total_length * 1000
    : finite(beatmap?.totalLength);
  const bpm = finite(score?.beatmap?.bpm) ?? finite(beatmap?.bpm);
  return {
    title,
    artist: score?.beatmapset?.artist ?? beatmap?.artist ?? "",
    version: score?.beatmap?.version ?? beatmap?.version ?? "",
    creator: score?.beatmapset?.creator ?? beatmap?.creator ?? "",
    stars: finite(stars),
    lengthMs: lengthMs == null ? null : lengthMs / rate,
    bpm: bpm == null ? null : bpm * rate,
    keyCount,
    od: applyDifficultyMods(finite(score?.beatmap?.accuracy) ?? finite(beatmap?.od), mods),
  };
}

export function buildReplayPlayerInfo(
  name: string,
  avatarUrl: string | undefined,
  countryCode: string | undefined,
  coverUrl?: string | null,
): ReplayPlayerInfo {
  return {
    name,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    ...(countryCode ? { countryCode: countryCode.toUpperCase() } : {}),
  };
}

export function formatReplayInfoLength(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
