import { pingSkinViews } from "./skins";

// Views earned from a grid. A card is seen when at least half of it stays in
// the upper half of the viewport for three continuous seconds. The skin's
// ref lands here rather than in its own request, because one scroll can
// qualify several cards. The queue flushes shortly after the first card
// joins it, and on the page hiding so a visitor who
// scrolled and left still counts (keepalive carries the request out).
// The set spares repeat sends for a card re-rendered by filtering or scrolled
// back into view; what actually counts is the backend's 6h-per-IP dedup.
export const SKIN_VIEW_FLUSH_MS = 1500;

const queued = new Set<string>();
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

export function flushSkinViews(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  pingSkinViews(batch);
}

function listen(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSkinViews();
  });
  window.addEventListener("pagehide", flushSkinViews);
}

export function queueSkinView(ref: string): void {
  if (queued.has(ref)) return;
  queued.add(ref);
  pending.push(ref);
  listen();
  if (flushTimer == null) flushTimer = setTimeout(flushSkinViews, SKIN_VIEW_FLUSH_MS);
}

// Test seam: the set is for the life of the page, which in a test is the suite.
export function resetSkinViewQueue(): void {
  if (flushTimer != null) clearTimeout(flushTimer);
  flushTimer = null;
  pending = [];
  queued.clear();
}
