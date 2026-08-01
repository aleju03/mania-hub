/** Browse tabs that survive in the URL; "player" is the default, so it doesn't. */
export type ReplayBrowseTabParam = "beatmap" | "side-by-side" | "upload";

export type ReplayBackSearch = {
  player?: string;
  tab?: ReplayBrowseTabParam;
};

export type ReplayScoreSearch = {
  scoreId: number;
  beatmapsetId?: number;
};

export type ReplayBackNavigation =
  | { type: "history" }
  | { type: "route"; search: ReplayBackSearch };

export function getReplayBackNavigation({
  canGoBack,
  playerParam,
  tab,
}: {
  canGoBack: boolean;
  playerParam?: string;
  tab?: ReplayBrowseTabParam;
}): ReplayBackNavigation {
  if (canGoBack) return { type: "history" };
  if (playerParam) return { type: "route", search: { player: playerParam } };
  if (tab) return { type: "route", search: { tab } };
  return { type: "route", search: {} };
}

export function getReplaySearch(scoreId: number, beatmapsetId: number | undefined): ReplayScoreSearch {
  return { scoreId, beatmapsetId };
}
