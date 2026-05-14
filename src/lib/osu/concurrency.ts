import { TRACKER_SNAPSHOT_BATCH_TIMEOUT_MS } from "./constants";
import type { CountryRecentScoresResponse } from "./internal-types";

export async function withTrackerSnapshotBatchBudget(
  feedPromise: Promise<CountryRecentScoresResponse>,
): Promise<CountryRecentScoresResponse | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), TRACKER_SNAPSHOT_BATCH_TIMEOUT_MS);
  });
  return Promise.race([
    feedPromise.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    timeoutPromise,
  ]);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) return;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}
