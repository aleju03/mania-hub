export function normalizeReplayPlayerParam(playerParam: string | null | undefined): string | null {
  const normalized = playerParam?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function shouldStartReplayPlayerLoad({
  normalizedPlayerParam,
  loadedPlayerParam,
  loadingPlayerParam,
  hasScoreId,
}: {
  normalizedPlayerParam: string | null;
  loadedPlayerParam: string | null;
  loadingPlayerParam: string | null;
  hasScoreId: boolean;
}): boolean {
  if (hasScoreId || !normalizedPlayerParam) return false;
  if (loadedPlayerParam === normalizedPlayerParam) return false;
  if (loadingPlayerParam === normalizedPlayerParam) return false;
  return true;
}
