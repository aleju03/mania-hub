import { initializeAnalyticsEntry, track } from "./analytics";

let installed = false;

export function installAnalyticsReliability(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  initializeAnalyticsEntry();
  const seen = new Map<string, number>();
  const report = (event: string, value: unknown) => {
    const message = (value instanceof Error ? value.message : String(value ?? "Unknown error")).slice(0, 500);
    const key = `${event}:${message}`;
    const now = Date.now();
    for (const [entry, ts] of seen) if (now - ts >= 60_000) seen.delete(entry);
    if (seen.has(key) || seen.size >= 5) return;
    seen.set(key, now);
    track(event, { message });
  };
  window.addEventListener("error", (event) => {
    // Resource failures are not JS exceptions and have no ErrorEvent message.
    if (event.message && event.message !== "Script error.") report("client_error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => report("client_unhandled_rejection", event.reason));

  const documentPath = window.location.pathname;
  const documentUrl = window.location.href;
  const loaded = () => {
    // loadEventEnd is populated after the load listener returns.
    window.setTimeout(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (!navigation || navigation.loadEventEnd <= 0) return;
      track("page_load_result", {
        $pathname: documentPath,
        $current_url: documentUrl,
        duration_ms: Math.round(navigation.loadEventEnd - navigation.startTime),
        success: true,
      });
    }, 0);
  };
  if (document.readyState === "complete") loaded();
  else window.addEventListener("load", loaded, { once: true });
}
