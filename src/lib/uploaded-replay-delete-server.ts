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

// An account's own deletion (routes/api/internal/account-deletion.ts) runs
// unattended, so it takes the opposite order: the objects first, and the index
// row only once they are gone. A failed object delete leaves the row, so the
// next sweep finds the upload again instead of orphaning a file that carries
// the player's name.
export async function removeUploadedReplayObjectsFirst(id: string): Promise<DeleteUploadedReplayResult> {
  const { deleteUploadedReplayObjects } = await import("./r2-cache");
  const { deleteLocalUploadedReplay, uploadedReplaysUseR2 } = await import("./uploaded-replay-store");
  try {
    if (uploadedReplaysUseR2()) await deleteUploadedReplayObjects(id);
    await deleteLocalUploadedReplay(id);
  } catch {
    return { ok: false, error: "unavailable" };
  }
  const removed = await deleteUploadedReplayIndexRow({ id, userId: null, asAdmin: true });
  if (!removed.ok) return { ok: false, error: removed.error };
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
