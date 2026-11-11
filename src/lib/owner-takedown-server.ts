/* The server-only helpers behind the owner takedown (owner-takedown.ts) and a
   player's own deletion (self-deletion-server.ts, account-deletion-server.ts).
   Kept apart and loaded only from inside server handlers: owner-takedown.ts is
   imported by the admin panel in the browser, and these reach R2 and the
   local upload store. */

const UPLOAD_PAGE_SIZE = 50;

/* Every upload in the owner index under this account, deleted the way the
   owner's own delete button does it. The first page (0-based) is re-read each
   round because each delete shifts the rest up. */
export async function deleteOwnedUploads(
  userId: number,
  options: { objectsFirst?: boolean } = {},
): Promise<{ deleted: number; failed: number }> {
  const { fetchUploadedReplayIndexPage } = await import("./uploaded-replay-index");
  const { removeUploadedReplay, removeUploadedReplayObjectsFirst } = await import("./uploaded-replay-delete-server");
  let deleted = 0;
  let failed = 0;
  const tried = new Set<string>();
  for (;;) {
    const page = await fetchUploadedReplayIndexPage({
      viewerUserId: userId,
      asAdmin: false,
      allOwners: false,
      page: 0,
      pageSize: UPLOAD_PAGE_SIZE,
    });
    const pending = page.uploads.filter((upload) => upload.ownerUserId === userId && !tried.has(upload.id));
    if (pending.length === 0) break;
    for (const upload of pending) {
      tried.add(upload.id);
      const result = options.objectsFirst
        ? await removeUploadedReplayObjectsFirst(upload.id)
        : await removeUploadedReplay(upload.id, { userId: null, asAdmin: true });
      if (result.ok) deleted += 1;
      else failed += 1;
    }
  }
  return { deleted, failed };
}

/* This instance's memory copy of the osu! profile; the other instance's
   expires on its own within minutes (USER_CACHE_TTL). */
export async function forgetUser(userId: number, username: string): Promise<void> {
  const { invalidatePersistentCache } = await import("./api");
  const { getUserCacheKey } = await import("./osu/users");
  const { USER_CACHE_VERSION } = await import("./osu/constants");
  for (const key of [String(userId), username]) {
    if (key) await invalidatePersistentCache(getUserCacheKey(key));
  }
  await invalidatePersistentCache(`user-id:v${USER_CACHE_VERSION}:${userId}`);
}
