import { useEffect, useMemo, useRef, useState } from "react";
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

export function ManiaCard3DPanel({ user, scores, loading }: ManiaCardPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ManiaCardRenderer | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const data = useMemo(() => buildManiaCardRenderData({ user, scores }), [user, scores]);

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
      <div className="mx-auto w-full max-w-[440px] px-2">
        <div
          ref={hostRef}
          role="img"
          className="relative w-full overflow-visible"
          style={{ aspectRatio: "5 / 7", touchAction: "none" }}
          aria-label={`${data.user.username} ${data.tierStyle.label} Maniacard. Control ${data.skills.fingerControl}, Speed ${data.skills.speed}, Precision ${data.skills.accuracy}.`}
        />
      </div>
    </div>
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
