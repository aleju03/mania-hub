import { createServerFn } from "@tanstack/react-start";

import { edgeCache, noStore } from "./osu/server";
import type { UploadedReplayBeatmapResolution, UploadedReplayOpenData } from "./uploaded-replay-payload";
import { normalizeUploadedReplayId } from "./uploaded-replay-store";

// The client-facing half of opening an uploaded replay. The work lives in
// uploaded-replay-open-server.ts and is imported inside the handlers, so this
// module stays importable from the replay route without dragging R2 or the
// filesystem into the browser bundle.

function normalizeChecksumInput(input: { checksum?: unknown } | undefined): { checksum: string } {
  const checksum = String(input?.checksum ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(checksum)) throw new Error("Invalid beatmap checksum.");
  return { checksum };
}

// Fallback for an upload whose POST could not resolve the chart (an osu!
// hiccup mid-upload): the file is stored, only the chart is retried here.
export const getUploadedReplayBeatmapResolution = createServerFn({ method: "GET" })
  .validator(normalizeChecksumInput)
  .handler(async ({ data }): Promise<UploadedReplayBeatmapResolution> => {
    const { resolveUploadedReplayBeatmap } = await import("./uploaded-replay-open-server");
    const resolved = await resolveUploadedReplayBeatmap(data.checksum);
    // A miss flips to a hit the moment someone contributes the map.
    if (resolved.file && resolved.file.checksumMatched !== false) edgeCache(300, 3600);
    else noStore();
    return resolved;
  });

// One call for a share link: the packed replay and its chart together. Null
// when the upload is gone (deleted, or never existed).
export const getUploadedReplayOpenData = createServerFn({ method: "GET" })
  .validator((input: { uploadId?: unknown } | undefined) => {
    const uploadId = normalizeUploadedReplayId(typeof input?.uploadId === "string" ? input.uploadId : "");
    if (!uploadId) throw new Error("Invalid upload id.");
    return { uploadId };
  })
  .handler(async ({ data }): Promise<UploadedReplayOpenData | null> => {
    const { readUploadedReplayPacked, resolveUploadedReplayBeatmap } = await import("./uploaded-replay-open-server");
    const stored = await readUploadedReplayPacked(data.uploadId);
    if (!stored) {
      noStore();
      return null;
    }
    const beatmap = await resolveUploadedReplayBeatmap(stored.replay.header.beatmapHash ?? "");
    // Short even when fully resolved: a delete has to take the share link
    // down promptly, and a contributed copy can arrive any minute otherwise.
    if (beatmap.file && beatmap.file.checksumMatched !== false) edgeCache(60, 300);
    else noStore();
    return { id: data.uploadId, filename: stored.filename, replay: stored.replay, beatmap };
  });
