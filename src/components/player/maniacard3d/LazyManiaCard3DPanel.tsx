import { lazy, Suspense } from "react";
import type { ManiaCardPanelProps } from "./types";

const loadPanel = () => import("./ManiaCard3DPanel");
const Panel = lazy(() => loadPanel().then((module) => ({ default: module.ManiaCard3DPanel })));

export function preloadManiaCard3DPanel(): void {
  void loadPanel().catch(() => {});
}

export function ManiaCard3DPanel(props: ManiaCardPanelProps) {
  return (
    <Suspense fallback={
      <div className="py-4 sm:py-6" aria-busy="true">
        <div className="mx-auto w-full max-w-[440px] px-2">
          <div className="rounded-[22px] border-2 border-osu-b3/30 bg-osu-b4/40 animate-pulse" style={{ aspectRatio: "5 / 7" }} />
        </div>
      </div>
    }>
      <Panel {...props} />
    </Suspense>
  );
}
