import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
  fetchBeatmapFile,
  getPersistentCached,
  setPersistentCache
} from "../api";
import { estimateDan } from "../dan-estimator";
import { DAN_ESTIMATE_CACHE_VERSION } from "../dan-estimator/cache-version";
import { parseCachedManiaBeatmap } from "../parsed-beatmap-cache";
import type { LeanDanEstimate } from "../types";
import { edgeCache } from "./server";
import { asInputRecord } from "./validators";
import { mapWithConcurrency } from "./concurrency";

// ── Dan Estimates ──────────────────────────────────────────────────────────────

const DAN_ESTIMATE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const DAN_ESTIMATE_CONCURRENCY = 6;

function danCacheKey(beatmapId: number, rate: number): string {
  const r = Math.round(rate * 100);
  return r === 100
    ? `dan:v${DAN_ESTIMATE_CACHE_VERSION}:${beatmapId}`
    : `dan:v${DAN_ESTIMATE_CACHE_VERSION}:${beatmapId}:r${r}`;
}

interface DanEstimateRequest {
  beatmapId: number;
  starRating?: number;
  rate?: number;
}

async function computeDanEstimate(
  req: DanEstimateRequest,
): Promise<LeanDanEstimate | null> {
  const rate = req.rate ?? 1;
  const key = danCacheKey(req.beatmapId, rate);
  const cached = await getPersistentCached<LeanDanEstimate>(key);
  if (cached) return cached;

  try {
    const osuFile = await fetchBeatmapFile(req.beatmapId);
    const map = parseCachedManiaBeatmap(req.beatmapId, osuFile);
    if (map.keyCount !== 4) return null;

    const estimate = estimateDan(map, {
      starRating: req.starRating,
      rate: rate !== 1 ? rate : undefined,
    });

    const lean: LeanDanEstimate = {
      label: estimate.label,
      variant: estimate.variant,
      displayName: estimate.displayName,
      rawDan: estimate.rawDan,
      family: estimate.family,
      confidence: estimate.confidence,
      estimatorVersion: DAN_ESTIMATE_CACHE_VERSION,
    };

    await setPersistentCache(key, lean, DAN_ESTIMATE_CACHE_TTL);
    return lean;
  } catch {
    return null;
  }
}

export const getDanEstimates = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { items?: unknown[]; estimatorVersion?: unknown }): { items: DanEstimateRequest[]; estimatorVersion: number } => {
      const raw = asInputRecord(input);
      const items = Array.isArray(raw.items) ? raw.items : [];
      return {
        estimatorVersion: Number(raw.estimatorVersion) || DAN_ESTIMATE_CACHE_VERSION,
        items: items.map((item: any) => ({
          beatmapId: Number(item.beatmapId),
          starRating: item.starRating != null ? Number(item.starRating) : undefined,
          rate: item.rate != null ? Number(item.rate) : undefined,
        })),
      };
    },
  )
  .handler(
    async ({
      data,
    }: {
      data: { items: DanEstimateRequest[]; estimatorVersion: number };
    }): Promise<Record<string, LeanDanEstimate | null>> => {
      const { readCurrentAuth } = await import("../auth-server");
      const auth = await readCurrentAuth();
      const allowed = auth.canUseDevFeatures;

      if (allowed) edgeCache(3600, 86400);
      else setResponseHeader("Cache-Control", "private, no-store");

      const results: Record<string, LeanDanEstimate | null> = {};
      if (!allowed) {
        for (const req of data.items) {
          const rate = req.rate ?? 1;
          const key = rate === 1
            ? String(req.beatmapId)
            : `${req.beatmapId}:${Math.round(rate * 100)}`;
          results[key] = null;
        }
        return results;
      }

      await mapWithConcurrency(data.items, DAN_ESTIMATE_CONCURRENCY, async (req) => {
        const rate = req.rate ?? 1;
        const key = rate === 1
          ? String(req.beatmapId)
          : `${req.beatmapId}:${Math.round(rate * 100)}`;
        results[key] = await computeDanEstimate(req);
      });

      return results;
    },
  );
