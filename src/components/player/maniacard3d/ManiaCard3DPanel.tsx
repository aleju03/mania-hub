import { useLingui } from "@lingui/react/macro";
import { AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MANIA_TIER_STYLES,
  type NextManiaCardTier,
} from "#/lib/maniacard";
import { RatingExplainerModal, TIER_FILL_COLOR, TIER_TEXT_COLOR } from "./RatingExplainerModal";
import { ManiaCardRenderer } from "./ManiaCardRenderer";
import {
  buildManiaCardRenderData,
  buildManiaCardRenderDataFromSkills,
  getManiaCardRenderDataSignature,
} from "./renderData";
import type { ManiaCardPanelProps, ManiaCardReadyData } from "./types";
import { isWindowActive, subscribeWindowActivity } from "#/lib/window-activity";

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  return reduced;
}

function isMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 640px)").matches
  );
}

function getDevicePixelRatio() {
  return typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
}

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const RENDER_START_DELAY_MS = 120;
const RENDER_IDLE_TIMEOUT_MS = 500;

function scheduleRendererStart(callback: () => void) {
  if (typeof window === "undefined") {
    callback();
    return () => {};
  }

  const idleWindow = window as WindowWithIdleCallback;
  let active = true;
  let frameId: number | null = null;
  let timeoutId: number | null = null;
  let idleId: number | null = null;

  frameId = window.requestAnimationFrame(() => {
    frameId = null;
    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      if (!active) return;

      if (idleWindow.requestIdleCallback) {
        idleId = idleWindow.requestIdleCallback(() => {
          idleId = null;
          if (active) callback();
        }, { timeout: RENDER_IDLE_TIMEOUT_MS });
        return;
      }

      callback();
    }, RENDER_START_DELAY_MS);
  });

  return () => {
    active = false;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
  };
}

export function ManiaCard3DPanel({
  user,
  scores,
  precomputedSkills,
  loading,
  isOwnProfile = false,
  tierOverride,
  team,
}: ManiaCardPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ManiaCardRenderer | null>(null);
  const latestReadyDataRef = useRef<ManiaCardReadyData | null>(null);
  const latestReadySignatureRef = useRef<string | null>(null);
  const rendererSignatureRef = useRef<string | null>(null);
  const pendingSignatureRef = useRef<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [readySignature, setReadySignature] = useState<string | null>(null);
  const [ratingModalOpen, setRatingModalOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const data = useMemo(
    () => precomputedSkills
      ? buildManiaCardRenderDataFromSkills({ user, skills: precomputedSkills, scores, tierOverride, team })
      : buildManiaCardRenderData({ user, scores, tierOverride }),
    [precomputedSkills, scores, team, tierOverride, user],
  );
  const dataSignature = useMemo(() => getManiaCardRenderDataSignature(data), [data]);
  const rendererReady = readySignature === dataSignature;

  useEffect(() => {
    if (data.status === "ready") {
      latestReadyDataRef.current = data;
      latestReadySignatureRef.current = dataSignature;
      return;
    }

    latestReadyDataRef.current = null;
    latestReadySignatureRef.current = null;
  }, [data, dataSignature]);

  useEffect(() => {
    setReadySignature(null);
    if (loading || data.status !== "ready") return;
    const host = hostRef.current;
    const initialData = latestReadyDataRef.current;
    const initialSignature = latestReadySignatureRef.current;
    if (!host || !initialData || !initialSignature) return;

    setRenderError(null);

    let renderer: ManiaCardRenderer | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let removeResizeFallback = () => {};
    let cancelScheduledStart = () => {};
    let active = true;

    const disposeRenderer = () => {
      resizeObserver?.disconnect();
      removeResizeFallback();
      renderer?.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
      rendererSignatureRef.current = null;
      pendingSignatureRef.current = null;
    };

    const cleanup = () => {
      active = false;
      cancelScheduledStart();
      disposeRenderer();
    };

    cancelScheduledStart = scheduleRendererStart(() => {
      if (!active) return;

      try {
        const scheduledData = latestReadyDataRef.current;
        const scheduledSignature = latestReadySignatureRef.current;
        if (!scheduledData || !scheduledSignature) return;

        pendingSignatureRef.current = scheduledSignature;
        rendererSignatureRef.current = scheduledSignature;
        renderer = new ManiaCardRenderer({
          host,
          data: scheduledData,
          mobile: isMobileViewport(),
          reducedMotion,
          devicePixelRatio: getDevicePixelRatio(),
          onReady: () => {
            if (active) setReadySignature(pendingSignatureRef.current);
          },
          onError: (error) => {
            if (!active) return;
            disposeRenderer();
            setRenderError(error instanceof Error ? error.message : "3D renderer unavailable.");
          },
        });
        rendererRef.current = renderer;
        renderer.setWindowActive(isWindowActive());

        const resize = () => renderer?.resize();
        if (typeof ResizeObserver === "function") {
          resizeObserver = new ResizeObserver(resize);
          resizeObserver.observe(host);
        } else if (typeof window !== "undefined") {
          window.addEventListener("resize", resize);
          removeResizeFallback = () => window.removeEventListener("resize", resize);
        }
        renderer.resize();
      } catch (error) {
        cleanup();
        setRenderError(error instanceof Error ? error.message : "3D renderer unavailable.");
      }
    });

    return cleanup;
  }, [data.status, loading, reducedMotion]);

  useEffect(() => {
    const apply = () => rendererRef.current?.setWindowActive(isWindowActive());
    apply();
    return subscribeWindowActivity(apply);
  }, []);

  useEffect(() => {
    if (loading || data.status !== "ready") {
      setReadySignature(null);
      return;
    }

    const renderer = rendererRef.current;
    if (!renderer || rendererSignatureRef.current === dataSignature) return;

    setRenderError(null);
    setReadySignature(null);
    pendingSignatureRef.current = dataSignature;
    rendererSignatureRef.current = dataSignature;
    void renderer.setData(data);
  }, [data, dataSignature, loading]);

  if (loading) return <ManiaCard3DLoading />;

  if (data.status === "empty") {
    return (
      <div className="max-w-[640px] mx-auto py-12 text-center text-sm text-osu-f1">
        {data.message}
      </div>
    );
  }

  if (renderError) return <ManiaCard3DFallback />;

  return (
    <div className="py-4 sm:py-6">
      <div className="mx-auto w-full max-w-[440px] px-2 relative">
        <div
          ref={hostRef}
          role="img"
          className="relative w-full overflow-visible"
          style={{ aspectRatio: "5 / 7", touchAction: "none" }}
          aria-label={`${data.user.username} ${data.tierStyle.label} Maniacard. Control ${data.skills.fingerControl}, Speed ${data.skills.speed}, Precision ${data.skills.accuracy}.`}
        />
        {!rendererReady && (
          <div
            className="pointer-events-none absolute inset-2 rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40 animate-pulse"
            aria-hidden="true"
          />
        )}
        {rendererReady && (
          <TierProgress
            nextTier={data.nextTier}
            cardRating={data.skills.cardPower}
            tierLabel={data.tierStyle.label}
            onExplain={() => setRatingModalOpen(true)}
          />
        )}
      </div>
      <AnimatePresence>
        {ratingModalOpen && (
          <RatingExplainerModal
            key={user.id}
            userId={user.id}
            nextTier={data.nextTier}
            cardRating={data.skills.cardPower}
            isOwnProfile={isOwnProfile}
            onClose={() => setRatingModalOpen(false)}
            team={team != null}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function TierProgress({
  nextTier,
  cardRating,
  tierLabel,
  onExplain,
}: {
  nextTier: NextManiaCardTier | null;
  cardRating: number;
  tierLabel: string;
  onExplain?: () => void;
}) {
  const { t } = useLingui();
  if (!nextTier) return (
    <div className="mt-4 sm:mt-0 sm:absolute sm:top-1/2 sm:left-full sm:ml-6 sm:-translate-y-1/2 sm:w-[180px]">
      <span className="text-2xl font-bold tabular-nums text-white">{cardRating}</span>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-osu-f1">
        <span>{tierLabel}</span>
        {onExplain ? (
          <button type="button" onClick={onExplain} aria-label={t`How card rating is calculated`} className="cursor-pointer text-osu-f1/70 transition-colors hover:text-osu-f1">(?)</button>
        ) : null}
      </div>
    </div>
  );
  const toColor = TIER_FILL_COLOR[nextTier.tier] ?? "rgb(226, 232, 240)";
  const pct = Math.round(nextTier.progress * 100);
  const currentLabel = MANIA_TIER_STYLES[nextTier.currentTier].label;

  return (
    <div className="mt-4 sm:mt-0 sm:absolute sm:top-1/2 sm:left-full sm:ml-6 sm:-translate-y-1/2 sm:w-[180px]">
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold text-white tabular-nums">{cardRating}</span>
        <span className="text-xs text-osu-f1 tabular-nums">/ {nextTier.threshold}</span>
      </div>
      <div
        className="mt-2 h-1 rounded-full bg-osu-b3/40 overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t`Progress from ${currentLabel} to ${nextTier.label}`}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.max(2, pct)}%`, backgroundColor: toColor }}
        />
      </div>
      <div className="mt-2 flex items-baseline gap-1.5 text-[11px]">
        <span className="font-bold tabular-nums" style={{ color: toColor }}>+{nextTier.remaining}</span>
        <span className="text-osu-f1">{t`to`}</span>
        <span className={`font-semibold ${TIER_TEXT_COLOR[nextTier.tier] ?? "text-osu-l2"}`}>{nextTier.label}</span>
        {onExplain ? (
          <button
            type="button"
            onClick={onExplain}
            className="ml-0.5 text-osu-f1/70 hover:text-osu-f1 cursor-pointer transition-colors"
            aria-label={t`How card rating is calculated`}
          >
            (?)
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ManiaCard3DFallback() {
  const { t } = useLingui();
  return (
    <div className="py-4 sm:py-6">
      <div className="max-w-[440px] mx-auto px-2">
        <div
          className="relative grid place-items-center rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40 px-6 text-center text-sm text-osu-f1"
          style={{ aspectRatio: "5 / 7" }}
        >
          {t`3D card preview is unavailable on this device.`}
        </div>
      </div>
    </div>
  );
}

function ManiaCard3DLoading() {
  const { t } = useLingui();
  return (
    <div className="py-4 sm:py-6">
      <div className="max-w-[440px] mx-auto px-2">
        <div
          className="relative rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40"
          style={{ aspectRatio: "5 / 7" }}
        >
          <div className="absolute inset-0 rounded-[22px] animate-pulse" />
        </div>
        <div className="mt-4 text-center text-[11px] text-osu-f1">{t`Calculating skills...`}</div>
      </div>
    </div>
  );
}
