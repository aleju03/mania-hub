const SCORE_ID_PATTERN = /^\d+$/;
const SCORE_URL_PATTERN = /(?:^|\/)scores(?:\/[a-z]+)?\/(\d+)(?:[/?#]|$)/i;

export function parseReplayScoreInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const rawId = SCORE_ID_PATTERN.test(trimmed) ? trimmed : SCORE_URL_PATTERN.exec(trimmed)?.[1];
  if (!rawId) return null;

  const scoreId = Number(rawId);
  return Number.isSafeInteger(scoreId) && scoreId > 0 ? scoreId : null;
}
