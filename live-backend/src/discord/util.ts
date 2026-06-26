// Runs `fn` over `items` with at most `limit` in flight at once (a worker pool,
// so a slow item never blocks others the way fixed chunking would). Used to fan
// out live-feed posts across many subscribed channels without exceeding Discord's
// global rate budget. `fn` must not reject (handle its own errors); a rejection
// aborts the pool.
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const max = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: max }, () => worker()));
}
