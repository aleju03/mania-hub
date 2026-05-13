import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { uploadReplayVideo } from "./r2.js";

const MAX_VIDEO_BYTES = 600 * 1024 * 1024;
const VIDEO_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export type ReplayVideoExportStatus = "started" | "uploaded" | "queued" | "running" | "done" | "failed" | "cancelled";

export type ReplayVideoExportRow = {
  id: string;
  filename: string;
  status: ReplayVideoExportStatus;
  fps: number;
  width: number;
  height: number;
  audioUrl: string | null;
  audioStartSeconds: number;
  sourceDurationSeconds: number;
  effectiveRate: number;
  storageKey: string | null;
  url: string | null;
  signed: boolean;
  sizeBytes: number | null;
  mimeType: string | null;
  encodedWith: string | null;
  hasAudio: boolean | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type StartInput = {
  filename?: unknown;
  fps?: unknown;
  width?: unknown;
  height?: unknown;
  audioUrl?: unknown;
  audioStartSeconds?: unknown;
  sourceDurationSeconds?: unknown;
  effectiveRate?: unknown;
};

export async function createReplayVideoExport(db: Db, config: Config, input: StartInput): Promise<ReplayVideoExportRow> {
  let id = createVideoId();
  while (await getReplayVideoExport(db, id)) id = createVideoId();
  const now = new Date().toISOString();
  await mkdir(workDir(config, id), { recursive: true });
  await exec(
    db,
    `insert into replay_video_exports
     (id, filename, status, fps, width, height, audio_url, audio_start_seconds, source_duration_seconds, effective_rate, created_at, updated_at)
     values (?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sanitizeFilename(input.filename),
      Math.round(parsePositiveNumber(input.fps, 30, 60)),
      Math.round(parsePositiveNumber(input.width, 1280, 1920)),
      Math.round(parsePositiveNumber(input.height, 720, 1080)),
      typeof input.audioUrl === "string" && input.audioUrl ? input.audioUrl : null,
      Math.max(0, Number(input.audioStartSeconds) || 0),
      parsePositiveNumber(input.sourceDurationSeconds, 1, 60 * 60),
      parsePositiveNumber(input.effectiveRate, 1, 4),
      now,
      now,
    ],
  );
  const row = await getReplayVideoExport(db, id);
  if (!row) throw new Error("Failed to create replay video export");
  return row;
}

export async function writeReplayVideoUpload(db: Db, config: Config, id: string, buffer: Buffer): Promise<ReplayVideoExportRow> {
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error("Video is too large.");
  const row = await requireReplayVideoExport(db, id);
  if (row.status === "done" || row.status === "cancelled") throw new Error(`Replay video job is ${row.status}.`);
  await mkdir(workDir(config, id), { recursive: true });
  await writeFile(inputPath(config, id), buffer);
  await exec(db, "update replay_video_exports set status = 'uploaded', error = null, updated_at = ? where id = ?", [new Date().toISOString(), id]);
  return requireReplayVideoExport(db, id);
}

export async function markReplayVideoQueued(db: Db, id: string): Promise<ReplayVideoExportRow> {
  const row = await requireReplayVideoExport(db, id);
  if (row.status !== "uploaded" && row.status !== "failed") throw new Error("Upload the replay video before finalizing.");
  await exec(db, "update replay_video_exports set status = 'queued', error = null, updated_at = ? where id = ?", [new Date().toISOString(), id]);
  return requireReplayVideoExport(db, id);
}

export async function cancelReplayVideoExport(db: Db, config: Config, id: string): Promise<void> {
  await exec(db, "update replay_video_exports set status = 'cancelled', updated_at = ? where id = ?", [new Date().toISOString(), id]);
  await rm(workDir(config, id), { recursive: true, force: true });
}

export async function finishReplayVideoExport(db: Db, config: Config, id: string): Promise<ReplayVideoExportRow> {
  const row = await requireReplayVideoExport(db, id);
  if (row.status === "done") return row;
  if (row.status === "cancelled") throw new Error("Replay video export was cancelled.");
  await exec(db, "update replay_video_exports set status = 'running', error = null, updated_at = ? where id = ?", [new Date().toISOString(), id]);

  try {
    const input = inputPath(config, id);
    const output = outputPath(config, id);
    const audio = audioPath(config, id);
    const optimized = optimizedPath(config, id);
    const hasAudio = row.audioUrl ? await saveFetchedAudio(row.audioUrl, audio) : false;
    const sourceDuration = Math.max(0.1, row.sourceDurationSeconds);
    let encodedWith = "webcodecs-avc";
    let finalPath = input;

    if (hasAudio) {
      if (config.replayVideoOptimize) {
        const optimizedWithAudio = await optimizeVideoWithAudio(config, input, audio, optimized, row, sourceDuration);
        if (optimizedWithAudio) {
          finalPath = optimized;
          encodedWith = `webcodecs-avc+ffmpeg-x264-crf${config.replayVideoOptimizeCrf}+aac`;
        }
      }
      if (finalPath === input) {
        await muxAudioCopyVideo(config, input, audio, output, row, sourceDuration);
        finalPath = output;
        encodedWith = "webcodecs-avc+ffmpeg-aac";
      }
    } else if (config.replayVideoOptimize) {
      const optimizedVideo = await optimizeVideoOnly(config, input, optimized);
      if (optimizedVideo) {
        finalPath = optimized;
        encodedWith = `webcodecs-avc+ffmpeg-x264-crf${config.replayVideoOptimizeCrf}`;
      }
    }

    const buffer = await readFile(finalPath);
    const uploaded = await uploadReplayVideo(config, id, row.filename, "video/mp4", buffer);
    const now = new Date().toISOString();
    await exec(
      db,
      `update replay_video_exports
       set status = 'done', storage_key = ?, url = ?, signed = ?, size_bytes = ?, mime_type = ?,
           encoded_with = ?, has_audio = ?, error = null, completed_at = ?, updated_at = ?
       where id = ?`,
      [uploaded.storageKey, uploaded.url, uploaded.signed ? 1 : 0, uploaded.sizeBytes, uploaded.mimeType, encodedWith, hasAudio ? 1 : 0, now, now, id],
    );
    await rm(workDir(config, id), { recursive: true, force: true });
    return requireReplayVideoExport(db, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await exec(db, "update replay_video_exports set status = 'failed', error = ?, updated_at = ? where id = ?", [message, new Date().toISOString(), id]);
    throw error;
  }
}

export async function getReplayVideoExport(db: Db, id: string): Promise<ReplayVideoExportRow | null> {
  const row = (await exec(db, "select * from replay_video_exports where id = ? limit 1", [id])).rows[0];
  return row ? rowToExport(row) : null;
}

export async function requireReplayVideoExport(db: Db, id: string): Promise<ReplayVideoExportRow> {
  const row = await getReplayVideoExport(db, id);
  if (!row) throw new Error("Unknown replay video job.");
  return row;
}

export function replayVideoExportResponse(row: ReplayVideoExportRow): Record<string, unknown> {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    url: row.url,
    signed: row.signed,
    storageKey: row.storageKey,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    encodedWith: row.encodedWith,
    hasAudio: row.hasAudio,
    error: row.error,
  };
}

function rowToExport(row: Record<string, unknown>): ReplayVideoExportRow {
  return {
    id: String(row.id),
    filename: String(row.filename),
    status: String(row.status) as ReplayVideoExportStatus,
    fps: Number(row.fps),
    width: Number(row.width),
    height: Number(row.height),
    audioUrl: row.audio_url == null ? null : String(row.audio_url),
    audioStartSeconds: Number(row.audio_start_seconds),
    sourceDurationSeconds: Number(row.source_duration_seconds),
    effectiveRate: Number(row.effective_rate),
    storageKey: row.storage_key == null ? null : String(row.storage_key),
    url: row.url == null ? null : String(row.url),
    signed: Number(row.signed) === 1,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    mimeType: row.mime_type == null ? null : String(row.mime_type),
    encodedWith: row.encoded_with == null ? null : String(row.encoded_with),
    hasAudio: row.has_audio == null ? null : Number(row.has_audio) === 1,
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

async function saveFetchedAudio(audioUrl: string, outputPath: string): Promise<boolean> {
  try {
    const response = await fetch(audioUrl, { headers: { "User-Agent": "mania-hub-replay-video-export" } });
    if (!response.ok) return false;
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  const binary = process.env.FFMPEG_PATH || (typeof ffmpegStaticPath === "string" ? ffmpegStaticPath : "ffmpeg");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      code === 0 ? resolvePromise() : reject(new Error(`ffmpeg exited with ${code ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}

async function optimizeVideoOnly(config: Config, input: string, output: string): Promise<boolean> {
  try {
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-map",
      "0:v:0",
      ...optimizedVideoArgs(config),
      "-movflags",
      "+faststart",
      output,
    ]);
    const [inputStats, outputStats] = await Promise.all([stat(input), stat(output)]);
    return outputStats.size < inputStats.size;
  } catch {
    return false;
  }
}

async function optimizeVideoWithAudio(
  config: Config,
  input: string,
  audio: string,
  output: string,
  row: ReplayVideoExportRow,
  sourceDuration: number,
): Promise<boolean> {
  try {
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-ss",
      String(Math.max(0, row.audioStartSeconds)),
      "-t",
      String(sourceDuration),
      "-i",
      audio,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      ...optimizedVideoArgs(config),
      "-af",
      atempoChain(row.effectiveRate),
      "-c:a",
      "aac",
      "-b:a",
      config.replayVideoAudioBitrate,
      "-shortest",
      "-movflags",
      "+faststart",
      output,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function muxAudioCopyVideo(
  config: Config,
  input: string,
  audio: string,
  output: string,
  row: ReplayVideoExportRow,
  sourceDuration: number,
): Promise<void> {
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-ss",
    String(Math.max(0, row.audioStartSeconds)),
    "-t",
    String(sourceDuration),
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-af",
    atempoChain(row.effectiveRate),
    "-c:a",
    "aac",
    "-b:a",
    config.replayVideoAudioBitrate,
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  ]);
}

function optimizedVideoArgs(config: Config): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    config.replayVideoOptimizePreset,
    "-crf",
    String(config.replayVideoOptimizeCrf),
    "-pix_fmt",
    "yuv420p",
  ];
}

function atempoChain(rate: number): string {
  let remaining = Math.max(0.25, Math.min(4, rate));
  const filters: string[] = [];
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`);
  return filters.join(",");
}

function createVideoId(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (const byte of bytes) out += VIDEO_ID_ALPHABET[byte % VIDEO_ID_ALPHABET.length];
  return out;
}

function sanitizeFilename(value: unknown): string {
  const fallback = `replay-${Date.now()}.mp4`;
  if (typeof value !== "string") return fallback;
  const safe = value
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  if (!safe) return fallback;
  const withoutExtension = safe.replace(/\.(webm|mp4)$/i, "");
  return `${withoutExtension || "replay"}.mp4`;
}

function parsePositiveNumber(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function workDir(config: Config, id: string): string {
  return resolve(config.replayVideoWorkDir, id);
}

function inputPath(config: Config, id: string): string {
  return resolve(workDir(config, id), "video.mp4");
}

function outputPath(config: Config, id: string): string {
  return resolve(workDir(config, id), "out.mp4");
}

function optimizedPath(config: Config, id: string): string {
  return resolve(workDir(config, id), "optimized.mp4");
}

function audioPath(config: Config, id: string): string {
  return resolve(workDir(config, id), "audio.bin");
}
