import { parseManiaBeatmap, type ManiaBeatmap } from "./beatmap-parser";

const MAX_PARSED_BEATMAPS = 50;
const parsedBeatmapCache = new Map<number, { content: string; beatmap: ManiaBeatmap }>();

export function parseCachedManiaBeatmap(beatmapId: number, content: string): ManiaBeatmap {
  const cached = parsedBeatmapCache.get(beatmapId);
  if (cached?.content === content) {
    parsedBeatmapCache.delete(beatmapId);
    parsedBeatmapCache.set(beatmapId, cached);
    return cached.beatmap;
  }

  const beatmap = parseManiaBeatmap(content);
  parsedBeatmapCache.set(beatmapId, { content, beatmap });

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
