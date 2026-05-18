import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { MANIA_TIER_STYLES, type NextManiaCardTier } from "#/lib/maniacard";
import { ManiaCardRenderer } from "./ManiaCardRenderer";
import { buildManiaCardRenderData } from "./renderData";
import type { ManiaCardPanelProps } from "./types";

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

const TIER_TEXT_COLOR: Record<string, string> = {
  common: "text-slate-200",
  rare: "text-sky-200",
  elite: "text-violet-200",
  superRare: "text-fuchsia-200",
  ultraRare: "text-rose-200",
  legendary: "text-yellow-100",
  mythic: "text-red-200",
  ascendant: "text-white",
  worldClass: "text-emerald-200",
};

const TIER_FILL_COLOR: Record<string, string> = {
  common: "rgb(148, 163, 184)",
  rare: "rgb(56, 189, 248)",
  elite: "rgb(167, 139, 250)",
  superRare: "rgb(232, 121, 249)",
  ultraRare: "rgb(251, 113, 133)",
  legendary: "rgb(251, 191, 36)",
  mythic: "rgb(248, 113, 113)",
  ascendant: "rgb(226, 232, 240)",
  worldClass: "rgb(110, 231, 183)",
};

export function ManiaCard3DPanel({ user, scores, loading }: ManiaCardPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ManiaCardRenderer | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [readyData, setReadyData] = useState<ReturnType<typeof buildManiaCardRenderData> | null>(null);
  const [ratingModalOpen, setRatingModalOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const data = useMemo(() => buildManiaCardRenderData({ user, scores }), [user, scores]);
  const rendererReady = readyData === data;

  useEffect(() => {
    if (!ratingModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRatingModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ratingModalOpen]);

  useEffect(() => {
    setReadyData(null);
    if (loading || data.status !== "ready") return;
    const host = hostRef.current;
    if (!host) return;

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
    };

    const cleanup = () => {
      active = false;
      cancelScheduledStart();
      disposeRenderer();
    };

    cancelScheduledStart = scheduleRendererStart(() => {
      if (!active) return;

      try {
        renderer = new ManiaCardRenderer({
          host,
          data,
          mobile: isMobileViewport(),
          reducedMotion,
          devicePixelRatio: getDevicePixelRatio(),
          onReady: () => {
            if (active) setReadyData(data);
          },
          onError: (error) => {
            if (!active) return;
            disposeRenderer();
            setRenderError(error instanceof Error ? error.message : "3D renderer unavailable.");
          },
        });
        rendererRef.current = renderer;

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
  }, [data, loading, reducedMotion]);

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
        {rendererReady && data.nextTier && (
          <TierProgress
            nextTier={data.nextTier}
            cardRating={data.skills.cardPower}
            onExplain={() => setRatingModalOpen(true)}
          />
        )}
      </div>
      <AnimatePresence>
        {ratingModalOpen && data.nextTier && (
          <RatingExplainerModal
            nextTier={data.nextTier}
            cardRating={data.skills.cardPower}
            onClose={() => setRatingModalOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function TierProgress({
  nextTier,
  cardRating,
  onExplain,
}: {
  nextTier: NextManiaCardTier;
  cardRating: number;
  onExplain: () => void;
}) {
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
        aria-label={`Progress from ${currentLabel} to ${nextTier.label}`}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.max(2, pct)}%`, backgroundColor: toColor }}
        />
      </div>
      <div className="mt-2 flex items-baseline gap-1.5 text-[11px]">
        <span className="font-bold tabular-nums" style={{ color: toColor }}>+{nextTier.remaining}</span>
        <span className="text-osu-f1">to</span>
        <span className={`font-semibold ${TIER_TEXT_COLOR[nextTier.tier] ?? "text-osu-l2"}`}>{nextTier.label}</span>
        <button
          type="button"
          onClick={onExplain}
          className="ml-0.5 text-osu-f1/70 hover:text-osu-f1 cursor-pointer transition-colors"
          aria-label="How card rating is calculated"
        >
          (?)
        </button>
      </div>
    </div>
  );
}

type RatingTrait = { label: string; weight: number; inputs: string; onCard: boolean };

const RATING_TRAITS: RatingTrait[] = [
  { label: "Control", weight: 9, inputs: "stars, LN density, OD, combo retention", onCard: true },
  { label: "Speed", weight: 7, inputs: "effective BPM (after rate mods), rice density, stars", onCard: true },
  { label: "Precision", weight: 5, inputs: "accuracy curve, MAX/300 ratio, OD, misses", onCard: true },
  { label: "Stamina", weight: 7, inputs: "rate-adjusted length, total object count", onCard: false },
];

function StepNumber({ n }: { n: number }) {
  return (
    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-osu-b3/60 text-[11px] font-bold text-white tabular-nums">
      {n}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <StepNumber n={n} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-[13px] font-semibold text-white leading-tight">{title}</div>
        <div className="mt-1.5 text-[12px] text-osu-f1/85 leading-snug">{children}</div>
      </div>
    </div>
  );
}

function RatingExplainerModal({
  nextTier,
  cardRating,
  onClose,
}: {
  nextTier: NextManiaCardTier;
  cardRating: number;
  onClose: () => void;
}) {
  const toColor = TIER_FILL_COLOR[nextTier.tier] ?? "rgb(226, 232, 240)";

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer p-4"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="modal-card-mobile-safe relative isolate bg-osu-b4 border border-osu-b3/20 rounded-2xl w-[440px] max-w-full max-h-[85vh] overflow-hidden shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <div className="pointer-events-none absolute inset-0 bg-osu-b4" aria-hidden="true" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </button>
        <div className="relative z-10 max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
          <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">How your Maniacard works</div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white tabular-nums">{cardRating}</span>
            <span className="text-[11px] text-osu-f1">
              <span className="font-bold tabular-nums" style={{ color: toColor }}>+{nextTier.remaining}</span>{" "}
              <span className="text-osu-f1">to</span>{" "}
              <span className={`font-semibold ${TIER_TEXT_COLOR[nextTier.tier] ?? "text-osu-l2"}`}>{nextTier.label}</span>
            </span>
          </div>

          <div className="mt-5 space-y-4">
            <Step n={1} title="Your top 200 mania plays are pulled">
              Each play is weighted by{" "}
              <code className="text-osu-yellow font-mono text-[11px]">pp^0.72 × 0.965^rank</code>, so your best plays count most.
            </Step>

            <Step n={2} title="Each play gets scored on 4 traits">
              <div className="space-y-1.5">
                {RATING_TRAITS.map((t) => (
                  <div key={t.label} className="flex gap-2">
                    <span className="font-semibold text-white text-[12px] w-[68px] flex-shrink-0">{t.label}</span>
                    <span className="text-osu-f1/80 text-[11px] leading-snug">{t.inputs}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-osu-f1/70">Traits are normalized per keymode, so plays from different keymodes don't get compared on the same BPM and density scale.</p>
            </Step>

            <Step n={3} title="Three traits go on the card front">
              <span className="font-semibold text-white">Control</span>, <span className="font-semibold text-white">Speed</span>, and <span className="font-semibold text-white">Precision</span> are shown as the card's signature stats. Stamina still feeds the rating below, but isn't displayed.
              <p className="mt-2 text-[11px] text-osu-f1/70">
                The front stats keep your trait spread, then use the same rating budget as the tier progress so card numbers and rarity move together.
              </p>
            </Step>

            <Step n={4} title="Rating = PP + skill traits">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-osu-yellow font-semibold tabular-nums text-[12px] w-9">72%</span>
                  <span>Total PP (39%) + top-play strength (33%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-osu-yellow font-semibold tabular-nums text-[12px] w-9">28%</span>
                  <span>Control (9%) + Stamina (7%) + Speed (7%) + Precision (5%)</span>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-osu-f1/70">This number determines your tier.</p>
            </Step>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function ManiaCard3DFallback() {
  return (
    <div className="py-4 sm:py-6">
      <div className="max-w-[440px] mx-auto px-2">
        <div
          className="relative grid place-items-center rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40 px-6 text-center text-sm text-osu-f1"
          style={{ aspectRatio: "5 / 7" }}
        >
          3D card preview is unavailable on this device.
        </div>
      </div>
    </div>
  );
}

function ManiaCard3DLoading() {
  return (
    <div className="py-4 sm:py-6">
      <div className="max-w-[440px] mx-auto px-2">
        <div
          className="relative rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40"
          style={{ aspectRatio: "5 / 7" }}
        >
          <div className="absolute inset-0 rounded-[22px] animate-pulse" />
        </div>
        <div className="mt-4 text-center text-[11px] text-osu-f1">Calculating skills...</div>
      </div>
    </div>
  );
}
