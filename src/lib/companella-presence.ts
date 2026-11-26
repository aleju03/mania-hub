import { useEffect, useSyncExternalStore } from "react";

import { DEFAULT_COUNTRY_CODE } from "#/lib/country";
import {
  fetchCompanellaPresenceSnapshotDirect,
  isLiveBackendConfigured,
  openLiveEventSource,
  type CompanellaPresence,
} from "#/lib/live-backend";

// Live presence from Hashi, one store per tab: the snapshot once,
// then the companella_presence events over the shell's passive live stream.
// Who is streaming their plays rides along (companella_live): a separate
// setting in the app, so it is kept apart from the presence entries.
// The backend does not log those events, so a reconnect reads the snapshot
// again instead of replaying them.

type PresenceMap = ReadonlyMap<number, CompanellaPresence>;

const EMPTY: PresenceMap = new Map();
// A route change unmounts one consumer before the next mounts; keep the stream
// through the gap instead of reopening it.
const RELEASE_DELAY_MS = 5_000;

let current: PresenceMap = EMPTY;
const EMPTY_LIVE: ReadonlySet<number> = new Set();
let liveIds: ReadonlySet<number> = EMPTY_LIVE;
const listeners = new Set<() => void>();
let consumers = 0;
let source: ReturnType<typeof openLiveEventSource> = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotInFlight = false;

function publish(next: PresenceMap, nextLive: ReadonlySet<number> = liveIds): void {
  current = next;
  liveIds = nextLive;
  for (const listener of listeners) listener();
}

function readSnapshot(): void {
  if (snapshotInFlight) return;
  snapshotInFlight = true;
  void fetchCompanellaPresenceSnapshotDirect()
    .then(({ presence, live }) => publish(new Map(presence.map((entry) => [entry.user_id, entry])), new Set(live)))
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

function onLive(event: Event): void {
  try {
    const payload = JSON.parse((event as MessageEvent).data) as { user_id?: number; live?: boolean };
    const userId = Number(payload.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    const next = new Set(liveIds);
    if (payload.live) next.add(userId);
    else next.delete(userId);
    publish(current, next);
  } catch {
    // Ignore malformed events.
  }
}

function start(): void {
  if (source || !isLiveBackendConfigured()) return;
  // Presence events reach every country's stream; reuse the shell's passive one.
  source = openLiveEventSource(DEFAULT_COUNTRY_CODE, { observe: true });
  source?.addEventListener("companella_presence", onPresence);
  source?.addEventListener("companella_live", onLive);
  source?.addEventListener("open", readSnapshot);
  readSnapshot();
}

function stop(): void {
  source?.removeEventListener("companella_presence", onPresence);
  source?.removeEventListener("companella_live", onLive);
  source?.removeEventListener("open", readSnapshot);
  source?.close();
  source = null;
  publish(EMPTY, EMPTY_LIVE);
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

/** Whether the player is streaming their plays right now, so their profile can offer Watch. */
export function usePlayerStreaming(userId: number | null | undefined): boolean {
  useEffect(retain, []);
  const live = useSyncExternalStore(subscribe, () => liveIds, () => EMPTY_LIVE);
  return userId != null && live.has(userId);
}
