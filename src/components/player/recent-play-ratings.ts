import { useEffect, useState } from "react";
import {
  fetchLiveRecentPlayRatingsDirect,
  isLiveBackendConfigured,
  openLiveEventSource,
  type LiveRecentPlayRating,
  type LiveRecentPlayRatingRequest,
} from "#/lib/live-backend";
import { DEFAULT_COUNTRY_CODE } from "#/lib/country";
import { getScoreRate, getScoreTimeMs } from "#/lib/score";
import type { OsuScore } from "#/lib/types";

export type RecentPlayRatingView = LiveRecentPlayRating & { loadError?: true; onRetry?: () => void };
type Entry = { rating: LiveRecentPlayRating; at: number };
// Answers with and without the rating gain are kept apart, so the dialog
// never reuses a Recent tab answer that lacks it.
const ratingsByUser = new Map<string, Map<string, Entry>>();
const BATCH_SIZE = 100;
const MAX_USERS = 20;
const MAX_RATINGS_PER_USER = 500;
const REASK_MS = 10 * 60_000;
// The backend drops a cached answer as soon as the job behind it finishes, so
// a finished job is rechecked right away, after a beat that folds a burst of
// events (chart analysis, dan estimate, skills) into one read. An answer that
// still names a finished job is rechecked once the 30s origin cache has
// expired, which also covers a backend that predates that invalidation.
const EVENT_SETTLE_MS = 250;
const MIN_REASK_MS = 31_000;
// Rechecks after events are spaced so a list whose charts finish analysis one
// by one stays inside the 30 per minute public read limit.
const CHANGED_READ_GAP_MS = 10_000;
const RECOVERY_MS = 5 * 60_000;
const UNAVAILABLE: LiveRecentPlayRating = { msd: null, dan: null, missing: { msd: "not_analyzed", dan: "not_analyzed" } };
const UNSUPPORTED: LiveRecentPlayRating = { msd: null, dan: null, missing: { msd: "unsupported", dan: "unsupported" } };
const EMPTY_LOOKUP = new Map<string, RecentPlayRatingView>();

function userRatings(userId: number, gain: boolean): Map<string, Entry> {
  const slot = gain ? `${userId}:gain` : String(userId);
  const known = ratingsByUser.get(slot) ?? new Map<string, Entry>();
  ratingsByUser.delete(slot);
  ratingsByUser.set(slot, known);
  while (ratingsByUser.size > MAX_USERS) ratingsByUser.delete(ratingsByUser.keys().next().value!);
  return known;
}

export function recentPlayRatingKey(score: OsuScore): string {
  if (score.companella) return `import:${score.companella.importId}`;
  return String(score.legacy_score_id != null && score.legacy_score_id > 0 ? score.legacy_score_id : score.id);
}

type Ask = ({ play: LiveRecentPlayRatingRequest } | { importId: string } | { unavailable: true }) & { key: string };
function toAsk(score: OsuScore): Ask {
  const key = recentPlayRatingKey(score);
  if (score.companella) return { key, importId: score.companella.importId };
  const scoreId = Number(key);
  const beatmapId = score.beatmap?.id ?? 0;
  const keyCount = Math.round(Number(score.beatmap?.cs));
  const rate = getScoreRate(score.mods);
  if (!(scoreId > 0) || !(beatmapId > 0) || !Number.isInteger(keyCount) || keyCount < 1 || keyCount > 18 || rate < 0.5 || rate > 2) {
    return { key, unavailable: true };
  }
  const mods = (score.mods ?? []).map((mod) => (typeof mod === "string" ? mod : mod?.acronym ?? "")).filter(Boolean);
  return { key, play: { scoreId, beatmapId, keyCount, rate, mods,
    playedAt: getScoreTimeMs(score), passed: score.passed !== false && score.rank !== "F" } };
}

/** Undefined cells are loading; absent ratings and failed requests are explicit. */
export function useRecentPlayRatingLookup(
  userId: number | undefined,
  scores: OsuScore[],
  enabled: boolean,
  options: { gain?: boolean } = {},
): Map<string, RecentPlayRatingView> {
  const gain = options.gain === true;
  const [result, setResult] = useState<{ userId: number; lookup: Map<string, RecentPlayRatingView> }>();
  const signature = enabled ? JSON.stringify(scores.map(toAsk)) : "[]";

  useEffect(() => {
    if (!enabled || !userId) return;
    const asks = [...new Map((JSON.parse(signature) as Ask[]).map((ask) => [ask.key, ask])).values()];
    const known = userRatings(userId, gain);
    const controller = new AbortController();
    const errors = new Set<string>();
    // Preserve notifications racing an in-flight snapshot.
    const changed = new Map<string, number>();
    const markChanged = (key: string, due: number) => changed.set(key, Math.min(due, changed.get(key) ?? Infinity));
    // Keys an event asked to recheck. If the answer comes back unchanged it may
    // be a cached one, so it gets a single recheck after the cache window.
    const eventChanged = new Set<string>();
    let lastChangedRead = -Infinity;
    const observedJobs = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let source: ReturnType<typeof openLiveEventSource> = null;
    let running = false;

    const publish = () => {
      const lookup = new Map<string, RecentPlayRatingView>();
      for (const ask of asks) {
        if ("unavailable" in ask) lookup.set(ask.key, UNSUPPORTED);
        else if (!isLiveBackendConfigured()) lookup.set(ask.key, UNAVAILABLE);
        else if (errors.has(ask.key)) lookup.set(ask.key, { ...(known.get(ask.key)?.rating ?? UNAVAILABLE), loadError: true, onRetry: () => void read("retry") });
        else if (known.has(ask.key)) lookup.set(ask.key, known.get(ask.key)!.rating);
      }
      setResult({ userId, lookup });
    };

    const nextCheck = (entry: Entry, key: string) => {
      const changedDue = changed.get(key);
      if (changedDue != null) return Math.max(changedDue, lastChangedRead + CHANGED_READ_GAP_MS);
      if (!entry.rating.pending) return Infinity;
      const due = Math.min(...(entry.rating.jobs ?? []).map((job) => Date.parse(job.runAfter)).filter(Number.isFinite));
      // Scheduled sessions sleep until work is due. Slow recovery covers a
      // lost event, an unavailable stream or a deleted/replaced job.
      return Math.max(entry.at + RECOVERY_MS, Number.isFinite(due) ? due + 60_000 : 0);
    };
    const schedule = () => {
      clearTimeout(timer);
      if (controller.signal.aborted || document.visibilityState !== "visible") return;
      const due = Math.min(...asks.map(({ key }) => known.has(key) ? nextCheck(known.get(key)!, key) : Infinity));
      if (Number.isFinite(due)) timer = setTimeout(() => void read("updates"), Math.max(1, due - Date.now()));
    };
    const read = async (mode: "list" | "updates" | "resume" | "retry" = "list") => {
      if (running || controller.signal.aborted || document.visibilityState !== "visible" || !isLiveBackendConfigured()) return;
      running = true;
      const now = Date.now();
      const missing = asks.filter((ask) => {
        if ("unavailable" in ask) return false;
        const entry = known.get(ask.key);
        if (mode === "retry" && errors.has(ask.key)) return true;
        if (!entry) return mode !== "updates";
        if (nextCheck(entry, ask.key) <= now) return true;
        if (mode === "resume" && entry.rating.pending) return now - entry.at >= MIN_REASK_MS;
        return mode !== "updates" && now - entry.at >= REASK_MS;
      });
      try {
        for (let start = 0; start < missing.length; start += BATCH_SIZE) {
          if (controller.signal.aborted || document.visibilityState !== "visible") break;
          const batch = missing.slice(start, start + BATCH_SIZE);
          const recheckIfSame = new Map<string, string>();
          if (batch.some((ask) => changed.has(ask.key))) lastChangedRead = now;
          for (const ask of batch) {
            changed.delete(ask.key);
            if (eventChanged.delete(ask.key)) recheckIfSame.set(ask.key, JSON.stringify(known.get(ask.key)?.rating ?? null));
            for (const job of known.get(ask.key)?.rating.jobs ?? []) observedJobs.delete(job.id);
          }
          const plays = batch.flatMap((ask) => ("play" in ask ? [ask.play] : []));
          const importIds = batch.flatMap((ask) => ("importId" in ask ? [ask.importId] : []));
          try {
            const fresh = mode !== "list" || batch.some((ask) => known.has(ask.key));
            const found = await fetchLiveRecentPlayRatingsDirect(userId, plays, importIds, { signal: controller.signal, fresh, gain });
            if (controller.signal.aborted) return;
            const at = Date.now();
            for (const ask of batch) {
              const rating = ("play" in ask ? found.items[ask.key] : "importId" in ask ? found.imports[ask.importId] : null) ?? UNAVAILABLE;
              errors.delete(ask.key);
              known.delete(ask.key);
              known.set(ask.key, { rating, at });
              if (rating.jobs?.some((job) => observedJobs.has(job.id)) || recheckIfSame.get(ask.key) === JSON.stringify(rating)) {
                markChanged(ask.key, at + MIN_REASK_MS);
              }
            }
            while (known.size > MAX_RATINGS_PER_USER) known.delete(known.keys().next().value!);
            publish();
          } catch {
            if (controller.signal.aborted) return;
            for (const ask of missing.slice(start)) {
              errors.add(ask.key);
              const entry = known.get(ask.key);
              if (entry) entry.at = Date.now();
            }
            publish();
            break;
          }
        }
      } finally {
        running = false;
        schedule();
      }
    };

    const connect = () => {
      if (source || !isLiveBackendConfigured() || !asks.some((ask) => !("unavailable" in ask))) return;
      // job_status reaches every country. Reuse the shell's passive stream.
      source = openLiveEventSource(DEFAULT_COUNTRY_CODE, { observe: true });
      source?.addEventListener("job_status", (event) => {
        try {
          const job = JSON.parse(event.data) as { id?: number; status?: string; type?: string; userId?: number; beatmapId?: number };
          if (!job.id || !["done", "failed", "queued"].includes(job.status ?? "")) return;
          observedJobs.add(job.id);
          while (observedJobs.size > 128) observedJobs.delete(observedJobs.values().next().value!);
          for (const ask of asks) {
            const targeted = job.status === "done" && "play" in ask && (
              (job.type === "compute_player_skills" && job.userId === userId)
              || ((job.type === "analyze_beatmap_chart" || job.type === "compute_dan_estimate") && job.beatmapId === ask.play.beatmapId));
            if (!targeted && !known.get(ask.key)?.rating.jobs?.some((pending) => pending.id === job.id)) continue;
            // Only a finished job has a new answer behind it. A queued or
            // failed one waits out the origin cache like it always did.
            if (job.status === "done") {
              markChanged(ask.key, Date.now() + EVENT_SETTLE_MS);
              eventChanged.add(ask.key);
            } else {
              markChanged(ask.key, (known.get(ask.key)?.at ?? Date.now()) + MIN_REASK_MS);
            }
          }
          schedule();
        } catch { /* Ignore malformed events. */ }
      });
      source?.addEventListener("open", () => void read("resume"));
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") { connect(); void read("resume"); }
      else { source?.close(); source = null; }
    };
    publish();
    if (document.visibilityState === "visible") { connect(); void read(); }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      clearTimeout(timer);
      source?.close();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, userId, signature, gain]);

  return enabled && result && result.userId === userId ? result.lookup : EMPTY_LOOKUP;
}
