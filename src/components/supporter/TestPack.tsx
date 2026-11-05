import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

import type { SupporterBladeId, SupporterWrapperId } from "../../lib/supporter-pack-style";

/* A pack to try the wrapper and the blade on, in the /supporter stage: the
   real 3D pack the packs page deals, printed on the wrapper on show and cut
   with the blade on show. Opening it opens nothing; a fresh one drops in
   after each. The pack scene loads only when this is first shown. */

const PackStage = lazy(() => import("../packs/PackStage").then((module) => ({ default: module.PackStage })));

export function TestPack({ wrapper, blade }: { wrapper: SupporterWrapperId | null; blade: SupporterBladeId | null }) {
  const { t } = useLingui();
  const reduced = useReducedMotion() ?? false;
  const [round, setRound] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return (
    <div className="flex w-full select-none flex-col items-center py-2">
      <Suspense fallback={<div className="aspect-[3/5] w-[min(220px,56vw)] animate-pulse rounded-xl bg-white/[0.04]" />}>
        <PackStage
          key={round}
          wrapper={wrapper}
          blade={blade}
          reducedMotion={reduced}
          onOpened={() => {
            timer.current = window.setTimeout(() => setRound((n) => n + 1), 650);
          }}
        />
      </Suspense>
      <p className="mt-1 text-center text-[11px] text-osu-f1">{t`A test pack: nothing is spent, open as many as you like.`}</p>
    </div>
  );
}
