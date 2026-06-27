import { useSyncExternalStore } from "react";

function canReadWindowActivity(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

export function isWindowActive(): boolean {
  if (!canReadWindowActivity()) return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

export function subscribeWindowActivity(callback: () => void): () => void {
  if (!canReadWindowActivity()) return () => {};

  window.addEventListener("focus", callback);
  window.addEventListener("blur", callback);
  window.addEventListener("pageshow", callback);
  window.addEventListener("pagehide", callback);
  document.addEventListener("visibilitychange", callback);

  return () => {
    window.removeEventListener("focus", callback);
    window.removeEventListener("blur", callback);
    window.removeEventListener("pageshow", callback);
    window.removeEventListener("pagehide", callback);
    document.removeEventListener("visibilitychange", callback);
  };
}

export function useWindowActive(): boolean {
  return useSyncExternalStore(subscribeWindowActivity, isWindowActive, () => true);
}
