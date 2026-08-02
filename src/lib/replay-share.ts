/** Canonical link for the replay currently on screen.
 *
 *  Uploaded replays already carry their own `/replay?uploadId=` link, handed
 *  back by the upload; scores get a clean `scoreId` link rather than whatever
 *  the address bar holds, which usually still carries the browse tab, player
 *  and beatmapset params the viewer was opened from.
 */
export function buildReplayShareUrl({
  origin,
  scoreId,
  uploadShareUrl,
}: {
  origin: string;
  scoreId?: number;
  uploadShareUrl?: string | null;
}): string | null {
  const base = uploadShareUrl
    ? safeUrl(uploadShareUrl, origin)
    : scoreId != null && Number.isFinite(scoreId)
      ? safeUrl(`/replay?scoreId=${scoreId}`, origin)
      : null;
  if (!base) return null;
  base.searchParams.delete("t");
  return base.toString();
}

/** Same link, seeked: `?t=` in wall-clock seconds, dropped for the start. */
export function withReplayShareTime(shareUrl: string, startSeconds: number | null | undefined): string {
  const url = safeUrl(shareUrl, shareUrl);
  if (!url) return shareUrl;
  const t = roundShareSeconds(startSeconds);
  if (t == null) url.searchParams.delete("t");
  else url.searchParams.set("t", String(t));
  return url.toString();
}

/** The viewer seeks in tenths of a second, so links round to the same grid. */
export function roundShareSeconds(seconds: number | null | undefined): number | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const rounded = Math.round(seconds * 10) / 10;
  return rounded > 0 ? rounded : null;
}

function safeUrl(url: string, base: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}
