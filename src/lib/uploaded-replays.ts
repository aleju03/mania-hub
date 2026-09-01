import { createServerFn } from "@tanstack/react-start";

import { describeUploadedReplayById, type UploadedReplayDescription } from "./uploaded-replay-describe";
import { getCommunityBeatmapAssets } from "./community-beatmap-store";
import {
  deleteUploadedReplayIndexRow,
  fetchUploadedReplayIndexPage,
  isUploadedReplayIndexConfigured,
  recordUploadedReplayOwner,
} from "./uploaded-replay-index";
import { listRecentUploadedReplays, normalizeUploadedReplayId } from "./uploaded-replay-store";

// "Your uploads" on /replay's Upload tab, and the delete behind it.
//
// The list comes from the live backend's owner index (who uploaded what), and
// each row's human-readable half is the same derived description the community
// list and the R2 admin browser read, so nothing here re-parses an .osr that
// has already been described once.

export const MY_UPLOADS_PAGE_SIZE = 12;

export interface MyUploadedReplay {
  id: string;
  uploadedAt: number;
  ownerUserId: number;
  ownerUsername: string;
  originalFilename: string | null;
  /** Null when the file behind the row is gone or no longer parses. */
  description: UploadedReplayDescription | null;
  /** A map osu! doesn't know whose background a contributor supplied. */
  communityBackground: boolean;
}

async function describeWithCommunityBackground(id: string): Promise<Pick<MyUploadedReplay, "description" | "communityBackground">> {
  const description = await describeUploadedReplayById(id).catch(() => null);
  const communityBackground = description && !description.beatmap && description.beatmapHash
    ? (await getCommunityBeatmapAssets(description.beatmapHash)).background
    : false;
  return { description, communityBackground };
}

export interface MyUploadedReplayPage {
  uploads: MyUploadedReplay[];
  total: number;
  page: number;
  hasMore: boolean;
  /** True when the viewer is reading every uploader's list, not their own. */
  allOwners: boolean;
}

const EMPTY_PAGE: MyUploadedReplayPage = { uploads: [], total: 0, page: 0, hasMore: false, allOwners: false };

function toMillis(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const fetchMyUploadedReplays = createServerFn({ method: "GET" })
  .validator((data: { page?: unknown; allOwners?: unknown } | undefined) => {
    const page = Math.floor(Number(data?.page ?? 0));
    return {
      page: Number.isFinite(page) && page > 0 ? Math.min(page, 200) : 0,
      allOwners: data?.allOwners === true,
    };
  })
  .handler(async ({ data }): Promise<MyUploadedReplayPage> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    const { readCurrentAuth } = await import("./auth-server");
    setResponseHeader("Cache-Control", "private, no-store");

    const auth = await readCurrentAuth();
    const allOwners = data.allOwners && auth.canUseAdminFeatures;
    // Anonymous visitors have no shelf, and asking for everyone's without being
    // an admin reads as asking for your own.
    if (!auth.viewer && !allOwners) return EMPTY_PAGE;

    const index = await fetchUploadedReplayIndexPage({
      viewerUserId: auth.viewer?.id ?? null,
      asAdmin: auth.canUseAdminFeatures,
      allOwners,
      page: data.page,
      pageSize: MY_UPLOADS_PAGE_SIZE,
    });

    const uploads = await Promise.all(index.uploads.map(async (row) => ({
      id: row.id,
      uploadedAt: toMillis(row.uploadedAt),
      ownerUserId: row.ownerUserId,
      ownerUsername: row.ownerUsername,
      originalFilename: row.originalFilename,
      // A row whose file has gone is kept, not dropped: it still needs a delete
      // button, and hiding it would leave the count wrong for good.
      ...(await describeWithCommunityBackground(row.id)),
    })));

    return { uploads, total: index.total, page: index.page, hasMore: index.hasMore, allOwners };
  });

// Public uploader context plus whether the current viewer may delete the
// upload they are watching. The uploader attribution is already public on the
// community upload cards and also tells the replay viewer whose replay skin to
// use; delete permission remains derived from the signed-in viewer here.
export const fetchUploadedReplayPermissions = createServerFn({ method: "GET" })
  .validator((data: { id?: unknown }) => {
    const id = normalizeUploadedReplayId(typeof data.id === "string" ? data.id : "");
    if (!id) throw new Error("Invalid upload id.");
    return { id };
  })
  .handler(async ({ data }): Promise<{ canDelete: boolean; isOwner: boolean; ownerUserId: number | null }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    const { readCurrentAuth } = await import("./auth-server");
    setResponseHeader("Cache-Control", "private, no-store");

    const auth = await readCurrentAuth();
    const { fetchUploadedReplayIndexRow } = await import("./uploaded-replay-index");
    const row = await fetchUploadedReplayIndexRow(data.id);
    const isOwner = row != null && auth.viewer != null && row.ownerUserId === auth.viewer.id;
    return {
      canDelete: isOwner || auth.canUseAdminFeatures,
      isOwner,
      ownerUserId: row?.ownerUserId ?? null,
    };
  });

export type DeleteUploadedReplayResult =
  | { ok: true }
  | { ok: false; error: "unauthorized" | "not_found" | "unavailable" };

// Deletes the upload for real: the index row first (that is where ownership is
// checked), then the .osr and its derived description. Losing the file after
// losing the row is the safe order - an orphaned object is still visible to
// /admin/r2, while an orphaned row would be an upload the owner is told they
// deleted and can still hand out a link to.
export const deleteUploadedReplay = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => {
    const id = normalizeUploadedReplayId(typeof data.id === "string" ? data.id : "");
    if (!id) throw new Error("Invalid upload id.");
    return { id };
  })
  .handler(async ({ data }): Promise<DeleteUploadedReplayResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    const { readCurrentAuth } = await import("./auth-server");
    setResponseHeader("Cache-Control", "private, no-store");

    const auth = await readCurrentAuth();
    const asAdmin = auth.canUseAdminFeatures;
    if (!auth.viewer && !asAdmin) return { ok: false, error: "unauthorized" };

    const authorized = await deleteUploadedReplayIndexRow({
      id: data.id,
      userId: auth.viewer?.id ?? null,
      asAdmin,
    });
    if (!authorized.ok) return { ok: false, error: authorized.error };

    const { deleteUploadedReplayObjects } = await import("./r2-cache");
    const { deleteLocalUploadedReplay, uploadedReplaysUseR2 } = await import("./uploaded-replay-store");
    try {
      if (uploadedReplaysUseR2()) await deleteUploadedReplayObjects(data.id);
      await deleteLocalUploadedReplay(data.id);
    } catch {
      return { ok: false, error: "unavailable" };
    }
    await forgetDeletedUpload(data.id);
    return { ok: true };
  });

// Both memory tiers that would keep describing a file that no longer exists.
// Per-instance only, which is enough: the community list is rebuilt from an R2
// listing the deleted object has already left, so the other instances drop it
// on their own next rebuild.
async function forgetDeletedUpload(id: string): Promise<void> {
  const { invalidatePersistentCache } = await import("./api");
  const { DESCRIPTION_VERSION } = await import("./uploaded-replay-describe");
  const { COMMUNITY_UPLOADS_CACHE_KEY } = await import("./uploaded-replay-community");
  await invalidatePersistentCache(`uploaded-replay-desc:v${DESCRIPTION_VERSION}:${id}`);
  await invalidatePersistentCache(COMMUNITY_UPLOADS_CACHE_KEY);
}

export interface UploadOwnerBackfillResult {
  scanned: number;
  indexed: number;
  /** Objects whose metadata names no uploader - anonymous before sign-in was required. */
  unowned: number;
  failed: number;
}

// One-time repair for uploads that predate the owner index (and for any row a
// best-effort record call missed): the uploader id has been stamped on every
// object's R2 metadata all along, so the index can be rebuilt from a HEAD per
// object. Admin-run rather than automatic - it costs one R2 request per upload.
export const backfillUploadedReplayOwners = createServerFn({ method: "POST" })
  .handler(async (): Promise<UploadOwnerBackfillResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    const { requireAdminAccess } = await import("./auth-server");
    setResponseHeader("Cache-Control", "private, no-store");
    await requireAdminAccess("Uploaded replay backfill");
    if (!isUploadedReplayIndexConfigured()) {
      throw new Error("The live backend is not configured, so there is no index to backfill.");
    }

    const { headUploadedReplayOwner } = await import("./r2-cache");
    const listed = await listRecentUploadedReplays(Number.MAX_SAFE_INTEGER);
    const result: UploadOwnerBackfillResult = { scanned: listed.length, indexed: 0, unowned: 0, failed: 0 };

    // Serial on purpose: this walks the whole prefix, and a burst of parallel
    // HEADs against R2 buys nothing for a maintenance action nobody watches.
    for (const entry of listed) {
      const meta = await headUploadedReplayOwner(entry.id);
      if (!meta) {
        result.failed += 1;
        continue;
      }
      if (meta.uploaderId == null) {
        result.unowned += 1;
        continue;
      }
      const recorded = await recordUploadedReplayOwner({
        id: entry.id,
        userId: meta.uploaderId,
        // The object never stored a name; the index shows the id until this
        // uploader's next upload fills it in.
        username: "",
        originalFilename: meta.originalFilename,
        uploadedAt: meta.uploadedAt ?? new Date(entry.uploadedAt).toISOString(),
      });
      if (recorded) result.indexed += 1;
      else result.failed += 1;
    }

    return result;
  });
