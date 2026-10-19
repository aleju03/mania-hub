import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";

import type { SupporterCompanion } from "../../lib/supporter-companions";
import { TungTungSahurKeycap } from "../player/TungTungSahurKeycap";

/* Draws a companion (lib/supporter-companions.ts): the keycap as its own
   pressable drawing, a model in a small 3D canvas that turns sideways when
   dragged, an image with a slow bob. Each fills the box it is given. */

function ModelCompanion({ url, facing, matte, label }: { url: string; facing?: number; matte?: boolean; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let scene: { dispose(): void } | undefined;
    void import("../../lib/companion-scene").then(({ mountCompanionScene }) => {
      if (!cancelled) scene = mountCompanionScene(host, url, { facing, matte });
    });
    return () => {
      cancelled = true;
      scene?.dispose();
    };
  }, [url, facing, matte]);
  return <div ref={hostRef} role="img" aria-label={label} className="relative h-full w-full" />;
}

function ImageCompanion({ url, label }: { url: string; label: string }) {
  return (
    <img
      src={url}
      alt={label}
      draggable={false}
      className="companion-bob h-full w-full select-none object-contain object-bottom drop-shadow-[0_8px_14px_rgba(0,0,0,0.4)]"
    />
  );
}

export function CompanionFigure({ companion }: { companion: SupporterCompanion }) {
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
    return <ModelCompanion url={entry.url!} facing={entry.facing} matte={entry.matte} label={i18n._(entry.name)} />;
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
      className={`absolute right-3 bottom-full z-20 translate-y-1 sm:right-5 ${keycap ? "h-28 w-16 sm:h-32 sm:w-[4.5rem]" : "h-32 w-24 sm:h-36 sm:w-28"}`}
    >
      {!keycap && <span className="pointer-events-none absolute inset-x-4 bottom-0 h-3 rounded-full bg-black/35 blur-md" />}
      <CompanionFigure companion={companion} />
    </div>
  );
}

/* The keycap at rest, both halves, for a tile (the real one is a button). */
function KeycapStill({ className }: { className?: string }) {
  return (
    <span className={`relative block ${className ?? ""}`}>
      <span className="absolute inset-y-0 left-1/2 aspect-[9/16] -translate-x-1/2">
        <img src="/images/easter-eggs/tung-tung-sahur-keycap-base.webp" alt="" className="absolute inset-x-0 bottom-0 mx-auto w-[61%] object-contain" />
        <img src="/images/easter-eggs/tung-tung-sahur-keycap-top.webp" alt="" className="absolute inset-x-0 bottom-[38%] mx-auto w-[78%] -translate-x-[3%] object-contain" />
      </span>
    </span>
  );
}

/* A still of a companion for a list tile: models are drawn once by a shared
   renderer, so a grid of them costs one WebGL context. */
export function CompanionThumb({ companion, className }: { companion: SupporterCompanion; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const model = "builtIn" in companion
    ? (companion.builtIn.kind === "model" ? { url: companion.builtIn.url!, facing: companion.builtIn.facing ?? 0, matte: !!companion.builtIn.matte } : null)
    : (companion.submitted.kind === "model" ? { url: companion.submitted.url, facing: 0, matte: false } : null);
  const modelUrl = model?.url;
  const modelFacing = model?.facing ?? 0;
  const modelMatte = model?.matte ?? false;
  useEffect(() => {
    if (!modelUrl) return;
    let alive = true;
    setSrc(null);
    void import("../../lib/companion-scene")
      .then(({ companionThumbnail }) => companionThumbnail(modelUrl, modelFacing, modelMatte))
      .then((next) => {
        if (alive) setSrc(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [modelUrl, modelFacing, modelMatte]);
  if ("builtIn" in companion && companion.builtIn.kind === "keycap") return <KeycapStill className={className} />;
  const still = model ? src : "submitted" in companion ? companion.submitted.url : null;
  return still ? <img src={still} alt="" draggable={false} className={`object-contain ${className ?? ""}`} /> : <span className={className} />;
}
