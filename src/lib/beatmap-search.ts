import type { OsuBeatmapset } from "./types";

type BeatmapSearchMatchTier = "strict" | "broad";

interface RankedBeatmapsetMatch {
  beatmapset: OsuBeatmapset;
  index: number;
  score: number;
  tier: BeatmapSearchMatchTier;
}

function normalizeBeatmapSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function rankBeatmapsetMatch(beatmapset: OsuBeatmapset, normalizedQuery: string): Omit<RankedBeatmapsetMatch, "beatmapset" | "index"> | null {
  const maniaBeatmaps = (beatmapset.beatmaps ?? []).filter((beatmap) => beatmap.mode === "mania");
  if (maniaBeatmaps.length === 0) return null;

  const title = normalizeBeatmapSearchText(beatmapset.title);
  const artist = normalizeBeatmapSearchText(beatmapset.artist);
  const creator = normalizeBeatmapSearchText(beatmapset.creator);
  const versions = maniaBeatmaps.map((beatmap) => normalizeBeatmapSearchText(beatmap.version)).filter(Boolean);
  const titleMatchesExactly = title === normalizedQuery;
  const titleContainsPhrase = title.includes(normalizedQuery);
  const versionContainsPhrase = versions.some((version) => version.includes(normalizedQuery));

  if (titleMatchesExactly) {
    return { score: 500, tier: "strict" };
  }
  if (titleContainsPhrase) {
    return { score: 450, tier: "strict" };
  }
  if (versionContainsPhrase) {
    return { score: 400, tier: "strict" };
  }

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  const combinedMetadata = [title, artist, creator, ...versions].join(" ");
  const titleContainsAllTokens = tokens.every((token) => title.includes(token));
  const metadataContainsAllTokens = tokens.every((token) => combinedMetadata.includes(token));

  if (titleContainsAllTokens) {
    return { score: 300, tier: "broad" };
  }
  if (metadataContainsAllTokens) {
    return { score: 200, tier: "broad" };
  }

  return null;
}

export function filterBeatmapSearchResults(beatmapsets: OsuBeatmapset[], query: string): OsuBeatmapset[] {
  const normalizedQuery = normalizeBeatmapSearchText(query);
  if (!normalizedQuery) return beatmapsets;

  const rankedMatches = beatmapsets
    .map((beatmapset, index) => {
      const match = rankBeatmapsetMatch(beatmapset, normalizedQuery);
      return match ? { beatmapset, index, ...match } : null;
    })
    .filter((match): match is RankedBeatmapsetMatch => match !== null);

  const strictMatches = rankedMatches.filter((match) => match.tier === "strict");
  const visibleMatches = strictMatches.length > 0 ? strictMatches : rankedMatches;

  return visibleMatches
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((match) => match.beatmapset);
}
