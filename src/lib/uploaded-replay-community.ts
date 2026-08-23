import { createServerFn } from "@tanstack/react-start";

import { getPersistentCacheEntry, setPersistentCache } from "./api";
import { describeUploadedReplayById, type UploadedReplayDescription } from "./uploaded-replay-describe";
import { fetchUploadedReplayIndexRow } from "./uploaded-replay-index";
import { listRecentUploadedReplays } from "./uploaded-replay-store";

// The Upload tab's community list: the newest uploads with their derived
// descriptions. Everything shown is already public - any upload is reachable
// at /replay?uploadId=<id> - so the list only surfaces what the share links
// expose, it grants nothing new. The uploader's name comes from the owner
// index and is deliberately public here: the card names the player in the
// replay, and without the uploader beside it viewers would have to assume the
// two are always the same person.

export type CommunityUploadEntry = UploadedReplayDescription & {
  uploadedAt: number;
  /** Null when the owner index has no row (pre-index upload, or index down). */
  uploadedBy: { userId: number; username: string } | null;
};

const COMMUNITY_UPLOADS_LIMIT = 9;
export const COMMUNITY_UPLOADS_CACHE_KEY = "community-uploads:v2";
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
        const [description, owner] = await Promise.all([
          describeUploadedReplayById(entry.id),
          fetchUploadedReplayIndexRow(entry.id),
        ]);
        if (!description) return null;
        return {
          ...description,
          uploadedAt: entry.uploadedAt,
          uploadedBy: owner ? { userId: owner.ownerUserId, username: owner.ownerUsername } : null,
        };
      }),
    )).filter((entry): entry is CommunityUploadEntry => entry !== null);

    await setPersistentCache(COMMUNITY_UPLOADS_CACHE_KEY, uploads, COMMUNITY_UPLOADS_CACHE_TTL);
    return { uploads };
  },
);
