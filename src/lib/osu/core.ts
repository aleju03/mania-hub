import { createServerOnlyFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { requireAdminAccess } from "../auth";

export function edgeCache(sMaxage: number, swr?: number): void {
  const effectiveSwr = swr ?? sMaxage * 4;
  setResponseHeader(
    "Cache-Control",
    `public, s-maxage=${sMaxage}, stale-while-revalidate=${effectiveSwr}`,
  );
}

export function noStore(): void {
  setResponseHeader("Cache-Control", "no-store");
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export const sanitizeServerProfilePageHtml = createServerOnlyFn(
  async (html: string | null | undefined): Promise<string | null> => {
    if (!html) return null;
    const { sanitizeProfilePageHtml } = await import("../profile-page");
    return sanitizeProfilePageHtml(html);
  },
);

export async function assertDevMutationAllowed(action: string): Promise<void> {
  await requireAdminAccess(action);
}
