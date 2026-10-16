// The delete behind "your uploads" on /replay and an owner takedown
// (owner-takedown.ts). Server-side only: it reaches R2 and the local store.

import { deleteUploadedReplayIndexRow } from "./uploaded-replay-index";
import type { DeleteUploadedReplayResult } from "./uploaded-replays";

// Index row first, then the objects; deleteUploadedReplay says why that order.
export async function removeUploadedReplay(
  id: string,
  actor: { userId: number | null; asAdmin: boolean },
): Promise<DeleteUploadedReplayResult> {
  const authorized = await deleteUploadedReplayIndexRow({ id, userId: actor.userId, asAdmin: actor.asAdmin });
  if (!authorized.ok) return { ok: false, error: authorized.error };

  const { deleteUploadedReplayObjects } = await import("./r2-cache");
  const { deleteLocalUploadedReplay, uploadedReplaysUseR2 } = await import("./uploaded-replay-store");
  try {
    if (uploadedReplaysUseR2()) await deleteUploadedReplayObjects(id);
    await deleteLocalUploadedReplay(id);
  } catch {
    return { ok: false, error: "unavailable" };
  }
  await forgetDeletedUpload(id);
  return { ok: true };
}

// Every memory tier that would keep serving a file that no longer exists.
// Per-instance only, which is enough: the community lists are rebuilt from an
// R2 listing the deleted object has already left, so the other instances drop
// it on their own next rebuild, and the packed artifact left R2 with the file.
async function forgetDeletedUpload(id: string): Promise<void> {
  const { invalidatePersistentCache } = await import("./api");
  const { DESCRIPTION_VERSION } = await import("./uploaded-replay-describe");
  const { UPLOADED_REPLAY_PACKED_VERSION } = await import("./uploaded-replay-payload");
  const { invalidateCommunityUploads } = await import("./uploaded-replay-community-server");
  await invalidatePersistentCache(`uploaded-replay-desc:v${DESCRIPTION_VERSION}:${id}`);
  await invalidatePersistentCache(`uploaded-replay-packed:v${UPLOADED_REPLAY_PACKED_VERSION}:${id}`);
  invalidateCommunityUploads(id);
}
