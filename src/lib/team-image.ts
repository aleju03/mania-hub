/* osu!'s content-hashed team flag and header paths, the only ones
   /api/team-image serves. */
export const TEAM_IMAGE_PATH_PATTERN = /^teams\/(flag|header)\/\d{1,9}\/[a-f0-9]{64}\.(png|jpe?g|gif|webp)$/;

/** Same-origin URL for a team flag or header, for canvas callers that need CORS. */
export function teamImageProxyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https:\/\/assets\.ppy\.sh\/(.+)$/.exec(url);
  return match && TEAM_IMAGE_PATH_PATTERN.test(match[1]) ? `/api/team-image?path=${encodeURIComponent(match[1])}` : null;
}
