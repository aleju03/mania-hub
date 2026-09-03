import crypto from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

// Uploads only go to R2 in production. The local .env points at the same
// bucket as prod, and the community list on /replay is an R2 listing, so a
// development upload would otherwise surface on the live site within minutes.
// Development writes to local disk instead; set REPLAY_UPLOADS_TO_R2=1 to
// exercise the R2 path deliberately. Reads still fall through to R2 so a prod
// share link keeps opening locally.
export function uploadedReplaysUseR2(): boolean {
  if (!isR2ReplayCacheConfigured()) return false;
  return process.env.NODE_ENV === "production" || process.env.REPLAY_UPLOADS_TO_R2 === "1";
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

export function normalizeUploadedReplayFilename(filename: string | null | undefined): string | undefined {
  const value = filename?.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!value || value.includes("\0")) return undefined;
  return value.replace(/["\r\n]+/g, "_").slice(0, 180);
}

export async function saveUploadedReplay(
  buffer: Buffer,
  metadata: UploadedReplayMetadata = {},
): Promise<{ id: string; storage: UploadedReplayStorage }> {
  const id = createUploadedReplayId();
  const safeFilename = normalizeUploadedReplayFilename(metadata.originalFilename);
  const production = process.env.NODE_ENV === "production";

  if (uploadedReplaysUseR2()) {
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

async function listR2UploadedReplays(): Promise<UploadedReplayListEntry[]> {
  const entries: UploadedReplayListEntry[] = [];
  for (const object of await listUploadedReplayObjects()) {
    const base = object.key.split("/").pop() ?? "";
    if (!/\.osr$/i.test(base)) continue;
    const id = normalizeUploadedReplayId(base.slice(0, -4));
    if (!id) continue;
    entries.push({ id, uploadedAt: object.uploadedAt });
  }
  return entries;
}

async function listLocalUploadedReplays(): Promise<UploadedReplayListEntry[]> {
  const entries: UploadedReplayListEntry[] = [];
  const dir = getLocalUploadDir();
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".osr")) continue;
    const id = normalizeUploadedReplayId(name.slice(0, -4));
    if (!id) continue;
    const stats = await stat(path.join(dir, name));
    entries.push({ id, uploadedAt: stats.mtimeMs });
  }
  return entries;
}

// Newest-first upload ids, for the community lists on /replay. R2 is the
// durable store; the local-disk directory only backs development. Development
// lists both, so the community pages look the way they do on the live site
// with its uploads (reads fall through to R2 anyway, and nothing here writes),
// with the local drops on top. Listing failures read as "nothing", never an
// error.
export async function listRecentUploadedReplays(limit: number): Promise<UploadedReplayListEntry[]> {
  const entries: UploadedReplayListEntry[] = [];
  const seen = new Set<string>();
  const add = (list: UploadedReplayListEntry[]) => {
    for (const entry of list) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  };

  if (uploadedReplaysUseR2()) {
    try {
      add(await listR2UploadedReplays());
    } catch {
      return [];
    }
  } else {
    add(await listLocalUploadedReplays().catch(() => []));
    if (isR2ReplayCacheConfigured()) add(await listR2UploadedReplays().catch(() => []));
  }

  return entries.sort((a, b) => b.uploadedAt - a.uploadedAt).slice(0, Math.max(0, limit));
}

export async function readUploadedReplay(id: string): Promise<StoredUploadedReplay | null> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return null;

  const fromR2 = async (): Promise<StoredUploadedReplay | null> => {
    if (!isR2ReplayCacheConfigured()) return null;
    const stored = await getUploadedReplay(normalized);
    if (!stored) return null;
    return {
      id: normalized,
      buffer: stored.buffer,
      storage: "r2",
      originalFilename: normalizeUploadedReplayFilename(stored.originalFilename),
    };
  };

  const fromDisk = async (): Promise<StoredUploadedReplay | null> => {
    try {
      const meta: { originalFilename?: string } = await readFile(getLocalUploadMetaPath(normalized), "utf8")
        .then((raw) => JSON.parse(raw) as { originalFilename?: string })
        .catch(() => ({}));
      return {
        id: normalized,
        buffer: await readFile(getLocalUploadPath(normalized)),
        storage: "local",
        originalFilename: normalizeUploadedReplayFilename(meta.originalFilename),
      };
    } catch {
      return null;
    }
  };

  // Whichever store this environment writes to is checked first; the other
  // is a fallback so development can still open a prod share link.
  if (uploadedReplaysUseR2()) return (await fromR2()) ?? (await fromDisk());
  return (await fromDisk()) ?? (await fromR2());
}

// Removes a development upload from local disk. A no-op for ids that were
// never stored there, so callers can run it unconditionally after the R2 delete.
export async function deleteLocalUploadedReplay(id: string): Promise<void> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return;
  await Promise.all([
    rm(getLocalUploadPath(normalized), { force: true }),
    rm(getLocalUploadMetaPath(normalized), { force: true }),
  ]);
}
