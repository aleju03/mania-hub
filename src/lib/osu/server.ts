import { createServerOnlyFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { requireAdminAccess } from "../auth";

export const edgeCache = createServerOnlyFn((sMaxage: number, swr?: number): void => {
  const effectiveSwr = swr ?? sMaxage * 4;
  setResponseHeader(
    "Cache-Control",
    `public, s-maxage=${sMaxage}, stale-while-revalidate=${effectiveSwr}`,
  );
});

export const noStore = createServerOnlyFn((): void => {
  setResponseHeader("Cache-Control", "no-store");
});

export const sanitizeServerProfilePageHtml = createServerOnlyFn(
  async (html: string | null | undefined): Promise<string | null> => {
    if (!html) return null;
    const { sanitizeProfilePageHtml } = await import("../profile-page");
    return sanitizeProfilePageHtml(html);
  },
);

export const assertDevMutationAllowed = createServerOnlyFn(async (action: string): Promise<void> => {
  await requireAdminAccess(action);
});
