// Capturing a job's inputs, in two steps with very different rules.
//
// `ReplayExportCapture` is taken synchronously from the viewer at the moment
// the user confirms: resolved settings, resolved rate and pitch policy, and
// references to the arrays and asset URLs in play right then. Nothing is
// re-read later, so changing the skin, the volume, or the replay afterwards
// cannot reach into a running job.
//
// `resolveReplayExportResources` then takes ownership of the bytes. A copied
// `blob:` URL string is not ownership: the route that made it can revoke it
// the moment it unmounts. The job fetches its own Blob and its own
// ImageBitmap and holds them until it releases them.

import type { ManiaNote, ManiaScrollVelocity, ManiaTimingPoint } from "../beatmap-parser";
import { getInlineBackgroundUrl } from "../audio-url";
import type { ReplayOverlaySettings, ReplayThumbHand } from "../replay-overlays";
import type { ReplaySkinSettings } from "../replay-skin";
import type { ReplayLeaderboardOptions } from "../replay-leaderboard";
import type { ReplayHitCounts } from "../replay-validation";
import type { ReplayStoryboardData } from "../storyboard/types";
import type { ReplayFrame, ReplayLifeBarFrame } from "../types";
import { ReplayExportError } from "./errors";
import type { ReplayViewportSnapshot } from "../replay-types";
import {
  REPLAY_EXPORT_AUDIO_BITRATE,
  REPLAY_EXPORT_CHANNELS,
  REPLAY_EXPORT_PRESETS,
  REPLAY_EXPORT_SAMPLE_RATE,
  exportVideoBitrate,
  DEFAULT_REPLAY_EXPORT_ENCODING_MODE,
  isCustomVideoBitrateAllowed,
  type ReplayExportEncodingMode,
  type ReplayExportPresetId,
} from "./limits";
import {
  REPLAY_EXPORT_RENDERER_REVISION,
  REPLAY_EXPORT_SPEC_VERSION,
  type ReplayExportModSpec,
  type ReplayExportSpecV1,
} from "./render-spec";
import type { LocalExportResources, ReplayExportLeaderboardEntry } from "./types";
import { REPLAY_EXPORT_AV1_QUANTIZER } from "./video-quality";
import { replayExportDimensions, replayExportViewport } from "./composition";

export type ReplayExportCapture = {
  /** Identity, for the filename and the spec. None of it is required. */
  scoreId: number | null;
  beatmapId: number | null;
  beatmapsetId: number | null;
  beatmapChecksum: string | null;
  uploadId: string | null;
  playerName: string;
  songTitle: string;
  difficultyName: string;

  replayFrames: ReplayFrame[];
  lifeBarFrames: ReplayLifeBarFrame[];
  keyCount: number;
  replayDurationMs: number;

  notes: ManiaNote[];
  timingPoints: ManiaTimingPoint[] | undefined;
  scrollVelocities: ManiaScrollVelocity[] | undefined;
  od: number | null;
  isConvert: boolean;
  expectedCounts: ReplayHitCounts | undefined;
  realTotalScore: number | null;
  initialCombo: number;

  isLazer: boolean;
  legacyReplayFrameRounding: boolean;
  mods: ReplayExportModSpec[];
  modRate: number;
  userSpeed: number;
  /** Already resolved as `userSpeed * modRate`; never recomputed downstream. */
  effectiveRate: number;
  /** Already resolved from the mod list; never re-derived from acronyms. */
  pitchPreserved: boolean;

  bgDim: number;
  blackPlayfield: boolean;
  scrollSpeed: number;
  showInputOverlay: boolean;
  inputOverlayOnly: boolean;
  inputOverlayColor: string;
  inputOverlayKeyHistory: boolean;
  missThumbHand: ReplayThumbHand;
  skinSettings: ReplaySkinSettings;
  overlaySettings: ReplayOverlaySettings;
  viewport?: ReplayViewportSnapshot;

  leaderboard: ReplayExportLeaderboardEntry[];
  leaderboardPlayerName: string;
  leaderboardOptions?: ReplayLeaderboardOptions;
  leaderboardVisible: boolean;
  storyboard: ReplayStoryboardData | null;
  storyboardEnabled: boolean;

  /** Master mute in the viewer; false silences the export's audio entirely. */
  audioEnabled: boolean;
  songVolume: number;
  hitsoundsEnabled: boolean;
  beatmapHitsounds: boolean;
  beatmapHitsoundVolume: number;
  keypressHitsounds: boolean;
  keypressHitsoundVolume: number;
  comboBreakSound: boolean;
  /** Loaded sample bytes, copied out of the viewer's hitsound player. */
  hitsoundSamples: Map<string, ArrayBuffer>;

  /** Where the song can be fetched from right now. May be a `blob:` URL. */
  songUrl: string | null;
  /** Background candidates in preference order; the first that loads wins. */
  backgroundUrls: Array<string | null | undefined>;

  locale: string;
};

export type ReplayExportSpecOptions = {
  preset: ReplayExportPresetId;
  encodingMode?: ReplayExportEncodingMode;
  /** Optional explicit video bitrate in bits per second. */
  videoBitrate?: number;
  startMs: number;
  endMs: number;
  /** False produces a video with no audio track at all. */
  includeAudio: boolean;
};

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "replay";
}

export function buildReplayExportFilename(capture: ReplayExportCapture): string {
  const player = sanitizeFilenamePart(capture.playerName || "player");
  const title = sanitizeFilenamePart(capture.songTitle || "replay");
  const difficulty = sanitizeFilenamePart(capture.difficultyName || "mania");
  const scoreSuffix = capture.scoreId ? `-${capture.scoreId}` : "";
  return `${player}-${title}-${difficulty}${scoreSuffix}.mp4`;
}

function assetManifest(capture: ReplayExportCapture): ReplayExportSpecV1["assets"] {
  const assets: ReplayExportSpecV1["assets"] = [];
  const replayId = capture.scoreId != null
    ? `score:${capture.scoreId}`
    : capture.uploadId
      ? `upload:${capture.uploadId}`
      : `player:${capture.playerName}`;
  assets.push({ role: "replay", id: replayId });
  if (capture.beatmapChecksum) assets.push({ role: "beatmap", id: `md5:${capture.beatmapChecksum}` });
  else if (capture.beatmapId != null) assets.push({ role: "beatmap", id: `beatmap:${capture.beatmapId}` });
  if (capture.songUrl) assets.push({ role: "song", id: `song:${replayId}` });
  if (capture.backgroundUrls.some(Boolean)) assets.push({ role: "background", id: `background:${replayId}` });
  if (capture.storyboardEnabled && capture.storyboard) {
    assets.push({ role: "storyboard", id: `storyboard:${replayId}` });
  }
  for (const key of [...capture.hitsoundSamples.keys()].sort()) {
    const role = key.startsWith("beatmap:")
      ? "beatmap-sound"
      : key.startsWith("skin:")
        ? "skin-sound"
        : "default-sound";
    assets.push({ role, id: key });
  }
  return assets;
}

/**
 * Turns a capture plus a range and preset into the serializable spec. Small
 * mutable settings objects are deep-copied here so a later preferences write
 * cannot reach a queued job.
 */
export function buildReplayExportSpec(
  capture: ReplayExportCapture,
  options: ReplayExportSpecOptions,
): ReplayExportSpecV1 {
  const preset = REPLAY_EXPORT_PRESETS[options.preset];
  const encodingMode = options.encodingMode ?? DEFAULT_REPLAY_EXPORT_ENCODING_MODE;
  if (options.videoBitrate !== undefined && !isCustomVideoBitrateAllowed(options.videoBitrate)) {
    throw new RangeError("Custom video bitrate must be between 0.5 and 20 Mbps.");
  }
  const quantizerMode = encodingMode === "compact" && options.videoBitrate === undefined;
  const dimensions = replayExportDimensions(capture.viewport ?? preset, preset);
  const wantsAudio = options.includeAudio && capture.audioEnabled;
  const hitsoundsEnabled = wantsAudio && capture.hitsoundsEnabled;

  return {
    schemaVersion: REPLAY_EXPORT_SPEC_VERSION,
    rendererRevision: REPLAY_EXPORT_RENDERER_REVISION,
    appVersion: String(import.meta.env.VITE_APP_VERSION ?? "dev"),
    source: {
      scoreId: capture.scoreId,
      beatmapId: capture.beatmapId,
      beatmapsetId: capture.beatmapsetId,
      beatmapChecksum: capture.beatmapChecksum,
      uploadId: capture.uploadId,
      playerName: capture.playerName,
    },
    ruleset: {
      keyCount: capture.keyCount,
      isConvert: capture.isConvert,
      isLazer: capture.isLazer,
      legacyReplayFrameRounding: capture.legacyReplayFrameRounding,
      od: capture.od,
      mods: capture.mods.map((mod) => (mod.settings ? { acronym: mod.acronym, settings: { ...mod.settings } } : { acronym: mod.acronym })),
      modRate: capture.modRate,
      userSpeed: capture.userSpeed,
    },
    range: { startMs: options.startMs, endMs: options.endMs },
    playback: {
      rate: capture.effectiveRate,
      pitchPolicy: capture.pitchPreserved ? "preserved" : "follows-rate",
    },
    output: {
      container: "mp4",
      width: dimensions.width,
      height: dimensions.height,
      fps: preset.fps,
      encodingMode,
      videoCodec: encodingMode === "compact" ? "av1" : "avc",
      videoBitrate: options.videoBitrate ?? exportVideoBitrate(preset, dimensions, encodingMode),
      videoBitrateMode: quantizerMode ? "quantizer" : "variable",
      ...(quantizerMode ? { videoQuantizer: REPLAY_EXPORT_AV1_QUANTIZER } : {}),
      audioCodec: wantsAudio ? "aac" : null,
      audioBitrate: REPLAY_EXPORT_AUDIO_BITRATE,
      sampleRate: REPLAY_EXPORT_SAMPLE_RATE,
      channels: REPLAY_EXPORT_CHANNELS,
    },
    visual: {
      bgDim: capture.bgDim,
      blackPlayfield: capture.blackPlayfield,
      scrollSpeed: capture.scrollSpeed,
      showInputOverlay: capture.showInputOverlay,
      inputOverlayOnly: capture.inputOverlayOnly,
      inputOverlayColor: capture.inputOverlayColor,
      inputOverlayKeyHistory: capture.inputOverlayKeyHistory,
      missThumbHand: capture.missThumbHand,
      storyboardEnabled: capture.storyboardEnabled && capture.storyboard !== null,
      leaderboardVisible: capture.leaderboardVisible,
      skinSettings: structuredClone(capture.skinSettings),
      overlaySettings: structuredClone(capture.overlaySettings),
      ...(capture.viewport ? { viewport: replayExportViewport(capture.viewport, dimensions) } : {}),
    },
    audio: {
      songEnabled: wantsAudio && capture.songUrl !== null,
      songVolume: capture.songVolume,
      hitsoundsEnabled,
      beatmapHitsounds: capture.beatmapHitsounds,
      beatmapHitsoundVolume: capture.beatmapHitsoundVolume,
      keypressHitsounds: capture.keypressHitsounds,
      keypressHitsoundVolume: capture.keypressHitsoundVolume,
      comboBreakSound: capture.comboBreakSound,
    },
    assets: assetManifest(capture),
    locale: capture.locale,
    filename: buildReplayExportFilename(capture),
  };
}

async function fetchOwnedBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new ReplayExportError("asset_load_failed", `Asset request failed (${response.status}).`);
  return response.blob();
}

async function loadOwnedBackground(
  candidates: Array<string | null | undefined>,
  signal: AbortSignal,
): Promise<ImageBitmap | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const url = getInlineBackgroundUrl(candidate ?? null);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      const blob = await fetchOwnedBlob(url, signal);
      return await createImageBitmap(blob);
    } catch (error) {
      if (signal.aborted) throw new ReplayExportError("export_interrupted");
      void error;
    }
  }
  return null;
}

/**
 * Takes ownership of the job's input bytes. Runs once, during the job's
 * preparation phase, and everything it returns lives until `release()`.
 */
export async function resolveReplayExportResources(
  capture: ReplayExportCapture,
  spec: ReplayExportSpecV1,
  signal: AbortSignal,
): Promise<LocalExportResources> {
  let songFile: Blob | null = null;
  if (spec.audio.songEnabled && capture.songUrl) {
    try {
      songFile = await fetchOwnedBlob(capture.songUrl, signal);
    } catch (error) {
      if (signal.aborted) throw new ReplayExportError("export_interrupted");
      throw new ReplayExportError(
        "asset_load_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  const backgroundImage = await loadOwnedBackground(capture.backgroundUrls, signal);

  let released = false;
  const resources: LocalExportResources = {
    replayFrames: capture.replayFrames,
    lifeBarFrames: capture.lifeBarFrames,
    notes: capture.notes,
    timingPoints: capture.timingPoints,
    scrollVelocities: capture.scrollVelocities,
    expectedCounts: capture.expectedCounts,
    realTotalScore: capture.realTotalScore ?? undefined,
    initialCombo: capture.initialCombo,
    leaderboard: capture.leaderboard,
    leaderboardPlayerName: capture.leaderboardPlayerName,
    leaderboardOptions: capture.leaderboardOptions ? { ...capture.leaderboardOptions } : undefined,
    storyboard: capture.storyboard,
    songFile,
    backgroundImage,
    // Already a copy taken from the viewer's player, so a skin swap during
    // the export cannot replace the job's samples.
    hitsoundSamples: capture.hitsoundSamples,
    release: () => {
      if (released) return;
      released = true;
      resources.songFile = null;
      if (resources.backgroundImage && "close" in resources.backgroundImage) {
        resources.backgroundImage.close();
      }
      resources.backgroundImage = null;
      resources.hitsoundSamples = new Map();
      resources.storyboard = null;
      resources.leaderboard = [];
    },
  };
  return resources;
}
