import { createServerFn } from "@tanstack/react-start";

import { edgeCache } from "./osu/server";
import type { CommunityUploadEntry } from "./uploaded-replay-payload";

// The Upload tab's community list and the gallery behind it: every upload,
// newest first, with its derived description. Everything shown is already
// public - any upload is reachable at /replay?uploadId=<id> - so the lists
// only surface what the share links expose, they grant nothing new. The work
// lives in uploaded-replay-community-server.ts, imported inside the handlers.

export type { CommunityUploadEntry } from "./uploaded-replay-payload";

export interface CommunityUploadsPage {
  uploads: CommunityUploadEntry[];
  /** Every upload there is, not just the ones on this page. */
  total: number;
  page: number;
  hasMore: boolean;
}

const RECENT_COMMUNITY_UPLOADS_LIMIT = 9;
export const COMMUNITY_UPLOADS_PAGE_SIZE = 24;

export const getRecentCommunityUploads = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ uploads: CommunityUploadEntry[]; total: number }> => {
    const { getUploadsSlice } = await import("./uploaded-replay-community-server");
    return getUploadsSlice(0, RECENT_COMMUNITY_UPLOADS_LIMIT);
  },
);

// A page of the gallery at /replay/community. Public data, so the edge may
// hold a page briefly; the server tier is what actually paces the rebuilds.
export const getCommunityUploadsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: unknown } | undefined) => {
    const page = Math.floor(Number(data?.page ?? 0));
    return { page: Number.isFinite(page) && page > 0 ? Math.min(page, 1000) : 0 };
  })
  .handler(async ({ data }): Promise<CommunityUploadsPage> => {
    edgeCache(60, 120);
    const { getUploadsSlice } = await import("./uploaded-replay-community-server");
    const offset = data.page * COMMUNITY_UPLOADS_PAGE_SIZE;
    const { uploads, total } = await getUploadsSlice(offset, COMMUNITY_UPLOADS_PAGE_SIZE);
    return { uploads, total, page: data.page, hasMore: offset + COMMUNITY_UPLOADS_PAGE_SIZE < total };
  });
