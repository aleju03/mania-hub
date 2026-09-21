// The serializable half of an export job.
//
// A spec says *what* to render in plain JSON: resolved settings, a source
// range, an output configuration, and the identities of the files involved.
// It holds no `blob:` URLs, no file handles, no decoded buffers, no tokens,
// and no reference to the React tree that produced it. Everything runtime and
// browser-owned lives in `LocalExportResources` instead (see `types.ts`), so
// this object can be stringified, stored, diffed, and hashed.

import type { ReplayOverlaySettings, ReplayThumbHand } from "../replay-overlays";
import type { ReplaySkinSettings } from "../replay-skin";
import type { ReplayViewportSnapshot } from "../replay-types";

export const REPLAY_EXPORT_SPEC_VERSION = 1;

/**
 * Bumped by hand whenever a change to the export renderer, compositor,
 * timeline, or audio pipeline can move pixels or samples. A moving "latest"
 * label would let a spec captured under one build be rendered by another and
 * still claim to match.
 */
export const REPLAY_EXPORT_RENDERER_REVISION = "replay-export-r5";

export type ReplayExportPitchPolicy = "follows-rate" | "preserved";

export type ReplayExportAssetRole =
  | "replay"
  | "beatmap"
  | "song"
  | "background"
  | "skin-image"
  | "skin-sound"
  | "beatmap-sound"
  | "default-sound"
  | "storyboard"
  | "font";

/**
 * A logical asset identity, never a locator. `id` is stable for the same
 * bytes (a beatmap file name, a sample key, an osu! asset id); resolving it to
 * actual bytes is the resolver's job and differs per environment.
 */
export type ReplayExportAssetRef = {
  role: ReplayExportAssetRole;
  id: string;
};

export type ReplayExportOutputSpec = {
  container: "mp4" | "webm";
  width: number;
  height: number;
  fps: number;
  videoCodec: "av1" | "avc" | "vp9" | "vp8";
  videoBitrate: number;
  /** AV1 quality target; absent for bitrate-controlled codecs. */
  videoQuantizer?: number;
  /** Null when the export was explicitly asked for without an audio track. */
  audioCodec: "aac" | "opus" | null;
  audioBitrate: number;
  sampleRate: number;
  channels: number;
};

export type ReplayExportVisualSpec = {
  bgDim: number;
  blackPlayfield: boolean;
  scrollSpeed: number;
  showInputOverlay: boolean;
  inputOverlayOnly: boolean;
  inputOverlayColor: string;
  inputOverlayKeyHistory: boolean;
  missThumbHand: ReplayThumbHand;
  storyboardEnabled: boolean;
  leaderboardVisible: boolean;
  skinSettings: ReplaySkinSettings;
  overlaySettings: ReplayOverlaySettings;
  /** Captured viewer composition; older specs without this use the output dimensions. */
  viewport?: ReplayViewportSnapshot;
};

export type ReplayExportAudioSpec = {
  songEnabled: boolean;
  /** Viewer master volume, 0-1, already resolved. */
  songVolume: number;
  hitsoundsEnabled: boolean;
  beatmapHitsounds: boolean;
  beatmapHitsoundVolume: number;
  keypressHitsounds: boolean;
  keypressHitsoundVolume: number;
  comboBreakSound: boolean;
};

/**
 * A mod as the renderer consumes it: an acronym plus whatever settings came
 * with it (a custom rate, a hidden coverage). Dropping the settings would
 * silently re-render a play under a different mod than the one it used.
 */
export type ReplayExportModSpec = {
  acronym: string;
  settings?: Record<string, string | number | boolean>;
};

export type ReplayExportRulesetSpec = {
  keyCount: number;
  isConvert: boolean;
  isLazer: boolean;
  legacyReplayFrameRounding: boolean;
  od: number | null;
  mods: ReplayExportModSpec[];
  modRate: number;
  userSpeed: number;
};

export type ReplayExportSpecV1 = {
  schemaVersion: typeof REPLAY_EXPORT_SPEC_VERSION;
  rendererRevision: string;
  /** Free-form build label; excluded from the content hash on purpose. */
  appVersion: string;
  source: {
    scoreId: number | null;
    beatmapId: number | null;
    beatmapsetId: number | null;
    beatmapChecksum: string | null;
    uploadId: string | null;
    playerName: string;
  };
  ruleset: ReplayExportRulesetSpec;
  range: { startMs: number; endMs: number };
  playback: { rate: number; pitchPolicy: ReplayExportPitchPolicy };
  output: ReplayExportOutputSpec;
  visual: ReplayExportVisualSpec;
  audio: ReplayExportAudioSpec;
  assets: ReplayExportAssetRef[];
  /** Locale the rendered text (leaderboard, HUD labels) was resolved under. */
  locale: string;
  filename: string;
};

function fail(message: string): never {
  throw new TypeError(`Invalid replay export spec: ${message}`);
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requireNullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  return requireFiniteNumber(value, path);
}

function requireNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requireString(value, path);
}

function parseViewport(value: unknown): ReplayViewportSnapshot {
  const viewport = requireObject(value, "visual.viewport");
  const width = requireFiniteNumber(viewport.width, "visual.viewport.width");
  const height = requireFiniteNumber(viewport.height, "visual.viewport.height");
  if (width < 1 || height < 1) fail("visual.viewport dimensions must be at least one pixel");
  return {
    width, height,
    fullscreen: requireBoolean(viewport.fullscreen, "visual.viewport.fullscreen"),
    fullHeight: requireBoolean(viewport.fullHeight, "visual.viewport.fullHeight"),
    coarsePointer: requireBoolean(viewport.coarsePointer, "visual.viewport.coarsePointer"),
  };
}

const ASSET_ROLES = new Set<string>([
  "replay",
  "beatmap",
  "song",
  "background",
  "skin-image",
  "skin-sound",
  "beatmap-sound",
  "default-sound",
  "storyboard",
  "font",
]);

/**
 * Runtime validation at the boundary. Every future runner parses a spec with
 * this rather than trusting a cast, so an unknown settings bag or an injected
 * locator can never reach the renderer.
 */
export function parseReplayExportSpec(value: unknown): ReplayExportSpecV1 {
  const raw = requireObject(value, "spec");
  if (raw.schemaVersion !== REPLAY_EXPORT_SPEC_VERSION) {
    fail(`schemaVersion must be ${REPLAY_EXPORT_SPEC_VERSION}`);
  }

  const source = requireObject(raw.source, "source");
  const ruleset = requireObject(raw.ruleset, "ruleset");
  const range = requireObject(raw.range, "range");
  const playback = requireObject(raw.playback, "playback");
  const output = requireObject(raw.output, "output");
  const visual = requireObject(raw.visual, "visual");
  const audio = requireObject(raw.audio, "audio");

  if (!Array.isArray(raw.assets)) fail("assets must be an array");
  const assets = raw.assets.map((entry, index) => {
    const asset = requireObject(entry, `assets[${index}]`);
    const role = requireString(asset.role, `assets[${index}].role`);
    if (!ASSET_ROLES.has(role)) fail(`assets[${index}].role is not a known role`);
    const id = requireString(asset.id, `assets[${index}].id`);
    if (/^(?:blob|data|https?|file):/i.test(id)) {
      fail(`assets[${index}].id is a locator, not an identity`);
    }
    return { role: role as ReplayExportAssetRole, id };
  });

  const startMs = requireFiniteNumber(range.startMs, "range.startMs");
  const endMs = requireFiniteNumber(range.endMs, "range.endMs");
  if (endMs <= startMs) fail("range.endMs must be greater than range.startMs");

  const pitchPolicy = requireString(playback.pitchPolicy, "playback.pitchPolicy");
  if (pitchPolicy !== "follows-rate" && pitchPolicy !== "preserved") {
    fail("playback.pitchPolicy must be 'follows-rate' or 'preserved'");
  }

  const container = requireString(output.container, "output.container");
  if (container !== "mp4" && container !== "webm") fail("output.container must be 'mp4' or 'webm'");
  const videoCodec = requireString(output.videoCodec, "output.videoCodec");
  if (videoCodec !== "av1" && videoCodec !== "avc" && videoCodec !== "vp9" && videoCodec !== "vp8") {
    fail("output.videoCodec is not a supported codec");
  }
  const videoQuantizer = output.videoQuantizer === undefined
    ? undefined : requireFiniteNumber(output.videoQuantizer, "output.videoQuantizer");
  if (videoQuantizer !== undefined && (videoCodec !== "av1" || !Number.isInteger(videoQuantizer)
    || videoQuantizer < 0 || videoQuantizer > 255)) {
    fail("output.videoQuantizer must be an AV1 quantizer index from 0 to 255");
  }
  const audioCodec = output.audioCodec === null ? null : requireString(output.audioCodec, "output.audioCodec");
  if (audioCodec !== null && audioCodec !== "aac" && audioCodec !== "opus") {
    fail("output.audioCodec is not a supported codec");
  }

  if (!Array.isArray(ruleset.mods)) fail("ruleset.mods must be an array");
  const mods = ruleset.mods.map((entry, index) => {
    const mod = requireObject(entry, `ruleset.mods[${index}]`);
    const acronym = requireString(mod.acronym, `ruleset.mods[${index}].acronym`);
    if (mod.settings === undefined) return { acronym };
    const settings = requireObject(mod.settings, `ruleset.mods[${index}].settings`);
    const cleaned: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(settings)) {
      const kind = typeof value;
      if (kind !== "string" && kind !== "number" && kind !== "boolean") {
        fail(`ruleset.mods[${index}].settings.${key} must be a string, number, or boolean`);
      }
      if (kind === "number" && !Number.isFinite(value as number)) {
        fail(`ruleset.mods[${index}].settings.${key} must be finite`);
      }
      cleaned[key] = value as string | number | boolean;
    }
    return { acronym, settings: cleaned };
  });

  return {
    schemaVersion: REPLAY_EXPORT_SPEC_VERSION,
    rendererRevision: requireString(raw.rendererRevision, "rendererRevision"),
    appVersion: requireString(raw.appVersion, "appVersion"),
    source: {
      scoreId: requireNullableNumber(source.scoreId, "source.scoreId"),
      beatmapId: requireNullableNumber(source.beatmapId, "source.beatmapId"),
      beatmapsetId: requireNullableNumber(source.beatmapsetId, "source.beatmapsetId"),
      beatmapChecksum: requireNullableString(source.beatmapChecksum, "source.beatmapChecksum"),
      uploadId: requireNullableString(source.uploadId, "source.uploadId"),
      playerName: requireString(source.playerName, "source.playerName"),
    },
    ruleset: {
      keyCount: requireFiniteNumber(ruleset.keyCount, "ruleset.keyCount"),
      isConvert: requireBoolean(ruleset.isConvert, "ruleset.isConvert"),
      isLazer: requireBoolean(ruleset.isLazer, "ruleset.isLazer"),
      legacyReplayFrameRounding: requireBoolean(
        ruleset.legacyReplayFrameRounding,
        "ruleset.legacyReplayFrameRounding",
      ),
      od: requireNullableNumber(ruleset.od, "ruleset.od"),
      mods,
      modRate: requireFiniteNumber(ruleset.modRate, "ruleset.modRate"),
      userSpeed: requireFiniteNumber(ruleset.userSpeed, "ruleset.userSpeed"),
    },
    range: { startMs, endMs },
    playback: {
      rate: requireFiniteNumber(playback.rate, "playback.rate"),
      pitchPolicy,
    },
    output: {
      container,
      width: requireFiniteNumber(output.width, "output.width"),
      height: requireFiniteNumber(output.height, "output.height"),
      fps: requireFiniteNumber(output.fps, "output.fps"),
      videoCodec,
      videoBitrate: requireFiniteNumber(output.videoBitrate, "output.videoBitrate"),
      ...(videoQuantizer === undefined ? {} : { videoQuantizer }),
      audioCodec,
      audioBitrate: requireFiniteNumber(output.audioBitrate, "output.audioBitrate"),
      sampleRate: requireFiniteNumber(output.sampleRate, "output.sampleRate"),
      channels: requireFiniteNumber(output.channels, "output.channels"),
    },
    visual: {
      bgDim: requireFiniteNumber(visual.bgDim, "visual.bgDim"),
      blackPlayfield: requireBoolean(visual.blackPlayfield, "visual.blackPlayfield"),
      scrollSpeed: requireFiniteNumber(visual.scrollSpeed, "visual.scrollSpeed"),
      showInputOverlay: requireBoolean(visual.showInputOverlay, "visual.showInputOverlay"),
      inputOverlayOnly: requireBoolean(visual.inputOverlayOnly, "visual.inputOverlayOnly"),
      inputOverlayColor: requireString(visual.inputOverlayColor, "visual.inputOverlayColor"),
      inputOverlayKeyHistory: requireBoolean(visual.inputOverlayKeyHistory, "visual.inputOverlayKeyHistory"),
      missThumbHand: requireString(visual.missThumbHand, "visual.missThumbHand") as ReplayThumbHand,
      storyboardEnabled: requireBoolean(visual.storyboardEnabled, "visual.storyboardEnabled"),
      leaderboardVisible: requireBoolean(visual.leaderboardVisible, "visual.leaderboardVisible"),
      skinSettings: requireObject(visual.skinSettings, "visual.skinSettings") as unknown as ReplaySkinSettings,
      overlaySettings: requireObject(visual.overlaySettings, "visual.overlaySettings") as unknown as ReplayOverlaySettings,
      ...(visual.viewport === undefined ? {} : { viewport: parseViewport(visual.viewport) }),
    },
    audio: {
      songEnabled: requireBoolean(audio.songEnabled, "audio.songEnabled"),
      songVolume: requireFiniteNumber(audio.songVolume, "audio.songVolume"),
      hitsoundsEnabled: requireBoolean(audio.hitsoundsEnabled, "audio.hitsoundsEnabled"),
      beatmapHitsounds: requireBoolean(audio.beatmapHitsounds, "audio.beatmapHitsounds"),
      beatmapHitsoundVolume: requireFiniteNumber(audio.beatmapHitsoundVolume, "audio.beatmapHitsoundVolume"),
      keypressHitsounds: requireBoolean(audio.keypressHitsounds, "audio.keypressHitsounds"),
      keypressHitsoundVolume: requireFiniteNumber(audio.keypressHitsoundVolume, "audio.keypressHitsoundVolume"),
      comboBreakSound: requireBoolean(audio.comboBreakSound, "audio.comboBreakSound"),
    },
    assets,
    locale: requireString(raw.locale, "locale"),
    filename: requireString(raw.filename, "filename"),
  };
}

/** Round-trips a spec through JSON, the way a future runner would receive it. */
export function cloneReplayExportSpec(spec: ReplayExportSpecV1): ReplayExportSpecV1 {
  return parseReplayExportSpec(JSON.parse(JSON.stringify(spec)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "number") {
    // -0 and 0 render the same frame; normalize so they hash the same.
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) result[key] = canonicalize(entryValue);
    return result;
  }
  return value;
}

/**
 * Stable string form of everything that can change the rendered output. The
 * build label is dropped (the renderer revision already pins behavior) and no
 * credential, URL, path, or job timestamp is ever part of a spec, so there is
 * nothing else to strip.
 */
export function canonicalReplayExportSpecJson(spec: ReplayExportSpecV1): string {
  const { appVersion: _appVersion, ...rest } = spec;
  return JSON.stringify(canonicalize(rest));
}

export async function hashReplayExportSpec(spec: ReplayExportSpecV1): Promise<string> {
  const json = canonicalReplayExportSpecJson(spec);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable, so an export spec cannot be hashed.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
