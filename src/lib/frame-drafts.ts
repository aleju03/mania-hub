import { createServerFn } from "@tanstack/react-start";

import type { AccountDraftSummary } from "./frame-drafts-server";

/* Server functions behind the frame editor's account drafts and "Edit in the
   editor" (logic in frame-drafts-server.ts). */

async function viewerId(): Promise<number> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) throw new Error("Log in first.");
  return auth.viewer.id;
}

async function noStore() {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
}

export const fetchAccountDrafts = createServerFn({ method: "GET" }).handler(async (): Promise<AccountDraftSummary[]> => {
  await noStore();
  const { listAccountDrafts } = await import("./frame-drafts-server");
  return listAccountDrafts(await viewerId());
});

export const fetchAccountDraft = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => ({ id: String(data?.id ?? "") }))
  .handler(async ({ data }): Promise<{ body: string | null }> => {
    await noStore();
    const { loadAccountDraft } = await import("./frame-drafts-server");
    return { body: await loadAccountDraft(await viewerId(), data.id) };
  });

const SAVE_ERRORS: Record<string, string> = {
  full: "Your account holds 20 drafts. Delete one to keep this one there too; it's still saved in this browser.",
  too_big: "This draft is too big to keep on your account; it's still saved in this browser.",
  stale: "A newer copy of this draft is on your account.",
  invalid: "That draft couldn't be read.",
};

export const storeAccountDraft = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown; name?: unknown; updatedAt?: unknown; thumb?: unknown; submitted?: unknown; body?: unknown }) => ({
    id: String(data?.id ?? ""),
    name: typeof data?.name === "string" ? data.name : "",
    updatedAt: Number(data?.updatedAt) || Date.now(),
    thumb: typeof data?.thumb === "string" ? data.thumb : null,
    submitted: typeof data?.submitted === "string" ? data.submitted : null,
    body: typeof data?.body === "string" ? data.body : "",
  }))
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string; stale: boolean }> => {
    const { saveAccountDraft } = await import("./frame-drafts-server");
    const result = await saveAccountDraft(await viewerId(), data);
    return result.ok ? result : { ok: false, error: SAVE_ERRORS[result.error] ?? "Couldn't save the draft.", stale: result.error === "stale" };
  });

export const removeAccountDraft = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => ({ id: String(data?.id ?? "") }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { deleteAccountDraft } = await import("./frame-drafts-server");
    await deleteAccountDraft(await viewerId(), data.id);
    return { ok: true };
  });

/* One of the viewer's own frame pictures, as a data URL the editor can draw from. */
export const fetchOwnFramePicture = createServerFn({ method: "POST" })
  .validator((data: { url?: unknown }) => ({ url: String(data?.url ?? "") }))
  .handler(async ({ data }): Promise<{ dataUrl: string }> => {
    await viewerId();
    const { isFramePictureUrl } = await import("./frame-drafts-server");
    if (!isFramePictureUrl(data.url)) throw new Error("That isn't a frame picture.");
    const response = await fetch(data.url);
    if (!response.ok) throw new Error("Couldn't load the frame's picture.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 8 * 1024 * 1024) throw new Error("That picture is too big.");
    return { dataUrl: `data:image/png;base64,${buffer.toString("base64")}` };
  });
