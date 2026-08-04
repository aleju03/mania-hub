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

function canReadDocumentVisibility(): boolean {
  return typeof document !== "undefined";
}

export function isDocumentVisible(): boolean {
  return !canReadDocumentVisibility() || document.visibilityState !== "hidden";
}

export function subscribeDocumentVisibility(callback: () => void): () => void {
  if (!canReadDocumentVisibility()) return () => {};
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

/** Visibility without focus: an unfocused second-monitor page stays live, but
 * a background tab releases scarce HTTP/1.1 streaming connections. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeDocumentVisibility, isDocumentVisible, () => true);
}
