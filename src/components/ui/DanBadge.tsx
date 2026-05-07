import { useEffect, useState } from "react";
import { useAppStore } from "#/store";
import type { LeanDanEstimate, LeanTrackerScore, OsuScore } from "#/lib/types";
import { getDanEstimates } from "#/lib/osu";
import { getScoreRate } from "#/lib/score";

// ── Batched fetcher ────────────────────────────────────────────────────────────

type Listener = () => void;

interface PendingRequest {
  beatmapId: number;
  starRating?: number;
  rate: number;
}

const cache = new Map<string, LeanDanEstimate | null>();
const pending = new Map<string, PendingRequest>();
const listeners = new Set<Listener>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function estimateKey(beatmapId: number, rate: number): string {
  const r = Math.round(rate * 100);
  return r === 100 ? String(beatmapId) : `${beatmapId}:${r}`;
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
    const results = await getDanEstimates({
      data: {
        items: batch.map((r) => ({
          beatmapId: r.beatmapId,
          starRating: r.starRating,
          rate: r.rate !== 1 ? r.rate : undefined,
        })),
      },
    });

    const typed = results as Record<string, LeanDanEstimate | null>;
    for (const [key, value] of Object.entries(typed)) {
      cache.set(key, value);
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

const DAN_IMAGE_EXTENSIONS: Record<string, "png" | "svg"> = {
  "1": "svg", "2": "svg", "3": "svg", "4": "svg", "5": "svg",
  "6": "svg", "7": "svg", "8": "svg", "9": "svg", "10": "svg",
  alpha: "png", beta: "png", gamma: "png", delta: "png",
  epsilon: "png", zeta: "png", eta: "png",
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
  const beatmapId = score.beatmap?.id;
  const keyCount = score.beatmap?.cs;
  const starRating = score.beatmap?.difficulty_rating;
  const rate = getScoreRate(score.mods);

  const estimate = useDanEstimate(
    showDanEstimates && keyCount === 4 ? beatmapId : undefined,
    starRating,
    rate,
  );

  if (!showDanEstimates || !estimate) return null;

  return <DanBadgeInner estimate={estimate} />;
}

export function DanBadgeFromEstimate({ estimate }: { estimate: LeanDanEstimate }) {
  return <DanBadgeInner estimate={estimate} />;
}
