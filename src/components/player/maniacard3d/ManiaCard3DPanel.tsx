import { useEffect, useMemo, useRef, useState } from "react";
import { ManiaCardRenderer } from "./ManiaCardRenderer";
import { buildManiaCardRenderData } from "./renderData";
import type { ManiaCardPanelProps } from "./types";

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
}

export function ManiaCard3DPanel({ user, scores, loading }: ManiaCardPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ManiaCardRenderer | null>(null);
  const reducedMotion = useReducedMotion();
  const data = useMemo(() => buildManiaCardRenderData({ user, scores }), [user, scores]);

  useEffect(() => {
    if (loading || data.status !== "ready") return;
    const host = hostRef.current;
    if (!host) return;

    const renderer = new ManiaCardRenderer({
      host,
      data,
      mobile: isMobileViewport(),
      reducedMotion,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    rendererRef.current = renderer;

    const resize = new ResizeObserver(() => renderer.resize());
    resize.observe(host);
    renderer.resize();

    return () => {
      resize.disconnect();
      renderer.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [data, loading, reducedMotion]);

  if (loading) return <ManiaCard3DLoading />;

  if (data.status === "empty") {
    return (
      <div className="max-w-[640px] mx-auto py-12 text-center text-sm text-osu-f1">
        {data.message}
      </div>
    );
  }

  return (
    <div className="py-4 sm:py-6">
      <div className="mx-auto w-full max-w-[440px] px-2">
        <div
          ref={hostRef}
          className="relative w-full overflow-visible"
          style={{ aspectRatio: "5 / 7" }}
          aria-label={`${data.user.username} ${data.tierStyle.label} Maniacard. Control ${data.skills.fingerControl}, Speed ${data.skills.speed}, Precision ${data.skills.accuracy}.`}
        />
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
