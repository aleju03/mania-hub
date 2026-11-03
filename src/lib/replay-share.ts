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

/** Same-origin link to the replay's .osr: a score's or an upload's. Imports
 *  and unsaved local files get none. */
export function buildReplayDownloadUrl({
  scoreId,
  uploadId,
  filename,
}: {
  scoreId?: number | null;
  uploadId?: string | null;
  filename?: string | null;
}): string | null {
  const params = new URLSearchParams();
  if (uploadId) params.set("uploadId", uploadId);
  else if (scoreId != null && Number.isSafeInteger(scoreId) && scoreId > 0) params.set("scoreId", String(scoreId));
  else return null;
  if (filename) params.set("name", filename);
  return `/api/replay-file?${params.toString()}`;
}

/** osu!'s own export name: "player - artist - title [diff] (date) OsuMania.osr". */
export function replayDownloadFilename({
  playerName,
  artist,
  title,
  version,
  playedAt,
}: {
  playerName?: string | null;
  artist?: string | null;
  title?: string | null;
  version?: string | null;
  playedAt?: string | null;
}): string {
  const parts = [playerName, artist, title].map((part) => part?.trim()).filter(Boolean);
  let name = parts.join(" - ");
  if (version?.trim()) name += ` [${version.trim()}]`;
  const date = playedAt ? new Date(playedAt) : null;
  if (date && Number.isFinite(date.getTime())) {
    const pad = (n: number) => String(n).padStart(2, "0");
    name += ` (${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())})`;
  }
  return sanitizeReplayFilename(`${name || "replay"} OsuMania.osr`);
}

/** Strips characters Windows and macOS refuse in file names. */
export function sanitizeReplayFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!cleaned || cleaned === ".osr") return "replay.osr";
  return cleaned.toLowerCase().endsWith(".osr") ? cleaned : `${cleaned}.osr`;
}
