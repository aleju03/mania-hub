import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import type { Config } from "../config.js";
import { extractBeatmapArchiveFile } from "./beatmap-archive.js";
import {
  getCachedBeatmapAudioAsset,
  isBeatmapAudioStorageConfigured,
  readCachedBeatmapAudioAsset,
  uploadBeatmapAudioAsset,
  type BeatmapAudioAsset,
} from "./r2-assets.js";

// Fallback budgets for configs that predate the env vars (and for test configs
// that only fill in the fields they exercise).
const DEFAULT_AUDIO_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_AUDIO_CACHE_MAX_ENTRIES = 12;
const DEFAULT_AUDIO_CACHE_MAX_BYTES = 180 * 1024 * 1024;
const MAX_AUDIO_FILENAME_LENGTH = 260;
const MP4_AUDIO_MIME_TYPE = "audio/mp4";

type AudioValue = {
  buffer: Buffer;
  mimeType: string;
};

export type PreparedBeatmapAudio = {
  buffer: Buffer | null;
  mimeType: string;
  sizeBytes: number;
  publicUrl: string | null;
  mp3InMp4: boolean;
};

type AudioCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
  value: PreparedBeatmapAudio;
};

const preparedAudioCache = new Map<string, AudioCacheEntry>();
const preparedAudioPromises = new Map<string, Promise<PreparedBeatmapAudio>>();

const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".ogg", ".wav", ".flac", ".m4a"] as const;

export function isAllowedBeatmapAudioFilename(filename: string): boolean {
  if (filename.length > MAX_AUDIO_FILENAME_LENGTH || filename.includes("\0")) {
    return false;
  }
  const lower = filename.toLowerCase();
  return ALLOWED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isMp3BeatmapAudio(filename: string, mimeType?: string): boolean {
  return filename.toLowerCase().endsWith(".mp3") || mimeType === "audio/mpeg" || mimeType === "audio/mp3";
}

export function getBeatmapAudioMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return MP4_AUDIO_MIME_TYPE;
  return "application/octet-stream";
}

export async function getCachedBeatmapAudioMetadata(
  config: Config,
  beatmapsetId: string,
  filename: string,
): Promise<PreparedBeatmapAudio | null> {
  const cacheKey = getCacheKey(beatmapsetId, filename);
  const cached = getPreparedMemoryCache(cacheKey);
  if (cached) return cached;

  const asset = await getCachedBeatmapAudioAsset(config, beatmapsetId, filename);
  if (!asset) return null;
  return fromAsset(asset, filename, null);
}

export async function getPreparedBeatmapAudio(
  config: Config,
  beatmapsetId: string,
  filename: string,
): Promise<PreparedBeatmapAudio> {
  const cacheKey = getCacheKey(beatmapsetId, filename);
  const memoryCached = getPreparedMemoryCache(cacheKey);
  if (memoryCached) return memoryCached;

  const cachedAsset = await getCachedBeatmapAudioAsset(config, beatmapsetId, filename);
  if (cachedAsset?.publicUrl) return fromAsset(cachedAsset, filename, null);
  if (cachedAsset) {
    const object = await readCachedBeatmapAudioAsset(config, beatmapsetId, filename);
    if (object) {
      const value = fromAsset(object, filename, object.buffer);
      setPreparedMemoryCache(config, cacheKey, value);
      return value;
    }
  }

  let promise = preparedAudioPromises.get(cacheKey);
  if (!promise) {
    promise = prepareBeatmapAudio(config, beatmapsetId, filename)
      .finally(() => {
        preparedAudioPromises.delete(cacheKey);
      });
    preparedAudioPromises.set(cacheKey, promise);
  }
  return promise;
}

async function prepareBeatmapAudio(
  config: Config,
  beatmapsetId: string,
  filename: string,
): Promise<PreparedBeatmapAudio> {
  // Reuse a previously cached Ogg as the conversion source. A seek fix should
  // not require downloading the whole map archive again (or its availability).
  const legacyOgg = filename.toLowerCase().endsWith(".ogg")
    ? await readCachedBeatmapAudioAsset(config, beatmapsetId, filename, { legacyOgg: true })
    : null;
  const sourceBuffer = legacyOgg?.buffer
    ?? await extractBeatmapArchiveFile(beatmapsetId, filename, config.beatmapArchiveMaxBytes);
  const source: AudioValue = {
    buffer: sourceBuffer,
    mimeType: getBeatmapAudioMimeType(filename),
  };
  const playback = await preparePlaybackAudio(source, filename);

  if (isBeatmapAudioStorageConfigured(config)) {
    try {
      const uploaded = await uploadBeatmapAudioAsset(config, beatmapsetId, filename, playback.mimeType, playback.buffer);
      const value = fromAsset(uploaded, filename, uploaded.publicUrl ? null : playback.buffer);
      if (!uploaded.publicUrl) setPreparedMemoryCache(config, getCacheKey(beatmapsetId, filename), value);
      return value;
    } catch {
      // Serving directly is still better than breaking playback if storage has
      // a transient issue; the in-flight dedupe still prevents duplicate work.
    }
  }

  const value = {
    buffer: playback.buffer,
    mimeType: playback.mimeType,
    sizeBytes: playback.buffer.length,
    publicUrl: null,
    mp3InMp4: isMp3BeatmapAudio(filename, source.mimeType),
  };
  setPreparedMemoryCache(config, getCacheKey(beatmapsetId, filename), value);
  return value;
}

export async function preparePlaybackAudio(source: AudioValue, filename: string): Promise<AudioValue> {
  if (isMp3BeatmapAudio(filename, source.mimeType)) {
    return remuxPlaybackAudio(source, filename, "mp4");
  }
  if (filename.toLowerCase().endsWith(".ogg") || source.mimeType === "audio/ogg") {
    // Chromium can resume Ogg/Vorbis from an earlier packet while reporting
    // the requested time after seeking within buffered audio. With the usual
    // second-long Ogg pages, that leaves the song audibly behind its clock.
    // One packet per page gives every packet its own granule timestamp without
    // changing the codec, samples, pitch or browser format support.
    return remuxPlaybackAudio(source, filename, "ogg");
  }
  return source;
}

async function remuxPlaybackAudio(input: AudioValue, filename: string, format: "mp4" | "ogg"): Promise<AudioValue> {
  const dir = await mkdtemp(join(tmpdir(), "mania-hub-audio-playback-"));
  const inputPath = join(dir, `input${getAudioExtension(filename)}`);
  const outputPath = join(dir, `audio.${format}`);
  try {
    await writeFile(inputPath, input.buffer);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "copy",
      // Ogg normally randomizes its stream serial; keep identical sources
      // byte-identical so the content-addressed audio store can deduplicate.
      ...(format === "mp4" ? ["-movflags", "+faststart"] : ["-fflags", "+bitexact", "-page_duration", "1"]),
      outputPath,
    ]);
    return { buffer: await readFile(outputPath), mimeType: format === "mp4" ? MP4_AUDIO_MIME_TYPE : "audio/ogg" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[], binary?: string): Promise<void> {
  const resolvedBinary = binary || process.env.FFMPEG_PATH || (typeof ffmpegStaticPath === "string" ? ffmpegStaticPath : "ffmpeg");
  return new Promise((resolve, reject) => {
    const child = spawn(resolvedBinary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with ${code ?? "unknown"}: ${stderr.trim()}`));
      }
    });
  });
}

function fromAsset(asset: BeatmapAudioAsset, filename: string, buffer: Buffer | null): PreparedBeatmapAudio {
  return {
    buffer,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    publicUrl: asset.publicUrl,
    mp3InMp4: isMp3BeatmapAudio(filename),
  };
}

function getAudioExtension(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : ".bin";
}

function getCacheKey(beatmapsetId: string, filename: string): string {
  return `${beatmapsetId}:${filename}`;
}

function getPreparedMemoryCache(cacheKey: string, now = Date.now()): PreparedBeatmapAudio | null {
  const entry = preparedAudioCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    preparedAudioCache.delete(cacheKey);
    return null;
  }
  entry.lastAccessedAt = now;
  return entry.value;
}

function setPreparedMemoryCache(config: Config, cacheKey: string, value: PreparedBeatmapAudio, now = Date.now()): void {
  if (!value.buffer) return;
  preparedAudioCache.set(cacheKey, {
    expiresAt: now + (config.audioCacheTtlMs ?? DEFAULT_AUDIO_CACHE_TTL_MS),
    lastAccessedAt: now,
    sizeBytes: value.sizeBytes,
    value,
  });
  prunePreparedMemoryCache(config, now);
}

function prunePreparedMemoryCache(config: Config, now = Date.now()): void {
  const maxEntries = config.audioCacheMaxEntries ?? DEFAULT_AUDIO_CACHE_MAX_ENTRIES;
  const maxBytes = config.audioCacheMaxBytes ?? DEFAULT_AUDIO_CACHE_MAX_BYTES;

  for (const [key, entry] of preparedAudioCache.entries()) {
    if (entry.expiresAt <= now) preparedAudioCache.delete(key);
  }

  if (preparedAudioCache.size > maxEntries) {
    const entriesToRemove = [...preparedAudioCache.entries()]
      .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt)
      .slice(0, preparedAudioCache.size - maxEntries);

    entriesToRemove.forEach(([key]) => {
      preparedAudioCache.delete(key);
    });
  }

  let totalBytes = [...preparedAudioCache.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (totalBytes <= maxBytes) return;

  const entriesByAge = [...preparedAudioCache.entries()]
    .sort(([, a], [, b]) => a.lastAccessedAt - b.lastAccessedAt);

  for (const [key, entry] of entriesByAge) {
    if (totalBytes <= maxBytes) break;
    preparedAudioCache.delete(key);
    totalBytes -= entry.sizeBytes;
  }
}
