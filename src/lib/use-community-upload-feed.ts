import { useCallback, useEffect, useRef, useState } from "react";
import { getCommunityUploadsPage } from "./uploaded-replay-community";
import type { CommunityUploadsPage, CommunityUploadsQuery } from "./uploaded-replay-feed";
import type { CommunityUploadEntry } from "./uploaded-replay-payload";

type Feed = {
  uploads: CommunityUploadEntry[];
  total: number;
  nextCursor: string | null;
  indexing: boolean;
};
type SavedFeed = { feed: Feed; fetchedAt: number; prefetch?: { cursor: string; result: Promise<CommunityUploadsPage> } };
const feeds = new Map<string, SavedFeed>();
const EMPTY: Feed = { uploads: [], total: 0, nextCursor: null, indexing: false };
const CACHE_MS = 60_000;

export function useCommunityUploadFeed(query: CommunityUploadsQuery) {
  const key = JSON.stringify([query.q, query.keys, query.grade, query.starMin, query.starMax, query.sort]);
  const saved = feeds.get(key);
  const initial = saved && Date.now() - saved.fetchedAt < CACHE_MS ? saved.feed : EMPTY;
  const [feed, setFeed] = useState<Feed>(initial);
  const [loading, setLoading] = useState(initial === EMPTY);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const current = useRef(initial);

  const load = useCallback(async (append: boolean) => {
    if (busy.current) return;
    const filters = { q: query.q, keys: query.keys, grade: query.grade, starMin: query.starMin, starMax: query.starMax, sort: query.sort };
    busy.current = true;
    const revision = generation.current;
    const cursor = append ? current.current.nextCursor : null;
    setLoading(true);
    setFailed(false);
    try {
      const saved = feeds.get(key);
      const result = cursor && saved?.prefetch?.cursor === cursor
        ? await saved.prefetch.result
        : await getCommunityUploadsPage({ data: { ...filters,
          ...(cursor ? { cursor } : { limit: Math.max(24, current.current.uploads.length) }) } });
      if (generation.current !== revision) return;
      const seen = new Set(current.current.uploads.map((entry) => entry.id));
      const next = { ...result, uploads: append
        ? [...current.current.uploads, ...result.uploads.filter((entry) => !seen.has(entry.id))]
        : result.uploads };
      current.current = next;
      setFeed(next);
      const cached: SavedFeed = { feed: next, fetchedAt: Date.now() };
      feeds.delete(key);
      feeds.set(key, cached);
      while (feeds.size > 8) feeds.delete(feeds.keys().next().value!);
      if (result.nextCursor && !result.indexing) {
        const resultPromise = getCommunityUploadsPage({ data: { ...filters, cursor: result.nextCursor } });
        cached.prefetch = { cursor: result.nextCursor, result: resultPromise };
        // Speculative failures must not become unhandled rejections or poison
        // Retry. A foreground attempt will make a fresh request instead.
        void resultPromise.catch(() => { cached.prefetch = undefined; });
      }
    } catch {
      if (generation.current === revision) setFailed(true);
    } finally {
      if (generation.current === revision) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [key, query.q, query.keys, query.grade, query.starMin, query.starMax, query.sort]);

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    const saved = feeds.get(key);
    const cached = saved && Date.now() - saved.fetchedAt < CACHE_MS ? saved.feed : null;
    current.current = cached ?? EMPTY;
    setFeed(current.current);
    setFailed(false);
    if (cached) setLoading(false);
    else void load(false);
    return () => { generation.current += 1; };
  }, [key, load]);

  // A cold catalog fills in the background. Refresh the visible prefix so
  // new matches cannot fall behind a used cursor, without blocking scrolling.
  useEffect(() => {
    if (!feed.indexing || loading || failed) return;
    const timer = window.setTimeout(() => void load(false), 2000);
    return () => window.clearTimeout(timer);
  }, [feed, loading, failed, load]);

  const loadMore = useCallback(() => {
    if (current.current.nextCursor) void load(true);
  }, [load]);
  const retry = useCallback(() => void load(current.current.uploads.length > 0 && !current.current.indexing), [load]);
  return { ...feed, loading, failed, loadMore, retry };
}
