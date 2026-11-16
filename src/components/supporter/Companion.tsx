import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLingui } from "@lingui/react/macro";

import type { SupporterCompanion } from "../../lib/supporter-companions";
import type { CompanionScene } from "../../lib/companion-scene";
import { queueGpuWork } from "../../lib/gpu-queue";
import { useWebGlSlot } from "../../lib/gl-budget";
import { TungTungSahurKeycap } from "../player/TungTungSahurKeycap";

/* Draws a companion (lib/supporter-companions.ts): the keycap as its own
   pressable drawing, a model in a small 3D canvas that turns sideways when
   dragged, a still image. Each fills the box it is given. */

function ModelCompanion({ url, facing, matte, size = 1, spin, label }: { url: string; facing?: number; matte?: boolean; size?: number; spin?: number; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CompanionScene | null>(null);
  const modelRef = useRef({ url, facing, matte, spin });
  modelRef.current = { url, facing, matte, spin };
  const glSlot = useWebGlSlot(hostRef);
  // one canvas for as long as this stays a model; it waits for a quiet moment to start
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !glSlot) return;
    let cancelled = false;
    let unqueue: (() => void) | undefined;
    void import("../../lib/companion-scene").then(({ mountCompanionScene }) => {
      if (cancelled) return;
      unqueue = queueGpuWork(() => {
        if (cancelled) return;
        const { url: first, facing: turn, matte: flat, spin: turning } = modelRef.current;
        sceneRef.current = mountCompanionScene(host, first, { facing: turn, matte: flat, spin: turning });
      });
    });
    return () => {
      cancelled = true;
      unqueue?.();
      sceneRef.current?.dispose();
      sceneRef.current = null;
      shown.current = modelRef.current.url;
    };
  }, [glSlot]);
  // swapping the model keeps the canvas, its context and compiled shaders; the
  // old one stays up until the new one loads, so it keeps its own size till then
  const shown = useRef(url);
  const [shownSize, setShownSize] = useState(size);
  useEffect(() => {
    if (shown.current === url) return;
    shown.current = url;
    const scene = sceneRef.current;
    if (!scene) {
      setShownSize(size);
      return;
    }
    scene.setModel(url, { facing, matte, onShow: () => flushSync(() => setShownSize(size)) });
  }, [url, facing, matte, size]);
  // a taller one (supporter-companions.ts `size`) grows up and out of its box, standing on the same floor
  const grown = shownSize > 1 ? { width: `${shownSize * 100}%`, height: `${shownSize * 100}%` } : undefined;
  return <div ref={hostRef} role="img" aria-label={label} style={grown} className={grown ? "absolute bottom-0 left-1/2 -translate-x-1/2" : "relative h-full w-full"} />;
}

function ImageCompanion({ url, label }: { url: string; label: string }) {
  return (
    <img
      src={url}
      alt={label}
      draggable={false}
      className="h-full w-full select-none object-contain object-bottom drop-shadow-[0_8px_14px_rgba(0,0,0,0.4)]"
    />
  );
}

/** `spin` keeps a model turning on its own, in radians a second (negative turns it the other way). */
export function CompanionFigure({ companion, spin }: { companion: SupporterCompanion; spin?: number }) {
  const { i18n } = useLingui();
  if ("builtIn" in companion) {
    const entry = companion.builtIn;
    // its parts are placed for its own narrow box, so it keeps that shape
    if (entry.kind === "keycap") {
      return (
        <div className="mx-auto aspect-[9/16] h-full max-w-full">
          <TungTungSahurKeycap />
        </div>
      );
    }
    return <ModelCompanion url={entry.url!} facing={entry.facing} matte={entry.matte} size={entry.size} spin={spin} label={i18n._(entry.name)} />;
  }
  const entry = companion.submitted;
  return entry.kind === "model"
    ? <ModelCompanion url={entry.url} label={entry.name} />
    : <ImageCompanion url={entry.url} label={entry.name} />;
}

/* The box a companion takes beside a profile's numbers: the keycap's narrow
   one, or a wider one for a figure, standing on the rail with a soft shadow. */
export function ProfileCompanion({ companion }: { companion: SupporterCompanion }) {
  const keycap = "builtIn" in companion && companion.builtIn.kind === "keycap";
  return (
    <div
      className={`absolute right-0 bottom-full z-20 translate-y-1 sm:right-5 ${keycap ? "h-28 w-16 sm:h-32 sm:w-[4.5rem]" : "h-32 w-24 sm:h-36 sm:w-28"}`}
    >
      {!keycap && <span className="pointer-events-none absolute inset-x-4 bottom-0 h-3 rounded-full bg-black/35 blur-md" />}
      <CompanionFigure companion={companion} />
    </div>
  );
}

const KEYCAP_BASE = "/images/easter-eggs/tung-tung-sahur-keycap-base.webp";
const KEYCAP_TOP = "/images/easter-eggs/tung-tung-sahur-keycap-top.webp";
/* The top at rest as the live keycap places it (TungTungSahurKeycap: 3.25px
   left and 4px down in its 72x128 box), in shares of this box. */
const KEYCAP_TOP_CLASS = "absolute inset-x-0 bottom-[31.9%] mx-auto w-[78%] -translate-x-[5.8%] object-contain";

/* The keycap at rest, layered like the real one (a button): the top sits in
   the base, which covers it again below its rim, with the arm and the right
   edge drawn over that. */
function KeycapStill({ className }: { className?: string }) {
  return (
    <span className={`relative block ${className ?? ""}`}>
      <span className="absolute inset-y-0 left-1/2 aspect-[9/16] -translate-x-1/2">
        <img src={KEYCAP_BASE} alt="" draggable={false} className="absolute inset-x-0 bottom-0 mx-auto w-[61%] object-contain" />
        <img src={KEYCAP_TOP} alt="" draggable={false} className={KEYCAP_TOP_CLASS} />
        <img src={KEYCAP_BASE} alt="" draggable={false} className="absolute inset-x-0 bottom-0 mx-auto w-[61%] object-contain" style={{ clipPath: "inset(12% 0 0 0)" }} />
        <img src={KEYCAP_TOP} alt="" draggable={false} className={KEYCAP_TOP_CLASS} style={{ clipPath: "inset(0 70% 0 0)" }} />
        <img src={KEYCAP_TOP} alt="" draggable={false} className={KEYCAP_TOP_CLASS} style={{ clipPath: "inset(0 0 0 84%)" }} />
      </span>
    </span>
  );
}

/* A still of a companion for a list tile: the site's models have one
   rendered ahead of time; a submitted model is drawn once by a shared
   renderer, so a grid of them costs one WebGL context, and only once its tile
   is near the screen, one at a time. */
export function CompanionThumb({ companion, className }: { companion: SupporterCompanion; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const model = "submitted" in companion && companion.submitted.kind === "model" ? companion.submitted.url : null;
  useEffect(() => {
    const node = ref.current;
    if (!model || !node) return;
    let alive = true;
    let unqueue: (() => void) | undefined;
    setSrc(null);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      unqueue = queueGpuWork(() => {
        void import("../../lib/companion-scene")
          .then(({ companionThumbnail }) => companionThumbnail(model))
          .then((next) => {
            if (alive) setSrc(next);
          })
          .catch(() => {});
      });
    }, { rootMargin: "200px 0px" });
    observer.observe(node);
    return () => {
      alive = false;
      observer.disconnect();
      unqueue?.();
    };
  }, [model]);
  if ("builtIn" in companion) {
    const entry = companion.builtIn;
    if (entry.kind === "keycap") return <KeycapStill className={className} />;
    return <img src={entry.thumb} alt="" draggable={false} loading="lazy" className={`object-contain ${className ?? ""}`} />;
  }
  const still = model ? src : companion.submitted.url;
  return still ? <img src={still} alt="" draggable={false} className={`object-contain ${className ?? ""}`} /> : <span ref={ref} className={className} />;
}
