import { useEffect, useState } from "react";
import { useAppStore } from "#/store";
import type { LeanDanEstimate, LeanTrackerScore, OsuScore } from "#/lib/types";
import { getDanEstimates } from "#/lib/osu";
import { getScoreRate } from "#/lib/score";
import { useAuth } from "#/lib/auth-context";
import { DAN_ESTIMATE_CACHE_VERSION } from "#dan/dan-estimator/cache-version";
import { fetchLiveDanEstimates, isLiveBackendConfigured } from "#/lib/live-backend";

// ── Batched fetcher ────────────────────────────────────────────────────────────

type Listener = () => void;

interface PendingRequest {
  beatmapId: number;
  starRating?: number;
  rate: number;
}

const cache = new Map<string, LeanDanEstimate | null>();
const pending = new Map<string, PendingRequest>();
const pendingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingRetryCounts = new Map<string, number>();
const listeners = new Set<Listener>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function estimateResponseKey(beatmapId: number, rate: number): string {
  const r = Math.round(rate * 100);
  return r === 100 ? String(beatmapId) : `${beatmapId}:${r}`;
}

function estimateKey(beatmapId: number, rate: number): string {
  return `v${DAN_ESTIMATE_CACHE_VERSION}:${estimateResponseKey(beatmapId, rate)}`;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 50);
}

async function flush() {
  flushTimer = null;
  if (pending.size === 0) return;

  const batch = Array.from(pending.values());
  pending.clear();

  try {
    const items = batch.map((r) => ({
      beatmapId: r.beatmapId,
      starRating: r.starRating,
      rate: r.rate !== 1 ? r.rate : undefined,
    }));

    let results: Record<string, LeanDanEstimate | null>;
    let livePending = new Set<string>();

    if (isLiveBackendConfigured()) {
      try {
        const live = await fetchLiveDanEstimates(items, DAN_ESTIMATE_CACHE_VERSION);
        results = live.results;
        livePending = new Set(live.pending);
      } catch {
        results = await getDanEstimates({
          data: {
            estimatorVersion: DAN_ESTIMATE_CACHE_VERSION,
            items,
          },
        }) as Record<string, LeanDanEstimate | null>;
      }
    } else {
      results = await getDanEstimates({
        data: {
          estimatorVersion: DAN_ESTIMATE_CACHE_VERSION,
          items,
        },
      }) as Record<string, LeanDanEstimate | null>;
    }

    for (const request of batch) {
      const responseKey = estimateResponseKey(request.beatmapId, request.rate);
      const key = estimateKey(request.beatmapId, request.rate);
      if (livePending.has(responseKey)) {
        schedulePendingRetry(key);
        continue;
      }
      clearPendingRetry(key);
      cache.set(key, results[responseKey] ?? null);
    }
  } catch {
    // Silently fail; badges just won't appear
  }

  for (const fn of listeners) fn();
}

function requestEstimate(
  beatmapId: number,
  starRating: number | undefined,
  rate: number,
): LeanDanEstimate | null | undefined {
  const key = estimateKey(beatmapId, rate);
  if (cache.has(key)) return cache.get(key)!;
  if (!pending.has(key)) {
    pending.set(key, { beatmapId, starRating, rate });
    scheduleFlush();
  }
  return undefined;
}

function schedulePendingRetry(key: string) {
  if (pendingRetryTimers.has(key)) return;
  const retryCount = (pendingRetryCounts.get(key) ?? 0) + 1;
  pendingRetryCounts.set(key, retryCount);
  if (retryCount > 8) {
    pendingRetryCounts.delete(key);
    cache.set(key, null);
    return;
  }
  const retryDelay = Math.min(30_000, 1500 * 2 ** Math.min(5, retryCount - 1));
  pendingRetryTimers.set(key, setTimeout(() => {
    pendingRetryTimers.delete(key);
    for (const fn of listeners) fn();
  }, retryDelay));
}

function clearPendingRetry(key: string) {
  const timer = pendingRetryTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingRetryTimers.delete(key);
  }
  pendingRetryCounts.delete(key);
}

// ── Hook ───────────────────────────────────────────────────────────────────────

function useDanEstimate(
  beatmapId: number | undefined,
  starRating: number | undefined,
  rate: number,
): LeanDanEstimate | null | undefined {
  const [, rerender] = useState(0);

  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [beatmapId, rate]);

  if (!beatmapId) return null;
  return requestEstimate(beatmapId, starRating, rate);
}

// ── Dan image resolution ───────────────────────────────────────────────────────

const DAN_IMAGE_EXTENSIONS: Record<string, "webp" | "svg"> = {
  "1": "svg", "2": "svg", "3": "svg", "4": "svg", "5": "svg",
  "6": "svg", "7": "svg", "8": "svg", "9": "svg", "10": "svg",
  alpha: "webp", beta: "webp", gamma: "webp", delta: "webp",
  epsilon: "webp", zeta: "webp", eta: "webp",
};

function getDanImageSrc(label: string, family: string): string | null {
  if (family === "ln" && /^(1[0-6]|[1-9])$/.test(label)) {
    return `/images/dans/ln/${label}.svg`;
  }
  const ext = DAN_IMAGE_EXTENSIONS[label];
  return ext ? `/images/dans/reform/${label}.${ext}` : null;
}

// ── Family colors ──────────────────────────────────────────────────────────────

const FAMILY_COLOR: Record<string, string> = {
  stream: "text-sky-300",
  jack: "text-red-300",
  handstream: "text-violet-300",
  stamina: "text-emerald-300",
  chordjack: "text-amber-300",
  tech: "text-fuchsia-300",
  ln: "text-teal-300",
  dan: "text-orange-300",
};

// ── Component ──────────────────────────────────────────────────────────────────

function DanBadgeInner({ estimate }: { estimate: LeanDanEstimate }) {
  const imgSrc = getDanImageSrc(estimate.label, estimate.family);
  const familyColor = FAMILY_COLOR[estimate.family] ?? "text-white/70";
  const variantText = estimate.variant ?? "";

  return (
    <span
      className="inline-flex items-center gap-1 flex-shrink-0"
      title={`Dan estimate: ${estimate.displayName} (${estimate.family}${estimate.confidence < 0.5 ? ", low confidence" : ""})`}
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt={estimate.displayName}
          className="h-5 w-5 object-contain drop-shadow-[0_1px_3px_rgba(0,0,0,0.5)]"
        />
      ) : (
        <span className="text-[9px] font-bold text-white/80 uppercase">{estimate.label}</span>
      )}
      {variantText && (
        <span className={`text-[9px] font-bold leading-none ${familyColor}`}>{variantText}</span>
      )}
    </span>
  );
}

export function DanBadge({ score }: { score: OsuScore | LeanTrackerScore }) {
  const showDanEstimates = useAppStore((state) => state.showDanEstimates);
  const canUseDanEstimates = useAuth().canUseDevFeatures;
  const canShowDanEstimates = canUseDanEstimates && showDanEstimates;
  const beatmapId = score.beatmap?.id;
  const keyCount = score.beatmap?.cs;
  const starRating = score.beatmap?.difficulty_rating;
  const rate = getScoreRate(score.mods);

  const estimate = useDanEstimate(
    canShowDanEstimates && keyCount === 4 ? beatmapId : undefined,
    starRating,
    rate,
  );

  if (!canShowDanEstimates || !estimate) return null;

  return <DanBadgeInner estimate={estimate} />;
}

export function DanBadgeFromEstimate({ estimate }: { estimate: LeanDanEstimate }) {
  return <DanBadgeInner estimate={estimate} />;
}
