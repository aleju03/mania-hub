import { useEffect, useSyncExternalStore } from "react";

import { fetchScoreVideosDirect, isLiveBackendConfigured } from "#/lib/live-backend";

// Proof videos on official plays (backend features/score-videos.ts), one store
// per tab: the list is a handful of links, read once and again when a later
// consumer finds it older than STALE_MS. Keyed by every id a play goes by.

type VideoMap = ReadonlyMap<number, string>;

const EMPTY: VideoMap = new Map();
const STALE_MS = 5 * 60_000;

let current: VideoMap = EMPTY;
let loadedAt = 0;
let inFlight = false;
const listeners = new Set<() => void>();

/** Reads the list again; the admin tab calls it after a change. */
export function reloadScoreVideos(): void {
  if (inFlight || !isLiveBackendConfigured()) return;
  inFlight = true;
  void fetchScoreVideosDirect()
    .then((videos) => {
      loadedAt = Date.now();
      current = new Map(videos.flatMap((video) => video.ids.map((id) => [id, video.url] as const)));
      for (const listener of listeners) listener();
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = false;
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The proof video of a play named by any of its ids. Undefined during SSR. */
export function useScoreVideo(...ids: Array<number | null | undefined>): string | undefined {
  useEffect(() => {
    if (Date.now() - loadedAt > STALE_MS) reloadScoreVideos();
  }, []);
  const map = useSyncExternalStore(subscribe, () => current, () => EMPTY);
  for (const id of ids) {
    if (id != null && id > 0 && map.has(id)) return map.get(id);
  }
  return undefined;
}

/** A play's video: the one it was entered from by hand, or a proof video on an official play. */
export function usePlayVideo(score: { id?: number | null; legacy_score_id?: number | null; companella?: { video?: string } | null }): string | undefined {
  const proof = useScoreVideo(score.companella ? null : score.id, score.companella ? null : score.legacy_score_id);
  return score.companella ? score.companella.video : proof;
}
