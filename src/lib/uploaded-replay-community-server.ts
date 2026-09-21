import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { waitUntil } from "@vercel/functions";
import { getCommunityBeatmapAssets } from "./community-beatmap-store";
import { DESCRIPTION_VERSION, describeUploadedReplayById, needsStarRatingAtRate, readUploadedReplayDescription } from "./uploaded-replay-describe";
import { fetchUploadedReplayIndexRows } from "./uploaded-replay-index";
import { queryCommunityUploads, type CommunityUploadsQuery } from "./uploaded-replay-feed";
import type { CommunityUploadEntry } from "./uploaded-replay-payload";
import { listRecentUploadedReplays, normalizeUploadedReplayId, uploadedReplaysUseR2 } from "./uploaded-replay-store";

// The gallery queries a local metadata catalog. R2 listing, summary reads,
// old-artifact upgrades and osu! lookups run behind it, never per gallery page.
// Persisting the catalog keeps a process restart from making old pages cold.
const REFRESH_MS = 2 * 60_000;
const DESCRIPTION_REFRESH_MS = 24 * 60 * 60_000;
type CachedUpload = { upload: CommunityUploadEntry; checkedAt: number };
const catalog = new Map<string, CachedUpload>();
const deletedIds = new Set<string>();
let loaded: Promise<void> | null = null;
let refresh: Promise<void> | null = null;
let refreshedAt = 0;
let listed = false;
let pending = 0;
let failed = false;
let generation = 0;
let saving = Promise.resolve();

function catalogPath(): string {
  const directory = process.env.VERCEL ? tmpdir() : path.resolve(process.env.REPLAY_UPLOAD_DIR || "data/replay-uploads");
  return path.join(directory, `community-catalog-v1-${uploadedReplaysUseR2() ? "prod" : "dev"}.json`);
}

async function loadCatalog(): Promise<void> {
  loaded ??= (async () => {
    try {
      const saved = JSON.parse(await readFile(catalogPath(), "utf8")) as { version?: number; entries?: CachedUpload[] };
      if (saved.version !== 1 || !Array.isArray(saved.entries)) return;
      for (const entry of saved.entries) {
        if (entry?.upload && !deletedIds.has(entry.upload.id) && normalizeUploadedReplayId(entry.upload.id) && Array.isArray(entry.upload.mods)
          && Number.isFinite(entry.upload.uploadedAt) && Number.isFinite(entry.checkedAt)) catalog.set(entry.upload.id, entry);
      }
    } catch {
      // Missing/read-only disk is a cold cache, never a missing replay.
    }
  })();
  await loaded;
}

// Only the one refresh task writes. Atomic rename prevents a restart from
// reading half a catalog; failure on ephemeral/read-only hosts is harmless.
function saveCatalog(): Promise<void> {
  saving = saving.then(writeCatalog);
  return saving;
}

async function writeCatalog(): Promise<void> {
  const target = catalogPath();
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, JSON.stringify({ version: 1, entries: [...catalog.values()] }));
    await rename(temporary, target);
  } catch { /* Best-effort cache. R2 remains authoritative. */ }
}

export function invalidateCommunityUploads(deletedId?: string): void {
  generation += 1;
  refreshedAt = 0;
  if (deletedId) {
    deletedIds.add(deletedId);
    catalog.delete(deletedId);
    void loadCatalog().then(saveCatalog);
  }
}

async function refreshCatalog(): Promise<void> {
  const revision = generation;
  // A failed listing must not erase a previously populated catalog.
  const entries = (await listRecentUploadedReplays(Number.POSITIVE_INFINITY, true)).filter((entry) => !deletedIds.has(entry.id));
  if (revision !== generation) return;
  listed = true;
  const ids = new Set(entries.map((entry) => entry.id));
  for (const id of catalog.keys()) if (!ids.has(id)) catalog.delete(id);
  const missing = entries.filter((entry) => !catalog.has(entry.id));
  pending = missing.length;
  const repairs = new Set<string>();

  // Attribution is batched and runs alongside artifact reads. It never holds
  // up the cards, even if the bridge takes its entire timeout to answer.
  const ownerRows = new Map<string, NonNullable<CommunityUploadEntry["uploadedBy"]>>();
  const ownersWork = (async () => {
    for (let offset = 0; offset < entries.length; offset += 100) {
      const rows = await fetchUploadedReplayIndexRows(entries.slice(offset, offset + 100).map((entry) => entry.id));
      if (revision !== generation) return;
      for (const row of rows.values()) {
        const cached = catalog.get(row.id);
        if (cached) cached.upload.uploadedBy = { userId: row.ownerUserId, username: row.ownerUsername };
      }
      // Return rows for newly hydrated cards too, when this finishes first.
      for (const row of rows.values()) ownerRows.set(row.id, { userId: row.ownerUserId, username: row.ownerUsername });
    }
  })();

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, missing.length) }, async () => {
    while (next < missing.length && revision === generation) {
      const entry = missing[next++];
      const description = await readUploadedReplayDescription(entry.id).catch(() => null);
      if (revision !== generation) return;
      if (description) {
        catalog.set(entry.id, { upload: {
          ...description, uploadedAt: entry.uploadedAt, uploadedBy: ownerRows.get(entry.id) ?? null, communityBackground: false,
        }, checkedAt: description.beatmap && (description.version ?? 1) >= DESCRIPTION_VERSION ? Date.now() : 0 });
        pending -= 1;
      } else {
        repairs.add(entry.id);
      }
    }
  }));
  await ownersWork;
  if (revision !== generation) return;
  await saveCatalog();

  // Repair absent/old descriptions at bounded concurrency, after all cheap
  // reads. One old replay waiting on osu! cannot block the rest of the feed.
  const toRefresh = entries.filter((entry) => {
    const cached = catalog.get(entry.id);
    return repairs.has(entry.id) || (cached && (Date.now() - cached.checkedAt >= DESCRIPTION_REFRESH_MS
      || (cached.upload.version ?? 1) < DESCRIPTION_VERSION
      || needsStarRatingAtRate(cached.upload)));
  });
  pending = repairs.size;
  next = 0;
  await Promise.all(Array.from({ length: Math.min(2, toRefresh.length) }, async () => {
    while (next < toRefresh.length && revision === generation) {
      const entry = toRefresh[next++];
      const previous = catalog.get(entry.id);
      const description = await describeUploadedReplayById(entry.id).catch(() => null);
      const communityBackground = description && !description.beatmap && description.beatmapHash
        ? (await getCommunityBeatmapAssets(description.beatmapHash).catch(() => null))?.background ?? false
        : false;
      if (revision !== generation) return;
      if (description) catalog.set(entry.id, { upload: {
        ...description, uploadedAt: entry.uploadedAt,
        uploadedBy: ownerRows.get(entry.id) ?? previous?.upload.uploadedBy ?? null, communityBackground,
      }, checkedAt: Date.now() });
      if (repairs.has(entry.id)) pending -= 1;
      if (next % 24 === 0) await saveCatalog();
    }
  }));
  if (revision !== generation) return;
  await saveCatalog();
  refreshedAt = Date.now();
}

async function snapshot() {
  await loadCatalog();
  if (!refresh && Date.now() - refreshedAt >= REFRESH_MS) {
    failed = false;
    refresh = refreshCatalog().catch(() => {
      failed = true;
      refreshedAt = Date.now();
    }).finally(() => { refresh = null; pending = 0; });
    // Nitro's always-on process keeps running; the rollback serverless target
    // also needs the request lifetime extended for background cache work.
    try { waitUntil(refresh); } catch { /* No request context in tests/tools. */ }
  }
  if (failed && catalog.size === 0) throw new Error("Uploads are temporarily unavailable.");
  return { entries: [...catalog.values()].map((entry) => entry.upload), indexing: !failed && (!listed && catalog.size === 0 || pending > 0) };
}

export async function getUploadsSlice(offset: number, limit: number) {
  const { entries, indexing } = await snapshot();
  entries.sort((a, b) => b.uploadedAt - a.uploadedAt || a.id.localeCompare(b.id, "en-US"));
  return { uploads: entries.slice(offset, offset + limit), total: entries.length, indexing };
}

export async function getUploadsFeed(query: CommunityUploadsQuery) {
  const { entries, indexing } = await snapshot();
  return queryCommunityUploads(entries, query, indexing);
}
