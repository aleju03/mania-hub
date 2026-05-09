import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import type { Connect } from "vite";
import { isR2ReplayCacheConfigured, putReplayVideoAndGetUrl } from "#/lib/r2-cache";

const MAX_FRAME_BYTES = 2.5 * 1024 * 1024;
const MAX_FRAMES = 12_000;
const JOB_TTL_MS = 20 * 60 * 1000;
const DEFAULT_REPLAY_VIDEO_PUBLIC_ORIGIN = "https://mania-tracker.com";
const VIDEO_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

type ReplayVideoJob = {
  id: string;
  dir: string;
  filename: string;
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  audioUrl: string | null;
  audioStartSeconds: number;
  sourceDurationSeconds: number;
  effectiveRate: number;
  createdAt: number;
};

const jobs = new Map<string, ReplayVideoJob>();

function createVideoId(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (const byte of bytes) out += VIDEO_ID_ALPHABET[byte % VIDEO_ID_ALPHABET.length];
  return out;
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeFilename(value: unknown): string {
  const fallback = `replay-${Date.now()}.webm`;
  if (typeof value !== "string") return fallback;
  const safe = value
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return safe && safe.toLowerCase().endsWith(".webm") ? safe : fallback;
}

function getReplayVideoPublicOrigin(): string {
  const raw = process.env.REPLAY_VIDEO_PUBLIC_ORIGIN
    || process.env.SITE_URL
    || process.env.VITE_SITE_URL
    || DEFAULT_REPLAY_VIDEO_PUBLIC_ORIGIN;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return DEFAULT_REPLAY_VIDEO_PUBLIC_ORIGIN;
  }
}

function parsePositiveNumber(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function cleanupExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt < JOB_TTL_MS) continue;
    jobs.delete(id);
    void rm(job.dir, { recursive: true, force: true });
  }
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

function runFfmpeg(args: string[]): Promise<void> {
  const binary = process.env.FFMPEG_PATH || ffmpegStaticPath || "ffmpeg";
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
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

async function saveFetchedAudio(request: Request, audioUrl: string, outputPath: string): Promise<boolean> {
  const response = await fetch(new URL(audioUrl, request.url), {
    headers: { "User-Agent": "mania-hub-replay-video-export" },
  });
  if (!response.ok) return false;
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return true;
}

async function finishJob(request: Request, job: ReplayVideoJob) {
  const outputPath = path.join(job.dir, "out.webm");
  const audioPath = path.join(job.dir, "audio.bin");
  const hasAudio = job.audioUrl ? await saveFetchedAudio(request, job.audioUrl, audioPath) : false;
  const sourceDuration = Math.max(0.1, job.sourceDurationSeconds);

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    String(job.fps),
    "-i",
    path.join(job.dir, "frame-%06d.jpg"),
  ];

  if (hasAudio) {
    args.push(
      "-ss",
      String(Math.max(0, job.audioStartSeconds)),
      "-t",
      String(sourceDuration),
      "-i",
      audioPath,
    );
  }

  args.push(
    "-map",
    "0:v:0",
  );

  if (hasAudio) {
    args.push("-map", "1:a:0");
  }

  args.push(
    "-frames:v",
    String(job.frameCount),
    "-vf",
    `scale=${job.width}:${job.height}:flags=lanczos,format=yuv420p`,
    "-c:v",
    "libvpx",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-b:v",
    process.env.REPLAY_VIDEO_BITRATE || "9000k",
  );

  if (hasAudio) {
    args.push(
      "-af",
      atempoChain(job.effectiveRate),
      "-c:a",
      "libopus",
      "-b:a",
      "128k",
      "-shortest",
    );
  } else {
    args.push("-an");
  }

  args.push(outputPath);

  await runFfmpeg(args);
  const buffer = await readFile(outputPath);
  const uploaded = await putReplayVideoAndGetUrl(job.id, job.filename, "video/webm", buffer);
  if (!uploaded) throw new Error("R2 upload failed.");
  return uploaded;
}

export function replayVideoJobMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    try {
      const requestUrl = req.url ?? "";
      if (!requestUrl.startsWith("/api/replay-video-job")) {
        next();
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed." });
        return;
      }

      if (!isR2ReplayCacheConfigured()) {
        sendJson(res, 503, { error: "R2 is not configured for replay video uploads." });
        return;
      }

      cleanupExpiredJobs();
      const url = new URL(requestUrl, "http://localhost");
      const action = url.searchParams.get("action");

      if (action === "start") {
        const body = await readJsonBody(req);
        let id = createVideoId();
        while (jobs.has(id)) id = createVideoId();
        const dir = await mkdir(path.join(os.tmpdir(), `mania-hub-replay-video-${id}`), { recursive: true })
          .then(() => path.join(os.tmpdir(), `mania-hub-replay-video-${id}`));
        const job: ReplayVideoJob = {
          id,
          dir,
          filename: sanitizeFilename(body.filename),
          fps: Math.round(parsePositiveNumber(body.fps, 30, 60)),
          width: Math.round(parsePositiveNumber(body.width, 1280, 1920)),
          height: Math.round(parsePositiveNumber(body.height, 720, 1080)),
          frameCount: Math.min(MAX_FRAMES, Math.max(1, Math.round(Number(body.frameCount) || 1))),
          audioUrl: typeof body.audioUrl === "string" && body.audioUrl ? body.audioUrl : null,
          audioStartSeconds: Math.max(0, Number(body.audioStartSeconds) || 0),
          sourceDurationSeconds: parsePositiveNumber(body.sourceDurationSeconds, 1, 60 * 60),
          effectiveRate: parsePositiveNumber(body.effectiveRate, 1, 4),
          createdAt: Date.now(),
        };
        jobs.set(id, job);
        sendJson(res, 200, { id });
        return;
      }

      const id = url.searchParams.get("id") ?? "";
      const job = jobs.get(id);
      if (!job) {
        sendJson(res, 404, { error: "Unknown replay video job." });
        return;
      }

      if (action === "frame") {
        const index = Number(url.searchParams.get("index"));
        if (!Number.isInteger(index) || index < 0 || index >= job.frameCount) {
          sendJson(res, 400, { error: "Invalid frame index." });
          return;
        }
        const contentLength = Number(req.headers["content-length"] ?? 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_FRAME_BYTES) {
          sendJson(res, 413, { error: "Frame is too large." });
          return;
        }
        const buffer = await readRequestBody(req);
        if (buffer.length > MAX_FRAME_BYTES) {
          sendJson(res, 413, { error: "Frame is too large." });
          return;
        }
        await writeFile(path.join(job.dir, `frame-${String(index + 1).padStart(6, "0")}.jpg`), buffer);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === "finish") {
        try {
          const request = new Request(new URL(requestUrl, "http://localhost").toString(), { method: "POST" });
          const uploaded = await finishJob(request, job);
          const publicUrl = new URL(
            `/videos/${encodeURIComponent(job.id)}/${encodeURIComponent(job.filename)}`,
            getReplayVideoPublicOrigin(),
          ).toString();
          jobs.delete(id);
          void rm(job.dir, { recursive: true, force: true });
          sendJson(res, 200, {
            url: publicUrl,
            signed: false,
            storageKey: uploaded.storageKey,
            sizeBytes: uploaded.sizeBytes,
            mimeType: uploaded.mimeType,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "ffmpeg export failed.";
          sendJson(res, 500, { error: message });
        }
        return;
      }

      if (action === "cancel") {
        jobs.delete(id);
        void rm(job.dir, { recursive: true, force: true });
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 400, { error: "Unknown replay video job action." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Replay video export failed.";
      sendJson(res, 500, { error: message });
    }
  };
}
