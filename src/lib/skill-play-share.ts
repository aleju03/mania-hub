import { skillAxisMeta } from "./skill-axes";

export interface SharedSkillPlaySearch {
  score?: number;
  keys?: number;
  map?: number;
  rating?: string;
}

export function parseSharedSkillPlaySearch(search: Record<string, unknown>): SharedSkillPlaySearch {
  const score = Number(search.score);
  const keys = Number(search.keys);
  const map = Number(search.map);
  const rating = String(search.rating ?? "Overall");
  if (!Number.isSafeInteger(score) || score <= 0 || !Number.isInteger(keys) || keys < 1 || keys > 18
    || !Number.isSafeInteger(map) || map <= 0
    || (rating !== "dan:rc" && rating !== "dan:ln" && !skillAxisMeta(rating))) return {};
  return { score, keys, map, rating };
}

export function skillPlaySharePath(username: string, scoreId: number | null | undefined, keyCount: number, beatmapId: number, rating: string): string | null {
  const search = parseSharedSkillPlaySearch({ score: scoreId, keys: keyCount, map: beatmapId, rating });
  if (!search.score) return null;
  const query = new URLSearchParams({ score: String(search.score), keys: String(keyCount), map: String(beatmapId), rating });
  return `/player/${encodeURIComponent(username)}/skills?${query}`;
}
