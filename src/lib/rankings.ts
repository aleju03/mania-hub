export type RankDeltaSortDirection = "asc" | "desc";

export function getRankTierClass(rank: number | null | undefined): string {
  if (!rank || rank < 1) return "";
  if (rank <= 10) return "peak-rank-tier peak-rank-mythic";
  if (rank <= 50) return "peak-rank-tier peak-rank-gold";
  if (rank <= 200) return "peak-rank-tier peak-rank-platinum";
  if (rank <= 1000) return "peak-rank-tier peak-rank-chrome";
  if (rank <= 5000) return "peak-rank-tier peak-rank-steel";
  if (rank <= 25000) return "peak-rank-tier peak-rank-bronze";
  return "";
}

export function compareRankDeltaValues(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: RankDeltaSortDirection,
): number {
  const aValue = typeof a === "number" && Number.isFinite(a) ? a : null;
  const bValue = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (aValue !== null && bValue === null) return -1;
  if (aValue === null && bValue !== null) return 1;
  if (aValue === null || bValue === null) return 0;

  return dir === "desc" ? bValue - aValue : aValue - bValue;
}
