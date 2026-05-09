export interface ReplaySeoScore {
  username: string;
  title: string;
  version: string;
}

function truncateTitle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildReplaySeoTitle(
  scoreId: number,
  score?: ReplaySeoScore | null,
  playerName = "",
): string {
  if (!score || !score.username || !score.title) {
    return playerName ? `${playerName}'s replay` : `Score #${scoreId} replay`;
  }

  if (score.version) {
    const withDifficulty = `${score.username} on ${score.title} [${score.version}]`;
    if (withDifficulty.length <= 90) return withDifficulty;
  }

  const withoutDifficulty = `${score.username} on ${score.title}`;
  if (withoutDifficulty.length <= 90) return withoutDifficulty;

  return truncateTitle(withoutDifficulty, 90);
}
