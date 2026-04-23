import type { RankingsResponse } from "./types";

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

export function getGlobalRankChange(history: number[] | undefined): number | null {
  if (!history || history.length < 8) return null;

  const current = history[history.length - 1];
  const weekAgo = history[history.length - 8];

  if (!current || !weekAgo || current === 0 || weekAgo === 0) return null;

  return weekAgo - current;
}

export function getCrRankChanges(
  ranking: RankingsResponse["ranking"],
  rankHistories: Record<number, number[]>,
): Record<number, number> {
  const entries = ranking.slice(0, 50);
  const withOldRank = entries
    .map((entry, index) => {
      const history = rankHistories[entry.user.id];
      const oldGlobal = history && history.length >= 8 ? history[history.length - 8] : null;

      return {
        userId: entry.user.id,
        currentCR: index + 1,
        oldGlobal,
      };
    })
    .filter((entry) => entry.oldGlobal !== null && entry.oldGlobal !== 0);

  if (withOldRank.length === 0) return {};

  const oldOrder = [...withOldRank].sort((a, b) => a.oldGlobal! - b.oldGlobal!);
  const changes: Record<number, number> = {};

  oldOrder.forEach((entry, index) => {
    const oldCR = index + 1;
    changes[entry.userId] = oldCR - entry.currentCR;
  });

  return changes;
}
