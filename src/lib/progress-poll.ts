export function getProgressPollDelay(elapsedMs: number): number {
  if (elapsedMs < 5_000) return 750;
  if (elapsedMs < 20_000) return 1_500;
  return 2_500;
}

export function startProgressPoll(poll: () => void | Promise<void>): () => void {
  let cancelled = false;
  let timeoutId: number | null = null;
  const startedAt = Date.now();

  const tick = async () => {
    try {
      await poll();
    } finally {
      if (cancelled) return;
      timeoutId = window.setTimeout(tick, getProgressPollDelay(Date.now() - startedAt));
    }
  };

  void tick();

  return () => {
    cancelled = true;
    if (timeoutId != null) window.clearTimeout(timeoutId);
  };
}
