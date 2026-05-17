import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getUploadedReplay, isR2ReplayCacheConfigured, putUploadedReplay } from "./r2-cache";

export const UPLOADED_REPLAY_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export type UploadedReplayStorage = "r2" | "local";

export type StoredUploadedReplay = {
  id: string;
  buffer: Buffer;
  storage: UploadedReplayStorage;
  originalFilename?: string;
};

export function createUploadedReplayId(): string {
  return crypto.randomBytes(15).toString("base64url");
}

export function normalizeUploadedReplayId(id: string | null | undefined): string | null {
  const value = id?.trim() ?? "";
  return UPLOADED_REPLAY_ID_PATTERN.test(value) ? value : null;
}

function getLocalUploadDir(): string {
  const configured = process.env.REPLAY_UPLOAD_DIR;
  return path.resolve(process.cwd(), configured && configured.trim() ? configured : "data/replay-uploads");
}

function getLocalUploadPath(id: string): string {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) throw new Error("Invalid uploaded replay id.");
  return path.join(getLocalUploadDir(), `${normalized}.osr`);
}

function getLocalUploadMetaPath(id: string): string {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) throw new Error("Invalid uploaded replay id.");
  return path.join(getLocalUploadDir(), `${normalized}.json`);
}

function normalizeOriginalFilename(filename: string | null | undefined): string | undefined {
  const value = filename?.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!value || value.includes("\0")) return undefined;
  return value.replace(/["\r\n]+/g, "_").slice(0, 180);
}

export async function saveUploadedReplay(buffer: Buffer, originalFilename?: string): Promise<{ id: string; storage: UploadedReplayStorage }> {
  const id = createUploadedReplayId();
  const safeFilename = normalizeOriginalFilename(originalFilename);

  if (isR2ReplayCacheConfigured()) {
    const stored = await putUploadedReplay(id, buffer, safeFilename);
    if (stored) return { id, storage: "r2" };
  }

  await mkdir(getLocalUploadDir(), { recursive: true });
  await writeFile(getLocalUploadPath(id), buffer);
  if (safeFilename) {
    await writeFile(getLocalUploadMetaPath(id), JSON.stringify({ originalFilename: safeFilename }), "utf8");
  }
  return { id, storage: "local" };
}

export async function readUploadedReplay(id: string): Promise<StoredUploadedReplay | null> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return null;

  if (isR2ReplayCacheConfigured()) {
    const stored = await getUploadedReplay(normalized);
    if (stored) {
      return {
        id: normalized,
        buffer: stored.buffer,
        storage: "r2",
        originalFilename: normalizeOriginalFilename(stored.originalFilename),
      };
    }
  }

  try {
    const meta: { originalFilename?: string } = await readFile(getLocalUploadMetaPath(normalized), "utf8")
      .then((raw) => JSON.parse(raw) as { originalFilename?: string })
      .catch(() => ({}));
    return {
      id: normalized,
      buffer: await readFile(getLocalUploadPath(normalized)),
      storage: "local",
      originalFilename: normalizeOriginalFilename(meta.originalFilename),
    };
  } catch {
    return null;
  }
}
