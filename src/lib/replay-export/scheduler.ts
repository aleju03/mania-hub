// Keeping the page usable while an export runs.
//
// Encoding is asynchronous, but rendering a frame and mixing a second of PCM
// are not: without an explicit yield they hold the main thread for as long as
// they take. `await Promise.resolve()` does not help, because a microtask
// runs before the browser gets a turn. This yields a real task.

export type CooperativeScheduler = {
  /** Yields if the current run of work has used up its budget. */
  maybeYield: () => Promise<void>;
  /** Yields unconditionally. */
  yieldNow: () => Promise<void>;
};

type SchedulerWithYield = {
  yield?: () => Promise<void>;
};

function yieldToBrowser(): Promise<void> {
  const native = (globalThis as { scheduler?: SchedulerWithYield }).scheduler?.yield;
  if (typeof native === "function") {
    return native.call((globalThis as { scheduler?: SchedulerWithYield }).scheduler).catch(() => {});
  }
  if (typeof MessageChannel === "function") {
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function createCooperativeScheduler(budgetMs: number): CooperativeScheduler {
  let sliceStart = performance.now();
  const yieldNow = async () => {
    await yieldToBrowser();
    sliceStart = performance.now();
  };
  return {
    yieldNow,
    maybeYield: async () => {
      if (performance.now() - sliceStart < budgetMs) return;
      await yieldNow();
    },
  };
}
