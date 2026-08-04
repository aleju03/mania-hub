import crypto from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getUploadedReplay, isR2ReplayCacheConfigured, listUploadedReplayObjects, putUploadedReplay } from "./r2-cache";

export const UPLOADED_REPLAY_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export type UploadedReplayStorage = "r2" | "local";

export type StoredUploadedReplay = {
  id: string;
  buffer: Buffer;
  storage: UploadedReplayStorage;
  originalFilename?: string;
};

export interface UploadedReplayMetadata {
  originalFilename?: string;
  uploaderId?: number | null;
  uploadedAt?: string;
}

// In production the only durable store is R2 (serverless local disk is
// ephemeral and per-instance); a missing or failing R2 must surface as a
// controlled error, never a silent local-disk "success" that loses the file.
export class ReplayStorageUnavailableError extends Error {
  constructor(message = "Replay storage is unavailable.") {
    super(message);
  }
}

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

export async function saveUploadedReplay(
  buffer: Buffer,
  metadata: UploadedReplayMetadata = {},
): Promise<{ id: string; storage: UploadedReplayStorage }> {
  const id = createUploadedReplayId();
  const safeFilename = normalizeOriginalFilename(metadata.originalFilename);
  const production = process.env.NODE_ENV === "production";

  if (isR2ReplayCacheConfigured()) {
    try {
      const stored = await putUploadedReplay(id, buffer, {
        originalFilename: safeFilename,
        uploaderId: metadata.uploaderId ?? null,
        uploadedAt: metadata.uploadedAt,
      });
      if (stored) return { id, storage: "r2" };
    } catch (error) {
      if (production) {
        throw new ReplayStorageUnavailableError(error instanceof Error ? error.message : undefined);
      }
      // Development: fall through to local disk.
    }
    if (production) throw new ReplayStorageUnavailableError();
  } else if (production) {
    throw new ReplayStorageUnavailableError("R2 replay storage is not configured.");
  }

  await mkdir(getLocalUploadDir(), { recursive: true });
  await writeFile(getLocalUploadPath(id), buffer);
  await writeFile(
    getLocalUploadMetaPath(id),
    JSON.stringify({
      ...(safeFilename ? { originalFilename: safeFilename } : {}),
      uploaderId: metadata.uploaderId ?? null,
      uploadedAt: metadata.uploadedAt ?? new Date().toISOString(),
    }),
    "utf8",
  );
  return { id, storage: "local" };
}

export type UploadedReplayListEntry = { id: string; uploadedAt: number };

// Newest-first upload ids, for the community recent-uploads list on /replay's
// Upload tab. R2 is the durable store; the local-disk directory only backs
// development. Listing failures read as "nothing recent", never an error.
export async function listRecentUploadedReplays(limit: number): Promise<UploadedReplayListEntry[]> {
  const entries: UploadedReplayListEntry[] = [];

  if (isR2ReplayCacheConfigured()) {
    try {
      for (const object of await listUploadedReplayObjects()) {
        const base = object.key.split("/").pop() ?? "";
        if (!/\.osr$/i.test(base)) continue;
        const id = normalizeUploadedReplayId(base.slice(0, -4));
        if (!id) continue;
        entries.push({ id, uploadedAt: object.uploadedAt });
      }
    } catch {
      return [];
    }
  } else {
    try {
      const dir = getLocalUploadDir();
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".osr")) continue;
        const id = normalizeUploadedReplayId(name.slice(0, -4));
        if (!id) continue;
        const stats = await stat(path.join(dir, name));
        entries.push({ id, uploadedAt: stats.mtimeMs });
      }
    } catch {
      return [];
    }
  }

  return entries.sort((a, b) => b.uploadedAt - a.uploadedAt).slice(0, Math.max(0, limit));
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
