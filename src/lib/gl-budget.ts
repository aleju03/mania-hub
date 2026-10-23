import { useEffect, useRef, useState, type RefObject } from "react";

/* Browsers keep only so many WebGL contexts alive per page (16 on desktop
   Chrome, 8 on Android) and past that silently kill the oldest, which then
   stays black or shows Chrome's sad face. A long page of live cosmetics (the
   support page: a 3D card, a gift ticket, theme backdrops, companions, name
   tags, blade swatches) goes past 8 on a phone just by scrolling. So each
   component that owns a context asks for a slot here and draws only while it
   holds one: a slot goes to a component near the screen, and when none is
   free the one that left the screen longest ago gives its slot back (its
   component disposes its context and shows its flat look until it is near
   again). A context the browser kills anyway is rebuilt once it is near. The
   shared contexts (foil and theme swatches) stay outside this, which is why
   the caps sit a little under the browser's. */

interface Holder {
  near: boolean;
  /* When it was last near the screen, for picking whom to evict. */
  lastNear: number;
  live: boolean;
  waiting: boolean;
  /* Name tags and swatches: they have a fine flat look and give way to the big pieces. */
  low: boolean;
  losses: number;
  set(live: boolean): void;
}

const holders = new Set<Holder>();
const MOBILE_LIMIT = 5;
const DESKTOP_LIMIT = 12;
/* After this many contexts lost out from under it, a component keeps its flat look. */
const MAX_LOSSES = 3;

let cachedLimit = 0;
function limit(): number {
  if (cachedLimit) return cachedLimit;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || window.matchMedia?.("(pointer: coarse)").matches;
  cachedLimit = mobile ? MOBILE_LIMIT : DESKTOP_LIMIT;
  return cachedLimit;
}

function liveCount(): number {
  let count = 0;
  for (const holder of holders) if (holder.live) count++;
  return count;
}

function revoke(holder: Holder) {
  holder.live = false;
  holder.waiting = holder.near;
  holder.set(false);
}

function victimFor(asker: Holder): Holder | undefined {
  let best: Holder | undefined;
  for (const holder of holders) {
    if (!holder.live || holder.near) continue;
    if (!best || holder.lastNear < best.lastNear) best = holder;
  }
  if (best || asker.low) return best;
  // a big piece on screen outranks a name tag or swatch, even one in view
  for (const holder of holders) {
    if (!holder.live || !holder.low) continue;
    if (!best || holder.lastNear < best.lastNear) best = holder;
  }
  return best;
}

let settling = false;
function settle() {
  if (settling) return;
  settling = true;
  try {
    const waiting = [...holders].filter((holder) => holder.waiting && holder.near && !holder.live);
    waiting.sort((a, b) => Number(a.low) - Number(b.low));
    for (const holder of waiting) {
      if (liveCount() >= limit()) {
        const victim = victimFor(holder);
        if (!victim) continue;
        revoke(victim);
      }
      holder.live = true;
      holder.waiting = false;
      holder.set(true);
    }
  } finally {
    settling = false;
  }
}

/* Whether the component around `ref` may hold a WebGL context now. Mount the
   context while this is true and dispose it (freeing the context) when it
   turns false. `low` marks pieces that give way to bigger ones. The element
   behind `ref` may be swapped (a canvas remade after holding a context). */
export function useWebGlSlot(ref: RefObject<HTMLElement | null>, { enabled = true, low = false }: { enabled?: boolean; low?: boolean } = {}): boolean {
  const [live, setLive] = useState(false);
  const watchRef = useRef<{ watch(element: HTMLElement | null): void } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const holder: Holder = { near: false, lastNear: 0, live: false, waiting: false, low, losses: 0, set: setLive };
    holders.add(holder);
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watched: HTMLElement | null = null;
    const watcher = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry.target !== watched) return;
      holder.near = entry.isIntersecting;
      holder.lastNear = performance.now();
      if (holder.near && !holder.live) holder.waiting = true;
      settle();
    }, { rootMargin: "300px 0px" });
    // webglcontextlost does not bubble, but capture still passes through here
    const onLost = () => {
      if (!holder.live) return;
      holder.losses++;
      holder.live = false;
      holder.waiting = false;
      setLive(false);
      settle();
      if (holder.losses > MAX_LOSSES) return;
      clearTimeout(retry);
      retry = setTimeout(() => {
        holder.waiting = holder.near;
        settle();
      }, 400);
    };
    const watch = (element: HTMLElement | null) => {
      if (element === watched) return;
      if (watched) {
        watcher.unobserve(watched);
        watched.removeEventListener("webglcontextlost", onLost, true);
      }
      watched = element;
      if (!element) return;
      watcher.observe(element);
      element.addEventListener("webglcontextlost", onLost, true);
    };
    watchRef.current = { watch };
    watch(ref.current);
    return () => {
      clearTimeout(retry);
      watch(null);
      watcher.disconnect();
      watchRef.current = null;
      holders.delete(holder);
      setLive(false);
      if (holder.live) settle();
    };
  }, [ref, enabled, low]);

  // follow the element if the component swapped it
  useEffect(() => {
    watchRef.current?.watch(ref.current);
  });

  return enabled && live;
}
