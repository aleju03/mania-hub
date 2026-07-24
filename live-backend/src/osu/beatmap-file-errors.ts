// Shared detector for a *permanent* .osu-file fetch failure.
//
// `OsuApiClient.getBeatmapFileUncached` throws
//   `Failed to fetch .osu file for beatmap <id>: osu (<err>); catboy (<err>)`
// after every mirror fails. When every source failed with a 404 or an invalid
// file, the beatmap is genuinely unavailable and retrying can never succeed, so
// dependent jobs (dan estimates, chart/activity analysis, osu-file backfill)
// should give up instead of retrying on backoff forever.
export function isTerminalBeatmapFileError(message: string): boolean {
  if (!message.startsWith("Failed to fetch .osu file for beatmap ")) return false;
  const separatorIndex = message.indexOf(": ");
  if (separatorIndex < 0) return false;
  const sourceErrors = message
    .slice(separatorIndex + 2)
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return sourceErrors.length > 0 && sourceErrors.every((part) => part.includes("(404)") || part.includes("invalid .osu file"));
}
