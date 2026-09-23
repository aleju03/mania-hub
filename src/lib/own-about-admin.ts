import { createServerFn } from "@tanstack/react-start";

import { parseBBCode, type BBNode } from "./bbcode";
import { adminAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";

/* The admin page for About pages restricted players saved here
   (/admin/about-pages, live-backend features/own-about.ts). Nobody reviews
   them before they show, so this is where one gets cleared, and where an image
   pasted into one, which we host under bbcode/ in the public bucket, gets
   deleted. */

export interface SavedAboutImage {
  src: string;
  /** Our bucket key when we host the file, so it can be deleted; null for other hosts. */
  key: string | null;
}

export interface SavedAboutPage {
  userId: number;
  username: string;
  avatarUrl: string;
  raw: string;
  updatedAt: string;
  accountStatus: "restricted" | "missing" | "wiped" | null;
  images: SavedAboutImage[];
}

const HOSTED_KEY_PATTERN = /^bbcode\/[a-f0-9]{64}\.[a-z0-9]+$/;

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

/**
 * Every saved page's owner and source. Server-only; the BBCode image audit
 * counts an image on one of these as in use. Null when the backend could not
 * say, which the audit must treat as "anything might be in use".
 */
export async function readSavedAboutPages(): Promise<Array<Omit<SavedAboutPage, "images">> | null> {
  try {
    const response = await adminFetch("/api/admin/own-about-pages");
    if (!response.ok) return null;
    const body = await response.json() as { entries?: Array<Omit<SavedAboutPage, "images">> };
    return Array.isArray(body.entries) ? body.entries : null;
  } catch {
    return null;
  }
}

function collectImageSources(nodes: BBNode[], into: string[]): void {
  for (const node of nodes) {
    if (node.type === "img" || node.type === "imagemap") into.push(node.src);
    if ("children" in node) collectImageSources(node.children, into);
    if (node.type === "list") for (const item of node.items) collectImageSources(item, into);
  }
}

function hostedKey(src: string, publicBase: string | null): string | null {
  if (!publicBase || !src.startsWith(`${publicBase}/`)) return null;
  const key = src.slice(publicBase.length + 1).split(/[?#]/)[0];
  return HOSTED_KEY_PATTERN.test(key) ? key : null;
}

export const listSavedAboutPages = createServerFn({ method: "GET" }).handler(async (): Promise<SavedAboutPage[]> => {
  const { requireAdminAccess } = await import("./auth");
  await requireAdminAccess("List saved About pages");
  const pages = await readSavedAboutPages();
  if (!pages) throw new Error("Couldn't load saved About pages from the live backend.");
  const { getPublicBucketBaseUrl } = await import("./public-image-store");
  const publicBase = getPublicBucketBaseUrl()?.replace(/\/$/, "") ?? null;
  return pages.map((page) => {
    const sources: string[] = [];
    collectImageSources(parseBBCode(page.raw), sources);
    const images = [...new Set(sources)].map((src) => ({ src, key: hostedKey(src, publicBase) }));
    return { ...page, images };
  });
});

export const clearSavedAboutPage = createServerFn({ method: "POST" })
  .validator((data: { userId?: unknown }) => {
    const userId = Number(data?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid user id.");
    return { userId };
  })
  .handler(async ({ data }): Promise<boolean> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Clear a saved About page");
    const response = await adminFetch("/api/admin/own-about-pages/clear", {
      method: "POST",
      body: JSON.stringify({ userId: data.userId }),
    });
    if (!response.ok) throw new Error(`Server ${response.status} for /api/admin/own-about-pages/clear`);
    return ((await response.json()) as { cleared?: unknown }).cleared === true;
  });

/**
 * Deletes one image we host, from the bucket and from Cloudflare's cache.
 *
 * A moderation delete, not the audit's cleanup: it goes even if other pages
 * embed the same file. Only files a saved About page embeds, so this cannot be
 * used to delete arbitrary bucket objects.
 */
export const deleteSavedAboutImage = createServerFn({ method: "POST" })
  .validator((data: { key?: unknown }) => {
    const key = typeof data?.key === "string" ? data.key.trim() : "";
    if (!HOSTED_KEY_PATTERN.test(key)) throw new Error("Not a bbcode/ image key.");
    return { key };
  })
  .handler(async ({ data }): Promise<{ purged: boolean }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Delete an image from a saved About page");
    const pages = await readSavedAboutPages();
    const fileName = data.key.slice("bbcode/".length);
    if (!pages?.some((page) => page.raw.includes(fileName))) {
      throw new Error("No saved About page embeds that image.");
    }
    const [{ deleteR2AdminObject }, { invalidateBbcodeImageListing }, { purgeCloudflareUrls }, { getPublicBucketBaseUrl }] = await Promise.all([
      import("./r2-cache"),
      import("./bbcode-image-audit"),
      import("./cloudflare-purge"),
      import("./public-image-store"),
    ]);
    await deleteR2AdminObject("public", data.key);
    invalidateBbcodeImageListing();
    const publicBase = getPublicBucketBaseUrl()?.replace(/\/$/, "");
    const purge = publicBase ? await purgeCloudflareUrls([`${publicBase}/${data.key}`]) : null;
    return { purged: purge?.configured === true && purge.purged > 0 };
  });
