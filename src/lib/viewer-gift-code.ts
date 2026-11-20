import { useEffect, useState } from "react";

import { fetchSupporterGiftCode, type SupporterGiftState } from "./supporter-look-settings";

/* The signed-in supporter's gift code state, asked once for everything on
   /supporter that reads it (the code panel and the count on its section's
   nav entry). Kept a few seconds, so two readers mounting together share one
   request and a later visit asks again. */

const TTL_MS = 10_000;
let last: { viewerId: number; at: number; promise: Promise<SupporterGiftState | null> } | null = null;

export function loadViewerGift(viewerId: number): Promise<SupporterGiftState | null> {
  if (last && last.viewerId === viewerId && Date.now() - last.at < TTL_MS) return last.promise;
  const promise = fetchSupporterGiftCode().catch(() => null);
  last = { viewerId, at: Date.now(), promise };
  return promise;
}

/** How many unused gift codes they hold: one at a time, so 0 or 1. */
export function useViewerGiftCodeCount(viewerId: number | null | undefined, enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled || viewerId == null) return;
    let alive = true;
    void loadViewerGift(viewerId).then((gift) => alive && setCount(gift?.code ? 1 : 0));
    return () => {
      alive = false;
    };
  }, [viewerId, enabled]);
  return enabled && viewerId != null ? count : 0;
}
