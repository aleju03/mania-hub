import { JOB_LEASE_MS, type JobLease, type JobQueue } from "./queue.js";

export class JobLeaseLostError extends Error {}

/** Keep a claimed attempt owned until its handler and bookkeeping settle. */
export function maintainJobLease(
  queue: Pick<JobQueue, "renewLease">,
  id: number,
  lease: JobLease,
  controller: AbortController,
  initialDeadline = Date.now() + JOB_LEASE_MS,
): { lost: Promise<never>; stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline = initialDeadline;
  let rejectLost!: (error: JobLeaseLostError) => void;
  const lost = new Promise<never>((_resolve, reject) => { rejectLost = reject; });
  // A watchdog can release the lane while the handler still unwinds. The
  // lease remains alive then, although its original Promise.race has ended.
  lost.catch(() => {});
  const tick = async () => {
    if (stopped) return;
    const startedAt = Date.now();
    let owned: boolean;
    try {
      owned = await queue.renewLease(id, lease);
    } catch (cause) {
      if (stopped) return;
      // A temporary busy writer is not evidence another worker owns the job.
      // Retry inside the last successfully written lease, then abort if its
      // deadline passes without confirmation.
      if (Date.now() < deadline) schedule(Math.min(5_000, deadline - Date.now()));
      else lose(cause);
      return;
    }
    if (stopped) return;
    if (!owned) { lose(new Error("attempt no longer owned")); return; }
    deadline = startedAt + JOB_LEASE_MS;
    armExpiry();
    schedule();
  };
  const lose = (cause: unknown) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (expiryTimer) clearTimeout(expiryTimer);
    const error = new JobLeaseLostError(`job ${id} lease lost`, { cause });
    rejectLost(error);
    controller.abort(error);
  };
  const armExpiry = () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    // Renewal itself may be stuck in a queued write. Do not depend on that
    // promise settling to notice that the last confirmed lease has expired.
    expiryTimer = setTimeout(() => lose(new Error("confirmed lease expired")), Math.max(0, deadline - Date.now()));
    expiryTimer.unref?.();
  };
  const schedule = (delayMs = JOB_LEASE_MS / 3) => {
    timer = setTimeout(() => { void tick(); }, delayMs);
    timer.unref?.();
  };
  armExpiry();
  schedule(Math.max(0, Math.min(JOB_LEASE_MS / 3, deadline - Date.now())));
  return {
    lost,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (expiryTimer) clearTimeout(expiryTimer);
    },
  };
}
