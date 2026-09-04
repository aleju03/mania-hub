import type { LivePlayerActivitySnapshot } from "./live-backend";
import { isDocumentVisible, subscribeDocumentVisibility } from "./window-activity";

/** Serve the first calendar immediately, then follow only its pending repair. */
export function refreshPlayerActivitySnapshot(options: {
  load: () => Promise<LivePlayerActivitySnapshot>;
  onSnapshot: (snapshot: LivePlayerActivitySnapshot) => void;
  onInitialError: () => void;
  onInitialSettled: () => void;
}): () => void {
  let cancelled = false;
  let repairPending = false;
  let inFlight = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (cancelled || !repairPending || inFlight || timer || !isDocumentVisible() || attempts >= 10) return;
    timer = setTimeout(() => {
      timer = undefined;
      attempts++;
      void load(true);
    }, Math.min(30_000, 3_000 * 2 ** attempts));
  };
  const load = async (background = false) => {
    inFlight = true;
    try {
      const snapshot = await options.load();
      if (cancelled) return;
      options.onSnapshot(snapshot);
      repairPending = snapshot.refreshPending === true;
    } catch {
      // A retry failing must not replace a useful calendar with an error.
      if (!cancelled && !background) options.onInitialError();
    } finally {
      inFlight = false;
      if (!cancelled) {
        if (!background) options.onInitialSettled();
        schedule();
      }
    }
  };
  const unsubscribe = subscribeDocumentVisibility(() => {
    if (!isDocumentVisible()) {
      clearTimeout(timer);
      timer = undefined;
    } else {
      schedule();
    }
  });
  void load();

  return () => {
    cancelled = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
