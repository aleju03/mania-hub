/* First-time GPU setup (a WebGL context, a shader compile, a model's
   textures) holds the main thread for tens of milliseconds, far longer on a
   weak machine, and a page that starts a dozen at once freezes for a second.
   Queued here, they run one per idle moment once the page has painted, so
   scrolling and clicks get in between, and none starts while the page is
   being scrolled: a frame lost mid-scroll is the one people feel. Shader
   compiles inside draw loops take a slot with `takeGpuSlot`, which spaces them
   out the same way. */

const SLOT_GAP_MS = 40;
/* Nothing heavy starts until the page has been still this long. */
const SCROLL_QUIET_MS = 220;

type IdleWindow = Window & { requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number };

const queue: (() => void)[] = [];
let scheduled = false;
let lastHeavy = -Infinity;

let lastScroll = -Infinity;
let watchingScroll = false;
let scrollingNow = false;
let quietTimer: ReturnType<typeof setTimeout> | undefined;
const scrollListeners = new Set<(scrolling: boolean) => void>();
function watchScroll() {
  if (watchingScroll || typeof window === "undefined") return;
  watchingScroll = true;
  const mark = () => {
    lastScroll = performance.now();
    if (!scrollingNow) {
      scrollingNow = true;
      for (const listener of scrollListeners) listener(true);
    }
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      scrollingNow = false;
      for (const listener of scrollListeners) listener(false);
    }, SCROLL_QUIET_MS);
  };
  for (const type of ["scroll", "wheel", "touchmove"]) window.addEventListener(type, mark, { passive: true, capture: true });
}

/* Told when the page starts and stops being scrolled, for work that waits
   for a pause (a section switching to its live previews). Returns the
   unsubscribe. */
export function onScrollingChange(listener: (scrolling: boolean) => void): () => void {
  watchScroll();
  scrollListeners.add(listener);
  return () => {
    scrollListeners.delete(listener);
  };
}

/* Whether the page is being scrolled right now (or was a moment ago). */
export function isScrolling(): boolean {
  watchScroll();
  return performance.now() - lastScroll < SCROLL_QUIET_MS;
}

/* True, and claims the slot, when no other heavy GPU step ran in the last few
   frames and the page isn't being scrolled. */
export function takeGpuSlot(): boolean {
  const now = performance.now();
  if (now - lastHeavy < SLOT_GAP_MS || isScrolling()) return false;
  lastHeavy = now;
  return true;
}

function whenIdle(run: () => void) {
  const idle = (window as IdleWindow).requestIdleCallback;
  if (idle) idle(run, { timeout: 500 });
  else setTimeout(run, 16);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  // after the next frame has painted, then when the page is idle; while it
  // scrolls, check back once it may have stopped
  requestAnimationFrame(() => setTimeout(() => {
    if (!isScrolling()) return whenIdle(pump);
    setTimeout(() => {
      scheduled = false;
      schedule();
    }, SCROLL_QUIET_MS);
  }, 0));
}

function pump() {
  scheduled = false;
  if (queue.length === 0) return;
  if (!takeGpuSlot()) {
    schedule();
    return;
  }
  const task = queue.shift()!;
  try {
    task();
  } catch (error) {
    if (import.meta.env.DEV) console.warn("gpu task", error);
  }
  if (queue.length > 0) schedule();
}

/* Runs `task` in its own idle moment, after anything queued before it.
   Returns a cancel for a task that has not run yet. */
export function queueGpuWork(task: () => void): () => void {
  queue.push(task);
  schedule();
  return () => {
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
  };
}

/* A machine where several live previews at once cost more than they show:
   four cores or fewer, 4 GB of memory or less, or data saver on. */
export function isLowEndDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory ?? 8) <= 4 || nav.connection?.saveData === true;
}
