// Which Overall the skill surfaces headline: Etterna's (the average of the
// best skillsets, LN included; the default) or Legacy (the SSR aggregate the
// site showed before). A view preference like the plays explorer's, so it
// lives in its own small localStorage key. The server snapshot is always the
// default, so SSR and hydration agree and a stored Legacy applies right after.

import { useSyncExternalStore } from "react";
import { ETTERNA_OVERALL_AXIS, OVERALL_AXIS_META, type OverallMethod } from "./skill-axes";

export { hasEtternaOverall, modeOverall, type OverallMethod } from "./skill-axes";

export const OVERALL_METHOD_STORAGE_KEY = "mania-hub-overall-method-v1";

const listeners = new Set<() => void>();

function readOverallMethod(): OverallMethod {
  try {
    return window.localStorage.getItem(OVERALL_METHOD_STORAGE_KEY) === "classic" ? "classic" : "etterna";
  } catch {
    return "etterna";
  }
}

export function setOverallMethod(method: OverallMethod): void {
  try {
    if (method === "classic") window.localStorage.setItem(OVERALL_METHOD_STORAGE_KEY, method);
    else window.localStorage.removeItem(OVERALL_METHOD_STORAGE_KEY);
  } catch {
    // Storage blocked: the choice still holds for this page.
  }
  current = method;
  for (const listener of listeners) listener();
}

let current: OverallMethod | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab flipping it moves this one too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== OVERALL_METHOD_STORAGE_KEY) return;
    current = readOverallMethod();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): OverallMethod {
  if (current == null) current = readOverallMethod();
  return current;
}

export function useOverallMethod(): OverallMethod {
  return useSyncExternalStore(subscribe, getSnapshot, () => "etterna");
}

/** The leaderboard axis the Overall chip reads under a method. */
export function overallAxisFor(method: OverallMethod, hasEtterna: boolean): string {
  if (method !== "etterna" || !hasEtterna) return OVERALL_AXIS_META.key;
  return ETTERNA_OVERALL_AXIS;
}
