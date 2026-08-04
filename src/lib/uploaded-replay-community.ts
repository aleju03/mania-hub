import { createServerFn } from "@tanstack/react-start";

import { getPersistentCacheEntry, setPersistentCache } from "./api";
import { describeUploadedReplayById, type UploadedReplayDescription } from "./uploaded-replay-describe";
import { listRecentUploadedReplays } from "./uploaded-replay-store";

// The Upload tab's community list: the newest uploads with their derived
// descriptions. Everything shown is already public - any upload is reachable
// at /replay?uploadId=<id> - so the list only surfaces what the share links
// expose, it grants nothing new.

export type CommunityUploadEntry = UploadedReplayDescription & { uploadedAt: number };

const COMMUNITY_UPLOADS_LIMIT = 9;
const COMMUNITY_UPLOADS_CACHE_KEY = "community-uploads:v1";
// Short: the list should pick up fresh uploads within a couple of minutes, and
// a rebuild is one R2 LIST plus per-upload describes that are cached themselves.
const COMMUNITY_UPLOADS_CACHE_TTL = 2 * 60 * 1000;

export const getRecentCommunityUploads = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ uploads: CommunityUploadEntry[] }> => {
    const cached = await getPersistentCacheEntry<CommunityUploadEntry[]>(COMMUNITY_UPLOADS_CACHE_KEY);
    if (cached.hit) return { uploads: cached.value };

    const listed = await listRecentUploadedReplays(COMMUNITY_UPLOADS_LIMIT);
    const uploads = (await Promise.all(
      listed.map(async (entry) => {
        // Null descriptions (corrupt or just-deleted files) drop out silently.
        const description = await describeUploadedReplayById(entry.id);
        return description ? { ...description, uploadedAt: entry.uploadedAt } : null;
      }),
    )).filter((entry): entry is CommunityUploadEntry => entry !== null);

    await setPersistentCache(COMMUNITY_UPLOADS_CACHE_KEY, uploads, COMMUNITY_UPLOADS_CACHE_TTL);
    return { uploads };
  },
);
