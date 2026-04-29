export type ReplayBackSearch = {
  player?: string;
  tab?: "beatmap";
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
  tab?: "beatmap";
}): ReplayBackNavigation {
  if (canGoBack) return { type: "history" };
  if (playerParam) return { type: "route", search: { player: playerParam } };
  if (tab === "beatmap") return { type: "route", search: { tab: "beatmap" } };
  return { type: "route", search: {} };
}

export function getReplaySearch(scoreId: number, beatmapsetId: number | undefined): ReplayScoreSearch {
  return { scoreId, beatmapsetId };
}
