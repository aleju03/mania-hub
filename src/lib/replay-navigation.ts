export type ReplayBackSearch = {
  player?: string;
  tab?: "beatmap" | "upload";
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
  tab?: "beatmap" | "upload";
}): ReplayBackNavigation {
  if (canGoBack) return { type: "history" };
  if (playerParam) return { type: "route", search: { player: playerParam } };
  if (tab === "beatmap" || tab === "upload") return { type: "route", search: { tab } };
  return { type: "route", search: {} };
}

export function getReplaySearch(scoreId: number, beatmapsetId: number | undefined): ReplayScoreSearch {
  return { scoreId, beatmapsetId };
}
