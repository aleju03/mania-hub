import type { LocalBeatmapMatch } from "./replay-local-beatmap";

// Client side of /api/community-beatmap-asset: where a contributed map's song
// and background are served from, and the upload that puts them there.

export type CommunityBeatmapAssetKind = "audio" | "background";

export function getCommunityBeatmapAssetUrl(checksum: string, kind: CommunityBeatmapAssetKind): string {
  return `/api/community-beatmap-asset?checksum=${encodeURIComponent(checksum)}&kind=${kind}`;
}

/**
 * Sends the audio and background pulled out of a matched .osz. Best-effort by
 * design: the caller has already started local playback from the blobs, this
 * only spares the next viewer the silent, blank version. Resolves to which
 * kinds were sent (a bare .osu drop sends nothing).
 */
export async function uploadCommunityBeatmapAssets(
  checksum: string,
  match: Pick<LocalBeatmapMatch, "audioBlob" | "audioFilename" | "backgroundBlob" | "backgroundFilename">,
): Promise<CommunityBeatmapAssetKind[]> {
  const form = new FormData();
  form.set("checksum", checksum);
  const sent: CommunityBeatmapAssetKind[] = [];
  if (match.audioBlob && match.audioFilename) {
    form.set("audio", match.audioBlob, match.audioFilename.split("/").pop() ?? match.audioFilename);
    sent.push("audio");
  }
  if (match.backgroundBlob && match.backgroundFilename) {
    form.set("background", match.backgroundBlob, match.backgroundFilename.split("/").pop() ?? match.backgroundFilename);
    sent.push("background");
  }
  if (sent.length === 0) return [];
  const response = await fetch("/api/community-beatmap-asset", { method: "POST", body: form, credentials: "same-origin" });
  if (!response.ok) throw new Error(`Community beatmap asset upload failed (${response.status})`);
  return sent;
}
