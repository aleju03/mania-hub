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
const ratingsByUser = new Map<number, Map<string, Entry>>();
const BATCH_SIZE = 100;
const MAX_USERS = 20;
const MAX_RATINGS_PER_USER = 500;
const REASK_MS = 10 * 60_000;
// Let the 30s origin result cache expire before rechecking a completed job.
const MIN_REASK_MS = 31_000;
const RECOVERY_MS = 5 * 60_000;
const UNAVAILABLE: LiveRecentPlayRating = { msd: null, dan: null, missing: { msd: "not_analyzed", dan: "not_analyzed" } };
const UNSUPPORTED: LiveRecentPlayRating = { msd: null, dan: null, missing: { msd: "unsupported", dan: "unsupported" } };
const EMPTY_LOOKUP = new Map<string, RecentPlayRatingView>();

function userRatings(userId: number): Map<string, Entry> {
  const known = ratingsByUser.get(userId) ?? new Map<string, Entry>();
  ratingsByUser.delete(userId);
  ratingsByUser.set(userId, known);
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
export function useRecentPlayRatingLookup(userId: number | undefined, scores: OsuScore[], enabled: boolean): Map<string, RecentPlayRatingView> {
  const [result, setResult] = useState<{ userId: number; lookup: Map<string, RecentPlayRatingView> }>();
  const signature = enabled ? JSON.stringify(scores.map(toAsk)) : "[]";

  useEffect(() => {
    if (!enabled || !userId) return;
    const asks = [...new Map((JSON.parse(signature) as Ask[]).map((ask) => [ask.key, ask])).values()];
    const known = userRatings(userId);
    const controller = new AbortController();
    const errors = new Set<string>();
    // Preserve notifications racing an in-flight snapshot.
    const changed = new Set<string>();
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
      if (changed.has(key)) return entry.at + MIN_REASK_MS;
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
          for (const ask of batch) {
            changed.delete(ask.key);
            for (const job of known.get(ask.key)?.rating.jobs ?? []) observedJobs.delete(job.id);
          }
          const plays = batch.flatMap((ask) => ("play" in ask ? [ask.play] : []));
          const importIds = batch.flatMap((ask) => ("importId" in ask ? [ask.importId] : []));
          try {
            const fresh = mode !== "list" || batch.some((ask) => known.has(ask.key));
            const found = await fetchLiveRecentPlayRatingsDirect(userId, plays, importIds, { signal: controller.signal, fresh });
            if (controller.signal.aborted) return;
            const at = Date.now();
            for (const ask of batch) {
              const rating = ("play" in ask ? found.items[ask.key] : "importId" in ask ? found.imports[ask.importId] : null) ?? UNAVAILABLE;
              errors.delete(ask.key);
              known.delete(ask.key);
              known.set(ask.key, { rating, at });
              if (rating.jobs?.some((job) => observedJobs.has(job.id))) changed.add(ask.key);
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
            if (targeted || known.get(ask.key)?.rating.jobs?.some((pending) => pending.id === job.id)) changed.add(ask.key);
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
  }, [enabled, userId, signature]);

  return enabled && result && result.userId === userId ? result.lookup : EMPTY_LOOKUP;
}
