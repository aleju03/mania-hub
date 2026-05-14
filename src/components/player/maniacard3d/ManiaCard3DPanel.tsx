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
  const [ratingModalOpen, setRatingModalOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const data = useMemo(() => buildManiaCardRenderData({ user, scores }), [user, scores]);

  useEffect(() => {
    if (!ratingModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRatingModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ratingModalOpen]);

  useEffect(() => {
    if (loading || data.status !== "ready") return;
    const host = hostRef.current;
    if (!host) return;

    setRenderError(null);

    let renderer: ManiaCardRenderer | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let removeResizeFallback = () => {};
    let active = true;

    const disposeRenderer = () => {
      resizeObserver?.disconnect();
      removeResizeFallback();
      renderer?.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };

    const cleanup = () => {
      active = false;
      disposeRenderer();
    };

    try {
      renderer = new ManiaCardRenderer({
        host,
        data,
        mobile: isMobileViewport(),
        reducedMotion,
        devicePixelRatio: getDevicePixelRatio(),
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
      return;
    }

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
        {data.nextTier && (
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
      <button
        type="button"
        onClick={onExplain}
        className="mt-2 flex items-baseline gap-1.5 text-[11px] cursor-pointer hover:opacity-80 transition-opacity"
        aria-label="How card rating is calculated"
      >
        <span className="font-bold tabular-nums" style={{ color: toColor }}>+{nextTier.remaining}</span>
        <span className="text-osu-f1">to</span>
        <span className={`font-semibold ${TIER_TEXT_COLOR[nextTier.tier] ?? "text-osu-l2"}`}>{nextTier.label}</span>
        <span className="text-osu-f1/70 ml-0.5">(?)</span>
      </button>
    </div>
  );
}

type RatingContributor = { label: string; weight: number; sub: string };

const RATING_PP_CONTRIBUTORS: RatingContributor[] = [
  { label: "Total PP", weight: 39, sub: "your overall mania PP number" },
  { label: "Top-play strength", weight: 33, sub: "weighted PP across your top 200, higher plays count more" },
];

const RATING_SKILL_CONTRIBUTORS: RatingContributor[] = [
  { label: "Control", weight: 9, sub: "hard charts, LN density, OD, combo, accuracy" },
  { label: "Stamina", weight: 7, sub: "map length and object count" },
  { label: "Speed", weight: 7, sub: "BPM, rice density, stars" },
  { label: "Precision", weight: 5, sub: "accuracy, OD, MAX ratio, misses, difficulty" },
];

const RATING_MAX_WEIGHT = RATING_PP_CONTRIBUTORS[0].weight;

function ContributorRow({ contributor }: { contributor: RatingContributor }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-[110px] flex-shrink-0">
        <div className="text-[12px] font-semibold text-white leading-tight">{contributor.label}</div>
        <div className="text-[10px] text-osu-f1/70 leading-tight">{contributor.sub}</div>
      </div>
      <div className="flex-1 h-1.5 rounded-full bg-osu-b3/40 overflow-hidden">
        <div
          className="h-full rounded-full bg-osu-yellow"
          style={{ width: `${(contributor.weight / RATING_MAX_WEIGHT) * 100}%` }}
        />
      </div>
      <span className="text-[11px] text-osu-f1 tabular-nums w-9 text-right">{contributor.weight}%</span>
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
          <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">Card Rating</div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white tabular-nums">{cardRating}</span>
            <span className="text-[11px] text-osu-f1">
              <span className="font-bold tabular-nums" style={{ color: toColor }}>+{nextTier.remaining}</span>{" "}
              <span className="text-osu-f1">to</span>{" "}
              <span className={`font-semibold ${TIER_TEXT_COLOR[nextTier.tier] ?? "text-osu-l2"}`}>{nextTier.label}</span>
            </span>
          </div>
          <p className="mt-3 text-[12px] text-osu-l2 leading-snug">
            Rating is mostly driven by PP, with skill traits from your top plays fine-tuning the rest.
          </p>

          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">From your PP (72%)</div>
            <div className="space-y-2">
              {RATING_PP_CONTRIBUTORS.map((c) => (
                <ContributorRow key={c.label} contributor={c} />
              ))}
            </div>
          </div>

          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold mb-1">Skill traits (28%)</div>
            <div className="text-[11px] text-osu-f1/80 mb-2 leading-snug">
              Derived from your top plays. Control, Speed, and Precision are the three stats shown on the card front.
            </div>
            <div className="space-y-2">
              {RATING_SKILL_CONTRIBUTORS.map((c) => (
                <ContributorRow key={c.label} contributor={c} />
              ))}
            </div>
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
