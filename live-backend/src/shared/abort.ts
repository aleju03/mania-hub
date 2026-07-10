// Cooperative cancellation for job handlers. The worker watchdog aborts a
// signal when a job overruns its lane's ceiling; long handlers check this at
// batch/page boundaries so an abandoned (detached) invocation stops instead of
// running on and burning memory / osu! API budget.

export class JobAbortedError extends Error {
  constructor(message = "job aborted") {
    super(message);
    this.name = "JobAbortedError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) throw reason;
  throw new JobAbortedError(typeof reason === "string" ? reason : undefined);
}
