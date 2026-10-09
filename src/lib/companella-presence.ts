import { useEffect, useSyncExternalStore } from "react";

import { DEFAULT_COUNTRY_CODE } from "#/lib/country";
import {
  fetchCompanellaPresenceDirect,
  isLiveBackendConfigured,
  openLiveEventSource,
  type CompanellaPresence,
} from "#/lib/live-backend";

// Live presence from Hashi, one store per tab: the snapshot once,
// then the companella_presence events over the shell's passive live stream.
// The backend does not log those events, so a reconnect reads the snapshot
// again instead of replaying them.

type PresenceMap = ReadonlyMap<number, CompanellaPresence>;

const EMPTY: PresenceMap = new Map();
// A route change unmounts one consumer before the next mounts; keep the stream
// through the gap instead of reopening it.
const RELEASE_DELAY_MS = 5_000;

let current: PresenceMap = EMPTY;
const listeners = new Set<() => void>();
let consumers = 0;
let source: ReturnType<typeof openLiveEventSource> = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotInFlight = false;

function publish(next: PresenceMap): void {
  current = next;
  for (const listener of listeners) listener();
}

function readSnapshot(): void {
  if (snapshotInFlight) return;
  snapshotInFlight = true;
  void fetchCompanellaPresenceDirect()
    .then((entries) => publish(new Map(entries.map((entry) => [entry.user_id, entry]))))
    .catch(() => undefined)
    .finally(() => {
      snapshotInFlight = false;
    });
}

function onPresence(event: Event): void {
  try {
    const payload = JSON.parse((event as MessageEvent).data) as { user_id?: number; presence?: CompanellaPresence | null };
    const userId = Number(payload.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    const next = new Map(current);
    if (payload.presence) next.set(userId, payload.presence);
    else next.delete(userId);
    publish(next);
  } catch {
    // Ignore malformed events.
  }
}

function start(): void {
  if (source || !isLiveBackendConfigured()) return;
  // Presence events reach every country's stream; reuse the shell's passive one.
  source = openLiveEventSource(DEFAULT_COUNTRY_CODE, { observe: true });
  source?.addEventListener("companella_presence", onPresence);
  source?.addEventListener("open", readSnapshot);
  readSnapshot();
}

function stop(): void {
  source?.removeEventListener("companella_presence", onPresence);
  source?.removeEventListener("open", readSnapshot);
  source?.close();
  source = null;
  publish(EMPTY);
}

function retain(): () => void {
  consumers += 1;
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  start();
  return () => {
    consumers -= 1;
    if (consumers > 0) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (consumers === 0) stop();
    }, RELEASE_DELAY_MS);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every player with live presence, keyed by user id. Empty during SSR. */
export function useCompanellaPresenceMap(): PresenceMap {
  useEffect(retain, []);
  return useSyncExternalStore(subscribe, () => current, () => EMPTY);
}

export function usePlayerPresence(userId: number | null | undefined): CompanellaPresence | null {
  const map = useCompanellaPresenceMap();
  return userId == null ? null : map.get(userId) ?? null;
}
