// The admin Prism view (backend features/prism-view.ts): an admin's browser
// sends a signed token with its chart and skills reads, the backend answers
// them from the Prism sidecar's numbers, and usesPrism answers true here so
// 6K-8K draw as Prism's. Everyone else, and every server render, is untouched.

import { createServerFn } from "@tanstack/react-start";
import { setPrismViewProbe } from "#dan/prism/switch";

export const PRISM_VIEW_HEADER = "x-prism-view";
const STORAGE_KEY = "mania-hub-prism-view";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

/** A token for the backend, admins only (same signature as the backend's signPrismViewToken). */
export const mintPrismViewToken = createServerFn({ method: "POST" }).handler(async (): Promise<{ token: string }> => {
  const { requireAdminAccess } = await import("./auth");
  await requireAdminAccess("The Prism view");
  const adminToken = process.env.LIVE_ADMIN_TOKEN;
  if (!adminToken) throw new Error("Configure LIVE_ADMIN_TOKEN to use the Prism view.");
  const { createHmac } = await import("node:crypto");
  const exp = String(Date.now() + TOKEN_TTL_MS);
  const key = createHmac("sha256", adminToken).update("prism-view").digest();
  return { token: `${exp}.${createHmac("sha256", key).update(exp).digest("hex")}` };
});

/** The stored token while it is unexpired; null on the server. */
export function readPrismViewToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const token = window.localStorage.getItem(STORAGE_KEY);
    if (!token) return null;
    const exp = Number(token.slice(0, token.indexOf(".")));
    if (!(exp > Date.now())) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function isPrismViewOn(): boolean {
  return readPrismViewToken() != null;
}

/** Turns the view on (with a fresh token) or off, then reloads so every read and label follows. */
export async function setPrismView(on: boolean): Promise<void> {
  if (on) {
    const { token } = await mintPrismViewToken();
    window.localStorage.setItem(STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  window.location.reload();
}

/** Called once in the browser before the app renders. */
export function installPrismView(): void {
  if (readPrismViewToken()) setPrismViewProbe(() => true);
}

/** The header to add to a live backend read, when the view is on. */
export function prismViewHeaders(): Record<string, string> | null {
  const token = readPrismViewToken();
  return token ? { [PRISM_VIEW_HEADER]: token } : null;
}
