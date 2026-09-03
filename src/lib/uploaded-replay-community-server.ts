import { getCommunityBeatmapAssets } from "./community-beatmap-store";
import { describeUploadedReplayById } from "./uploaded-replay-describe";
import { fetchUploadedReplayIndexRows } from "./uploaded-replay-index";
import type { CommunityUploadEntry } from "./uploaded-replay-payload";
import { listRecentUploadedReplays, type UploadedReplayListEntry } from "./uploaded-replay-store";

// The lists' server half: the R2 listing, the per-page describes and the
// caches around them. Imported inside the server functions' handlers only,
// so the browser bundle never sees the upload store behind it.

// Short: the lists should pick up fresh uploads within a couple of minutes,
// and a rebuild is one R2 LIST plus per-upload describes that are cached
// themselves. Per-instance memory; an upload or delete on this instance
// clears it outright.
const COMMUNITY_UPLOADS_CACHE_TTL = 2 * 60 * 1000;

let listing: { entries: UploadedReplayListEntry[]; fetchedAt: number } | null = null;
let listingInFlight: Promise<UploadedReplayListEntry[]> | null = null;
const slices = new Map<string, { uploads: CommunityUploadEntry[]; fetchedAt: number }>();
const slicesInFlight = new Map<string, Promise<CommunityUploadEntry[]>>();

export function invalidateCommunityUploads(): void {
  listing = null;
  slices.clear();
}

// The full newest-first id list. The R2 LIST already walks the whole prefix
// for the nine-card list, so keeping all of it costs nothing extra and is
// what the gallery pages over.
async function listAllUploads(): Promise<UploadedReplayListEntry[]> {
  if (listing && Date.now() - listing.fetchedAt < COMMUNITY_UPLOADS_CACHE_TTL) return listing.entries;
  if (!listingInFlight) {
    listingInFlight = listRecentUploadedReplays(Number.POSITIVE_INFINITY)
      .then((entries) => {
        listing = { entries, fetchedAt: Date.now() };
        return entries;
      })
      .finally(() => {
        listingInFlight = null;
      });
  }
  return listingInFlight;
}

async function describeEntries(entries: UploadedReplayListEntry[]): Promise<CommunityUploadEntry[]> {
  const owners = await fetchUploadedReplayIndexRows(entries.map((entry) => entry.id));
  const described = await Promise.all(entries.map(async (entry) => {
    // Null descriptions (corrupt or just-deleted files) drop out silently.
    const description = await describeUploadedReplayById(entry.id).catch(() => null);
    if (!description) return null;
    const communityBackground = !description.beatmap && description.beatmapHash
      ? (await getCommunityBeatmapAssets(description.beatmapHash)).background
      : false;
    const owner = owners.get(entry.id);
    return {
      ...description,
      uploadedAt: entry.uploadedAt,
      uploadedBy: owner ? { userId: owner.ownerUserId, username: owner.ownerUsername } : null,
      communityBackground,
    };
  }));
  return described.filter((entry): entry is CommunityUploadEntry => entry !== null);
}

export async function getUploadsSlice(offset: number, limit: number): Promise<{ uploads: CommunityUploadEntry[]; total: number }> {
  const entries = await listAllUploads();
  const key = `${listing?.fetchedAt ?? 0}:${offset}:${limit}`;
  const cached = slices.get(key);
  if (cached && Date.now() - cached.fetchedAt < COMMUNITY_UPLOADS_CACHE_TTL) {
    return { uploads: cached.uploads, total: entries.length };
  }
  let inFlight = slicesInFlight.get(key);
  if (!inFlight) {
    inFlight = describeEntries(entries.slice(offset, offset + limit))
      .then((uploads) => {
        slices.set(key, { uploads, fetchedAt: Date.now() });
        return uploads;
      })
      .finally(() => {
        slicesInFlight.delete(key);
      });
    slicesInFlight.set(key, inFlight);
  }
  return { uploads: await inFlight, total: entries.length };
}

