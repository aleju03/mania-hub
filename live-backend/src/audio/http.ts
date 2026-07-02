import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import {
  getCachedBeatmapAudioMetadata,
  getPreparedBeatmapAudio,
  isAllowedBeatmapAudioFilename,
  type PreparedBeatmapAudio,
} from "./beatmap-audio.js";
import { HITSOUND_BUNDLE_MIME_TYPE, getPreparedHitsoundBundle } from "./hitsound-bundle.js";

const AUDIO_CACHE_HEADERS = {
  "cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
};

const AUDIO_IMMUTABLE_CACHE_HEADERS = {
  "cache-control": "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
};

export async function handleBeatmapAudioRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  url: URL,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendAudioCors(req, res, config);
    res.statusCode = 405;
    res.setHeader("allow", "GET,HEAD");
    res.end("Method not allowed");
    return;
  }

  const beatmapsetId = url.searchParams.get("beatmapsetId");
  const filename = url.searchParams.get("filename");
  if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
    sendAudioText(req, res, config, 400, "Invalid beatmapsetId");
    return;
  }
  if (!filename || !isAllowedBeatmapAudioFilename(filename)) {
    sendAudioText(req, res, config, 400, "Invalid filename");
    return;
  }

  if (req.method === "HEAD") {
    const cached = await getCachedBeatmapAudioMetadata(config, beatmapsetId, filename);
    if (!cached) {
      sendAudioCors(req, res, config);
      res.statusCode = 404;
      for (const [key, value] of Object.entries(AUDIO_CACHE_HEADERS)) res.setHeader(key, value);
      res.end();
      return;
    }
    sendAudioHeaders(req, res, config, cached, AUDIO_CACHE_HEADERS);
    res.statusCode = 200;
    res.end();
    return;
  }

  try {
    const audio = await getPreparedBeatmapAudio(config, beatmapsetId, filename);
    if (audio.publicUrl) {
      sendAudioCors(req, res, config);
      res.statusCode = 302;
      for (const [key, value] of Object.entries(AUDIO_CACHE_HEADERS)) res.setHeader(key, value);
      res.setHeader("location", audio.publicUrl);
      res.end();
      return;
    }
    const buffer = audio.buffer;
    if (!buffer) {
      sendAudioText(req, res, config, 404, "Audio is not available");
      return;
    }
    sendAudioBuffer(req, res, config, audio, buffer, req.headers.range);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown audio extraction error";
    sendAudioText(req, res, config, 404, message);
  }
}

// GET /api/hitsounds?beatmapsetId=…[&exclude=audio.mp3]
// Serves the set's hitsound files as one store-only zip (or 302 to the R2
// copy). An empty zip means the set has no hitsound files.
export async function handleBeatmapHitsoundsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  url: URL,
): Promise<void> {
  if (req.method !== "GET") {
    sendAudioCors(req, res, config);
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end("Method not allowed");
    return;
  }

  const beatmapsetId = url.searchParams.get("beatmapsetId");
  const exclude = url.searchParams.get("exclude");
  if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
    sendAudioText(req, res, config, 400, "Invalid beatmapsetId");
    return;
  }
  if (exclude != null && (exclude.length > 260 || exclude.includes("\0"))) {
    sendAudioText(req, res, config, 400, "Invalid exclude");
    return;
  }

  try {
    const bundle = await getPreparedHitsoundBundle(config, beatmapsetId, exclude || null);
    if (bundle.publicUrl) {
      sendAudioCors(req, res, config);
      res.statusCode = 302;
      for (const [key, value] of Object.entries(AUDIO_CACHE_HEADERS)) res.setHeader(key, value);
      res.setHeader("location", bundle.publicUrl);
      res.end();
      return;
    }
    if (!bundle.buffer) {
      sendAudioText(req, res, config, 404, "Hitsounds are not available");
      return;
    }
    sendAudioCors(req, res, config);
    res.statusCode = 200;
    for (const [key, value] of Object.entries(AUDIO_IMMUTABLE_CACHE_HEADERS)) res.setHeader(key, value);
    res.setHeader("content-type", HITSOUND_BUNDLE_MIME_TYPE);
    res.setHeader("content-length", String(bundle.buffer.length));
    res.end(bundle.buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown hitsound extraction error";
    sendAudioText(req, res, config, 404, message);
  }
}

function sendAudioBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  audio: PreparedBeatmapAudio,
  buffer: Buffer,
  rangeHeader: string | string[] | undefined,
): void {
  const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
  const size = buffer.length;
  const baseHeaders = {
    ...AUDIO_IMMUTABLE_CACHE_HEADERS,
    "content-type": audio.mimeType,
    "accept-ranges": "bytes",
    "x-audio-mp3-in-mp4": audio.mp3InMp4 ? "1" : "0",
    "x-audio-size-bytes": String(size),
  };

  if (range) {
    const parsed = parseRangeHeader(range, size);
    if (!parsed) {
      sendAudioCors(req, res, config);
      res.statusCode = 416;
      for (const [key, value] of Object.entries(baseHeaders)) res.setHeader(key, value);
      res.setHeader("content-range", `bytes */${size}`);
      res.end("Invalid Range");
      return;
    }
    const { start, end } = parsed;
    const slice = buffer.subarray(start, end + 1);
    sendAudioCors(req, res, config);
    res.statusCode = 206;
    for (const [key, value] of Object.entries(baseHeaders)) res.setHeader(key, value);
    res.setHeader("content-length", String(slice.length));
    res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
    res.end(slice);
    return;
  }

  sendAudioCors(req, res, config);
  res.statusCode = 200;
  for (const [key, value] of Object.entries(baseHeaders)) res.setHeader(key, value);
  res.setHeader("content-length", String(size));
  res.end(buffer);
}

function sendAudioHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  audio: PreparedBeatmapAudio,
  cacheHeaders: Record<string, string>,
): void {
  sendAudioCors(req, res, config);
  for (const [key, value] of Object.entries(cacheHeaders)) res.setHeader(key, value);
  res.setHeader("content-type", audio.mimeType);
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-length", String(audio.sizeBytes));
  res.setHeader("x-audio-mp3-in-mp4", audio.mp3InMp4 ? "1" : "0");
  res.setHeader("x-audio-size-bytes", String(audio.sizeBytes));
}

function sendAudioText(req: IncomingMessage, res: ServerResponse, config: Config, status: number, body: string): void {
  sendAudioCors(req, res, config);
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

function sendAudioCors(req: IncomingMessage, res: ServerResponse, config: Config): void {
  const origin = req.headers.origin;
  if (origin && (config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-methods", "GET,HEAD,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization,range");
    res.setHeader(
      "access-control-expose-headers",
      "accept-ranges,content-length,content-range,content-type,x-audio-mp3-in-mp4,x-audio-size-bytes",
    );
    res.setHeader("access-control-max-age", "600");
  }
}

// Accepts: bytes=start-end | bytes=start- | bytes=-suffix
function parseRangeHeader(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size) return null;
  return { start, end };
}
