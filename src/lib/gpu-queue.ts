/* First-time GPU setup (a WebGL context, a shader compile, a model's
   textures) holds the main thread for tens of milliseconds, far longer on a
   weak machine, and a page that starts a dozen at once freezes for a second.
   Queued here, they run one per idle moment once the page has painted, so
   scrolling and clicks get in between. Shader compiles inside draw loops take
   a slot with `takeGpuSlot`, which spaces them out the same way. */

const SLOT_GAP_MS = 40;

type IdleWindow = Window & { requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number };

const queue: (() => void)[] = [];
let scheduled = false;
let lastHeavy = -Infinity;

/* True, and claims the slot, when no other heavy GPU step ran in the last few frames. */
export function takeGpuSlot(): boolean {
  const now = performance.now();
  if (now - lastHeavy < SLOT_GAP_MS) return false;
  lastHeavy = now;
  return true;
}

function whenIdle(run: () => void) {
  const idle = (window as IdleWindow).requestIdleCallback;
  if (idle) idle(run, { timeout: 500 });
  else setTimeout(run, 16);
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

function schedule() {
  if (scheduled) return;
  scheduled = true;
  // after the next frame has painted, then when the page is idle
  requestAnimationFrame(() => setTimeout(() => whenIdle(pump), 0));
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
