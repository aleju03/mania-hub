import { parseManiaBeatmap, type ManiaBeatmap, type ParseManiaBeatmapOptions } from "./beatmap-parser";

const MAX_PARSED_BEATMAPS = 50;
const parsedBeatmapCache = new Map<string, { content: string; beatmap: ManiaBeatmap }>();

function getCacheKey(beatmapId: number, options: ParseManiaBeatmapOptions): string {
  return `${beatmapId}:${options.keyCount ?? "default"}`;
}

export function parseCachedManiaBeatmap(
  beatmapId: number,
  content: string,
  options: ParseManiaBeatmapOptions = {},
): ManiaBeatmap {
  const cacheKey = getCacheKey(beatmapId, options);
  const cached = parsedBeatmapCache.get(cacheKey);
  if (cached?.content === content) {
    parsedBeatmapCache.delete(cacheKey);
    parsedBeatmapCache.set(cacheKey, cached);
    return cached.beatmap;
  }

  const beatmap = parseManiaBeatmap(content, options);
  parsedBeatmapCache.set(cacheKey, { content, beatmap });

  while (parsedBeatmapCache.size > MAX_PARSED_BEATMAPS) {
    const oldestKey = parsedBeatmapCache.keys().next().value;
    if (oldestKey === undefined) break;
    parsedBeatmapCache.delete(oldestKey);
  }

  return beatmap;
}

export function clearParsedBeatmapCache(): void {
  parsedBeatmapCache.clear();
}
